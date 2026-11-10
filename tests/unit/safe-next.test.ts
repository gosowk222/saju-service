import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/domain/auth/safe-next";

describe("로그인 복귀 경로", () => {
  it.each(["/home", "/library", "/readings/abc/preview", "/readings/new?product=first-overview"])("앱 내부 경로 %s는 허용한다", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/%2F/evil.example",
    "%2F%2Fevil.example",
    "/%5Cevil.example",
    "javascript:alert(1)",
    "/javascript:alert(1)",
    "home",
    "/a\nb",
    "/login",
    "/login?next=/home",
    "/auth/callback",
    "/",
    "%E0%A4%A",
  ])("위험하거나 의미 없는 값 %s는 기본 경로로 바꾼다", (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_AFTER_LOGIN);
  });
});
