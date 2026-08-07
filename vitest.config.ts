import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the dependency-free shared lib runs under Vitest.
    // Everything under supabase/functions/{lookup,admin-import} is Deno-only.
    include: ["supabase/functions/_shared/lib/**/*.test.ts"],
  },
});
