import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { isLoginProvider } from "@/domain/auth/providers";
import { DEFAULT_AFTER_LOGIN } from "@/domain/auth/safe-next";
import { requestOrigin } from "@/lib/request-origin";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * 로그인이 필요한 화면. 홈과 상품 목록·상세는 로그인 없이 볼 수 있다.
 * 로그인하지 않은 채 이 화면을 열면(보관함, 마이, 사주 입력 등) 로그인 화면으로 보내고, 로그인 뒤 그 화면으로 돌아온다.
 * API는 각 라우트에서 직접 확인해 401을 돌려준다.
 */
const PROTECTED_PREFIXES = ["/readings", "/checkout", "/library", "/my"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, String(value));
      },
    },
  });

  // 세션을 갱신하면서 토큰을 검증한다. 화면 분기에만 쓰고, 권한 판단은 서버 코드에서 getUser로 다시 한다.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  // 회원(카카오 연결) 여부는 Supabase가 서명한 토큰의 app_metadata.providers로 나눈다. 사용자가 바꿀 수 있는 user_metadata는 보지 않는다.
  const providers = (data?.claims?.app_metadata as { providers?: unknown } | undefined)?.providers;
  const member = signedIn && Array.isArray(providers) && providers.some(isLoginProvider);
  const { pathname, search } = request.nextUrl;
  const next = encodeURIComponent(`${pathname}${search}`);

  const redirectWithCookies = (url: URL) => {
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!signedIn && isProtected(pathname)) {
    return redirectWithCookies(new URL(`/login?next=${next}`, requestOrigin(request)));
  }
  // 구글 제공자를 끄기 전에 만든 세션처럼 카카오 연결이 없는 세션은 회원 화면에 들어오지 못하고 카카오로 다시 로그인한다.
  if (signedIn && !member && isProtected(pathname)) {
    return redirectWithCookies(new URL(`/login?error=kakao_required&next=${next}`, requestOrigin(request)));
  }

  // 로그인 화면에 안내(error)가 붙어 있으면 보여 준다 (서버에서 다시 확인한 결과 카카오 회원이 아닌 경우 등).
  const loginNotice = pathname === "/login" && request.nextUrl.searchParams.has("error");
  if (member && !loginNotice && (pathname === "/" || pathname === "/login")) {
    return redirectWithCookies(new URL(DEFAULT_AFTER_LOGIN, requestOrigin(request)));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|woff2?)$).*)"],
};
