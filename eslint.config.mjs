import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 예제와 디자인 자료는 이 앱의 소스가 아니다.
    "examples/**",
    "saju-design-system/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
