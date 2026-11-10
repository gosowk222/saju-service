import { z } from "zod";
import { requireApiAdmin } from "@/server/access";
import { ApiError, ok, readJson, route } from "@/server/api";
import { adminGrantFreeTicket } from "@/server/tickets/free-ticket";

const BodySchema = z.object({
  userId: z.string().uuid(),
  requestId: z.string().uuid(),
  note: z.string().trim().max(200).optional(),
});

/** 관리자가 고른 회원에게 무료 이용권 한 장을 준다. 같은 요청 ID는 한 번만 반영된다. */
export const POST = route(async (request) => {
  const { user } = await requireApiAdmin();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");
  const outcome = await adminGrantFreeTicket({ adminId: user.id, ...body.data });
  if (outcome === "not_eligible") throw new ApiError(409, "not_eligible", "카카오로 로그인한 회원에게만 줄 수 있어요.");
  return ok({ outcome });
});
