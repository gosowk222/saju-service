import { CreateReadingSchema } from "@/domain/birth/input";
import { findScrollProduct } from "@/domain/products";
import { ApiError, ok, readJson, route } from "@/server/api";
import { requireReadingAccess } from "@/server/access";
import { createReading } from "@/server/readings/create";
import { createScrollReading } from "@/server/scroll/create";

export const POST = route(async (request) => {
  const { user, supabase } = await requireReadingAccess();
  const parsed = CreateReadingSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "입력을 다시 확인해 주세요.";
    throw new ApiError(422, "invalid_input", message);
  }
  // 족자 상품(무진)은 '지금의 나'를 받는 별도 경로로 만든다. 메신저 상품은 기존 경로 그대로다.
  const readingId = findScrollProduct(parsed.data.productId) ? await createScrollReading(user.id, parsed.data) : await createReading(user.id, parsed.data);
  await supabase.rpc("delete_my_draft", { p_product_id: parsed.data.productId });
  return ok({ readingId }, 201);
});
