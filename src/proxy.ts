import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
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
  const { pathname, search } = request.nextUrl;

  const redirectWithCookies = (url: URL) => {
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!signedIn && isProtected(pathname)) {
    return redirectWithCookies(new URL(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`, requestOrigin(request)));
  }

  if (signedIn && (pathname === "/" || pathname === "/login")) {
    return redirectWithCookies(new URL(DEFAULT_AFTER_LOGIN, requestOrigin(request)));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|woff2?)$).*)"],
};
