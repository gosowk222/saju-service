import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicBirthInput } from "sajuengine";
import type { MujinTimingBundle } from "@/domain/mujin/types";
import { computeMujinTiming } from "@/server/engine/mujin";
import { ScrollStepError } from "./config";
import { createScrollStore, isTimingBundle, scrollTimingKey, type AnalysisStore } from "./store";

/**
 * 9장(대운)·10장(앞으로 12개월) 기간 재료. 첫 유료 생성 때 고정한 기준일(fix_reference_date)로 한 번 계산해
 * reading_analyses(kind timing, cache_key mujin-timing:YYYY-MM-DD)에 저장하고, 재시도·재열람·후속 질문에서 그대로 쓴다.
 * 계산은 엔진 연결(computeMujinTiming)만 한다. 앱에서 대운·월운을 다시 계산하지 않는다.
 */

/**
 * 저장 한도. DB 제약은 jsonb 크기 256KiB 미만이다(pg_column_size). jsonb는 JSON 글자보다 클 수 있어 여유를 둔다.
 * 넘으면 분야별 원래 분석(analyses)을 줄이지 않고 오류로 알린다 (근거 ID·규칙 버전을 보존해야 한다).
 */
export const TIMING_PAYLOAD_LIMIT_BYTES = 200 * 1024;

export interface PrepareTimingInput {
  readonly readingId: string;
  readonly birth: PublicBirthInput;
  /** 첫 유료 생성 때 고정한 Asia/Seoul 기준일 (YYYY-MM-DD). fix_reference_date의 반환값을 넘긴다. */
  readonly referenceDate: string;
  /** 작성 계획의 성별 (plan.gender). 출생 입력의 성별과 같아야 한다. */
  readonly gender: "male" | "female";
}

/** 실행기용: 저장소와 계산 함수를 직접 받는다 (테스트는 가짜를 넣는다). */
export async function prepareScrollTimingWith(
  input: PrepareTimingInput & { readonly store: AnalysisStore; readonly compute?: typeof computeMujinTiming },
): Promise<MujinTimingBundle> {
  const { store, readingId, referenceDate } = input;
  const key = scrollTimingKey(referenceDate);
  const cached = await store.loadAnalysis<MujinTimingBundle>(readingId, key);
  if (isTimingBundle(cached, referenceDate)) return cached;

  const bundle = (input.compute ?? computeMujinTiming)({ birth: input.birth, referenceDate, gender: input.gender });
  const bytes = new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
  if (bytes >= TIMING_PAYLOAD_LIMIT_BYTES) throw new ScrollStepError("timing_too_large", false);

  const saved = await store.saveAnalysis(readingId, key, "timing", bundle.version, bundle);
  // 같은 기준일이면 계산 결과가 같으므로, 저장하지 못해도 이번 요청은 계산한 값으로 이어 간다 (다음 요청이 다시 계산한다).
  // 다른 요청이 먼저 저장했으면 그 값을 쓴다.
  return saved.saved && isTimingBundle(saved.payload, referenceDate) ? saved.payload : bundle;
}

/**
 * 고정된 기준일의 기간 재료를 돌려준다. 저장된 것이 있으면 다시 계산하지 않는다.
 * 후속 질문·PDF도 이 함수를 쓴다 (seoulDate() 대신 getReferenceDate로 읽은 기준일을 넘긴다).
 */
export async function prepareScrollTiming(input: PrepareTimingInput & { readonly admin: SupabaseClient }): Promise<MujinTimingBundle> {
  return prepareScrollTimingWith({ ...input, store: createScrollStore(input.admin) });
}
