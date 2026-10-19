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
