import "server-only";
import { type CreateReadingInput } from "@/domain/birth/input";
import { findProduct } from "@/domain/products";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { analyzeBirth, resolveBirthDateNow, toPublicBirthInput } from "@/server/engine/analyze";
import { PLACES_VERSION, PLACE_SOURCE_PREFIX, adminLabel, findPlace, placeLabel } from "@/server/places/search";

const READINGS_PER_HOUR = 30;

/**
 * 입력을 서버에서 다시 검증하고 엔진을 실행해 풀이 기록을 만든다.
 * 기록은 수정하지 않는다. 입력을 고치면 새 기록을 만들어 이전 주문과 섞이지 않게 한다.
 */
export async function createReading(userId: string, input: CreateReadingInput): Promise<string> {
  const product = findProduct(input.productId);
  if (!product) throw new ApiError(404, "unknown_product", "상품을 찾을 수 없어요.");

  const situation = product.situation.options.find((option) => option.id === input.situationId);
  if (input.situationId && !situation) throw new ApiError(422, "invalid_situation", "현재 상황을 다시 선택해 주세요.");
  if (product.situation.required && !situation) throw new ApiError(422, "situation_required", "현재 상황을 선택해 주세요.");
  const concern = product.concern.enabled ? input.concern : "";
  if (product.concern.required && !concern) throw new ApiError(422, "concern_required", "궁금한 점을 입력해 주세요.");

  const resolved = resolveBirthDateNow(input.yymmdd, input.calendar, input.isLeapMonth);
  if (!resolved.ok) throw new ApiError(422, `date_${resolved.code}`, resolved.message);

  // 브라우저가 보낸 좌표는 받지 않는다. 서버의 지역 자료에서 다시 찾는다.
  const place = findPlace(input.geonameId);
  if (!place || place.countryCode !== "KR") throw new ApiError(422, "invalid_place", "지역을 다시 선택해 주세요.");

  const label = placeLabel(place);
  const birth = toPublicBirthInput({
    birthDate: resolved.birthDate,
    calendar: input.calendar,
    isLeapMonth: resolved.isLeapMonth,
    gender: input.gender,
    birthTime: input.birthTime,
    birthPlace: {
      timezoneId: place.timezoneId,
      longitudeDeg: place.longitudeDeg,
      latitudeDeg: place.latitudeDeg,
      label,
      source: `${PLACE_SOURCE_PREFIX}:${place.geonameId}`,
    },
  });

  let analysis;
  try {
    analysis = analyzeBirth({
      birth,
      product,
      nickname: input.nickname,
      situationId: situation?.id ?? null,
      concern,
    });
  } catch {
    throw new ApiError(422, "calculation_failed", "이 정보로는 사주를 계산하지 못했어요. 입력을 확인해 주세요.");
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_reading", {
    p_user_id: userId,
    p_hourly_limit: READINGS_PER_HOUR,
    p_reading: {
      product_id: product.id,
      product_version: product.version,
      nickname: input.nickname,
      birth_input: analysis.birth,
      place_snapshot: {
        geonameId: place.geonameId,
        name: place.name,
        admin: adminLabel(place),
        label,
        countryCode: place.countryCode,
        latitudeDeg: place.latitudeDeg,
        longitudeDeg: place.longitudeDeg,
        timezoneId: place.timezoneId,
        datasetVersion: PLACES_VERSION,
      },
      situation_id: situation?.id ?? null,
      concern,
      chart: analysis.chart,
      preview: analysis.preview,
      persona_id: analysis.persona.id,
      persona_version: analysis.persona.version,
      ruleset_id: analysis.plan.rulesetId,
      ruleset_version: analysis.plan.rulesetVersion,
      engine_meta: analysis.engineMeta,
    },
    p_internals: { plan: analysis.plan, trace: analysis.trace },
  });
  if (error) {
    if (error.message.includes("rate_limited")) {
      throw new ApiError(429, "rate_limited", "잠시 후 다시 시도해 주세요.");
    }
    throw new ApiError(500, "save_failed", "저장하지 못했어요. 다시 시도해 주세요.");
  }
  return data as string;
}
