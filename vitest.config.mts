import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 단위 테스트는 환경 값을 직접 넘긴다. 실제 키가 든 .env 파일은 읽지 않는다.
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
