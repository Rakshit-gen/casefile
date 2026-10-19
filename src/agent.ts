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
