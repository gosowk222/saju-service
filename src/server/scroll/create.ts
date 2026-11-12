import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateReadingInput } from "@/domain/birth/input";
import { EMPTY_NOW, MujinNowSchema } from "@/domain/mujin/now";
import { MUJIN_RULESET } from "@/domain/mujin/natal-links";
import { findScrollProduct } from "@/domain/products";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { resolveBirthDateNow, toPublicBirthInput } from "@/server/engine/analyze";
import { analyzeMujinBirth } from "@/server/engine/mujin";
import { PLACES_VERSION, PLACE_SOURCE_PREFIX, adminLabel, findPlace, placeLabel } from "@/server/places/search";

/** 회원당 시간당 풀이 기록 수 상한. 메신저 상품(src/server/readings/create.ts)과 같은 값이다. */
const READINGS_PER_HOUR = 30;

/**
 * 족자 상품(무진)의 풀이 기록을 만든다. 메신저 상품의 createReading과 같은 방식으로 입력을 서버에서 다시 검증하고
 * 엔진으로 원국과 원국 작성 계획을 만든다. LLM은 부르지 않는다 (무료 장은 풀이 화면이 생성 API로 쓴다).
 *
 * - 상황 선택지(situationId)는 메신저 상품용이라 받지 않는다. '지금의 나'(now)는 MujinNowSchema로 다시 검증한다.
 * - 궁금한 점 원문은 readings.concern에만 둔다. 범위 판정과 정리는 생성 단계가 한다.
 * - 기록은 수정하지 않는다. 입력을 고치면 새 기록을 만든다 (이전 이용권·결제와 섞이지 않게).
 * - 맛보기(preview)는 메신저 상품용이라 JSON null로 둔다 (칸은 비어 있을 수 없어 SQL null 대신 JSON null).
 */
export async function createScrollReading(userId: string, input: CreateReadingInput, deps: { readonly admin?: SupabaseClient } = {}): Promise<string> {
  const product = findScrollProduct(input.productId);
  if (!product) throw new ApiError(404, "unknown_product", "상품을 찾을 수 없어요.");
  if (input.situationId !== null) throw new ApiError(422, "invalid_situation", "이 상품은 '지금의 나'로 상황을 받아요. 입력을 다시 확인해 주세요.");

  const parsedNow = MujinNowSchema.safeParse(input.now ?? EMPTY_NOW);
  if (!parsedNow.success) throw new ApiError(422, "invalid_now", parsedNow.error.issues[0]?.message ?? "지금의 나를 다시 골라 주세요.");
  const now = parsedNow.data;

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

  let analysis: ReturnType<typeof analyzeMujinBirth>;
  try {
    analysis = analyzeMujinBirth({ birth, product, nickname: input.nickname, now });
  } catch {
    throw new ApiError(422, "calculation_failed", "이 정보로는 사주를 계산하지 못했어요. 입력을 확인해 주세요.");
  }

  const ruleset = analysis.plan.rulesets.find((entry) => entry.id === product.rulesetId);
  const admin = deps.admin ?? createSupabaseAdminClient();
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
      situation_id: null,
      // 소유자가 읽을 수 있는 칸이다. 검증한 선택 값만 넣고 내부 판단은 넣지 않는다.
      situation_detail: now,
      concern,
      chart: analysis.chart,
      preview: null,
      persona_id: analysis.persona.id,
      persona_version: analysis.persona.version,
      ruleset_id: product.rulesetId,
      ruleset_version: ruleset?.version ?? MUJIN_RULESET.version,
      engine_meta: analysis.engineMeta,
    },
    p_internals: { plan: analysis.plan, trace: analysis.trace },
  });
  if (error) {
    if ((error.message ?? "").includes("rate_limited")) throw new ApiError(429, "rate_limited", "잠시 후 다시 시도해 주세요.");
    throw new ApiError(500, "save_failed", "저장하지 못했어요. 다시 시도해 주세요.");
  }
  return data as string;
}
