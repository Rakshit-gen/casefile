import { getAgentByName } from "agents";
import { z } from "zod";
import { SupportAgent } from "./agent";
import type { Env, EscalationMessage } from "./env";
import { AgentFlags, DEFAULT_FLAGS, FLAGS_KEY, readFlags } from "./flags";
import { recallFor } from "./recall";
import { ARTICLES, seedStatements } from "./seed";
import { Trace } from "./trace";
import { sameString, sign } from "./zones";

export { SupportAgent };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CaseWebhook = z.object({
  caseId: z.string().regex(/^[A-Za-z0-9-]{3,64}$/).optional(),
  accountId: z.string().min(1).max(64),
  subject: z.string().min(1).max(300),
  description: z.string().min(1).max(4000),
  channel: z.enum(["email", "web", "chat", "api"]).default("web"),
});
const Message = z.object({ text: z.string().min(1).max(4000) });
const Decision = z.object({ approved: z.boolean(), by: z.string().min(1).max(60) });

// Customers get a token per case; it is an HMAC of the case id, so the
// worker can check it without storing it.
const customerToken = (env: Env, caseId: string) => sign(env.WEBHOOK_SECRET, `customer|${caseId}`);

async function requireOperator(req: Request, env: Env) {
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.OPERATOR_TOKEN || !sameString(got, env.OPERATOR_TOKEN)) throw new HttpError(401, "operator token required");
}

async function requireCustomer(req: Request, env: Env, caseId: string) {
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!sameString(got, await customerToken(env, caseId))) throw new HttpError(401, "case token required");
}

// Signature over "<timestamp>.<body>", like most case-system webhooks, with
// a five minute window so a captured request can't be replayed later.
async function verifyWebhook(req: Request, env: Env, body: string) {
  const ts = Number(req.headers.get("x-casefile-timestamp"));
  const sig = req.headers.get("x-casefile-signature")?.replace(/^sha256=/, "") ?? "";
  if (!ts || Math.abs(Date.now() - ts * 1000) > 300_000) throw new HttpError(401, "stale or missing timestamp");
  if (!sameString(sig, await sign(env.WEBHOOK_SECRET, `${ts}.${body}`))) throw new HttpError(401, "bad signature");
}

async function parse<T>(req: Request, schema: z.ZodType<T>, raw?: string): Promise<T> {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? (await req.text()));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const agent = (env: Env, caseId: string) => getAgentByName<Env, SupportAgent>(env.CASE, caseId);

