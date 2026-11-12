import { z } from "zod";
import { ApiError, ok, readJson, route } from "@/server/api";
import { requireReadingAccess } from "@/server/access";
import { runScrollTier } from "@/server/scroll/runner";

/**
 * 족자 상품(무진)의 한 단계(무료 또는 유료)를 요청 안에서 쓴다. 시간 예산이 끝나면 반납하고 partial을 돌려주며,
 * 화면이 곧바로 다시 요청해 이어 쓴다. 서버 응답 뒤에 작업이 계속된다고 가정하지 않는다.
 * 순서는 기존 생성 라우트와 같다: 같은 출처 확인(route) → 로그인·카카오 회원·운영 게이트 → 본문 확인 → 실행.
 * 유료 단계의 권한은 서버가 DB에서 다시 확인한다. 브라우저가 보낸 tier는 할 일을 고를 뿐 권한 근거가 아니다.
 */
export const maxDuration = 300;

const BodySchema = z.object({ tier: z.enum(["free", "paid"]), retry: z.boolean().default(false) });

export const POST = route<{ readingId: string }>(async (request, { readingId }) => {
  const { user } = await requireReadingAccess();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");
  if (!z.string().uuid().safeParse(readingId).success) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");

  const result = await runScrollTier({ userId: user.id, readingId, tier: body.data.tier, retry: body.data.retry });
  return ok({ result });
});
