import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicBirthInput } from "sajuengine";
import type { MujinTimingBundle } from "@/domain/mujin/types";
import type { TimingAnalysis } from "@/domain/reading/types";
import { MUJIN_FEATURE_IDS } from "@/server/engine/features";
import { computeMujinTiming } from "@/server/engine/mujin";
import { TIMING_ANALYSIS_VERSION, analyzeTiming, type TimingFeatureIds, type TimingRequest } from "@/server/engine/timing";
import { ScrollStepError } from "./config";
import { createScrollStore, isTimingBundle, scrollExtraTimingKey, scrollTimingKey, type AnalysisStore } from "./store";

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

// ─── 후속 질문: 고정된 12개월 밖의 기간 ─────────────────────────────────────────────

/**
 * 무진 기간 계산의 기능 ID. 9·10장 기간 재료(computeMujinTiming)와 같다. 시각 미상에서도 세운·월운을 계산하는 무진 기능이고,
 * 대운 맥락은 무진 대운 기능으로 기존 기간 분석(analyzeTiming)과 같은 방식(기간의 첫 달·끝 달 기준)으로 붙인다.
 */
export const MUJIN_TIMING_FEATURES: TimingFeatureIds = { yearMonths: MUJIN_FEATURE_IDS.yearMonths, decade: MUJIN_FEATURE_IDS.luck };

export interface PrepareExtraTimingInput {
  readonly readingId: string;
  readonly birth: PublicBirthInput;
  /** 첫 유료 생성 때 고정한 기준일 (YYYY-MM-DD). 질문한 날이 아니다. 저장 키와 분석 기록의 기준일이 된다. */
  readonly referenceDate: string;
  /** 따로 계산할 분야와 기간 (사용자가 말한 기간 가운데 고정된 12개월 밖의 달, 절기 기준 월 이름). */
  readonly requests: readonly TimingRequest[];
}

/** 저장된 값이 그 분야·기준일의 기간 분석 모양인지. */
function isExtraTiming(value: unknown, request: TimingRequest, referenceDate: string): value is TimingAnalysis {
  const analysis = value as Partial<TimingAnalysis> | null;
  return (
    !!analysis &&
    analysis.version === TIMING_ANALYSIS_VERSION &&
    analysis.domain === request.domain &&
    analysis.referenceDate === referenceDate &&
    analysis.window?.kind === request.period.kind &&
    Array.isArray(analysis.months) &&
    Array.isArray(analysis.notable) &&
    Array.isArray(analysis.careful) &&
    Array.isArray(analysis.limitations)
  );
}

/**
 * 후속 질문이 고정된 12개월 밖의 기간을 물었을 때 그 기간만 계산한다 (묘묘 후속 질문의 기간 처리 timingFor와 같은 방식).
 * 요청마다 reading_analyses(kind timing, 키 scrollExtraTimingKey)에 저장된 것이 있으면 다시 계산하지 않고, 없는 것만 한 세션에서
 * 계산(analyzeTiming, 무진 기능)해 저장한다. 같은 키를 다른 요청이 먼저 저장했으면 그 값을 쓴다. 저장하지 못해도 계산한 값으로 답한다
 * (다음 질문이 다시 계산한다). 돌려주는 순서는 requests 순서다. 계산은 엔진 연결만 한다 (LLM 호출 없음).
 */
export async function prepareScrollExtraTimingWith(
  input: PrepareExtraTimingInput & { readonly store: AnalysisStore; readonly compute?: typeof analyzeTiming },
): Promise<TimingAnalysis[]> {
  const { store, readingId, referenceDate, requests } = input;
  const keyOf = (request: TimingRequest) => scrollExtraTimingKey(request.domain, request.period.startMonth, request.period.endMonth, referenceDate);
  const found = new Map<string, TimingAnalysis>();
  const missing: TimingRequest[] = [];
  for (const request of requests) {
    const key = keyOf(request);
    if (found.has(key) || missing.some((entry) => keyOf(entry) === key)) continue;
    const cached = await store.loadAnalysis<TimingAnalysis>(readingId, key);
    if (isExtraTiming(cached, request, referenceDate)) found.set(key, cached);
    else missing.push(request);
  }
  if (missing.length) {
    const computed = (input.compute ?? analyzeTiming)({ birth: input.birth, referenceDate, requests: missing, features: MUJIN_TIMING_FEATURES });
    for (const [index, request] of missing.entries()) {
      const analysis = computed[index]!;
      const saved = await store.saveAnalysis(readingId, keyOf(request), "timing", analysis.version, analysis);
      found.set(keyOf(request), saved.saved && isExtraTiming(saved.payload, request, referenceDate) ? saved.payload : analysis);
    }
  }
  return requests.map((request) => found.get(keyOf(request))!);
}

/** 서버 권한 클라이언트로 저장하는 prepareScrollExtraTimingWith. 후속 질문(scroll/followup.ts)이 쓴다. */
export async function prepareScrollExtraTiming(input: PrepareExtraTimingInput & { readonly admin: SupabaseClient }): Promise<TimingAnalysis[]> {
  return prepareScrollExtraTimingWith({ ...input, store: createScrollStore(input.admin) });
}
