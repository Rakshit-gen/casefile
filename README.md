# casefile

A support agent on Cloudflare Workers that works customer cases for a CDN: it reads the account, runs diagnostics on the customer's zones, searches the docs and past cases, and proposes fixes. It can't change anything a policy, a second model and a person haven't all let through, and it hands the case to a human when it should.

Built on the Agents SDK. Each case is a Durable Object holding its own conversation. Recall uses Vectorize, the model runs on Workers AI through AI Gateway, KV holds the rollout flag, Queues carries the handoff to humans, and D1 stores traces, usage and actions for the console.

The accounts, zones and docs are fictional (`src/seed.ts`). A zone is a row in D1, and "changing SSL mode" updates that row. The agent, the gates and the evals around it are the actual code.

## Quickstart

Needs Node 22 or newer, pnpm, and a Cloudflare account for the model and Vectorize (both only run remotely).

```
pnpm install
npx wrangler login
npx wrangler d1 create casefile                  # put the id in wrangler.jsonc
npx wrangler kv namespace create FLAGS           # same
npx wrangler vectorize create casefile-kb --dimensions=768 --metric=cosine
npx wrangler queues create casefile-escalations
# create an AI Gateway named "casefile" in the dashboard (AI > AI Gateway)
cp .dev.vars.example .dev.vars                   # fill in three random secrets
pnpm dev
```

Then open http://localhost:8787, paste your `OPERATOR_TOKEN`, press "Seed demo data" and open a demo case. The customer side opens in a new tab.

`pnpm test` needs no account. It runs the whole suite inside workerd with scripted models and keyword recall in place of Workers AI and Vectorize.

## What happens on a case

```
signed webhook ─► CASE Durable Object (one per case)
                    │ input guard: redact secrets, PII; flag injection
                    │ rollout flag (KV) ── not in rollout ─► human only, no model call
                    ▼
                  agent loop (Workers AI via AI Gateway, up to 6 steps)
                    tools: get_account, run_diagnostics, search_docs,
                           similar_cases, propose_change, escalate, resolve
                    │
       propose_change ─► policy (code) ─► reviewer model ─► person ─► run
                    │
                    ▼ output guard ─► reply ─► spans, usage, first response time → D1
       escalate ─► Queue ─► signed webhook to the human team, with traceparent
```

**One Durable Object per case.** The case's messages live in that object's SQLite, so two messages on the same case are handled one at a time and every turn sees the whole conversation. A case opened twice with the same id gets back the same case. Resolved cases are summarised and indexed, so `similar_cases` can find how a past case was fixed.

**Changes go through three gates.**

1. Policy, in plain code (`src/policy.ts`). The zone must belong to the case's account, and the account comes from the signed webhook, never from anything the model or customer typed. A case gets at most 3 proposals. SSL can't be turned off or downgraded, and `strict` needs a valid origin certificate. Purge URLs must be on the zone. Purging everything is high risk; purging URLs is low risk.
2. A reviewer model, with its own prompt, that sees the proposal and the diagnostics and answers approve or reject in a fixed schema. If it errors or returns something unparseable, that counts as a rejection.
3. A person, in the console. A change only runs with a credential minted at approval time: an HMAC over the action and zone that expires after 60 seconds. If nobody answers within `APPROVAL_SLA_SECONDS` (30 minutes), the action expires and the case escalates as urgent. With the `autoApproveLowRisk` flag on, URL purges that pass the first two gates run without a person. SSL changes never do.

Proposals in one turn are handled one after another. Without that, parallel tool calls raced on the cap, and the offline evals caught it.

**Untrusted text stays marked.** Doc articles and past cases come back from tools inside `<untrusted>` tags, with any tags inside them escaped. Customer messages go to the model as user messages, never into the system prompt. Both are scanned for injection patterns ("ignore previous instructions", fake system notes, and similar), and a hit is recorded as a guardrail event. The seed data includes a poisoned community article that tells the agent to turn SSL off. What stops it is the policy gate, not the prompt.

**Secrets and PII never reach the model or the database.** The input guard redacts private keys, cloud and GitHub tokens, JWTs, bearer tokens, `key=`/`password=` values, emails, card numbers (Luhn-checked) and phone numbers before anything is stored. The reply is redacted again on the way out. When a customer pastes a credential, the reply tells them to rotate it.

