import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const sourcePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: { enabled: false }
  },
  resolve: {
    alias: {
      "@repo-circuit/core": sourcePath("./packages/core/src/index.ts"),
      "@repo-circuit/providers": sourcePath("./packages/providers/src/index.ts"),
      "@repo-circuit/session": sourcePath("./packages/session/src/index.ts"),
      "@repo-circuit/tools": sourcePath("./packages/tools/src/index.ts")
    }
  }
});
