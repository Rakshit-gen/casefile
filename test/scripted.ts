import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { useModels } from "../src/model";

// Scripted models for tests and the offline evals. A script sees what a
// real model would see (system prompt, conversation, tool results so far)
// and answers with text or tool calls.

export interface View {
  system: string;
  userTexts: string[];
  toolResults: { toolName: string; output: unknown }[];
  // Tool calls made since the last user message.
  calledSoFar: string[];
  isReviewer: boolean;
  promptText: string;
}

export type Reply = { text: string } | { calls: { tool: string; input: Record<string, unknown> }[] };
export type Script = (v: View) => Reply;

let callId = 0;

export function view(prompt: { role: string; content: unknown }[]): View {
  const system = prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  const userTexts: string[] = [];
  let lastUser = -1;
  prompt.forEach((m, i) => {
    if (m.role !== "user") return;
    lastUser = i;
    for (const p of m.content as { type: string; text?: string }[]) if (p.type === "text") userTexts.push(p.text!);
  });
  const toolResults: View["toolResults"] = [];
  const calledSoFar: string[] = [];
  prompt.slice(lastUser + 1).forEach((m) => {
    for (const p of (Array.isArray(m.content) ? m.content : []) as { type: string; toolName?: string; output?: { value: unknown } }[]) {
      if (p.type === "tool-call") calledSoFar.push(p.toolName!);
      if (p.type === "tool-result") toolResults.push({ toolName: p.toolName!, output: p.output?.value });
    }
  });
  return { system, userTexts, toolResults, calledSoFar, isReviewer: system.startsWith("You review changes"), promptText: JSON.stringify(prompt) };
}

export function scriptedModel(script: Script): LanguageModel {
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const v = view(opts.prompt as never);
      const r = script(v);
      const usage = {
        inputTokens: { total: Math.ceil(v.promptText.length / 4), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      };
      if ("text" in r) return { content: [{ type: "text", text: r.text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      return {
        content: r.calls.map((c) => ({ type: "tool-call" as const, toolCallId: `call-${++callId}`, toolName: c.tool, input: JSON.stringify(c.input) })),
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
  });
}

export const APPROVE: Script = () => ({ text: '{"approve": true, "reason": "the change fixes the finding in the diagnostics"}' });

// Installs one script for the agent and one for the reviewer (told apart
// by the reviewer's system prompt). Returns what each model was shown.
export function install(agent: Script, reviewer: Script = APPROVE) {
  const seen = { agent: [] as View[], reviewer: [] as View[] };
  useModels(() =>
    scriptedModel((v) => {
      (v.isReviewer ? seen.reviewer : seen.agent).push(v);
      return v.isReviewer ? reviewer(v) : agent(v);
    }),
  );
  return seen;
}

// A script that walks through a list of steps, one per model call, then
// answers with the final text.
export function steps(list: Reply[]): Script {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}
