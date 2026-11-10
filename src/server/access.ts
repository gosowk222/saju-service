import "server-only";
import type { User } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { cache } from "react";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError, requireApiUser, type AuthedContext } from "@/server/api";
import { requirePageUser } from "@/server/auth";

/**
 * 회원 역할과 풀이 상품 이용 범위.
 *
 * - 역할: user(기본) 또는 admin. DB의 user_roles에서만 바꾼다 (docs/ADMIN.md).
 * - 서버 설정 readings_open_to_all: 끄면(기본) 관리자만, 켜면 모든 회원이 풀이 상품을 이용한다.
 *   개발 중 실제 테스트를 할 때 테스트 링크가 퍼져도 아무나 풀이를 받지 못하게 하는 설정이다.
 * - 막는 것: 출생정보 입력·맛보기 만들기, 이용권 사용, 결제, 풀이 생성·재시도, 후속 질문.
 *   막지 않는 것: 상품 둘러보기, 로그인, 이미 받은 풀이 다시 보기, 보관함, PDF.
 *
 * 판단은 서버가 DB에서 다시 읽는다. 클라이언트가 보낸 역할이나 설정 값은 쓰지 않는다.
 */
export interface ReadingAccess {
  readonly role: "user" | "admin";
  readonly openToAll: boolean;
  readonly allowed: boolean;
}

const CLOSED: ReadingAccess = { role: "user", openToAll: false, allowed: false };

/** 한 번의 화면 렌더링 안에서는 한 번만 읽는다. 읽지 못하면 막는 쪽으로 정한다. */
export const getReadingAccess = cache(async (userId: string): Promise<ReadingAccess> => {
  try {
    const { data, error } = await createSupabaseAdminClient().rpc("get_reading_access", { p_user_id: userId });
    if (error || !data) {
      console.error("[access] load failed", { code: error?.code ?? "empty" });
      return CLOSED;
    }
    const value = data as Partial<ReadingAccess>;
    return { role: value.role === "admin" ? "admin" : "user", openToAll: value.openToAll === true, allowed: value.allowed === true };
  } catch (error) {
    console.error("[access] load failed", { reason: error instanceof Error ? error.name : typeof error });
    return CLOSED;
  }
});

export const READINGS_CLOSED_MESSAGE = "지금은 운영자가 허용한 계정만 풀이를 이용할 수 있어요.";

/** 풀이 상품을 이용하는 API(입력 저장, 맛보기 만들기, 이용권 사용, 결제, 생성, 후속 질문)의 공통 확인. */
export async function requireReadingAccess(): Promise<AuthedContext & { readonly access: ReadingAccess }> {
  const context = await requireApiUser();
  const access = await getReadingAccess(context.user.id);
  if (!access.allowed) throw new ApiError(403, "readings_closed", READINGS_CLOSED_MESSAGE);
  return { ...context, access };
}

/** 관리자 API. 관리자가 아니면 화면이 있는지도 알리지 않는다. */
export async function requireApiAdmin(): Promise<AuthedContext> {
  const context = await requireApiUser();
  const access = await getReadingAccess(context.user.id);
  if (access.role !== "admin") throw new ApiError(404, "not_found", "찾을 수 없어요.");
  return context;
}

/** 관리자 화면. 관리자가 아니면 404로 보인다. */
export async function requirePageAdmin(nextPath: string): Promise<User> {
  const user = await requirePageUser(nextPath);
  const access = await getReadingAccess(user.id);
  if (access.role !== "admin") notFound();
  return user;
}
