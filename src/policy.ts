import { z } from "zod";
import { SSL_MODES, type Zone } from "./zones";

// The first gate on a proposed change, and the only one that is plain
// code. It decides what the agent may even ask for, and it reads the
// account from the case (set by the signed webhook), never from anything
// the model or the customer typed.

export const MAX_ACTIONS_PER_CASE = 3;

export const ChangeParams = {
  set_ssl_mode: z.object({ mode: z.enum(SSL_MODES) }),
  purge_cache: z.object({
    urls: z.array(z.string().url()).min(1).max(30).optional(),
    everything: z.boolean().optional(),
  }),
};
export type ChangeKind = keyof typeof ChangeParams;

const RANK: Record<string, number> = { off: 0, flexible: 1, full: 2, strict: 3 };

export interface Verdict {
  allowed: boolean;
  risk: "low" | "high";
  reasons: string[];
  params?: unknown;
}

export function check(kind: ChangeKind, rawParams: unknown, zone: Zone | null, ctx: { accountId: string; actionsSoFar: number }): Verdict {
  const reasons: string[] = [];
  const deny = (why: string): Verdict => ({ allowed: false, risk: "high", reasons: [...reasons, why] });

  if (!zone || zone.account_id !== ctx.accountId) return deny("zone is not on this case's account");
  if (ctx.actionsSoFar >= MAX_ACTIONS_PER_CASE) return deny(`a case can propose at most ${MAX_ACTIONS_PER_CASE} changes; escalate instead`);

  const parsed = ChangeParams[kind].safeParse(rawParams);
  if (!parsed.success) return deny(`bad parameters: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  if (kind === "set_ssl_mode") {
    const { mode } = parsed.data as { mode: string };
    if (mode === zone.ssl_mode) return deny(`SSL mode is already ${mode}`);
    if (mode === "off") return deny("the agent never turns TLS off");
    if (RANK[mode] < RANK[zone.ssl_mode]) return deny("lowering the SSL mode weakens security; a person has to decide that, so escalate");
    if (mode === "strict" && !zone.origin_cert_valid) return deny("strict needs a valid origin certificate and this origin's is not");
    reasons.push(`raises SSL mode ${zone.ssl_mode} -> ${mode}`);
    return { allowed: true, risk: "high", reasons, params: parsed.data };
  }

  const p = parsed.data as { urls?: string[]; everything?: boolean };
  if (!p.everything && !p.urls?.length) return deny("purge needs urls or everything: true");
  if (p.everything && p.urls?.length) return deny("purge either everything or a list of urls, not both");
  if (p.urls) {
    const off = p.urls.filter((u) => {
      const h = new URL(u).hostname;
      return h !== zone.name && !h.endsWith(`.${zone.name}`);
    });
    if (off.length) return deny(`urls outside ${zone.name}: ${off.slice(0, 3).join(", ")}`);
    reasons.push(`purges ${p.urls.length} URLs`);
    return { allowed: true, risk: "low", reasons, params: p };
  }
  reasons.push("purges the whole cache; origin load will spike");
  return { allowed: true, risk: "high", reasons, params: p };
}
