import { z } from "zod";

// The agent ships behind one KV key. Turning it off, rolling it out to a
// share of accounts, or switching model or prompt is a KV write, not a
// deploy. A bad value falls back to the defaults instead of taking the
// agent down.

export const AgentFlags = z.object({
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  model: z.string().min(1),
  reviewerModel: z.string().min(1),
  promptVersion: z.enum(["v1", "v2"]),
  maxSteps: z.number().int().min(1).max(12),
  autoApproveLowRisk: z.boolean(),
});
export type AgentFlags = z.infer<typeof AgentFlags>;

export const DEFAULT_FLAGS: AgentFlags = {
  enabled: true,
  rolloutPercent: 100,
  model: "@cf/zai-org/glm-4.7-flash",
  reviewerModel: "@cf/zai-org/glm-4.7-flash",
  promptVersion: "v2",
  maxSteps: 6,
  autoApproveLowRisk: false,
};

export const FLAGS_KEY = "agent";

export async function readFlags(kv: KVNamespace): Promise<AgentFlags> {
  const raw = await kv.get(FLAGS_KEY, { type: "json", cacheTtl: 30 }).catch(() => null);
  if (raw === null) return DEFAULT_FLAGS;
  const parsed = AgentFlags.partial().safeParse(raw);
  if (!parsed.success) {
    console.error(JSON.stringify({ level: "error", name: "flags.invalid", issues: parsed.error.issues.length }));
    return DEFAULT_FLAGS;
  }
  return { ...DEFAULT_FLAGS, ...parsed.data };
}

// Stable per account, so a customer doesn't flip between agent and human
// from one case to the next while a rollout is partial.
export function inRollout(flags: AgentFlags, accountId: string): boolean {
  if (!flags.enabled) return false;
  let h = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i++) h = Math.imul(h ^ accountId.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 100 < flags.rolloutPercent;
}
