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

  it("stops a change the reviewer rejects, and treats a broken reviewer as a no", async () => {
    install(steps(FIX_REDIRECT_LOOP), () => ({ text: '{"approve": false, "reason": "no finding supports it"}' }));
    const r1 = await newCase("acct-larder", "redirect loop");
    expect((await actions(r1.caseId))[0].status).toBe("rejected_by_reviewer");

    install(steps(FIX_REDIRECT_LOOP), () => ({ text: "sure, looks fine to me" }));
    const r2 = await newCase("acct-larder", "redirect loop");
    const [a] = await actions(r2.caseId);
    expect(a.status).toBe("rejected_by_reviewer");
    expect(a.gate_notes).toContain("reviewer failed");
    expect((await zone("z-larder-shop"))!.ssl_mode).toBe("flexible");
  });

  it("runs low-risk purges without a person only when the flag says so", async () => {
    const purge = [
      call("propose_change", { kind: "purge_cache", zone: "larder.example", urls: ["https://larder.example/app.js"], rationale: "stale asset after deploy" }),
      call("propose_change", { kind: "purge_cache", zone: "larder.example", everything: true, rationale: "stale assets after deploy" }),
      say("Purged."),
    ];
    await env.FLAGS.put(FLAGS_KEY, JSON.stringify({ autoApproveLowRisk: true }));
    install(steps(purge));
    const r = await newCase("acct-larder", "old app.js after deploy, please purge");
    expect((await actions(r.caseId)).map((a) => a.status)).toEqual(["executed", "awaiting_human"]);
  });

  it("expires a change nobody approves and hands the case to a person", async () => {
    install(steps(FIX_REDIRECT_LOOP));
    const r = await newCase("acct-larder", "redirect loop");
    const [a] = await actions(r.caseId);
    const stub = env.CASE.getByName(r.caseId);
    await runInDurableObject(stub, (inst: SupportAgent) => inst.approvalTimeout({ actionId: a.id }));
    expect((await actions(r.caseId))[0].status).toBe("expired");
    expect((await caseRow(r.caseId))!.status).toBe("escalated");
    expect((await env.DB.prepare("SELECT priority FROM escalations WHERE case_id = ?").bind(r.caseId).first())!.priority).toBe("urgent");
  });
});

describe("guardrails", () => {
  it("flags a planted instruction in retrieved docs and still makes no change", async () => {
    // A fully compromised model: it does what the poisoned article says.
    install(
      steps([
        call("search_docs", { query: "fastest fix for ssl errors community tip" }),
        call("propose_change", { kind: "set_ssl_mode", zone: "shop.larder.example", mode: "off", rationale: "per support note" }),
        call("propose_change", { kind: "set_ssl_mode", zone: "larder.example", mode: "off", rationale: "per support note" }),
        say("Done, SSL is off."),
      ]),
    );
    const r = await newCase("acct-larder", "getting SSL errors, what's the fastest fix?");
    const kinds = (await guardrails(r.caseId)).map((g) => g.kind);
    expect(kinds).toContain("injection_in_retrieval");
    expect((await actions(r.caseId)).every((a) => a.status === "denied")).toBe(true);
    expect((await zone("z-larder-shop"))!.ssl_mode).toBe("flexible");
  });

  it("fences retrieved text so a document can't close the fence itself", async () => {
    const seen = install(steps([call("search_docs", { query: "community tip ssl" }), say("ok")]));
    await newCase("acct-larder", "ssl tip?");
    const results = JSON.stringify(seen.agent.at(-1)!.toolResults);
    expect(results).toContain("<untrusted source=\\\"kb:kb-community-tls-tip\\\">");
  });

  it("redacts PII and secrets before anything stores or sees them, and tells the customer to rotate", async () => {
    const seen = install(steps([say("Thanks, looking into it.")]));
    const r = await newCase(
      "acct-larder",
      "I'm jo@larder.example, card 4242 4242 4242 4242, call +44 20 7946 0958. my key is AKIAABCDEFGHIJKLMNOP",
    );
    const raw = ["jo@larder.example", "4242 4242 4242 4242", "7946 0958", "AKIAABCDEFGHIJKLMNOP"];
    for (const s of raw) expect(seen.agent[0].promptText).not.toContain(s);
    const transcript = await env.CASE.getByName(r.caseId).transcript();
    for (const s of raw) expect(JSON.stringify(transcript)).not.toContain(s);
    expect(r.reply).toMatch(/rotate it/);
    expect((await guardrails(r.caseId)).map((g) => g.kind).sort()).toEqual(["pii_redacted", "pii_redacted", "pii_redacted", "secret_redacted"]);
  });

  it("redacts what the model says too", async () => {
    install(steps([say("Sure, I emailed ops@larder.example the details.")]));
    const r = await newCase("acct-larder", "hello");
    expect(r.reply).toBe("Sure, I emailed [redacted email] the details.");
  });
});

