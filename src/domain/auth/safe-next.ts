/**
 * 로그인 뒤에 돌아갈 주소를 앱 내부 경로로만 제한한다.
 * 외부 주소, //로 시작하는 주소, 역슬래시나 제어 문자가 섞인 주소는 모두 기본 경로로 바꾼다.
 */
export const DEFAULT_AFTER_LOGIN = "/home";

export function safeNextPath(value: string | null | undefined): string {
  if (!value) return DEFAULT_AFTER_LOGIN;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  for (const candidate of [value, decoded]) {
    if (!candidate.startsWith("/")) return DEFAULT_AFTER_LOGIN;
    if (candidate.startsWith("//") || candidate.startsWith("/\\")) return DEFAULT_AFTER_LOGIN;
    if (candidate.includes("\\")) return DEFAULT_AFTER_LOGIN;
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return DEFAULT_AFTER_LOGIN;
    if (/^\/[a-z][a-z0-9+.-]*:/i.test(candidate)) return DEFAULT_AFTER_LOGIN;
  }
  // 파싱 결과가 다른 호스트로 해석되면 거부한다.
  try {
    const parsed = new URL(value, "https://app.invalid");
    if (parsed.host !== "app.invalid") return DEFAULT_AFTER_LOGIN;
    const path = `${parsed.pathname}${parsed.search}`;
    if (path === "/" || path.startsWith("/login") || path.startsWith("/auth/")) {
      return DEFAULT_AFTER_LOGIN;
    }
    return path;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}
