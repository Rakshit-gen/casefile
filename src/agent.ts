import { Agent } from "agents";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import type { Env } from "./env";
import { inRollout, readFlags, type AgentFlags } from "./flags";
import { injectionSignals, redact } from "./guard";
import { cost, model } from "./model";
import { PROMPTS } from "./prompts";
import { recallFor } from "./recall";
import { caseTools, type Outcome } from "./tools";
import { Trace } from "./trace";
import { execute, mintCredential, type ActionRow } from "./zones";

// One agent per support case. Its SQLite holds the conversation (the
// session memory the model sees each turn) and case notes from the
// system; D1 holds what the console and metrics need across cases.

export type CaseStatus = "open" | "waiting_on_approval" | "escalated" | "resolved" | "human_only";

export interface CaseState {
  caseId: string;
  accountId: string;
  plan: string;
  subject: string;
  status: CaseStatus;
  agentVersion: string;
}

export interface CaseInit {
  caseId: string;
  accountId: string;
  subject: string;
  description: string;
  channel: string;
}

export interface TurnResult {
  caseId: string;
  status: CaseStatus;
  reply: string | null;
  traceId: string;
}

type Role = "customer" | "agent" | "note";

const HISTORY_TURNS = 20;

const HANDOFF = "I've passed this to a support engineer with everything we've found so far. They'll reply here.";

export class SupportAgent extends Agent<Env, CaseState> {
  initialState: CaseState = { caseId: "", accountId: "", plan: "", subject: "", status: "open", agentVersion: "" };
  private lock: Promise<unknown> = Promise.resolve();

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, trace_id TEXT, at INTEGER NOT NULL)`;
  }

  // Model calls are network I/O, which lets another request into the
  // object. Turns and decisions on one case run one at a time.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private say(role: Role, content: string, traceId: string | null) {
    this.sql`INSERT INTO messages (role, content, trace_id, at) VALUES (${role}, ${content}, ${traceId}, ${Date.now()})`;
  }

  transcript(): { role: Role; content: string; trace_id: string | null; at: number }[] {
    return this.sql`SELECT role, content, trace_id, at FROM messages ORDER BY id`;
  }

  private history(): ModelMessage[] {
    const rows = this.sql<{ role: Role; content: string }>`
      SELECT role, content FROM (SELECT * FROM messages WHERE role != 'note' ORDER BY id DESC LIMIT ${HISTORY_TURNS}) ORDER BY id`;
    return rows.map((r) => (r.role === "customer" ? { role: "user", content: r.content } : { role: "assistant", content: r.content }));
  }

  private notes(): string[] {
    return this.sql<{ content: string }>`SELECT content FROM messages WHERE role = 'note' ORDER BY id DESC LIMIT 10`.map((r) => r.content).reverse();
  }

  private customerMessages(): string[] {
    return this.sql<{ content: string }>`SELECT content FROM messages WHERE role = 'customer' ORDER BY id`.map((r) => r.content);
  }

  private async guardrail(trace: Trace | null, kind: string, detail: string) {
    await this.env.DB.prepare("INSERT INTO guardrail_events (case_id, trace_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)")
      .bind(this.state.caseId, trace?.traceId ?? null, kind, detail.slice(0, 300), Date.now())
      .run();
  }

  private async setStatus(status: CaseStatus, extra: { summary?: string } = {}) {
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE cases SET status = ?,
         resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
         escalated_at = CASE WHEN ? IN ('escalated', 'human_only') THEN coalesce(escalated_at, ?) ELSE escalated_at END,
         summary = coalesce(?, summary)
       WHERE id = ?`,
    )
      .bind(status, status, now, status, now, extra.summary ?? null, this.state.caseId)
      .run();
    this.setState({ ...this.state, status });
  }

  private async escalate(trace: Trace, e: NonNullable<Outcome["escalate"]>, status: CaseStatus = "escalated") {
    const summary = redact(`${e.reason}\n\n${e.summary}\n\nSuggested next step: ${e.nextStep}`).text;
    await this.env.DB.prepare("INSERT OR REPLACE INTO escalations (case_id, priority, summary, queued_at) VALUES (?, ?, ?, ?)")
      .bind(this.state.caseId, e.priority, summary, Date.now())
      .run();
    await this.env.ESCALATIONS.send({ caseId: this.state.caseId, priority: e.priority, summary, traceparent: trace.traceparent() });
    this.say("note", `Escalated to a person (${e.priority}): ${e.reason}`, trace.traceId);
    await this.setStatus(status);
  }
}
