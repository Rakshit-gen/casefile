import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS, FLAGS_KEY, inRollout, readFlags } from "../src/flags";
import { fence, injectionSignals, redact } from "../src/guard";
import { check } from "../src/policy";
import { execute, mintCredential, type Zone } from "../src/zones";

describe("redact", () => {
  it("removes cards only when the Luhn check passes", () => {
    expect(redact("card 4242 4242 4242 4242").text).toBe("card [redacted card]");
    expect(redact("order 4242 4242 4242 4241").text).toBe("order 4242 4242 4242 4241");
  });

  it("tells phone numbers from order numbers", () => {
    expect(redact("call (415) 555-0123").text).toBe("call [redacted phone]");
    expect(redact("order 20261019448812").text).toBe("order 20261019448812");
  });

  it("leaves short numbers, IPs and zone names alone", () => {
    const s = "error 522 on api.ferro.example from 203.0.113.7 at 14:05, ticket 88231";
    expect(redact(s)).toEqual({ text: s, findings: [] });
  });

  it("catches the common credential shapes", () => {
    const r = redact(
      [
        "AKIAABCDEFGHIJKLMNOP",
        "ghp_" + "a".repeat(36),
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        "api_key=sk-live-12345678",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    expect(r.findings.map((f) => f.label)).toEqual(["private key", "aws access key", "github token", "bearer token", "key or password"]);
    expect(r.text).not.toMatch(/AKIA|ghp_|abcdefghij|sk-live|MIIE/);
  });
});
