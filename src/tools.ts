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
