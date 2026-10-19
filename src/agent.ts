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

  // Called once per case by the webhook. A retried webhook gets the same
  // case back instead of a second one.
  open(init: CaseInit): Promise<TurnResult> {
    return this.serial(async () => {
      if (this.state.caseId) {
        const last = this.sql<{ content: string }>`SELECT content FROM messages WHERE role = 'agent' ORDER BY id DESC LIMIT 1`[0];
        return { caseId: this.state.caseId, status: this.state.status, reply: last?.content ?? null, traceId: "" };
      }
      const acct = await this.env.DB.prepare("SELECT plan FROM accounts WHERE id = ?").bind(init.accountId).first<{ plan: string }>();
      if (!acct) throw new Error(`no account ${init.accountId}`);
      const flags = await readFlags(this.env.FLAGS);
      const subject = redact(init.subject).text.slice(0, 200);
      const live = inRollout(flags, init.accountId);
      const agentVersion = live ? `${flags.model}#${flags.promptVersion}` : "human";
      this.setState({ caseId: init.caseId, accountId: init.accountId, plan: acct.plan, subject, status: "open", agentVersion });
      await this.env.DB.prepare("INSERT OR IGNORE INTO cases (id, account_id, subject, channel, status, agent_version, opened_at) VALUES (?, ?, ?, ?, 'open', ?, ?)")
        .bind(init.caseId, init.accountId, subject, init.channel, agentVersion, Date.now())
        .run();

      if (!live) {
        // The kill switch, or an account outside the rollout: straight to a person.
        const trace = new Trace(init.caseId, "case.human_only");
        this.say("customer", redact(init.description).text, trace.traceId);
        await this.escalate(trace, { reason: "agent is off for this account", summary: subject, nextStep: "handle as a normal case", priority: "normal" }, "human_only");
        this.say("agent", "Thanks, a support engineer will pick this up and reply here.", trace.traceId);
        await this.env.DB.prepare("UPDATE cases SET first_response_at = ? WHERE id = ?").bind(Date.now(), init.caseId).run();
        await trace.end(this.env.DB, { case: init.caseId, flags: "off" });
        return { caseId: init.caseId, status: "human_only", reply: "Thanks, a support engineer will pick this up and reply here.", traceId: trace.traceId };
      }
      return this.turn(init.description, flags);
    });
  }

  message(text: string): Promise<TurnResult> {
    return this.serial(async () => {
      if (!this.state.caseId) throw new Error("no such case");
      return this.turn(text, await readFlags(this.env.FLAGS));
    });
  }

  private async turn(text: string, flags: AgentFlags): Promise<TurnResult> {
    const env = this.env;
    const caseId = this.state.caseId;
    const trace = new Trace(caseId, "turn");

    const input = await trace.span("guard.input", {}, async () => {
      const r = redact(text);
      return { ...r, injection: injectionSignals(r.text) };
    });
    for (const f of input.findings) await this.guardrail(trace, f.kind === "secret" ? "secret_redacted" : "pii_redacted", f.label);
    if (input.injection.length) await this.guardrail(trace, "injection_in_message", input.injection.join(", "));
    this.say("customer", input.text, trace.traceId);

    // Once a person owns the case the agent stops talking.
    if (this.state.status === "escalated" || this.state.status === "human_only") {
      await trace.end(env.DB, { case: caseId, skipped: this.state.status });
      return { caseId, status: this.state.status, reply: null, traceId: trace.traceId };
    }

    const outcome: Outcome = { escalate: null, resolve: null, awaiting: [], executed: [] };
    const tools = caseTools({
      env,
      caseId,
      accountId: this.state.accountId,
      flags,
      recall: recallFor(env),
      trace,
      customerMessages: this.customerMessages(),
      outcome,
      guardrail: (kind, detail) => this.guardrail(trace, kind, detail),
    });

    let reply: string;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stepStart = Date.now();
    try {
      const r = await generateText({
        model: model(env, flags.model, caseId),
        system: PROMPTS[flags.promptVersion]({ caseId, subject: this.state.subject, accountId: this.state.accountId, plan: this.state.plan, notes: this.notes() }),
        messages: this.history(),
        tools,
        stopWhen: stepCountIs(flags.maxSteps),
        maxRetries: 2,
        onStepStart: () => {
          stepStart = Date.now();
        },
        onStepFinish: (step) => {
          trace.record(
            "agent.step",
            {
              model: flags.model,
              input_tokens: step.usage.inputTokens ?? 0,
              output_tokens: step.usage.outputTokens ?? 0,
              finish: step.finishReason,
              tool_calls: step.toolCalls.map((c) => c.toolName).join(","),
            },
            stepStart,
            Date.now() - stepStart,
          );
        },
      });
      usage = { inputTokens: r.totalUsage.inputTokens ?? 0, outputTokens: r.totalUsage.outputTokens ?? 0 };
      reply = r.text.trim();
    } catch (e) {
      // A broken model is an escalation, not a dead chat.
      const msg = e instanceof Error ? e.message : String(e);
      trace.record("agent.error", { error: msg.slice(0, 300) }, stepStart, Date.now() - stepStart, "error");
      outcome.escalate ??= { reason: "the agent failed to answer", summary: `Model error: ${msg.slice(0, 200)}`, nextStep: "answer the customer", priority: "normal" };
      reply = "";
    }

    if (!reply) {
      reply = outcome.escalate
        ? HANDOFF
        : outcome.awaiting.length
          ? "I've proposed a fix. A support engineer has to approve it before it runs, and I'll update you here when it has."
          : "I couldn't finish working this out, so I've passed it to a support engineer.";
      if (!outcome.escalate && !outcome.awaiting.length) {
        outcome.escalate = { reason: "the agent ran out of steps", summary: this.state.subject, nextStep: "review the trace", priority: "normal" };
      }
    }

    const out = await trace.span("guard.output", {}, async () => redact(reply));
    for (const f of out.findings) await this.guardrail(trace, "output_redacted", f.label);
    reply = out.text;
    if (input.findings.some((f) => f.kind === "secret")) {
      reply += "\n\nYour message included what looks like a credential. I removed it from the case, but treat it as exposed and rotate it.";
    }
    this.say("agent", reply, trace.traceId);

    await env.DB.batch([
      env.DB.prepare("UPDATE cases SET first_response_at = coalesce(first_response_at, ?) WHERE id = ?").bind(Date.now(), caseId),
      env.DB.prepare("INSERT OR REPLACE INTO usage VALUES (?, ?, ?, 'agent', ?, ?, ?, ?)").bind(
        caseId, trace.traceId, flags.model, usage.inputTokens, usage.outputTokens, cost(flags.model, usage), Date.now(),
      ),
    ]);

    if (outcome.escalate) {
      await this.escalate(trace, outcome.escalate);
    } else if (outcome.resolve) {
      const summary = redact(outcome.resolve.summary).text;
      await this.setStatus("resolved", { summary });
      await recallFor(env).index("cases", [{ id: caseId, title: this.state.subject, text: summary }]);
    } else if (outcome.awaiting.length) {
      for (const id of outcome.awaiting) {
        this.say("note", `Change ${id} is waiting for a support engineer to approve it.`, trace.traceId);
        await this.schedule(Number(env.APPROVAL_SLA_SECONDS) || 1800, "approvalTimeout", { actionId: id });
      }
      await this.setStatus("waiting_on_approval");
    }

    await trace.end(env.DB, {
      case: caseId,
      status: this.state.status,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      prompt: flags.promptVersion,
    });
    return { caseId, status: this.state.status, reply, traceId: trace.traceId };
  }

  // The last gate: a person approves or rejects a proposed change. Only an
  // approval mints the one-minute credential the change runs with.
  decide(actionId: string, approved: boolean, by: string): Promise<{ status: string; result: string | null }> {
    return this.serial(async () => {
      const env = this.env;
      const a = await env.DB.prepare("SELECT a.*, z.name AS zone_name FROM actions a LEFT JOIN zones z ON z.id = a.zone_id WHERE a.id = ? AND a.case_id = ?")
        .bind(actionId, this.state.caseId)
        .first<ActionRow & { status: string; zone_name: string }>();
      if (!a) throw new Error(`no action ${actionId}`);
      if (a.status !== "awaiting_human") throw new Error(`action ${actionId} is already ${a.status}`);

      const trace = new Trace(this.state.caseId, "decision");
      let status = approved ? "executed" : "rejected";
      let result: string | null = null;
      if (approved) {
        try {
          result = await trace.span("action.execute", { action: a.id, kind: a.kind }, async () =>
            execute(env.DB, env.ACTION_SIGNING_KEY, a, await mintCredential(env.ACTION_SIGNING_KEY, a.id, a.zone_id)),
          );
        } catch (e) {
          status = "failed";
          result = e instanceof Error ? e.message : String(e);
        }
      }
      await env.DB.prepare("UPDATE actions SET status = ?, decided_by = ?, decided_at = ?, result = ? WHERE id = ?")
        .bind(status, by, Date.now(), result, a.id)
        .run();

      if (status === "executed") {
        this.say("note", `Change ${a.id} was approved by ${by} and ran: ${result}.`, trace.traceId);
        this.say("agent", `Update: the change I proposed has been approved and applied (${result}). Give it a minute, then check the site again and tell me if it's still broken.`, trace.traceId);
      } else {
        this.say("note", `Change ${a.id} was ${status === "failed" ? `approved but failed: ${result}` : `rejected by ${by}`}.`, trace.traceId);
        this.say("agent", HANDOFF, trace.traceId);
        await this.escalate(trace, {
          reason: status === "failed" ? `approved change ${a.id} failed` : `${by} rejected change ${a.id}`,
          summary: `${a.kind} on ${a.zone_name ?? a.zone_id} ${a.params}`,
          nextStep: "decide the fix with the customer",
          priority: "normal",
        });
      }
      if (this.state.status === "waiting_on_approval") {
        const left = await env.DB.prepare("SELECT count(*) AS n FROM actions WHERE case_id = ? AND status = 'awaiting_human'").bind(this.state.caseId).first<{ n: number }>();
        if (!left?.n) await this.setStatus("open");
      }
      await trace.end(env.DB, { action: a.id, status, by });
      return { status, result };
    });
  }
}