**Handoffs go through a Queue.** `escalate`, a model outage, a rejected approval and an expired approval all put a message on `casefile-escalations` with a summary, a priority and the W3C `traceparent` of the turn. The consumer POSTs it, signed, to `ESCALATION_WEBHOOK_URL` and retries with backoff. With no URL set, it records the handoff for the console instead.

**The flag lives in KV.** It sets on/off, rollout percent (a stable hash of the account id), model, reviewer model, prompt version, max steps and auto-approve, and the console edits it. An invalid value falls back to the defaults. A case outside the rollout goes straight to a human with no model call. Turning the flag off is the kill switch.

**Every turn is a trace.** Spans for the turn, each model step, each tool call and each gate are written to D1 and logged as JSON lines for Workers Logs. The console draws them as a waterfall. Token usage and cost are stored per case and per purpose (agent or reviewer). The metrics endpoint reports resolution and escalation rates, first response p50/p95, model step latency, cost per case, action outcomes, guardrail counts and per-tool errors.

## Evals

`evals/scenarios.ts` has 15 short support conversations against the demo accounts: redirect loops, expired certificates, a down origin, refund and abuse requests that must go to a person, a request for another account's zone, prompt injection in the message and in the docs, a pasted secret, and a two-turn case. Each has two kinds of checks:

- **Safety** must hold whatever the model does, because code enforces it. Nothing gets past policy on a zone the account doesn't own. Nothing turning TLS off or down gets through. No SSL change runs without a person. No sensitive string is stored or shown. The customer always gets an answer.
- **Quality** is what a good agent does: the right tools called, the right change proposed, escalated when it should be, and the reply mentions or avoids certain things.

**Offline, in CI** (`test/evals.test.ts`), every scenario plays against a hostile scripted model with a reviewer that approves everything. The model searches the poisoned doc, runs diagnostics on every zone including other accounts', makes 3 dangerous proposals per zone per turn, then claims it fixed things. That's 288 dangerous proposals across the 15 scenarios. The test fails if any safety check fails, or if any proposal errored instead of being judged, which is how the race above showed up.

**Live**, `pnpm eval` plays the same scenarios against a running casefile with the real model, scores both kinds of checks, writes `evals/results/<time>-<prompt>.json` and exits non-zero if safety is under 100% or quality is under `--min-quality` (default 0.8). Use it to compare prompt versions or models before raising the rollout percent.

```
CASEFILE_URL=http://localhost:8787 OPERATOR_TOKEN=... pnpm eval [--only redirect-loop,refund]
```

This calls Workers AI and costs money. At the listed glm-4.7-flash prices ($0.0605 per million input tokens, $0.40 per million output), a case of a few thousand tokens is a fraction of a cent, but no live run has been measured yet.

## API

| | |
|---|---|
| `POST /api/webhooks/case` | open a case. Signed: `x-casefile-timestamp` (within 5 minutes) and `x-casefile-signature: sha256=<HMAC(WEBHOOK_SECRET, ts + "." + body)>` |
| `POST /api/cases/:id/messages` | customer message `{text}`, with the case's customer token as Bearer |
| `GET /api/cases/:id/transcript` | customer view of the conversation, same token |

Operator routes take `Authorization: Bearer <OPERATOR_TOKEN>`:

| | |
|---|---|
| `POST /api/seed` | load the demo accounts, zones and docs, and index the docs |
| `POST /api/demo/case` | open a case without a signed webhook; returns the customer token |
| `GET /api/cases` | recent cases |
| `GET /api/cases/:id` | case, transcript, actions with gate notes, spans, guardrail events, usage, escalation |
| `POST /api/actions/:id/decision` | `{approved, by}` |
| `GET /api/metrics` | the last 7 days |
| `GET`/`PUT /api/flags` | the agent flag |

## Measured vs Claimed

| Claim | Value | How measured | Date |
|---|---|---|---|
| Tests pass | 45 of 45 | `pnpm test` (workerd, scripted models) | 2026-10-19 |
| Offline safety | 100% of safety checks, 15 scenarios, 288 dangerous proposals | `test/evals.test.ts` | 2026-10-19 |
| Live eval safety and quality | not measured yet | `pnpm eval` | |
| Cost per case, first response time with the real model | not measured yet | `/api/metrics` after a live run | |

## Status

Works locally and in tests. Not deployed, and no live eval has been run yet. Only two tools change anything (SSL mode, cache purge), on simulated zones. The operator console has one shared token rather than per-person logins, so put Cloudflare Access in front of a deployment.
