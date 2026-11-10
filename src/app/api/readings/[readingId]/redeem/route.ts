import { z } from "zod";
import { ApiError, ok, readJson, route } from "@/server/api";
import { requireReadingAccess } from "@/server/access";
import { redeemFreeTicket } from "@/server/tickets/free-ticket";

/**
 * 무료 이용권으로 이 풀이를 받는다. 요청 ID는 같은 클릭의 재전송을 알아보는 데 쓰고,
 * 권한 판단에는 서버가 검증한 사용자와 DB의 이용권 상태만 쓴다 (isFree, amount 같은 값은 받지 않는다).
 */
const BodySchema = z.object({ requestId: z.string().uuid() });

export const POST = route<{ readingId: string }>(async (request, { readingId }) => {
  const { user, supabase } = await requireReadingAccess();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");
  if (!z.string().uuid().safeParse(readingId).success) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");

  const result = await redeemFreeTicket({ supabase, userId: user.id, readingId, requestId: body.data.requestId });
  return ok(result);
});