export async function openCase(env: Env, input: z.infer<typeof CaseWebhook>) {
  const caseId = input.caseId ?? `C-${crypto.randomUUID().slice(0, 8)}`;
  const r = await (await agent(env, caseId)).open({ ...input, caseId });
  return { ...r, customerToken: await customerToken(env, caseId) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "POST" && path === "/api/webhooks/case") {
        const raw = await req.text();
        await verifyWebhook(req, env, raw);
        return json(await openCase(env, await parse(req, CaseWebhook, raw)), 201);
      }

      let m = path.match(/^\/api\/cases\/([\w-]+)\/(messages|transcript)$/);
      if (m) {
        await requireCustomer(req, env, m[1]);
        const stub = await agent(env, m[1]);
        if (req.method === "POST" && m[2] === "messages") return json(await stub.message((await parse(req, Message)).text));
        if (req.method === "GET" && m[2] === "transcript") return json((await stub.transcript()).filter((t) => t.role !== "note"));
      }

      if (!path.startsWith("/api/")) return new Response("not found", { status: 404 });
      await requireOperator(req, env);

      if (req.method === "POST" && path === "/api/seed") return json(await seed(env));
      // Opens a case without the webhook secret, for the console's demo button.
      if (req.method === "POST" && path === "/api/demo/case") return json(await openCase(env, await parse(req, CaseWebhook)), 201);
      if (req.method === "GET" && path === "/api/cases") return json(await listCases(env));
      if (req.method === "GET" && path === "/api/metrics") return json(await metrics(env));
      if (req.method === "GET" && path === "/api/flags") return json(await readFlags(env.FLAGS));
      if (req.method === "PUT" && path === "/api/flags") {
        const f = await parse(req, AgentFlags.partial());
        const next = { ...(await readFlags(env.FLAGS)), ...f };
        await env.FLAGS.put(FLAGS_KEY, JSON.stringify(next));
        return json(next);
      }

      m = path.match(/^\/api\/cases\/([\w-]+)$/);
      if (req.method === "GET" && m) return json(await caseDetail(env, m[1]));

      m = path.match(/^\/api\/actions\/([\w-]+)\/decision$/);
      if (req.method === "POST" && m) {
        const d = await parse(req, Decision);
        const a = await env.DB.prepare("SELECT case_id FROM actions WHERE id = ?").bind(m[1]).first<{ case_id: string }>();
        if (!a) throw new HttpError(404, `no action ${m[1]}`);
        return json(await (await agent(env, a.case_id)).decide(m[1], d.approved, d.by));
      }

      return bad("not found", 404);
    } catch (e) {
      if (e instanceof HttpError) return bad(e.message, e.status);
      const msg = e instanceof Error ? e.message : String(e);
      if (/^no (account|action|such case)/.test(msg)) return bad(msg, 404);
      if (/ is already /.test(msg)) return bad(msg, 409);
      console.error(JSON.stringify({ level: "error", name: "http.error", path, error: msg }));
      return bad("internal error", 500);
    }
  },

  // Escalations leave the agent through a queue, so a slow or failing
  // ticketing webhook never holds up a customer's reply. The message
  // carries the trace id of the turn that escalated.
  async queue(batch: MessageBatch<EscalationMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const m = msg.body;
      const trace = new Trace(m.caseId, "escalation.deliver", m.traceparent);
      try {
        let delivery = "stored for the console";
        if (env.ESCALATION_WEBHOOK_URL) {
          const body = JSON.stringify({ caseId: m.caseId, priority: m.priority, summary: m.summary });
          const ts = Math.floor(Date.now() / 1000);
          const res = await trace.span("webhook.post", { attempt: msg.attempts }, async () =>
            fetch(env.ESCALATION_WEBHOOK_URL!, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-casefile-timestamp": String(ts),
                "x-casefile-signature": `sha256=${await sign(env.WEBHOOK_SECRET, `${ts}.${body}`)}`,
                traceparent: trace.traceparent(),
              },
              body,
            }),
          );
          if (!res.ok) throw new Error(`webhook answered ${res.status}`);
          delivery = `webhook ${res.status}`;
        }
        await env.DB.prepare("UPDATE escalations SET delivered_at = ?, delivery = ? WHERE case_id = ?").bind(Date.now(), delivery, m.caseId).run();
        await trace.end(env.DB, { attempts: msg.attempts, delivery });
        msg.ack();
      } catch (e) {
        await trace.end(env.DB, { attempts: msg.attempts, error: e instanceof Error ? e.message : String(e) }, "error");
        msg.retry({ delaySeconds: Math.min(300, 2 ** msg.attempts * 5) });
      }
    }
  },
} satisfies ExportedHandler<Env, EscalationMessage>;

async function seed(env: Env) {
  await env.DB.batch(seedStatements(env.DB));
  const indexed = await recallFor(env).index(
    "kb",
    ARTICLES.map((a) => ({ id: a.id, title: a.title, text: a.body })),
  );
  if ((await env.FLAGS.get(FLAGS_KEY)) === null) await env.FLAGS.put(FLAGS_KEY, JSON.stringify(DEFAULT_FLAGS));
  return { articles: indexed };
}

async function listCases(env: Env) {
  const r = await env.DB.prepare(
    `SELECT c.*, a.name AS account_name,
       (SELECT count(*) FROM actions x WHERE x.case_id = c.id AND x.status = 'awaiting_human') AS awaiting
     FROM cases c JOIN accounts a ON a.id = c.account_id ORDER BY c.opened_at DESC LIMIT 100`,
  ).all();
  return r.results;
}

