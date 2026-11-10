import { NextResponse, type NextRequest } from "next/server";
import { isLoginProvider } from "@/domain/auth/providers";
import { AUTH_NEXT_COOKIE, safeNextPath } from "@/domain/auth/safe-next";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertSameOrigin } from "@/server/api";

/**
 * 앱의 유일한 로그인 시작 경로. 로그인 화면의 카카오 버튼이 이 주소로 폼을 보낸다.
 * 지원 제공자(카카오)가 아니면 OAuth를 시작하지 않고 로그인 화면으로 돌려보낸다.
 * PKCE 확인값은 Supabase 서버 클라이언트가 쿠키에 저장하고, 콜백(/auth/callback)에서 세션으로 바꾼다.
 */
export async function POST(request: NextRequest) {
  const origin = requestOrigin(request);
  const toLogin = (reason: string, next: string) => {
    const url = new URL("/login", origin);
    url.searchParams.set("error", reason);
    url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  };

  try {
    assertSameOrigin(request);
  } catch {
    return toLogin("oauth", "/home");
  }

  const form = await request.formData().catch(() => null);
  const next = safeNextPath(typeof form?.get("next") === "string" ? String(form!.get("next")) : null);
  const provider = form?.get("provider");
  if (!isLoginProvider(provider)) return toLogin("unsupported_provider", next);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${origin}/auth/callback`, skipBrowserRedirect: true },
  });
  if (error || !data.url) return toLogin("oauth", next);

  const response = NextResponse.redirect(data.url, 303);
  // 돌아올 주소를 잠시 둔다. 콜백에서 다시 검증한다.
  response.cookies.set(AUTH_NEXT_COOKIE, next, {
    path: "/",
    maxAge: 600,
    sameSite: "lax",
    httpOnly: true,
    secure: origin.startsWith("https://"),
  });
  return response;
}
