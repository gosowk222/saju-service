import { z } from "zod";
import { ApiError, ok, readJson, requireApiUser, route } from "@/server/api";
import { askFollowup } from "@/server/readings/followup";
import { getEntitlement } from "@/server/readings/store";

export const maxDuration = 120;

const BodySchema = z.object({
  clientRequestId: z.string().uuid(),
  question: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "질문을 입력해 주세요.").max(200, "질문은 200자까지 쓸 수 있어요.")),
});

export const POST = route<{ readingId: string }>(async (request, { readingId }) => {
  const { user, supabase } = await requireApiUser();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(422, "invalid_question", body.error.issues[0]?.message ?? "질문을 확인해 주세요.");

  const entitlement = await getEntitlement(supabase, readingId);
  if (!entitlement) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");

  const result = await askFollowup({
    userId: user.id,
    readingId,
    clientRequestId: body.data.clientRequestId,
    question: body.data.question,
  });
  return ok(result);
});
