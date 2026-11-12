import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inProductScope, type MujinConcernFact, type MujinQuestionInput } from "@/domain/mujin/personalize";
import type { ScrollTier, UserFactKind } from "@/domain/mujin/types";
import type { ProductBase, QuestionDomain, ScrollProductDefinition } from "@/domain/products/types";
import type { ExcludedQuestion } from "@/domain/reading/check";
import {
  QUESTION_DOMAINS,
  buildQuestionAnalysis,
  emptyAnalysis,
  excludedItems,
  inScopeItems,
  itemDomain,
  seoulDate,
  type QuestionAnalysis,
} from "@/domain/reading/question";
import type { LlmCallRecorder } from "@/server/llm/call-log";
import { callStructured, type LlmCallLog } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { buildMujinQuestionRequest, requestFields, type MujinBundle, type MujinQuestionOutput } from "@/server/llm/mujin-prompts";
import type { UsageMeter } from "@/server/llm/usage";
import { ScrollStepError } from "./config";
import { SCROLL_QUESTION_KEY, createScrollStore, type AnalysisStore } from "./store";

/**
 * 무진의 진짜 궁금한 점 정리. 질문 분류 호출은 풀이당 한 번이며(무료 단계에서 처음 계산), 결과를 reading_analyses에 저장해
 * 유료 단계·재시도·이어 쓰기에서 그대로 다시 쓴다. 같은 질문 ref(q1 …)가 단계마다 바뀌지 않게 하려는 것이다.
 *
 * - 범위 안·밖 판정은 서버가 상품 범위(scope)로 한다 (buildQuestionAnalysis). 사용자 문장이 범위·권한·출력 형식을 바꾸지 못한다.
 * - 범위 안 질문만 생성 입력(MujinQuestionInput)이 되고, 범위 밖 질문은 검사용(ExcludedQuestion)으로만 남는다.
 * - 사용자 사실은 종류(현재·과거·계획·가정·타인)를 보존하고, 범위 밖 분야의 사실은 버린다.
 * - 원문은 저장하지 않는다. 정리된 질문 문장(summary)과 사실 문장만 저장한다 (원문은 readings.concern에만 있다).
 * - 분류 실패(형식 오류·시간 초과)는 질문 없이 진행하지 않고 그 단계의 실패로 올린다 (호출한 쪽이 재시도 가능 여부를 정한다).
 */

export const SCROLL_QUESTION_VERSION = "mujin-question-analysis-1.0.0";

/** 사실 문장 수 상한. 궁금한 점은 200자 안이라 실제로는 몇 개뿐이다. */
const MAX_CONCERN_FACTS = 5;
const FACT_MAX_CHARS = 100;
const USER_FACT_KINDS: readonly UserFactKind[] = ["current", "past", "plan", "hypothetical", "about-others"];

/** 정리된 사용자 사실 하나 (종류 보존). */
export interface ScrollConcernFactRecord {
  readonly text: string;
  readonly domain: QuestionDomain;
  readonly kind: UserFactKind;
}

/** reading_analyses(kind question, cache_key mujin-question:initial)에 저장하는 값. */
export interface ScrollQuestionAnalysis {
  readonly version: typeof SCROLL_QUESTION_VERSION;
  /** 질문 정리 지시·형식 버전 (bundle.questionPrompt, bundle.questionSchema). */
  readonly promptVersion: string;
  readonly schemaVersion: string;
  /** 서버가 상품 범위를 적용한 질문 분석 (질문 ref는 items[].id). */
  readonly analysis: QuestionAnalysis;
  readonly facts: readonly ScrollConcernFactRecord[];
}

export interface PreparedScrollQuestions {
  readonly analysis: QuestionAnalysis;
  /** 범위 안 질문. ref는 질문 분석의 id(q1 …)이며 단계가 바뀌어도 같다. */
  readonly questions: readonly MujinQuestionInput[];
  readonly concernFacts: readonly MujinConcernFact[];
  /** 범위 밖으로 뺀 질문. 생성 입력에 넣지 않고 검사(재유입 확인)에만 쓴다. */
  readonly excluded: readonly ExcludedQuestion[];
  /** 이번 호출에서 질문을 새로 정리했는가 (true면 분류 호출을 한 번 했다). */
  readonly fresh: boolean;
}

