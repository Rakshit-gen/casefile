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
