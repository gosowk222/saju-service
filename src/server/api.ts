import "server-only";
import type { User } from "@supabase/supabase-js";
import { unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMember } from "@/server/auth";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin === new URL(requestOrigin(request)).origin) return;
  } catch {
    // 아래에서 거부한다.
  }
  throw new ApiError(403, "forbidden_origin", "허용되지 않은 요청입니다.");
}

/** 응답은 개인 데이터를 담으므로 어떤 캐시에도 저장되지 않게 한다. */
const NO_STORE = { "Cache-Control": "private, no-store" };

export function ok<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function failure(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE });
}

export interface AuthedContext {
  readonly user: User;
  readonly supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
}

/**
 * 서버에 다시 물어 토큰을 검증하고, 카카오 로그인 회원인지 확인한다. 세션 쿠키 값만으로 판단하지 않는다.
 * 구글만 연결된 예전 세션은 403으로 막는다. 사용자가 바꿀 수 있는 메타데이터나 요청 값은 보지 않는다.
 */
export async function requireApiUser(): Promise<AuthedContext> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ApiError(401, "unauthenticated", "로그인이 필요해요.");
  if (!isMember(data.user)) {
    throw new ApiError(403, KAKAO_LOGIN_REQUIRED, "카카오로 로그인한 회원만 이용할 수 있어요. 카카오로 다시 로그인해 주세요.");
  }
  return { user: data.user, supabase };
}

export const KAKAO_LOGIN_REQUIRED = "kakao_login_required";

type Handler<P> = (request: NextRequest, context: { params: P }) => Promise<NextResponse>;

/** 공통 처리: 교차 출처 차단, 알려진 오류 변환, 예상 못 한 오류의 안전한 기록. */
export function route<P = unknown>(handler: (request: NextRequest, params: P) => Promise<NextResponse>): Handler<Promise<P>> {
  return async (request, { params }) => {
    try {
      if (request.method !== "GET") assertSameOrigin(request);
      return await handler(request, await params);
    } catch (error) {
      // Next.js 내부 제어 신호(동적 렌더링 전환 등)는 오류로 처리하지 않는다.
      unstable_rethrow(error);
      if (error instanceof ApiError) return failure(error.status, error.code, error.message);
      // 출생정보와 본문이 로그에 남지 않도록 오류의 종류만 기록한다.
      console.error("[api] unexpected", request.nextUrl.pathname, error instanceof Error ? error.name : typeof error);
      return failure(500, "internal", "잠시 후 다시 시도해 주세요.");
    }
  };
}

export async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "요청 형식이 올바르지 않아요.");
  }
}

/** Postgres에서 raise한 코드(P0001)를 API 오류로 바꾼다. */
export function dbErrorCode(error: { message?: string } | null | undefined): string {
  return error?.message ?? "unknown";
}
