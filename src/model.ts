import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "./env";

// USD per million tokens, from the Workers AI model pages on 2026-10-19.
// An unknown model costs 0 here and shows up as such on the dashboard.
export const PRICES: Record<string, { input: number; output: number }> = {
  "@cf/zai-org/glm-4.7-flash": { input: 0.0605, output: 0.4 },
};

export function cost(model: string, u: { inputTokens?: number; outputTokens?: number }): number {
  const p = PRICES[model];
  if (!p) return 0;
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output) / 1e6;
}

// Tests and the offline evals swap in scripted models here.
let override: ((id: string) => LanguageModel) | null = null;
export function useModels(fn: ((id: string) => LanguageModel) | null): void {
  override = fn;
}

// Every call goes through AI Gateway, which adds its own logs, caching and
// rate limits on top of ours. Session affinity keeps one case on one
// replica so the shared prompt prefix stays cached.
export function model(env: Env, id: string, caseId: string): LanguageModel {
  if (override) return override(id);
  const ai = createWorkersAI({ binding: env.AI, gateway: { id: env.AI_GATEWAY_ID } });
  return ai(id, { reasoning_effort: "low", sessionAffinity: caseId });
}
