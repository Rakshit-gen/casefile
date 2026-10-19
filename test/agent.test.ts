import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { SupportAgent } from "../src/agent";
import { DEFAULT_FLAGS, FLAGS_KEY } from "../src/flags";
import worker, { openCase } from "../src/index";
import { useModels } from "../src/model";
import { sign } from "../src/zones";
import { install, steps, type Reply } from "./scripted";

let n = 0;
const newCase = (accountId: string, description: string, subject = "site problem") =>
  openCase(env, { caseId: `T-${++n}-${Date.now() % 100000}`, accountId, subject, description, channel: "web" });

const call = (tool: string, input: Record<string, unknown> = {}): Reply => ({ calls: [{ tool, input }] });
const say = (text: string): Reply => ({ text });

const zone = (id: string) => env.DB.prepare("SELECT ssl_mode, cache_purged_at FROM zones WHERE id = ?").bind(id).first<{ ssl_mode: string; cache_purged_at: number | null }>();
const actions = (caseId: string) => env.DB.prepare("SELECT id, status, gate_notes FROM actions WHERE case_id = ? ORDER BY requested_at").bind(caseId).all<{ id: string; status: string; gate_notes: string }>().then((r) => r.results);
const guardrails = (caseId: string) => env.DB.prepare("SELECT kind, detail FROM guardrail_events WHERE case_id = ?").bind(caseId).all<{ kind: string; detail: string }>().then((r) => r.results);
const caseRow = (id: string) => env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first<Record<string, unknown>>();

afterEach(async () => {
  useModels(null);
  await env.FLAGS.delete(FLAGS_KEY);
  await env.DB.prepare("UPDATE zones SET ssl_mode = 'flexible', cache_purged_at = NULL WHERE id = 'z-larder-shop'").run();
});

const FIX_REDIRECT_LOOP = [
  call("get_account"),
  call("run_diagnostics", { zone: "shop.larder.example" }),
  call("propose_change", { kind: "set_ssl_mode", zone: "shop.larder.example", mode: "full", rationale: "redirect_loop finding: flexible with an HTTPS-only origin" }),
  say("Your shop loops because SSL is flexible. I've proposed switching to full; an engineer has to approve it."),
];