export interface ScrollClassifyInput {
  readonly product: ScrollProductDefinition;
  readonly concern: string;
  readonly bundle: MujinBundle;
  /** 'Asia/Seoul' 기준 날짜. '내년 상반기' 같은 기간을 읽는 기준이다. */
  readonly referenceDate: string;
  readonly modelId: string;
  readonly deadlineAt: number;
  readonly meter?: UsageMeter;
  readonly onCall?: (log: LlmCallLog) => void;
}

/** 질문 정리 호출 하나. 테스트는 같은 모양의 가짜를 넣는다. */
export type ScrollClassifier = (input: ScrollClassifyInput) => Promise<MujinQuestionOutput>;

/** 무진 질문 정리 요청(buildMujinQuestionRequest)을 callStructured로 보낸다. 작업 설정은 기존 질문 정리(classify)와 같다. */
export function scrollClassifier(call: typeof callStructured = callStructured): ScrollClassifier {
  return async (input) => {
    const task = LLM_SETTINGS.tasks.classify;
    // 질문 정리는 캐릭터 문장을 쓰지 않으므로 문답 예시가 없다.
    const request = requestFields(buildMujinQuestionRequest({ product: input.product, concern: input.concern, referenceDate: input.referenceDate, bundle: input.bundle }));
    const result = await call({
      ...request,
      model: input.modelId,
      reasoningEffort: task.reasoningEffort,
      maxOutputTokens: task.maxOutputTokens,
      timeoutMs: task.timeoutMs,
      deadlineAt: input.deadlineAt,
      meter: input.meter,
      onCall: input.onCall,
    });
    return result.parsed;
  };
}

const isQuestionDomain = (value: string): value is QuestionDomain => (QUESTION_DOMAINS as readonly string[]).includes(value);
const asQuestionDomain = (value: string): QuestionDomain => (isQuestionDomain(value) ? value : "general");
const isFactKind = (value: string): value is UserFactKind => (USER_FACT_KINDS as readonly string[]).includes(value);

/** buildQuestionAnalysis와 같은 방식으로 정리한다: 제어 문자·꺾쇠 제거, 공백 정리, 길이 제한. */
const clean = (value: string, max: number) =>
  value
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** 분류기의 사용자 사실을 정리한다. 종류를 모르는 사실은 계획·가정이 현재 사실로 바뀌지 않게 버린다. */
function cleanFacts(raw: readonly { readonly text: string; readonly domain: string; readonly kind: string }[]): ScrollConcernFactRecord[] {
  return raw
    .flatMap((fact) => {
      const text = clean(fact.text, FACT_MAX_CHARS);
      return text && isFactKind(fact.kind) ? [{ text, domain: asQuestionDomain(fact.domain), kind: fact.kind }] : [];
    })
    .slice(0, MAX_CONCERN_FACTS);
}

/**
 * 저장된 질문 분석을 생성 입력으로 바꾼다 (순수 함수). 후속 질문처럼 다른 곳에서 정리한 결과에도 쓴다.
 * - questions: 범위 안 질문만. ref는 분석의 id(q1 …), topicDomain은 상품 연결(scope.routes)을 적용한 분야.
 * - concernFacts: 상품 범위 안 분야의 사실만, 종류(kind) 그대로. 빈 문장과 종류를 모르는 사실은 버린다.
 * - excluded: 범위 밖 질문의 정리된 문장과 분야 (검사용).
 * 상품 범위는 지금 상품 설정으로 다시 확인한다 (저장 뒤 범위가 좁아졌으면 그 질문은 쓰지 않는다).
 */
export function toScrollQuestions(
  analysis: QuestionAnalysis,
  facts: readonly { readonly text: string; readonly domain: string; readonly kind: string }[],
  product: Pick<ProductBase, "scope">,
): { readonly questions: MujinQuestionInput[]; readonly concernFacts: MujinConcernFact[]; readonly excluded: ExcludedQuestion[] } {
  const questions = inScopeItems(analysis)
    .filter((item) => inProductScope(product, item.domain))
    .map(
      (item): MujinQuestionInput => ({
        ref: item.id,
        summary: item.summary,
        domain: item.domain,
        topicDomain: itemDomain(item),
        intent: item.intent,
        answerability: item.answerability,
        missingInfo: item.missingInfo,
        timingSupported: item.timingSupported,
      }),
    );
  const concernFacts = facts.flatMap((fact): MujinConcernFact[] => {
    const text = fact.text.trim();
    const domain = asQuestionDomain(fact.domain);
    return text && isFactKind(fact.kind) && inProductScope(product, domain) ? [{ text, domain, kind: fact.kind }] : [];
  });
  const excluded = excludedItems(analysis).map(({ summary, domain }) => ({ summary, domain }));
  return { questions, concernFacts, excluded };
}

