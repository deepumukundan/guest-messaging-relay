import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          RELAY_PATH_TOKEN: "testpathtoken0123456789abcdefABCDEF",
          RESPONDER_WEBHOOK_URL: "https://routine.example/hooks/guest",
          RESPONDER_AUTH_HEADER: "Bearer routine-test-token",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
