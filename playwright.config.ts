import { defineConfig } from "@playwright/test";

const GATEWAY = "http://127.0.0.1:54399";
const APP_PORT = 3100;

/**
 * 브라우저 테스트. 외부 서비스는 tests/support/fake-gateway.ts가 대신한다.
 * 실제 OAuth, 실제 결제, 실제 모델 호출을 검증하지 않는다.
 */
const appEnv = {
  NEXT_PUBLIC_SUPABASE_URL: GATEWAY,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-publishable-key",
  SUPABASE_SECRET_KEY: "e2e-service-key",
  NEXT_PUBLIC_TOSS_CLIENT_KEY: "test_gck_e2e",
  TOSS_SECRET_KEY: "test_gsk_e2e_secret_marker",
  TOSS_API_BASE_URL: `${GATEWAY}/toss`,
  OPENAI_API_KEY: "e2e_openai_key_marker",
  OPENAI_BASE_URL: `${GATEWAY}/openai/v1`,
  OPENAI_MODEL: "gpt-5.6-luna",
  NEXT_TELEMETRY_DISABLED: "1",
};

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    channel: "chrome",
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx tests/support/fake-gateway.ts",
      url: `${GATEWAY}/__state`,
      reuseExistingServer: Boolean(process.env.PW_REUSE),
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `${process.env.PW_SKIP_BUILD ? "" : "npm run build && "}npx next start -p ${APP_PORT}`,
      url: `http://127.0.0.1:${APP_PORT}/products`,
      reuseExistingServer: Boolean(process.env.PW_REUSE),
      timeout: 280_000,
      env: appEnv,
    },
  ],
});