function isStoredAnalysis(value: unknown): value is ScrollQuestionAnalysis {
  const stored = value as Partial<ScrollQuestionAnalysis> | null;
  return !!stored && stored.version === SCROLL_QUESTION_VERSION && !!stored.analysis && Array.isArray(stored.analysis.items) && Array.isArray(stored.facts);
}

export interface PrepareQuestionsInput {
  readonly readingId: string;
  readonly userId: string;
  readonly product: ScrollProductDefinition;
  /** readings.concern 원문. 질문 정리 요청에만 넣는다. */
  readonly concern: string;
  readonly modelId: string;
  readonly deadlineAt: number;
  readonly recorder: LlmCallRecorder;
  readonly tier: ScrollTier;
  readonly bundle: MujinBundle;
  readonly meter?: UsageMeter;
  /** 질문 정리 호출. 없으면 실제 호출(callStructured)을 쓴다. */
  readonly classify?: ScrollClassifier;
  /** 기준일을 정할 현재 시각 (epoch ms). 없으면 Date.now. */
  readonly now?: () => number;
}

/** 실행기용: 저장소를 직접 받는다 (테스트는 가짜 저장소를 넣는다). */
export async function prepareScrollQuestionsWith(input: PrepareQuestionsInput & { readonly store: AnalysisStore }): Promise<PreparedScrollQuestions> {
  const { store, readingId, product, bundle } = input;
  const now = input.now ?? Date.now;
  const stored = await store.loadAnalysis<ScrollQuestionAnalysis>(readingId, SCROLL_QUESTION_KEY);
  if (isStoredAnalysis(stored)) return { ...toScrollQuestions(stored.analysis, stored.facts, product), analysis: stored.analysis, fresh: false };

  const referenceDate = seoulDate(new Date(now()));
  const concern = input.concern.trim();
  // 궁금한 점이 없으면 부르지 않고 저장하지도 않는다.
  if (!concern) return { analysis: emptyAnalysis(referenceDate), questions: [], concernFacts: [], excluded: [], fresh: false };

  const task = LLM_SETTINGS.tasks.classify;
  const classify = input.classify ?? scrollClassifier();
  const raw = await classify({
    product,
    concern,
    bundle,
    referenceDate,
    modelId: input.modelId,
    deadlineAt: input.deadlineAt,
    meter: input.meter,
    onCall: input.recorder.forCall({
      readingId,
      userId: input.userId,
      productId: product.id,
      tier: input.tier,
      step: "classify",
      unitId: null,
      promptVersion: bundle.questionPrompt,
      schemaVersion: bundle.questionSchema,
      personaVersion: null,
      reasoningEffort: task.reasoningEffort,
    }),
  });
  const record: ScrollQuestionAnalysis = {
    version: SCROLL_QUESTION_VERSION,
    promptVersion: bundle.questionPrompt,
    schemaVersion: bundle.questionSchema,
    analysis: buildQuestionAnalysis(product, referenceDate, raw),
    facts: cleanFacts(raw.userFacts),
  };
  const saved = await store.saveAnalysis(readingId, SCROLL_QUESTION_KEY, "question", SCROLL_QUESTION_VERSION, record);
  // 저장하지 못한 분석으로 장을 쓰면 다음 요청이 다시 분류해 질문 ref가 바뀔 수 있다. 이 단계를 실패로 올려 다시 시도하게 한다.
  if (!saved.saved) throw new ScrollStepError("analysis_save_failed", true);
  // 같은 키를 다른 요청이 먼저 저장했으면 그 값을 쓴다.
  const kept = isStoredAnalysis(saved.payload) ? saved.payload : record;
  return { ...toScrollQuestions(kept.analysis, kept.facts, product), analysis: kept.analysis, fresh: true };
}

/**
 * 진짜 궁금한 점을 정리해 생성 입력으로 돌려준다 (명세 3절). 저장된 분석이 있으면 그대로 쓰고(호출 없음),
 * 없고 궁금한 점이 비어 있으면 저장하지 않고 빈 결과를 돌려준다(호출 없음). 그 밖에는 한 번 분류해 저장한다.
 * 호출은 onCall 태그(step classify, tier, unitId null)로 llm_calls에 남는다.
 */
export async function prepareScrollQuestions(input: PrepareQuestionsInput & { readonly admin: SupabaseClient }): Promise<PreparedScrollQuestions> {
  return prepareScrollQuestionsWith({ ...input, store: createScrollStore(input.admin) });
}
