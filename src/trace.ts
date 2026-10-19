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

export class Trace {
  readonly traceId: string;
  readonly rootId = hex(8);
  private remoteParent: string | null;
  private rows: SpanRow[] = [];
  private started = Date.now();

  constructor(
    readonly caseId: string | null,
    readonly name: string,
    parent?: string,
  ) {
    const p = parseTraceparent(parent);
    this.traceId = p?.traceId ?? hex(16);
    this.remoteParent = p?.parentId ?? null;
  }

  traceparent(spanId = this.rootId): string {
    return `00-${this.traceId}-${spanId}-01`;
  }

  async span<T>(name: string, attrs: Record<string, unknown>, fn: (spanId: string) => Promise<T>, parent = this.rootId): Promise<T> {
    const id = hex(8);
    const t0 = Date.now();
    try {
      const out = await fn(id);
      this.push({ span_id: id, parent_id: parent, name, started_at: t0, duration_ms: Date.now() - t0, status: "ok", attrs });
      return out;
    } catch (e) {
      attrs.error = e instanceof Error ? e.message : String(e);
      this.push({ span_id: id, parent_id: parent, name, started_at: t0, duration_ms: Date.now() - t0, status: "error", attrs });
      throw e;
    }
  }

  // For things measured elsewhere, like a model step reported by the SDK.
  record(name: string, attrs: Record<string, unknown>, startedAt: number, durationMs: number, status: "ok" | "error" = "ok"): void {
    this.push({ span_id: hex(8), parent_id: this.rootId, name, started_at: startedAt, duration_ms: durationMs, status, attrs });
  }

  private push(r: Omit<SpanRow, "trace_id" | "case_id">) {
    const row: SpanRow = { trace_id: this.traceId, case_id: this.caseId, ...r };
    this.rows.push(row);
    console.log(JSON.stringify({ level: r.status === "error" ? "error" : "info", ...row, attrs: undefined, ...r.attrs }));
  }

  spans(): readonly SpanRow[] {
    return this.rows;
  }

  async end(db: D1Database, attrs: Record<string, unknown>, status: "ok" | "error" = "ok"): Promise<void> {
    this.push({ span_id: this.rootId, parent_id: this.remoteParent, name: this.name, started_at: this.started, duration_ms: Date.now() - this.started, status, attrs });
    const stmt = db.prepare("INSERT OR IGNORE INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    await db.batch(
      this.rows.map((s) =>
        stmt.bind(s.trace_id, s.span_id, s.parent_id, s.case_id, s.name, s.started_at, s.duration_ms, s.status, JSON.stringify(s.attrs)),
      ),
    );
  }
}
