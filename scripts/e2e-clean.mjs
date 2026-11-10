/**
 * .env 없이 브라우저 테스트를 돌린다.
 *
 * Next는 빌드와 실행 때 프로젝트 폴더의 .env를 자동으로 읽는다. 실제 키가 테스트 서버에 들어가지 않도록
 * 프로젝트를 임시 폴더로 복사하되 환경 파일(.env, .env.local 등)은 복사하지 않고, 그 폴더에서 테스트한다.
 * Claude Code는 이 방법으로만 브라우저 테스트를 돌린다 (playwright.config.ts).
 *
 *   npm run test:e2e:clean
 *   npm run test:e2e:clean -- tests/e2e/full-flow.spec.ts -g "제목"
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(tmpdir(), "saju-service-e2e-clean");
const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report"]);
const isRealEnvFile = (name) => name.startsWith(".env") && name !== ".env.example";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: target, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

mkdirSync(target, { recursive: true });
// 지난 실행의 소스와 빌드 결과는 지우고, 설치된 패키지만 다시 쓴다.
for (const name of readdirSync(target)) {
  if (name !== "node_modules") rmSync(path.join(target, name), { recursive: true, force: true });
}
cpSync(root, target, {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(root, source);
    if (!relative) return true;
    if (SKIPPED_DIRS.has(relative.split(path.sep)[0])) return false;
    return !isRealEnvFile(path.basename(source));
  },
});
const copied = readdirSync(target).filter(isRealEnvFile);
if (copied.length > 0) throw new Error(`환경 파일이 복사되었습니다: ${copied.join(", ")}`);

const lockHash = createHash("sha256").update(readFileSync(path.join(root, "package-lock.json"))).digest("hex");
const stamp = path.join(target, "node_modules", ".e2e-clean-lock");
if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== lockHash) {
  console.log(`[e2e:clean] 패키지 설치: ${target}`);
  const status = run("npm", ["ci", "--no-audit", "--no-fund"], { shell: true });
  if (status !== 0) process.exit(status);
  writeFileSync(stamp, lockHash);
}

console.log(`[e2e:clean] 브라우저 테스트: ${target} (환경 파일 없음)`);
const cli = path.join(target, "node_modules", "@playwright", "test", "cli.js");
process.exit(run(process.execPath, [cli, "test", ...process.argv.slice(2)]));
