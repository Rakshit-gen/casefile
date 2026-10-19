// Guardrails on text going in and out of the model.
//
// Redaction runs on every customer message before it is stored, logged,
// embedded or sent to a model, and on every reply before it reaches the
// customer. The injection check is a signal for the trace and the reviewer,
// not the defence: what stops an injected instruction from doing damage is
// that changes need a policy check, a reviewer and a person (see policy.ts).

export type FindingKind = "email" | "phone" | "card" | "secret";

export interface Finding {
  kind: FindingKind;
  label: string;
}

const SECRETS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ["key or password", /\b(?:api[_-]?key|api[_-]?token|secret|password|passwd|token)\b\s*[:=]\s*["']?[^\s"']{8,}/gi],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE = /(?<![\w.])(?:\+|\()?\d[\d ()-]{8,}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redact(text: string): { text: string; findings: Finding[] } {
  const findings: Finding[] = [];
  let out = text;
  for (const [label, re] of SECRETS) {
    out = out.replace(re, () => {
      findings.push({ kind: "secret", label });
      return `[redacted ${label}]`;
    });
  }
  out = out.replace(EMAIL, () => {
    findings.push({ kind: "email", label: "email address" });
    return "[redacted email]";
  });
  // Cards before phones: a card number also looks like a long phone number.
  out = out.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || !luhn(digits)) return m;
    findings.push({ kind: "card", label: "card number" });
    return "[redacted card]";
  });
  // Phones: 10 to 15 digits (the E.164 limit), written like a phone number
  // (leading + or separators). A bare run of digits is more often an order
  // or account number, which support needs to see.
  out = out.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 10 || digits > 15 || !/^[+(]|[ ()-]/.test(m)) return m;
    findings.push({ kind: "phone", label: "phone number" });
    return "[redacted phone]";
  });
  return { text: out, findings };
}
