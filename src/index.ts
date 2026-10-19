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
