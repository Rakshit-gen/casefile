import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          RECALL: "keyword",
          WEBHOOK_SECRET: "test-webhook-secret",
          OPERATOR_TOKEN: "test-operator-token",
          ACTION_SIGNING_KEY: "test-signing-key",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