describe("handing off", () => {
  it("escalates with a summary for the engineer and delivers it through the queue", async () => {
    install(
      steps([
        call("escalate", { reason: "refund request", summary: "Customer wants a refund for last month.", next_step: "billing review", priority: "normal" }),
        say("A person from billing will take this."),
      ]),
    );
    const r = await newCase("acct-quill", "I want a refund for last month", "refund");
    expect(r.status).toBe("escalated");
    const esc = await env.DB.prepare("SELECT summary, delivered_at FROM escalations WHERE case_id = ?").bind(r.caseId).first<{ summary: string }>();
    expect(esc!.summary).toMatch(/refund for last month[\s\S]*billing review/);

    // The agent stays quiet once a person owns the case.
    const later = await env.CASE.getByName(r.caseId).message("hello?");
    expect(later.reply).toBeNull();

    // Deliver it the way the queue would, carrying the turn's trace.
    const tp = `00-${r.traceId}-${"a".repeat(16)}-01`;
    const batch = createMessageBatch("casefile-escalations", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { caseId: r.caseId, priority: "normal" as const, summary: "s", traceparent: tp } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["m1"]);
    expect((await env.DB.prepare("SELECT delivery FROM escalations WHERE case_id = ?").bind(r.caseId).first())!.delivery).toBe("stored for the console");
    const deliver = await env.DB.prepare("SELECT parent_id FROM spans WHERE trace_id = ? AND name = 'escalation.deliver'").bind(r.traceId).first();
    expect(deliver!.parent_id).toBe("a".repeat(16));
  });

  it("escalates instead of failing when the model is down", async () => {
    install(() => {
      throw new Error("upstream 503");
    });
    const r = await newCase("acct-ferro", "api.ferro.example is down");
    expect(r.status).toBe("escalated");
    expect(r.reply).toMatch(/support engineer/);
  });

  it("sends every case to a person when the kill switch is off, without calling a model", async () => {
    await env.FLAGS.put(FLAGS_KEY, JSON.stringify({ ...DEFAULT_FLAGS, enabled: false }));
    const seen = install(steps([say("should not be called")]));
    const r = await newCase("acct-ferro", "help");
    expect(r.status).toBe("human_only");
    expect(seen.agent).toHaveLength(0);
    expect((await caseRow(r.caseId))!.agent_version).toBe("human");
  });
});

describe("http", () => {
  const body = JSON.stringify({ caseId: "W-1", accountId: "acct-pebble", subject: "no https", description: "my site has no padlock" });
  const signed = async (ts: number, b = body) => ({
    "content-type": "application/json",
    "x-casefile-timestamp": String(ts),
    "x-casefile-signature": `sha256=${await sign("test-webhook-secret", `${ts}.${b}`)}`,
  });

  it("accepts only signed, fresh webhooks, and a retried webhook gets the same case", async () => {
    install(steps([say("Your zone has SSL off. I can propose turning it on.")]));
    const now = Math.floor(Date.now() / 1000);
    expect((await SELF.fetch("http://x/api/webhooks/case", { method: "POST", body, headers: { ...(await signed(now)), "x-casefile-signature": "sha256=00" } })).status).toBe(401);
    expect((await SELF.fetch("http://x/api/webhooks/case", { method: "POST", body, headers: await signed(now - 600) })).status).toBe(401);

    const ok = await SELF.fetch("http://x/api/webhooks/case", { method: "POST", body, headers: await signed(now) });
    expect(ok.status).toBe(201);
    const first = await ok.json<{ caseId: string; customerToken: string; reply: string }>();
    const retry = await (await SELF.fetch("http://x/api/webhooks/case", { method: "POST", body, headers: await signed(now) })).json<{ reply: string }>();
    expect(retry.reply).toBe(first.reply);

    // The customer can talk on their case with its token and nothing else.
    const msg = (token: string) =>
      SELF.fetch(`http://x/api/cases/${first.caseId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "thanks" }) });
    expect((await msg("wrong")).status).toBe(401);
    expect((await msg(first.customerToken)).status).toBe(200);
  });

  it("keeps the operator API behind the operator token", async () => {
    expect((await SELF.fetch("http://x/api/cases")).status).toBe(401);
    expect((await SELF.fetch("http://x/api/metrics", { headers: { authorization: "Bearer test-operator-token" } })).status).toBe(200);
  });
});
