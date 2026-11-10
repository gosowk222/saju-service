import { DraftSchema } from "@/domain/birth/input";
import { ApiError, ok, readJson, requireApiUser, route } from "@/server/api";

/** 초안은 본인 권한으로 저장한다. 다른 사용자의 초안은 RLS로 막힌다. */
export const PUT = route(async (request) => {
  const { supabase } = await requireApiUser();
  const parsed = DraftSchema.safeParse(await readJson(request));
  if (!parsed.success) throw new ApiError(400, "invalid_draft", "입력 형식이 올바르지 않아요.");
  const { error } = await supabase.rpc("save_my_draft", {
    p_product_id: parsed.data.productId,
    p_payload: parsed.data,
  });
  if (error) throw new ApiError(500, "save_failed", "저장하지 못했어요.");
  return ok({ saved: true });
});
