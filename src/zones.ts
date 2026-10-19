// The customer's side of the product: zones with an SSL mode and an origin.
// Simulated in D1. Diagnostics are what an engineer would check first;
// changes run only through execute(), with a credential minted for that
// one approved action.

export const SSL_MODES = ["off", "flexible", "full", "strict"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface Zone {
  id: string;
  account_id: string;
  name: string;
  ssl_mode: SslMode;
  origin_https_only: number;
  origin_cert_valid: number;
  origin_up: number;
  error_rate_5xx: number;
  cache_purged_at: number | null;
}

export async function findZone(db: D1Database, accountId: string, ref: string): Promise<Zone | null> {
  return db
    .prepare("SELECT * FROM zones WHERE account_id = ? AND (id = ? OR name = lower(?))")
    .bind(accountId, ref, ref.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .first<Zone>();
}

export interface Finding {
  code: string;
  summary: string;
  fixable: boolean;
  fix?: string;
}

export function diagnose(z: Zone): Finding[] {
  const out: Finding[] = [];
  if (!z.origin_up) {
    out.push({ code: "522", summary: "Edge can't open a connection to the origin; the origin server is down or blocking edge addresses.", fixable: false });
  }
  if (z.ssl_mode === "flexible" && z.origin_https_only) {
    out.push({
      code: "redirect_loop",
      summary: "SSL mode is flexible (edge talks HTTP to the origin) but the origin redirects every HTTP request to HTTPS, so visitors loop (ERR_TOO_MANY_REDIRECTS).",
      fixable: true,
      fix: "set SSL mode to full",
    });
  }
  if (z.ssl_mode === "strict" && !z.origin_cert_valid) {
    out.push({
      code: "526",
      summary: "SSL mode is strict but the origin certificate is invalid or expired.",
      fixable: false,
      fix: "the customer must renew or replace the origin certificate; lowering the SSL mode would hide the problem",
    });
  }
  if (z.ssl_mode === "off") out.push({ code: "no_tls", summary: "SSL is off; visitors get plain HTTP.", fixable: true, fix: "set SSL mode to full or strict" });
  if (z.error_rate_5xx >= 0.05 && z.origin_up) {
    out.push({ code: "5xx", summary: `Origin is returning 5xx on ${(z.error_rate_5xx * 100).toFixed(1)}% of requests.`, fixable: false });
  }
  return out;
}

// --- credentials for one approved action -----------------------------------

export async function sign(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameString(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

// Bound to one action id and one zone, valid for a minute. The model never
// sees it; it is minted after a person approves and used once.
export async function mintCredential(key: string, actionId: string, zoneId: string, now = Date.now()): Promise<string> {
  const exp = now + 60_000;
  return `${exp}.${await sign(key, `${actionId}|${zoneId}|${exp}`)}`;
}

async function checkCredential(key: string, cred: string, actionId: string, zoneId: string, now = Date.now()): Promise<boolean> {
  const [exp, mac] = cred.split(".");
  if (!exp || !mac || Number(exp) < now) return false;
  return sameString(mac, await sign(key, `${actionId}|${zoneId}|${exp}`));
}
