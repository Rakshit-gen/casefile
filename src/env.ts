import type { SupportAgent } from "./agent";

export interface Env {
  DB: D1Database;
  CASE: DurableObjectNamespace<SupportAgent>;
  FLAGS: KVNamespace;
  VECTORS?: VectorizeIndex;
  AI: Ai;
  ESCALATIONS: Queue<EscalationMessage>;
  AI_GATEWAY_ID: string;
  APPROVAL_SLA_SECONDS: string;
  WEBHOOK_SECRET: string;
  OPERATOR_TOKEN: string;
  ACTION_SIGNING_KEY: string;
  ESCALATION_WEBHOOK_URL?: string;
  // "keyword" searches D1 directly instead of Vectorize. Tests use it, and
  // so does local dev without a Vectorize index.
  RECALL?: string;
}

export interface EscalationMessage {
  caseId: string;
  priority: "normal" | "urgent";
  summary: string;
  traceparent: string;
}
