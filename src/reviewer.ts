import { generateText, Output } from "ai";
import { z } from "zod";
import type { Env } from "./env";
import { model } from "./model";
import { REVIEWER_PROMPT } from "./prompts";
import type { Finding } from "./zones";

// The second gate: a separate model call with its own prompt and none of
// the agent's conversation beyond what the customer actually wrote. An
// injection that steered the agent has to get past this too, and then a
// person.

const Review = z.object({ approve: z.boolean(), reason: z.string().max(400) });
export type Review = z.infer<typeof Review>;

export async function review(
  env: Env,
  modelId: string,
  caseId: string,
  input: { customerMessages: string[]; zone: string; findings: Finding[]; kind: string; params: unknown; rationale: string },
): Promise<{ review: Review; usage: { inputTokens?: number; outputTokens?: number } }> {
  try {
    const r = await generateText({
      model: model(env, modelId, caseId),
      system: REVIEWER_PROMPT,
      prompt: JSON.stringify(
        {
          customer_messages: input.customerMessages.slice(-6),
          zone: input.zone,
          diagnostics: input.findings,
          proposed_change: { kind: input.kind, params: input.params, rationale: input.rationale },
        },
        null,
        2,
      ),
      output: Output.object({ schema: Review }),
      maxRetries: 1,
    });
    return { review: r.output, usage: r.totalUsage };
  } catch (e) {
    // A reviewer that can't answer is a no, never a yes.
    return { review: { approve: false, reason: `reviewer failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400) }, usage: {} };
  }
}
