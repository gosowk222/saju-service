import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicBirthInput } from "sajuengine";
import type { ProductDefinition } from "@/domain/products/types";
import type { ExcludedQuestion } from "@/domain/reading/check";
import { buildNarrationPlan, requestedTimingKey } from "@/domain/reading/focus";
import {
  QUESTION_ANALYSIS_VERSION,
  emptyAnalysis,
  excludedItems,
  inScopeItems,
  itemDomain,
  seoulDate,
  type QuestionAnalysis,
  type QuestionItem,
} from "@/domain/reading/question";
import type { NarrationPlanV2, ReadingPlanV2, TimingAnalysis } from "@/domain/reading/types";
import type { TimingDomain } from "@/domain/rules/timing";
import { TIMING_ANALYSIS_VERSION, analyzeTiming } from "@/server/engine/timing";
import type { LlmUsage } from "@/server/llm/client";
import { classifyQuestion, mergeUsage } from "@/server/llm/narrate";

/**
 * 질문 분석과 기간 재료를 풀이별로 저장하고 다시 쓴다.
 * 생성 재시도와 후속 질문에서 같은 분류와 같은 기간 계산을 반복하지 않기 위해서다.
 */

type Admin = SupabaseClient;

export const INITIAL_QUESTION_KEY = "question:initial";

export function timingCacheKey(domain: string, startMonth: string, endMonth: string, referenceDate: string): string {
  return `timing:${domain}:${startMonth}..${endMonth}@${referenceDate}`;
}

/**
 * 분석 저장소는 같은 분류·계산을 반복하지 않기 위한 보조 기능이다. 조회나 저장이 실패해도
 * (예: migration 미적용, 일시적 DB 오류) 결제한 풀이의 생성을 막지 않고 저장 없이 계속한다.
 * 로그에는 저장소 오류 코드만 남긴다.
 */
function warnCache(op: "load" | "save", error: { code?: string } | null) {
  console.warn("[analysis] cache unavailable", { op, code: error?.code ?? "unknown" });
}

export async function loadAnalysis<T>(admin: Admin, readingId: string, cacheKey: string): Promise<T | null> {
  const { data, error } = await admin.from("reading_analyses").select("payload").eq("reading_id", readingId).eq("cache_key", cacheKey).maybeSingle();
  if (error) {
    warnCache("load", error);
    return null;
  }
  return ((data as { payload: T } | null)?.payload ?? null) as T | null;
}

/** 이미 같은 키가 저장돼 있으면 그 값을 돌려준다. 동시에 계산한 두 요청이 서로 다른 값을 쓰지 않게 한다. */
export async function saveAnalysis<T>(admin: Admin, readingId: string, cacheKey: string, kind: "question" | "timing", version: string, payload: T): Promise<T> {
  const { data, error } = await admin.rpc("save_reading_analysis", {
    p_reading_id: readingId,
    p_cache_key: cacheKey,
    p_kind: kind,
    p_version: version,
    p_payload: payload,
  });
  if (error) {
    warnCache("save", error);
    return payload;
  }
  return (data as T | null) ?? payload;
}

export interface PreparedTiming {
  readonly requestKey: string;
  readonly analysis: TimingAnalysis;
}

