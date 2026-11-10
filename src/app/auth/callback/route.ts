import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/domain/auth/safe-next";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NEXT_COOKIE = "auth_next";

/**
 * OAuth 로그인을 마친 브라우저가 돌아오는 앱의 주소.
 * Supabase의 제공자 콜백(/auth/v1/callback)과는 다른 주소다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = requestOrigin(request);
  const next = safeNextPath(request.cookies.get(NEXT_COOKIE)?.value ?? searchParams.get("next"));

  const toLogin = (reason: string) => {
    const url = new URL("/login", origin);
    url.searchParams.set("error", reason);
    url.searchParams.set("next", next);
    const response = NextResponse.redirect(url);
    response.cookies.delete(NEXT_COOKIE);
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

  const response = NextResponse.redirect(new URL(next, origin));
  response.cookies.delete(NEXT_COOKIE);
  return response;
}
