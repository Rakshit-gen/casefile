import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { seedStatements } from "../src/seed";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
await env.DB.batch(seedStatements(env.DB));
