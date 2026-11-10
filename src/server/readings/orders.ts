import "server-only";
import { findProduct } from "@/domain/products";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { getReading, type OrderRow } from "@/server/readings/store";

const PROVIDER = "toss";
const CURRENCY = "KRW";

/**
 * 주문을 만들며 상품, 가격, 계산 결과의 식별값과 버전을 고정한다.
 * 금액은 서버의 상품 설정만 쓴다. 같은 풀이의 대기 주문이 있으면 다시 쓴다.
 */
export async function createOrder(userId: string, readingId: string): Promise<OrderRow> {
  const supabase = await createSupabaseServerClient();
  const reading = await getReading(supabase, readingId);
  if (!reading) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");

  const product = findProduct(reading.product_id);
  if (!product) throw new ApiError(404, "unknown_product", "판매 중인 상품이 아니에요.");

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_order", {
    p_user_id: userId,
    p_reading_id: readingId,
    p_product_id: product.id,
    p_product_version: product.version,
    p_amount: product.priceKrw,
    p_currency: CURRENCY,
    p_provider: PROVIDER,
    p_binding: {
      productId: product.id,
      productVersion: product.version,
      priceKrw: product.priceKrw,
      questionLimit: product.followupLimit,
      readingId,
      engineFingerprint: reading.engine_meta.fingerprint,
      rulesetId: reading.ruleset_id,
      rulesetVersion: reading.ruleset_version,
      personaId: reading.persona_id,
      personaVersion: reading.persona_version,
      placeGeonameId: reading.place_snapshot.geonameId,
      placeDatasetVersion: reading.place_snapshot.datasetVersion,
    },
  });
  if (error) {
    if (error.message.includes("already_paid")) throw new ApiError(409, "already_paid", "이미 구매한 풀이예요.");
    if (error.message.includes("not_found")) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
    if (error.message.includes("reading_closed")) {
      throw new ApiError(409, "reading_closed", "이 풀이는 다시 시작할 수 없어요. 입력 수정에서 새로 만들어 주세요.");
    }
    throw new ApiError(500, "order_failed", "주문을 만들지 못했어요.");
  }
  return data as OrderRow;
}
