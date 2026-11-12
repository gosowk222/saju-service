import { z } from "zod";
import { ApiError, ok, requireApiUser, route } from "@/server/api";
import { loadScrollState } from "@/server/scroll/state";

/**
 * 족자 상품(무진)의 저장 상태. 화면이 생성 중에 주기적으로 받는다.
 * 로그인·카카오 회원만 읽고, 소유자가 아니면 404다. 권한이 없으면 유료 장의 본문과 기간표는 들어가지 않는다.
 * 이미 받은 풀이 다시 보기라 운영 게이트(readingsOpenToAll)로 막지 않는다 (기존 상태 조회와 같다).
 */
export const GET = route<{ readingId: string }>(async (_request, { readingId }) => {
  const { user, supabase } = await requireApiUser();
  if (!z.string().uuid().safeParse(readingId).success) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
  const state = await loadScrollState(user.id, readingId, { user: supabase });
  if (!state) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
  return ok({ state });
});