/** 범위 안의 시기 질문에 필요한 기간 재료. 저장된 것이 있으면 계산하지 않는다. */
export async function timingFor(input: {
  readonly admin: Admin;
  readonly readingId: string;
  readonly birth: PublicBirthInput;
  readonly items: readonly QuestionItem[];
  readonly referenceDate: string;
}): Promise<{ readonly timing: PreparedTiming[]; readonly computed: number }> {
  const requests = new Map<string, { domain: TimingDomain; item: QuestionItem }>();
  for (const item of input.items) {
    const key = requestedTimingKey(item);
    const domain = itemDomain(item);
    if (key && domain && !requests.has(key)) requests.set(key, { domain: domain as TimingDomain, item });
  }
  const timing: PreparedTiming[] = [];
  const missing: { requestKey: string; cacheKey: string; domain: TimingDomain; item: QuestionItem }[] = [];
  for (const [requestKey, { domain, item }] of requests) {
    const cacheKey = timingCacheKey(domain, item.period!.startMonth, item.period!.endMonth, input.referenceDate);
    const cached = await loadAnalysis<TimingAnalysis>(input.admin, input.readingId, cacheKey);
    if (cached) timing.push({ requestKey, analysis: cached });
    else missing.push({ requestKey, cacheKey, domain, item });
  }
  if (missing.length) {
    const computed = analyzeTiming({
      birth: input.birth,
      referenceDate: input.referenceDate,
      requests: missing.map(({ domain, item }) => ({ domain, period: item.period! })),
    });
    for (const [index, entry] of missing.entries()) {
      const saved = await saveAnalysis(input.admin, input.readingId, entry.cacheKey, "timing", TIMING_ANALYSIS_VERSION, computed[index]!);
      timing.push({ requestKey: entry.requestKey, analysis: saved });
    }
  }
  return { timing, computed: missing.length };
}

export interface PreparedNarration {
  readonly plan: NarrationPlanV2;
  readonly analysis: QuestionAnalysis;
  readonly excluded: readonly ExcludedQuestion[];
  readonly llmCalls: number;
  readonly usage: LlmUsage | null;
  readonly versions: Record<string, unknown>;
}

/**
 * 최초 풀이의 작성 계획을 완성한다.
 * 궁금한 점이 비어 있으면 분류기를 부르지 않는다. 분석 결과는 저장해 두고 재시도할 때 다시 쓴다.
 */
export async function prepareNarration(input: {
  readonly admin: Admin;
  readonly readingId: string;
  readonly base: ReadingPlanV2;
  readonly product: ProductDefinition;
  readonly birth: PublicBirthInput;
  readonly concern: string;
  readonly modelId: string;
  readonly deadlineAt: number;
}): Promise<PreparedNarration> {
  const { admin, readingId, base, product, birth, concern, modelId, deadlineAt } = input;
  let llmCalls = 0;
  let usage: LlmUsage | null = null;

  let analysis = await loadAnalysis<QuestionAnalysis>(admin, readingId, INITIAL_QUESTION_KEY);
  if (!analysis) {
    const referenceDate = seoulDate();
    if (concern.trim()) {
      const classified = await classifyQuestion({ product, referenceDate, mode: "initial", text: concern, lastTurn: null, modelId, deadlineAt });
      llmCalls += classified.meta.llmCalls;
      usage = mergeUsage(usage, classified.meta.usage);
      analysis = classified.analysis;
    } else {
      analysis = emptyAnalysis(referenceDate);
    }
    analysis = await saveAnalysis(admin, readingId, INITIAL_QUESTION_KEY, "question", QUESTION_ANALYSIS_VERSION, analysis);
  }

  const { timing, computed } = await timingFor({ admin, readingId, birth, items: inScopeItems(analysis), referenceDate: analysis.referenceDate });
  const plan = buildNarrationPlan({ base, product, analysis, timing });
  return {
    plan,
    analysis,
    excluded: excludedItems(analysis).map(({ summary, domain }) => ({ summary, domain })),
    llmCalls,
    usage,
    versions: {
      planVersion: base.planVersion,
      rulesetVersion: base.rulesetVersion,
      productVersion: base.productVersion,
      personaVersion: base.personaVersion,
      questionAnalysis: { version: analysis.version, source: analysis.source, items: analysis.items.length, excluded: excludedItems(analysis).length },
      timing: timing.map((entry) => ({ version: entry.analysis.version, domain: entry.analysis.domain, window: entry.analysis.window, status: entry.analysis.status })),
      timingComputed: computed,
    },
  };
}
