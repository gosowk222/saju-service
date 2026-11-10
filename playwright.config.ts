import { readdirSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Next는 빌드와 실행 때 .env를 자동으로 읽는다. Claude Code는 사용자의 .env를 쓰지 않으므로, 실제 환경 파일이 있는
 * 폴더에서는 테스트를 시작하지 않는다. 파일 이름만 보고 내용은 읽지 않는다. 대신 npm run test:e2e:clean을 쓴다.
 */
const realEnvFiles = readdirSync(process.cwd()).filter((name) => name.startsWith(".env") && name !== ".env.example");
if ((process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) && realEnvFiles.length > 0) {
  throw new Error(
    "Claude Code에서는 .env가 있는 폴더에서 브라우저 테스트를 돌리지 않습니다. npm run test:e2e:clean을 사용하세요.",
  );
}

const GATEWAY = "http://127.0.0.1:54399";
/** 무료 테스트 모드(CHECKOUT_MODE 미설정 = 기본값 free_trial)와 결제 모드 앱을 같은 빌드로 하나씩 띄운다. */
const APP_PORT = 3100;
const PAYMENT_APP_PORT = 3101;
/** 결제 모드 앱에서 돌리는 테스트. 나머지는 무료 테스트 모드 앱에서 돌린다. */
const PAYMENT_SPECS = /(payment-generation|payment-mode).spec.ts$/;

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
    channel: "chrome",
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "free-trial", testIgnore: PAYMENT_SPECS, use: { baseURL: `http://127.0.0.1:${APP_PORT}` } },
    { name: "payment", testMatch: PAYMENT_SPECS, use: { baseURL: `http://127.0.0.1:${PAYMENT_APP_PORT}` } },
  ],
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
    {
      // 위 서버가 빌드를 마친 뒤 같은 빌드로 띄운다 (Playwright는 webServer를 순서대로 시작한다).
      command: `npx next start -p ${PAYMENT_APP_PORT}`,
      url: `http://127.0.0.1:${PAYMENT_APP_PORT}/products`,
      reuseExistingServer: Boolean(process.env.PW_REUSE),
      timeout: 120_000,
      env: { ...appEnv, CHECKOUT_MODE: "payment" },
    },
  ],
});