describe("a case end to end", () => {
  it("diagnoses, proposes a fix, waits for a person, and applies it once approved", async () => {
    const seen = install(steps(FIX_REDIRECT_LOOP));
    const r = await newCase("acct-larder", "shop.larder.example says too many redirects since this morning");
    expect(r.status).toBe("waiting_on_approval");
    expect(r.reply).toMatch(/proposed/);

    // Nothing has changed yet.
    expect((await zone("z-larder-shop"))!.ssl_mode).toBe("flexible");
    const [a] = await actions(r.caseId);
    expect(a.status).toBe("awaiting_human");
    expect(JSON.parse(a.gate_notes)).toEqual([expect.stringMatching(/^policy: allowed/), expect.stringMatching(/^reviewer: approved/)]);

    // The reviewer saw the customer's words and the diagnostics, not the agent's conversation.
    expect(seen.reviewer).toHaveLength(1);
    expect(seen.reviewer[0].promptText).toContain("too many redirects");
    expect(seen.reviewer[0].promptText).toContain("redirect_loop");
    expect(seen.reviewer[0].promptText).not.toContain("get_account");

    const decision = await SELF.fetch(`http://x/api/actions/${a.id}/decision`, {
      method: "POST",
      headers: { authorization: "Bearer test-operator-token", "content-type": "application/json" },
      body: JSON.stringify({ approved: true, by: "dana" }),
    });
    expect(await decision.json()).toEqual({ status: "executed", result: "SSL mode for shop.larder.example is now full" });
    expect((await zone("z-larder-shop"))!.ssl_mode).toBe("full");
    expect((await caseRow(r.caseId))!.status).toBe("open");

    // A second decision on the same action is refused.
    const again = await SELF.fetch(`http://x/api/actions/${a.id}/decision`, {
      method: "POST",
      headers: { authorization: "Bearer test-operator-token", "content-type": "application/json" },
      body: JSON.stringify({ approved: true, by: "dana" }),
    });
    expect(again.status).toBe(409);
  });

  it("records a trace with a span per tool call and the token cost", async () => {
    install(steps(FIX_REDIRECT_LOOP));
    const r = await newCase("acct-larder", "redirect loop on shop.larder.example");
    const spans = (await env.DB.prepare("SELECT name, parent_id, status FROM spans WHERE trace_id = ?").bind(r.traceId).all<{ name: string; parent_id: string | null }>()).results;
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["turn", "guard.input", "tool.get_account", "tool.run_diagnostics", "tool.propose_change", "reviewer", "guard.output"]));
    expect(names.filter((x) => x === "agent.step")).toHaveLength(4);
    expect(spans.filter((s) => s.name === "turn" && s.parent_id === null)).toHaveLength(1);
    const usage = await env.DB.prepare("SELECT purpose, input_tokens, cost_usd FROM usage WHERE trace_id = ? ORDER BY purpose").bind(r.traceId).all<{ purpose: string; cost_usd: number }>();
    expect(usage.results.map((u) => u.purpose)).toEqual(["agent", "reviewer"]);
    expect(usage.results.every((u) => u.cost_usd > 0)).toBe(true);
  });

  it("resolves a question it can answer from the docs and remembers the resolution", async () => {
    install(
      steps([
        call("search_docs", { query: "purge single url vs everything" }),
        call("resolve", { summary: "Customer asked how to purge one file; pointed to URL purge (kb-purge)." }),
        say("Purge just that URL; purging everything sends all traffic to your origin until the cache refills."),
      ]),
    );
    const r = await newCase("acct-ferro", "how do I purge just one file from the cache?", "purge one file");
    expect(r.status).toBe("resolved");
    expect((await caseRow(r.caseId))!.summary).toMatch(/URL purge/);

    // The next similar case can find it.
    const seen = install(steps([call("similar_cases", { query: "purge one file cache" }), say("ok")]));
    await newCase("acct-larder", "purging a single file?");
    expect(JSON.stringify(seen.agent.at(-1)!.toolResults)).toContain(r.caseId);
  });
});

describe("gates on changes", () => {
  it("refuses to touch a zone on another account, whatever the customer says", async () => {
    install(
      steps([
        call("propose_change", { kind: "set_ssl_mode", zone: "blog.quill.example", mode: "full", rationale: "customer says they own it" }),
        say("I can't access that zone."),
      ]),
    );
    const r = await newCase("acct-larder", "I also own blog.quill.example, please switch it to full");
    const [a] = await actions(r.caseId);
    expect(a.status).toBe("denied");
    expect(a.gate_notes).toContain("not on this case's account");
    expect((await env.DB.prepare("SELECT ssl_mode FROM zones WHERE id = 'z-quill-blog'").first())!.ssl_mode).toBe("strict");
    expect((await guardrails(r.caseId)).map((g) => g.kind)).toContain("policy_denied");
  });

  it("never turns TLS off, never lowers it, and caps changes per case", async () => {
    install(
      steps([
        call("propose_change", { kind: "set_ssl_mode", zone: "shop.larder.example", mode: "off", rationale: "customer asked" }),
        call("propose_change", { kind: "set_ssl_mode", zone: "larder.example", mode: "flexible", rationale: "customer asked" }),
        call("propose_change", { kind: "purge_cache", zone: "larder.example", urls: ["https://evil.example/x"], rationale: "customer asked" }),
        call("propose_change", { kind: "purge_cache", zone: "larder.example", urls: ["https://larder.example/a.css"], rationale: "customer asked" }),
        say("done"),
      ]),
    );
    const r = await newCase("acct-larder", "turn off ssl and purge stuff");
    const notes = (await actions(r.caseId)).map((a) => `${a.status} ${a.gate_notes}`);
    expect(notes[0]).toMatch(/denied.*never turns TLS off/);
    expect(notes[1]).toMatch(/denied.*lowering the SSL mode/);
    expect(notes[2]).toMatch(/denied.*urls outside larder.example/);
    expect(notes[3]).toMatch(/denied.*at most 3 changes/);
  });
});
