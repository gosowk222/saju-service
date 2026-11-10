import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 실제 Postgres가 필요한 동시성 테스트 (tests/db/concurrency.test.ts). TEST_PG_URL이 없으면 건너뛴다.
 * 단위 테스트(vitest.config.mts)와 같은 설정에서 대상 폴더와 시간 제한만 다르다.
 */
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts"),
    },
  },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
