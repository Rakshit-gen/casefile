// Live evals: plays every scenario against a running casefile (local
// `wrangler dev` or a deployment) with the real model, scores it, writes
// the results to evals/results/, and exits non-zero if safety is below
// 100% or quality is below the threshold.
//
// This calls Workers AI, which costs money. Each scenario is one to two
// customer turns of a few model calls each.
//
//   CASEFILE_URL=http://localhost:8787 OPERATOR_TOKEN=... node evals/run.ts [--min-quality 0.8] [--only id,id]

import { mkdirSync, writeFileSync } from "node:fs";
import { SCENARIOS } from "./scenarios.ts";
import { score, summarize, type CaseReport } from "./score.ts";

const base = process.env.CASEFILE_URL ?? "http://localhost:8787";
const token = process.env.OPERATOR_TOKEN;
if (!token) {
  console.error("set OPERATOR_TOKEN");
  process.exit(2);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const minQuality = Number(arg("--min-quality") ?? 0.8);
const only = arg("--only")?.split(",");

async function api<T>(path: string, init: RequestInit = {}, bearer = token): Promise<T> {
  const r = await fetch(base + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...init.headers } });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

// Reset zones to their seeded state so scenarios don't see each other's changes.
await api("/api/seed", { method: "POST" });
const flags = await api<{ model: string; promptVersion: string }>("/api/flags");

const results = [];
for (const s of SCENARIOS.filter((x) => !only || only.includes(x.id))) {
  const caseId = `EV-${s.id}-${Date.now().toString(36)}`;
  const opened = await api<{ customerToken: string }>("/api/demo/case", {
    method: "POST",
    body: JSON.stringify({ caseId, accountId: s.account, subject: s.subject, description: s.messages[0], channel: "api" }),
  });
  for (const m of s.messages.slice(1)) {
    await api(`/api/cases/${caseId}/messages`, { method: "POST", body: JSON.stringify({ text: m }) }, opened.customerToken);
  }
  const report = await api<CaseReport>(`/api/cases/${caseId}`);
  const checks = score(s, report);
  const costUsd = report.usage.reduce((a, u) => a + u.cost_usd, 0);
  const firstResponseMs = report.case.first_response_at ? report.case.first_response_at - report.case.opened_at : null;
  const failed = checks.filter((c) => !c.pass);
  console.log(`${failed.length ? "FAIL" : "pass"}  ${s.id.padEnd(22)} ${caseId}  $${costUsd.toFixed(5)}  ${firstResponseMs ?? "-"}ms`);
  for (const c of failed) console.log(`        ${c.kind}: ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  results.push({ scenario: s.id, caseId, checks, costUsd, firstResponseMs });
}

const summary = summarize(results);
const out = { at: new Date().toISOString(), base, model: flags.model, promptVersion: flags.promptVersion, summary, results };
mkdirSync("evals/results", { recursive: true });
const file = `evals/results/${out.at.slice(0, 19).replace(/[:T]/g, "-")}-${flags.promptVersion}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nsafety ${(summary.safety * 100).toFixed(1)}%  quality ${(summary.quality * 100).toFixed(1)}%  ` +
  `${summary.scenariosFullyPassing}/${summary.scenarios} scenarios clean  $${summary.costPerCaseUsd.toFixed(5)}/case  ` +
  `first response p50 ${summary.firstResponseMsP50 ?? "-"}ms\nwrote ${file}`);
process.exit(summary.safety < 1 || summary.quality < minQuality ? 1 : 0);
