import { tool } from "ai";
import { z } from "zod";
import type { Env } from "./env";
import type { AgentFlags } from "./flags";
import { fence, injectionSignals } from "./guard";
import { cost } from "./model";
import { check, type ChangeKind } from "./policy";
import type { Recall } from "./recall";
import { review } from "./reviewer";
import type { Trace } from "./trace";
import { diagnose, execute, findZone, mintCredential, type ActionRow } from "./zones";

// What the agent can do in one turn. Every tool is scoped to the case's
// account through `t.accountId`, which comes from the signed webhook. No
// tool takes an account id as input, so there's nothing for a prompt to
// redirect.

export interface Outcome {
  escalate: { reason: string; summary: string; nextStep: string; priority: "normal" | "urgent" } | null;
  resolve: { summary: string } | null;
  awaiting: string[];
  executed: string[];
}

export interface TurnContext {
  env: Env;
  caseId: string;
  accountId: string;
  flags: AgentFlags;
  recall: Recall;
  trace: Trace;
  customerMessages: string[];
  outcome: Outcome;
  guardrail(kind: string, detail: string): Promise<void>;
}

export const TOOL_NAMES = ["get_account", "run_diagnostics", "search_docs", "similar_cases", "propose_change", "escalate", "resolve"] as const;

export function caseTools(t: TurnContext) {
  const db = t.env.DB;
  const traced = <I, O>(name: string, fn: (input: I) => Promise<O>) => (input: I) =>
    t.trace.span(`tool.${name}`, { tool: name, input: JSON.stringify(input).slice(0, 500) }, () => fn(input));

  // Models send tool calls in parallel. Proposals are numbered and capped
  // per case, so they run one at a time.
  let proposals: Promise<unknown> = Promise.resolve();
  const oneAtATime = <I, O>(fn: (input: I) => Promise<O>) => (input: I): Promise<O> => {
    const run = proposals.then(() => fn(input));
    proposals = run.catch(() => undefined);
    return run;
  };

  // Retrieved text is the main way an injection reaches the model. It is
  // checked, logged and fenced; it is never trusted.
  const untrusted = async (source: string, text: string) => {
    const signals = injectionSignals(text);
    if (signals.length) await t.guardrail("injection_in_retrieval", `${source}: ${signals.join(", ")}`);
    return fence(source, text);
  };

  return {
    get_account: tool({
      description: "The case's account: plan, and the zones (sites) on it.",
      inputSchema: z.object({}),
      execute: traced("get_account", async () => {
        const [acct, zones] = await db.batch([
          db.prepare("SELECT id, name, plan FROM accounts WHERE id = ?").bind(t.accountId),
          db.prepare("SELECT id, name, ssl_mode FROM zones WHERE account_id = ? ORDER BY name").bind(t.accountId),
        ]);
        return { account: acct.results[0] ?? null, zones: zones.results };
      }),
    }),

    run_diagnostics: tool({
      description: "Check one zone on this account: SSL mode, origin reachability, certificate, error rate. Returns findings with whether each is fixable from our side.",
      inputSchema: z.object({ zone: z.string().min(1).max(253).describe("zone name like example.com, or its id") }),
      execute: traced("run_diagnostics", async ({ zone }: { zone: string }) => {
        const z = await findZone(db, t.accountId, zone);
        if (!z) return { error: `${zone} is not a zone on this account` };
        return {
          zone: z.name,
          ssl_mode: z.ssl_mode,
          origin_up: !!z.origin_up,
          origin_cert_valid: !!z.origin_cert_valid,
          error_rate_5xx: z.error_rate_5xx,
          findings: diagnose(z),
        };
      }),
    }),

    search_docs: tool({
      description: "Search the knowledge base. Returns the closest articles.",
      inputSchema: z.object({ query: z.string().min(2).max(300) }),
      execute: traced("search_docs", async ({ query }: { query: string }) => {
        const hits = await t.recall.search("kb", query, 3);
        return Promise.all(hits.map(async (h) => ({ title: h.title, score: Number(h.score.toFixed(3)), content: await untrusted(`kb:${h.id}`, h.text) })));
      }),
    }),

    similar_cases: tool({
      description: "Find resolved cases similar to this one and how they were resolved.",
      inputSchema: z.object({ query: z.string().min(2).max(300) }),
      execute: traced("similar_cases", async ({ query }: { query: string }) => {
        const hits = (await t.recall.search("cases", query, 3)).filter((h) => h.id !== t.caseId);
        return Promise.all(hits.map(async (h) => ({ case: h.id, subject: h.title, resolution: await untrusted(`case:${h.id}`, h.text) })));
      }),
    }),

    propose_change: tool({
      description:
        "Ask for a change to a zone on this account. It is checked by policy, then a reviewer, then a person approves it. It does not run immediately.",
      inputSchema: z.object({
        kind: z.enum(["set_ssl_mode", "purge_cache"]),
        zone: z.string().min(1).max(253),
        mode: z.enum(["off", "flexible", "full", "strict"]).optional().describe("for set_ssl_mode"),
        urls: z.array(z.string()).max(30).optional().describe("for purge_cache: full URLs to purge"),
        everything: z.boolean().optional().describe("for purge_cache: purge the whole zone"),
        rationale: z.string().min(5).max(400).describe("which diagnostic finding this fixes"),
      }),
      execute: oneAtATime(traced("propose_change", async (input: { kind: ChangeKind; zone: string; mode?: string; urls?: string[]; everything?: boolean; rationale: string }) => {
        const z = await findZone(db, t.accountId, input.zone);
        const n = (await db.prepare("SELECT count(*) AS n FROM actions WHERE case_id = ?").bind(t.caseId).first<{ n: number }>())!.n;
        const id = `A-${t.caseId}-${n + 1}`;
        const raw = input.kind === "set_ssl_mode" ? { mode: input.mode } : { urls: input.urls, everything: input.everything };
        const verdict = check(input.kind, raw, z, { accountId: t.accountId, actionsSoFar: n });
        const notes = [`policy: ${verdict.allowed ? "allowed" : "denied"}: ${verdict.reasons.join("; ")}`];
        const insert = (status: string, extra: string[] = []) =>
          db
            .prepare("INSERT INTO actions (id, case_id, kind, zone_id, params, rationale, risk, status, gate_notes, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(id, t.caseId, input.kind, z?.id ?? input.zone.slice(0, 253), JSON.stringify(verdict.params ?? raw), input.rationale, verdict.risk, status, JSON.stringify([...notes, ...extra]), Date.now())
            .run();

        if (!verdict.allowed || !z) {
          await insert("denied");
          await t.guardrail("policy_denied", `${input.kind} on ${input.zone}: ${verdict.reasons.at(-1)}`);
          return { status: "denied", reason: verdict.reasons.at(-1) };
        }

        const r = await t.trace.span("reviewer", { model: t.flags.reviewerModel }, () =>
          review(t.env, t.flags.reviewerModel, t.caseId, {
            customerMessages: t.customerMessages,
            zone: z.name,
            findings: diagnose(z),
            kind: input.kind,
            params: verdict.params,
            rationale: input.rationale,
          }),
        );
        await db
          .prepare("INSERT OR REPLACE INTO usage VALUES (?, ?, ?, 'reviewer', ?, ?, ?, ?)")
          .bind(t.caseId, t.trace.traceId, t.flags.reviewerModel, r.usage.inputTokens ?? 0, r.usage.outputTokens ?? 0, cost(t.flags.reviewerModel, r.usage), Date.now())
          .run();
        notes.push(`reviewer: ${r.review.approve ? "approved" : "rejected"}: ${r.review.reason}`);
        if (!r.review.approve) {
          await insert("rejected_by_reviewer");
          return { status: "rejected_by_reviewer", reason: r.review.reason };
        }

        if (verdict.risk === "low" && t.flags.autoApproveLowRisk) {
          await insert("approved", ["human: skipped, low risk and autoApproveLowRisk is on"]);
          const action: ActionRow = { id, case_id: t.caseId, kind: input.kind, zone_id: z.id, params: JSON.stringify(verdict.params) };
          const result = await execute(db, t.env.ACTION_SIGNING_KEY, action, await mintCredential(t.env.ACTION_SIGNING_KEY, id, z.id));
          await db.prepare("UPDATE actions SET status = 'executed', decided_by = 'policy', decided_at = ?, result = ? WHERE id = ?").bind(Date.now(), result, id).run();
          t.outcome.executed.push(id);
          return { status: "executed", result };
        }

        await insert("awaiting_human");
        t.outcome.awaiting.push(id);
        return { status: "awaiting_approval", action: id, note: "Tell the customer a support engineer has to approve this before it runs." };
      })),
    }),

    escalate: tool({
      description: "Hand the case to a person. Write the summary for the engineer who picks it up.",
      inputSchema: z.object({
        reason: z.string().min(3).max(300),
        summary: z.string().min(10).max(1200).describe("what the customer needs, what you checked, what you found"),
        next_step: z.string().max(400).describe("what you would do next"),
        priority: z.enum(["normal", "urgent"]),
      }),
      execute: traced("escalate", async (i: { reason: string; summary: string; next_step: string; priority: "normal" | "urgent" }) => {
        t.outcome.escalate = { reason: i.reason, summary: i.summary, nextStep: i.next_step, priority: i.priority };
        return { status: "escalated", note: "Tell the customer a support engineer will take it from here." };
      }),
    }),

    resolve: tool({
      description: "Close the case as solved. The summary is stored so similar cases can find it later.",
      inputSchema: z.object({ summary: z.string().min(10).max(800).describe("the cause and the fix, without customer details") }),
      execute: traced("resolve", async ({ summary }: { summary: string }) => {
        t.outcome.resolve = { summary };
        return { status: "resolved" };
      }),
    }),
  };
}