export async function caseDetail(env: Env, id: string) {
  const c = await env.DB.prepare("SELECT c.*, a.name AS account_name, a.plan FROM cases c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?").bind(id).first();
  if (!c) throw new HttpError(404, `no case ${id}`);
  const [actions, spans, guardrails, usage, escalation] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM actions WHERE case_id = ? ORDER BY requested_at").bind(id),
    env.DB.prepare("SELECT * FROM spans WHERE case_id = ? ORDER BY started_at, duration_ms DESC LIMIT 400").bind(id),
    env.DB.prepare("SELECT * FROM guardrail_events WHERE case_id = ? ORDER BY at").bind(id),
    env.DB.prepare("SELECT * FROM usage WHERE case_id = ? ORDER BY at").bind(id),
    env.DB.prepare("SELECT * FROM escalations WHERE case_id = ?").bind(id),
  ]);
  return {
    case: c,
    transcript: await (await agent(env, id)).transcript(),
    actions: (actions.results as Record<string, unknown>[]).map((a) => ({ ...a, gate_notes: JSON.parse(String(a.gate_notes)) })),
    spans: (spans.results as Record<string, unknown>[]).map((s) => ({ ...s, attrs: JSON.parse(String(s.attrs)) })),
    guardrails: guardrails.results,
    usage: usage.results,
    escalation: escalation.results[0] ?? null,
  };
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function metrics(env: Env) {
  const since = Date.now() - 7 * 86_400_000;
  const [cases, ttfr, cost, actions, guards, steps, tools] = await env.DB.batch([
    env.DB.prepare("SELECT status, count(*) AS n FROM cases WHERE opened_at > ? GROUP BY status").bind(since),
    env.DB.prepare("SELECT first_response_at - opened_at AS ms FROM cases WHERE opened_at > ? AND first_response_at IS NOT NULL AND agent_version != 'human'").bind(since),
    env.DB.prepare(
      "SELECT count(DISTINCT u.case_id) AS cases, coalesce(sum(u.cost_usd), 0) AS usd, coalesce(sum(u.input_tokens), 0) AS input, coalesce(sum(u.output_tokens), 0) AS output FROM usage u WHERE u.at > ?",
    ).bind(since),
    env.DB.prepare("SELECT status, count(*) AS n FROM actions WHERE requested_at > ? GROUP BY status").bind(since),
    env.DB.prepare("SELECT kind, count(*) AS n FROM guardrail_events WHERE at > ? GROUP BY kind").bind(since),
    env.DB.prepare("SELECT duration_ms AS ms FROM spans WHERE name = 'agent.step' AND started_at > ? ORDER BY started_at DESC LIMIT 2000").bind(since),
    env.DB.prepare("SELECT name, count(*) AS n, sum(status = 'error') AS errors, avg(duration_ms) AS avg_ms FROM spans WHERE name LIKE 'tool.%' AND started_at > ? GROUP BY name").bind(since),
  ]);
  const byStatus = Object.fromEntries((cases.results as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const total = Object.values(byStatus).reduce((a: number, b) => a + (b as number), 0);
  const firsts = (ttfr.results as { ms: number }[]).map((r) => r.ms);
  const stepMs = (steps.results as { ms: number }[]).map((r) => r.ms);
  const c = cost.results[0] as { cases: number; usd: number; input: number; output: number };
  return {
    window: "7d",
    cases: { total, byStatus },
    resolvedByAgent: total ? (byStatus.resolved ?? 0) / total : null,
    escalationRate: total ? ((byStatus.escalated ?? 0) + (byStatus.human_only ?? 0)) / total : null,
    firstResponseMs: { p50: pct(firsts, 50), p95: pct(firsts, 95), n: firsts.length },
    stepLatencyMs: { p50: pct(stepMs, 50), p95: pct(stepMs, 95), n: stepMs.length },
    costPerCaseUsd: c.cases ? c.usd / c.cases : null,
    tokens: { input: c.input, output: c.output },
    actions: Object.fromEntries((actions.results as { status: string; n: number }[]).map((r) => [r.status, r.n])),
    guardrails: Object.fromEntries((guards.results as { kind: string; n: number }[]).map((r) => [r.kind, r.n])),
    tools: tools.results,
  };
}
