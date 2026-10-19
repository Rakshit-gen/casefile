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
