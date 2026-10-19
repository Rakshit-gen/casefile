import type { Env } from "./env";

// Semantic recall over two collections: knowledge base articles, and
// summaries of cases the agent resolved. Vectorize in production; a plain
// keyword scorer over the same D1 rows in tests and in local dev without
// an index, so the agent code doesn't know which one it has.

export type Collection = "kb" | "cases";

export interface Hit {
  id: string;
  score: number;
  title: string;
  text: string;
}

export interface Recall {
  index(collection: Collection, docs: { id: string; title: string; text: string }[]): Promise<number>;
  search(collection: Collection, query: string, k: number): Promise<Hit[]>;
}

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export function recallFor(env: Env): Recall {
  return env.RECALL === "keyword" || !env.VECTORS ? new KeywordRecall(env.DB) : new VectorRecall(env);
}

class VectorRecall implements Recall {
  constructor(private env: Env) {}

  private async embed(texts: string[]): Promise<number[][]> {
    const out = (await this.env.AI.run(EMBEDDING_MODEL, { text: texts }, { gateway: { id: this.env.AI_GATEWAY_ID } })) as {
      data: number[][];
    };
    return out.data;
  }

  async index(collection: Collection, docs: { id: string; title: string; text: string }[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < docs.length; i += 50) {
      const batch = docs.slice(i, i + 50);
      const vectors = await this.embed(batch.map((d) => `${d.title}\n${d.text}`.slice(0, 2000)));
      await this.env.VECTORS!.upsert(
        batch.map((d, j) => ({
          id: `${collection}:${d.id}`,
          namespace: collection,
          values: vectors[j],
          metadata: { id: d.id, title: d.title, text: d.text.slice(0, 1500) },
        })),
      );
      n += batch.length;
    }
    return n;
  }

  async search(collection: Collection, query: string, k: number): Promise<Hit[]> {
    const [v] = await this.embed([query]);
    const r = await this.env.VECTORS!.query(v, { topK: k, namespace: collection, returnMetadata: "all" });
    return r.matches.map((m) => ({
      id: String(m.metadata?.id ?? m.id),
      score: m.score,
      title: String(m.metadata?.title ?? ""),
      text: String(m.metadata?.text ?? ""),
    }));
  }
}

const STOP = new Set("a an and are but can do does for from have how i in is it my of on or our so that the this to was we what when why with you your".split(" "));

function terms(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

class KeywordRecall implements Recall {
  constructor(private db: D1Database) {}

  async index(_c: Collection, docs: unknown[]): Promise<number> {
    return docs.length; // reads straight from D1, nothing to build
  }

  async search(collection: Collection, query: string, k: number): Promise<Hit[]> {
    const rows =
      collection === "kb"
        ? (await this.db.prepare("SELECT id, title, body AS text FROM kb_articles").all<{ id: string; title: string; text: string }>()).results
        : (
            await this.db
              .prepare("SELECT id, subject AS title, summary AS text FROM cases WHERE status = 'resolved' AND summary IS NOT NULL ORDER BY resolved_at DESC LIMIT 500")
              .all<{ id: string; title: string; text: string }>()
          ).results;
    const q = new Set(terms(query));
    if (!q.size) return [];
    return rows
      .map((r) => {
        const t = terms(`${r.title} ${r.title} ${r.text}`);
        const hits = t.filter((w) => q.has(w)).length;
        return { ...r, score: hits / Math.sqrt(t.length + 1) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
