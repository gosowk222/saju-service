import { z } from "zod";
import { ApiError, ok, readJson, requireApiUser, route } from "@/server/api";
import { runGeneration } from "@/server/readings/generate";
import { loadReadingState } from "@/server/readings/store";

/** 요청 안에서 생성을 끝낸다. 플랫폼이 허용하는 시간 안에 끝나지 않으면 다음 요청이 이어받는다. */
export const maxDuration = 300;

const BodySchema = z.object({ retry: z.boolean().default(false) });

export const POST = route<{ readingId: string }>(async (request, { readingId }) => {
  const { user, supabase } = await requireApiUser();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");

  const state = await loadReadingState(supabase, readingId);
  if (!state) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");

  if (state.status !== "completed") await runGeneration(user.id, readingId, body.data.retry);
  const latest = await loadReadingState(supabase, readingId);
  return ok(latest);
});
