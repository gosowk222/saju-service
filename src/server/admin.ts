import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";

/**
 * 관리자 화면의 서버 작업. 호출 전에 requireApiAdmin/requirePageAdmin으로 관리자인지 확인하고,
 * DB 함수도 관리자 역할을 한 번 더 확인한다 (not_admin).
 */

export interface MemberRow {
  readonly id: string;
  /** 카카오가 준 표시용 이름. 권한 판단에는 쓰지 않는다. */
  readonly name: string | null;
  readonly email: string | null;
  readonly created_at: string;
  readonly last_sign_in_at: string | null;
  readonly role: "user" | "admin";
  readonly kakao: boolean;
  readonly tickets_available: number;
  readonly tickets_used: number;
}

export async function listMembers(adminId: string, search: string | null): Promise<MemberRow[]> {
  const { data, error } = await createSupabaseAdminClient().rpc("admin_list_members", {
    p_admin_id: adminId,
    p_search: search,
    p_limit: 100,
  });
  if (error) throw new ApiError(500, "members_failed", "회원 목록을 불러오지 못했어요.");
  return (data ?? []) as MemberRow[];
}

/** 풀이 상품 이용 범위. true면 모든 회원, false면 관리자만. */
export async function setReadingsOpenToAll(adminId: string, open: boolean): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().rpc("set_readings_open_to_all", {
    p_admin_id: adminId,
    p_open: open,
  });
  if (error) {
    if (error.message?.includes("not_admin")) throw new ApiError(404, "not_found", "찾을 수 없어요.");
    throw new ApiError(500, "setting_failed", "설정을 저장하지 못했어요.");
  }
  return (data as { openToAll: boolean }).openToAll;
}
