import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Single source of truth for code/name normalization. The originals live
      // under supabase/functions so the Deno bundler never has to reach outside
      // its own directory.
      "@shared": fileURLToPath(
        new URL("../../supabase/functions/_shared/lib", import.meta.url),
      ),
    },
  },
});
