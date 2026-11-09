import type { NextRequest } from "next/server";

/**
 * 사용자가 접속한 주소를 구한다. next start나 프록시 뒤에서는 request.nextUrl.origin이
 * 서버 내부 주소가 될 수 있어, 리다이렉트로 호스트가 바뀌면 로그인 쿠키가 끊긴다.
 * APP_ORIGIN을 설정하면 그 값을 항상 쓴다.
 */
export function requestOrigin(request: NextRequest): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return request.nextUrl.origin;
  const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return `${protocol}://${host}`;
}
