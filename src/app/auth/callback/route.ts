import { NextResponse, type NextRequest } from "next/server";
import { AUTH_NEXT_COOKIE, safeNextPath } from "@/domain/auth/safe-next";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMember } from "@/server/auth";
import { ensureFreeTicket } from "@/server/tickets/free-ticket";

/**
 * OAuth 로그인을 마친 브라우저가 돌아오는 앱의 주소.
 * Supabase의 제공자 콜백(/auth/v1/callback)과는 다른 주소다.
 *
 * 카카오로 처음 로그인하면 Supabase가 회원을 만들고, 이후에는 같은 회원으로 다시 로그인한다.
 * 세션을 만든 뒤 카카오 연결이 없는 계정이면(지원하지 않는 제공자) 바로 로그아웃시킨다.
 * 무료 테스트 모드에서는 여기서 무료 이용권을 지급한다. 지급이 실패해도 로그인은 계속하고, 다음 이용권 조회에서 다시 지급한다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = requestOrigin(request);
  const next = safeNextPath(request.cookies.get(AUTH_NEXT_COOKIE)?.value ?? searchParams.get("next"));

  const toLogin = (reason: string) => {
    const url = new URL("/login", origin);
    url.searchParams.set("error", reason);
    url.searchParams.set("next", next);
    const response = NextResponse.redirect(url);
    response.cookies.delete(AUTH_NEXT_COOKIE);
    return response;
  };

  const providerError = searchParams.get("error");
  if (providerError) {
    return toLogin(providerError === "access_denied" ? "cancelled" : "oauth");
  }

  const code = searchParams.get("code");
  if (!code) return toLogin("oauth");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return toLogin("oauth");

  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data.user) return toLogin("oauth");
  if (!isMember(data.user)) {
    await supabase.auth.signOut({ scope: "local" });
    return toLogin("kakao_required");
  }

  await ensureFreeTicket(data.user.id);

  const response = NextResponse.redirect(new URL(next, origin));
  response.cookies.delete(AUTH_NEXT_COOKIE);
  return response;
}
