// Traces in the W3C traceparent shape. Every customer turn is one trace;
// model steps, tool calls, guardrail checks and the reviewer are spans in
// it. The trace id travels with queue messages, so an escalation delivered
// minutes later lands in the same trace as the turn that raised it.
//
// Each span is logged as one JSON line (Workers Logs indexes the fields)
// and written to D1 at the end of the turn for the console.

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  case_id: string | null;
  name: string;
  started_at: number;
  duration_ms: number;
  status: "ok" | "error";
  attrs: Record<string, unknown>;
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseTraceparent(tp: string | undefined): { traceId: string; parentId: string } | null {
  const m = tp?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/);
  return m ? { traceId: m[1], parentId: m[2] } : null;
}
