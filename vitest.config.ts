import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Same alias apps/web uses. Vitest does not read apps/web/vite.config.ts,
    // so it has to be repeated here for the web app's pure helpers.
    alias: {
      "@shared": fileURLToPath(
        new URL("./supabase/functions/_shared/lib", import.meta.url),
      ),
    },
  },
  test: {
    // The dependency-free shared lib plus the web app's pure helpers.
    // Everything under supabase/functions/{lookup,admin-import} is Deno-only,
    // and React components are verified with Playwright instead of jsdom.
    include: [
      "supabase/functions/_shared/lib/**/*.test.ts",
      "apps/web/src/lib/**/*.test.ts",
    ],
  },
});
