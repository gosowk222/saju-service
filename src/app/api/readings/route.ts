import { CreateReadingSchema } from "@/domain/birth/input";
import { ApiError, ok, readJson, route } from "@/server/api";
import { requireReadingAccess } from "@/server/access";
import { createReading } from "@/server/readings/create";

export const POST = route(async (request) => {
  const { user, supabase } = await requireReadingAccess();
  const parsed = CreateReadingSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "입력을 다시 확인해 주세요.";
    throw new ApiError(422, "invalid_input", message);
  }
  const readingId = await createReading(user.id, parsed.data);
  await supabase.rpc("delete_my_draft", { p_product_id: parsed.data.productId });
  return ok({ readingId }, 201);
});
