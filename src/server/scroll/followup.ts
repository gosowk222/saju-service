import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicBirthInput } from "sajuengine";
import { datesIn, materialTexts, TIMING_SECTION_IDS, timingDatesOf } from "@/domain/mujin/check";
import { chaptersForQuestion, MONTH_DOMAIN_LABEL, MONTH_DOMAINS, monthDomainOfQuestion, uniqueList } from "@/domain/mujin/personalize";
import { buildTimingSections } from "@/domain/mujin/timing-plan";
import {
  MUJIN_PLAN_VERSION,
  type MonthDomain,
  type MujinLuck,
  type MujinLuckPeriod,
  type MujinMaterial,
  type MujinMonth,
  type MujinMonths,
  type MujinPlan,
  type MujinSectionPlan,
  type MujinTimingBundle,
  type ScrollSectionContent,
} from "@/domain/mujin/types";
import { findPersona, type Persona } from "@/domain/personas";
import { findScrollProduct } from "@/domain/products";
import type { ProductDefinition, ScrollProductDefinition } from "@/domain/products/types";
import {
  CLARIFY_MAX,
  FOLLOWUP_SECTION_MAX,
  FOLLOWUP_TOTAL_MAX,
  checkExcluded,
  checkTextV2,
  percentsOf,
  type AllowedDates,
  type ExcludedQuestion,
} from "@/domain/reading/check";
import { tidyEmphasis } from "@/domain/reading/emphasis";
import { allowedChartTerms } from "@/domain/reading/lore";
import {
  addMonths,
  buildQuestionAnalysis,
  excludedItems,
  excludedLabel,
  inScopeFacts,
  inScopeItems,
  itemDomain,
  monthLabel,
  monthsBetween,
  reactionOf,
  seoulDate,
  type QuestionAnalysis,
  type QuestionItem,
} from "@/domain/reading/question";
import type { ChartView, FollowupOutputV2, TimingAnalysis } from "@/domain/reading/types";
import { TIMING_CAVEAT } from "@/domain/rules/timing";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { monthTone } from "@/server/engine/mujin";
import type { TimingRequest } from "@/server/engine/timing";
import { createCallRecorder, supabaseCallWriter, type LlmCallRecorder, type LlmCallStep } from "@/server/llm/call-log";
import { callStructured, callStructuredStream, isRetryableTransport, LlmError, type LlmCallLog, type StreamedResult } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import type { ExampleRecord } from "@/server/llm/example-block";
import {
  buildMujinFollowupRequest,
  MUJIN_FOLLOWUP_SCHEMA_VERSION,
  type MujinFollowupChapter,
  type MujinFollowupDelivered,
  type MujinFollowupPromptInput,
  type MujinFollowupQuestion,
  type MujinFollowupUserContext,
} from "@/server/llm/mujin-followup-prompt";
import { MUJIN_BUNDLE_VERSION, MUJIN_BUNDLES, type MujinBundle } from "@/server/llm/mujin-prompts";
import { buildQuestionPrompt, QUESTION_PROMPT_VERSION } from "@/server/llm/prompts";
import { followupParts, type StreamedFollowup } from "@/server/llm/stream-parts";
import { UsageMeter, type UsageSummary } from "@/server/llm/usage";
import { internalReason } from "@/server/log";
import type { FollowupResponse } from "@/server/readings/followup";
import { isReactionOnly, routeWithoutItems, type FollowupStatus } from "@/server/readings/followup-core";
import { ScrollStepError } from "./config";
import { SCROLL_QUESTION_VERSION, toScrollQuestions, type ScrollQuestionAnalysis } from "./questions";
import { createScrollStore, getReferenceDate, loadFinalSections, loadScrollReading, SCROLL_QUESTION_KEY } from "./store";
import { prepareScrollExtraTiming, prepareScrollTiming } from "./timing";

/**
 * 족자 상품(무진의 종합 사주)의 후속 질문. 묘묘(메신저)와 같은 정책을 쓰고 재료와 지시만 다르다.
 *
 * - 같은 것: 질문 횟수(entitlements.question_limit), 범위 판단(상품 scope), 차감(정상 답변만 한 번, 소질문 여러 개도 한 번),
 *   무료 반응 횟수, 되묻기·범위 밖 안내는 차감하지 않음, 분당 질문 수 제한, DB 함수 begin_followup·complete_followup·fail_followup,
 *   문단이 완성될 때마다 먼저 저장해 보여 주기, 출력 형식(followup-output-2.2.0), followups.usage의 합계.
 * - 다른 것
 *   · 질문 정리: 묘묘와 같은 질문 정리(question-1.3.0, mode followup, 직전 대화 참조)를 쓴다. 무진 질문 정리(mujin-question)는
 *     최초 풀이용이라 직전 대화를 받지 않는다. 이번 메시지의 사용자 사실은 '이번 메시지에서 한 말'로만 넘기고
 *     계획·가정을 현재 사실로 쓰지 않게 지시가 막는다.
 *   · 재료: 질문 분야와 이어지는 장(chaptersForQuestion)의 작성 재료와 그 장의 최종문 일부(상한까지), 원국 계산 사실, 지금의 나,
 *     처음 궁금한 점에서 정리한 사실. 기간 질문이면 첫 유료 생성 때 고정한 기준일(generation_jobs.reference_date)의 기간 재료를 쓴다.
 *     질문한 날짜로 기준일을 바꾸지 않는다 (명세 06 6절). 사용자가 말한 기간이 고정된 12개월 밖이면, 묘묘처럼 그 기간만 같은 기준일과
 *     무진 기능으로 계산해 reading_analyses에 저장하고 다시 쓴다 (prepareScrollExtraTiming). 계산한 달은 기간 자료(timing.months)와
 *     10장 재료에 더해, 지시의 '살펴본 기간'에 들어가게 한다 (지시 mujin-followup-1.0.0의 문장은 바꾸지 않는다).
 *   · 지시: mujin-followup-1.0.0 (characterBlock(무진)으로 시작, 묘묘 전용 반말 문구 없음). 후속 답변은 요청 하나 안에서 끝나므로
 *     묘묘처럼 지금 묶음(MUJIN_BUNDLE_VERSION)의 후속 지시와 그 묶음의 무진 설정을 쓴다. 버전은 followups.prompt_version과 analysis에 남는다.
 *   · 사용량: 호출마다 llm_calls에 step classify·followup, followupId, tier paid로도 남긴다. 기록 실패는 답변에 영향을 주지 않는다.
 *   · 기록: complete_followup의 analysis에 캐릭터 ID·버전, 묶음, 기간 기준일, 이어진 장을 남긴다.
 *
 * 로그에는 풀이 ID와 코드·숫자만 남긴다. 질문 원문, 생성 문장, 출생정보는 남기지 않는다.
 */

export interface FollowupInput {
  readonly userId: string;
  readonly readingId: string;
  readonly clientRequestId: string;
  readonly question: string;
}

export interface BeginResult {
  readonly outcome: "started" | "duplicate" | "busy" | "rate_limited" | "exhausted";
  readonly used: number;
  readonly limit: number;
  readonly followup?: { readonly id: string; readonly status: string; readonly answer: string | null };
}

export interface CompleteResult {
  readonly saved: boolean;
  readonly used: number;
  readonly limit: number;
}

/** 후속 답변에 쓰는 저장된 풀이 정보. 소유자의 풀이가 아니면 만들지 않는다. */
export interface ScrollFollowupContext {
  readonly productId: string;
  readonly personaId: string;
  readonly chart: ChartView;
  readonly birth: PublicBirthInput;
  readonly plan: MujinPlan;
  /** 장 ID별 최종문 (reading_sections.content). */
  readonly finals: ReadonlyMap<string, ScrollSectionContent>;
  /** 첫 유료 생성 때 고정한 기준일 (generation_jobs.reference_date, YYYY-MM-DD). */
  readonly referenceDate: string | null;
  /** 처음 진짜 궁금한 점을 정리해 저장한 결과 (생성 단계의 reading_analyses). 없거나 읽지 못하면 null. */
  readonly initialQuestions: Pick<ScrollQuestionAnalysis, "analysis" | "facts"> | null;
  /** 직전에 답한 후속 질문 한 번. 답은 600자로 자른다. */
  readonly lastTurn: { readonly question: string; readonly answer: string } | null;
}

/** 후속 질문의 저장소 작업. 기본값은 서버(service_role) 클라이언트이고, 테스트는 가짜를 넣는다. */
export interface ScrollFollowupStore {
  /** begin_followup. 권한 없음·완료 전·시작 실패는 ApiError로 바꿔 던진다. */
  readonly begin: (input: FollowupInput) => Promise<BeginResult>;
  readonly load: (readingId: string, userId: string) => Promise<ScrollFollowupContext | null>;
  /** 이 풀이에서 앞서 반응만 보낸 메시지 수 (무료 반응 횟수 판단). */
  readonly earlierReactions: (readingId: string) => Promise<number>;
  /** 문단까지 쓴 답을 저장한다. 이 요청이 더는 이 질문을 맡지 않으면 FollowupHandedOver를 던진다. */
  readonly publish: (followupId: string, answer: string) => Promise<void>;
  /** complete_followup. 저장 오류면 null. */
  readonly complete: (input: {
    readonly followupId: string;
    readonly userId: string;
    readonly status: FollowupStatus;
    readonly answer: string;
    readonly refs: readonly string[];
    readonly meta: Record<string, unknown>;
  }) => Promise<CompleteResult | null>;
  /** fail_followup. 호출이 있었으면 이미 쓴 사용량도 남긴다. */
  readonly fail: (input: { readonly followupId: string; readonly userId: string; readonly code: string; readonly usage: UsageSummary | null }) => Promise<void>;
}

export interface ScrollFollowupDeps {
  readonly store: ScrollFollowupStore;
  /** 이 질문 하나의 호출 단위 기록기 (llm_calls). */
  readonly recorder: () => LlmCallRecorder;
  readonly callStructured: typeof callStructured;
  readonly callStructuredStream: typeof callStructuredStream;
  /** 고정된 기준일의 기간 재료. 저장된 것이 있으면 다시 계산하지 않는다 (prepareScrollTiming). */
  readonly prepareTiming: (input: {
    readonly readingId: string;
    readonly birth: PublicBirthInput;
    readonly referenceDate: string;
    readonly gender: "male" | "female";
  }) => Promise<MujinTimingBundle>;
  /**
   * 고정된 12개월 밖을 물은 기간의 기간 분석 (질문 분야만, 고정 기준일, 무진 기능). 저장된 것이 있으면 다시 계산하지 않는다
   * (prepareScrollExtraTiming). requests 순서대로 돌려준다.
   */
  readonly prepareExtraTiming: (input: {
    readonly readingId: string;
    readonly birth: PublicBirthInput;
    readonly referenceDate: string;
    readonly requests: readonly TimingRequest[];
  }) => Promise<readonly TimingAnalysis[]>;
  readonly modelId: () => string;
  readonly now: () => number;
  /** 오늘 날짜 (Asia/Seoul). 질문 속 기간('내년 3월')을 읽는 기준이다. 기간 재료의 기준일은 바꾸지 않는다. */
  readonly today: () => string;
}

/** 시간이 지나 다른 요청이 이 질문을 실패로 정리했다. 더 저장하지 않는다. */
export class FollowupHandedOver extends Error {}

/** 함께 보내는 장의 상한 (한 메시지의 질문은 최대 4개다). 질문 분야의 장만 보내고 보고서 전체를 보내지 않는다. */
export const FOLLOWUP_MAX_CHAPTERS = 4;
/** 장 하나에서 함께 보내는 최종문의 글자 수 상한 (핵심 답 포함). */
export const DELIVERED_MAX_CHARS = 1_200;
/** 넓은 질문에 함께 보내는 장별 핵심 답의 글자 수 상한. */
export const OVERVIEW_ANSWER_MAX_CHARS = 200;
/** 호출 기록 저장을 기다리는 최대 시간. 기록 저장이 늦어도 답변 응답을 붙잡지 않는다. */
const CALL_LOG_FLUSH_MS = 5_000;

type MujinTiming = { readonly luck: MujinLuck; readonly months: MujinMonths };

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);
/** 굵게 표시(**)를 뺀 글. 이미 보낸 문장을 재료로 넘길 때 표시까지 옮겨 적지 않게 한다. */
const plain = (text: string) => text.replace(/\*\*/g, "").trim();

// ─── 재료 고르기 ─────────────────────────────────────────────

/**
 * 장 하나의 최종문 일부. 핵심 답과 블록 글(비교·점검 항목 포함)을 목차 순서대로 담고 상한에서 자른다.
 * 블록의 근거 연결(refs)과 질문 ID는 넣지 않는다.
 */
export function deliveredOf(content: ScrollSectionContent | undefined, max = DELIVERED_MAX_CHARS): MujinFollowupDelivered | null {
  if (!content) return null;
  const coreAnswer = clip(plain(content.coreAnswer), max);
  let budget = max - coreAnswer.length;
  const blocks: { type: MujinFollowupDelivered["blocks"][number]["type"]; text: string }[] = [];
  for (const block of content.blocks) {
    if (budget <= 0) break;
    const text = plain([block.text, ...block.items.map((item) => (item.label ? `${item.label}: ${item.text}` : item.text))].filter((part) => part.trim()).join("\n"));
    if (!text) continue;
    const kept = clip(text, budget);
    blocks.push({ type: block.type, text: kept });
    budget -= kept.length;
  }
  return { coreAnswer, blocks };
}

/** 계획의 작성용 ref(m1, m2 …) 가운데 가장 큰 번호. 9·10장 재료는 그 다음 번호부터 만든다 (생성 단계와 같은 방식). */
export function lastRefNumber(plan: MujinPlan): number {
  const refs = [...plan.facts, ...plan.nowFacts, ...plan.sections.flatMap((section) => section.materials)].map((material) => material.ref);
  return refs.reduce((max, ref) => {
    const match = /^m(\d+)$/.exec(ref);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

export interface FollowupMaterial {
  readonly questions: readonly MujinFollowupQuestion[];
  readonly chapters: readonly MujinFollowupChapter[];
  readonly overview: MujinFollowupPromptInput["overview"];
  /** 9·10장과 이어지는 질문이 있고 고정된 기간 재료가 있을 때만. */
  readonly timing: MujinTiming | null;
  /** 함께 보낸 장 ID (목차 순서). */
  readonly sectionIds: readonly string[];
}

/** 기간 자료(9장 대운, 10장 12개월)를 다루는 장. */
const TIMING_CHAPTERS = TIMING_SECTION_IDS;

/** 질문이 이어지는 장. 질문 분류 결과(분야·의도)로만 정한다 (사용자 문장의 단어로 찾지 않는다). */
export function chaptersOfItem(item: QuestionItem): readonly string[] {
  return chaptersForQuestion({ domain: item.domain, topicDomain: itemDomain(item), intent: item.intent });
}

/**
 * 함께 보낼 장을 고른다. 질문마다 한 장씩 돌아가며 고르므로 상한에 걸려도 모든 질문이 자기 장을 하나는 받는다.
 * 시기 질문은 기간 장(9·10장)을 먼저 받는다. 고른 장은 목차 순서로 둔다.
 */
function pickChapters(questions: readonly MujinFollowupQuestion[], order: readonly string[]): string[] {
  const queues = questions.map((question) =>
    question.intent === "timing"
      ? [...question.sectionIds.filter((id) => TIMING_CHAPTERS.has(id)), ...question.sectionIds.filter((id) => !TIMING_CHAPTERS.has(id))]
      : [...question.sectionIds],
  );
  const picked = new Set<string>();
  for (let round = 0; picked.size < FOLLOWUP_MAX_CHAPTERS && queues.some((queue) => queue.length > round); round += 1) {
    for (const queue of queues) {
      const id = queue[round];
      if (id !== undefined && picked.size < FOLLOWUP_MAX_CHAPTERS) picked.add(id);
    }
  }
  return order.filter((id) => picked.has(id));
}

// ─── 고정된 12개월 밖의 기간 ─────────────────────────────────────────────

const earlierMonth = (a: string, b: string) => (a < b ? a : b);
const laterMonth = (a: string, b: string) => (a > b ? a : b);

/**
 * 고정된 12개월 밖을 물은 기간 질문에서 따로 계산할 분야와 기간을 고른다 (순수 함수).
 * 묘묘의 기간 질문 처리(timingFor)와 같은 조건이다: 기간 판단 규칙이 있는 분야의 시기 질문(timingSupported)이고, 사용자가 기간을
 * 말했으며(explicit), 그 길이가 상품 timing.maxMonths 안이다. 분야는 10장 월운 분야로 읽는다(투자는 재물, 친구는 인간관계).
 * 12개월과 겹치는 달은 이미 있는 재료를 쓰고, 밖의 달(앞·뒤 구간)만 고른다. 같은 분야·기간은 한 번만 고른다.
 * 기간을 말하지 않은 시기 질문(default)은 지금처럼 고정된 12개월로 답한다.
 */
export function extraTimingRequests(input: {
  readonly items: readonly QuestionItem[];
  /** 고정된 12개월 (MujinMonths.window, 절기 기준 월 이름). */
  readonly window: { readonly startMonth: string; readonly endMonth: string };
  readonly product: Pick<ScrollProductDefinition, "timing">;
}): TimingRequest[] {
  const { startMonth: windowStart, endMonth: windowEnd } = input.window;
  const requests = new Map<string, TimingRequest>();
  for (const item of input.items) {
    const period = item.period;
    const domain = monthDomainOfQuestion({ domain: item.domain, topicDomain: itemDomain(item) });
    if (!item.timingSupported || period?.kind !== "explicit" || !domain) continue;
    if (!(input.product.timing.domains as readonly string[]).includes(domain)) continue;
    if (monthsBetween(period.startMonth, period.endMonth) > input.product.timing.maxMonths) continue;
    const segments: { readonly startMonth: string; readonly endMonth: string }[] = [];
    if (period.startMonth < windowStart) segments.push({ startMonth: period.startMonth, endMonth: earlierMonth(period.endMonth, addMonths(windowStart, -1)) });
    if (period.endMonth > windowEnd) segments.push({ startMonth: laterMonth(period.startMonth, addMonths(windowEnd, 1)), endMonth: period.endMonth });
    for (const segment of segments) {
      const key = `${domain}:${segment.startMonth}..${segment.endMonth}`;
      if (!requests.has(key)) requests.set(key, { domain, period: { kind: "explicit", ...segment } });
    }
  }
  return [...requests.values()];
}

/** 따로 살펴본 기간 재료의 작성 조건. 10장 재료(domain/mujin/timing-plan.ts)와 같은 기준이다. */
const EXTRA_CAVEAT = {
  month: "절기 기준 월이라 달력의 1일과 경계가 다르다.",
  scope: "질문하신 분야만 따로 살펴본 기간이다. 같은 달의 다른 분야는 살펴보지 않았다.",
  quiet: "표지가 없는 달은 이 분야를 밀어 주거나 막는 뚜렷한 표지가 없다는 뜻이며 좋다·나쁘다는 판정이 아니다.",
  mixed: "같은 달에 긍정과 주의 표지가 함께 있으면 둘을 함께 말한다.",
  careful: "주의 표지는 조건을 더 점검할 달이라는 뜻이며 실패·사고·손실이 생기는 날이라는 뜻이 아니다.",
  activity: "지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다.",
} as const;

type ExtraStatement = TimingAnalysis["months"][number];

const VERDICT_TEXT: Readonly<Record<ExtraStatement["verdict"], string>> = {
  notable: "긍정 표지가 있는 달",
  mixed: "긍정·주의 표지가 함께 있는 달",
  careful: "주의 표지가 있는 달",
  quiet: "중립 표지만 있는 달",
};

/** 기간 규칙(rules/timing.ts)의 결론 상태와 같은 대응. 저장된 기간 분석에는 상태 대신 verdict가 남는다. */
const STATUS_OF_VERDICT: Readonly<Record<ExtraStatement["verdict"], NonNullable<MujinMaterial["status"]>>> = {
  notable: "candidate",
  mixed: "deferred",
  careful: "observation",
  quiet: "observation",
};

const MARKER_TONE_TEXT: Readonly<Record<string, string>> = { positive: "긍정", caution: "주의", neutral: "중립" };

/** YYYY-MM-DD 두 개 → "(7월 7일~8월 6일)". 10장 재료와 같은 표기다. */
function rangeTextOf(startsOn: string | null, endsOn: string | null): string {
  const day = (date: string | null) => {
    const match = date ? /^\d{4}-(\d{2})-(\d{2})$/.exec(date) : null;
    return match ? `${Number(match[1])}월 ${Number(match[2])}일` : null;
  };
  const start = day(startsOn);
  const end = day(endsOn);
  return start && end ? `(${start}~${end})` : "";
}

const domainLabelOf = (domain: string) => MONTH_DOMAIN_LABEL[domain as MonthDomain] ?? domain;

/** "2028년 7월부터 2028년 12월까지" (절기 기준 월 이름). */
const spanLabel = (analysis: TimingAnalysis) => `${monthLabel(analysis.window.startMonth)}부터 ${monthLabel(analysis.window.endMonth)}까지`;

/**
 * 따로 계산한 기간 분석을 10장 재료로 옮긴다 (계산하지 않는다). 분석마다 기간 안내(engine-fact) 하나와, 표지가 있는 달마다
 * 그 달·분야의 직접 근거로 내린 기간 판단(period) 하나를 만든다. 결론의 규칙·근거 ID는 서버 기록으로만 남고 지시 입력에는 들어가지 않는다.
 */
function extraTimingMaterials(input: {
  readonly extra: readonly TimingAnalysis[];
  readonly startRef: number;
  readonly fixedLabel: string;
  readonly referenceDate: string;
}): MujinMaterial[] {
  let next = input.startRef;
  const take = () => `m${next++}`;
  const materials: MujinMaterial[] = [];
  for (const analysis of input.extra) {
    const label = domainLabelOf(analysis.domain);
    // 기간 분석은 계산을 마친 결과에만 TIMING_CAVEAT를 붙인다. 계산하지 못한 기간을 '표지 없음'으로 말하지 않게 나눈다.
    const computed = analysis.limitations.includes(TIMING_CAVEAT);
    const empty = !computed ? " 이 기간의 이 분야는 계산하지 못했다." : analysis.months.length ? "" : " 이 기간에는 이 분야와 바로 이어지는 표지를 찾지 못했다.";
    materials.push({
      ref: take(),
      kind: "engine-fact",
      questionIds: [],
      scope: "period",
      text:
        `질문하신 기간 ${spanLabel(analysis)}(절기 기준 월)의 ${label} 분야를 보고서와 같은 기준일(${input.referenceDate})과 같은 기간 판단 규칙으로 따로 살펴봤다. ` +
        `보고서 10장의 12개월(${input.fixedLabel}) 밖의 기간이다.${empty}`,
      caveats: uniqueList([EXTRA_CAVEAT.month, EXTRA_CAVEAT.scope, ...(computed ? [EXTRA_CAVEAT.quiet] : []), ...analysis.limitations]),
    });
    for (const statement of analysis.months) {
      const notable = analysis.notable.includes(statement.periodId);
      const careful = analysis.careful.includes(statement.periodId);
      const contextual = uniqueList(statement.contextualEvidenceIds);
      const supporting = uniqueList(statement.supportingEvidenceIds).filter((id) => !contextual.includes(id));
      const counter = uniqueList(statement.counterEvidenceIds).filter((id) => !contextual.includes(id) && !supporting.includes(id));
      materials.push({
        ref: take(),
        kind: "period",
        questionIds: [],
        scope: "period",
        text: `${statement.label}${rangeTextOf(statement.startsOn, statement.endsOn)}: ${label} ${VERDICT_TEXT[statement.verdict]}${notable ? "(주목 구간)" : careful ? "(주의 구간)" : ""} — ${statement.statement}`,
        aspect: notable ? "주목 구간" : careful ? "주의 구간" : "월별 판단",
        periodId: statement.periodId,
        status: STATUS_OF_VERDICT[statement.verdict],
        ruleId: statement.ruleId,
        ruleVersion: statement.ruleVersion,
        conclusionId: statement.conclusionId,
        evidence: { supporting, counter, contextual },
        basis: statement.markers.map((marker) => `${label} ${MARKER_TONE_TEXT[marker.tone] ?? "중립"} 표지: ${marker.text}`),
        action: uniqueList(statement.markers.map((marker) => marker.activity)).join("; "),
        caveats: uniqueList([
          TIMING_CAVEAT,
          EXTRA_CAVEAT.month,
          EXTRA_CAVEAT.activity,
          ...(statement.verdict === "mixed" ? [EXTRA_CAVEAT.mixed] : []),
          ...(statement.verdict === "careful" || careful ? [EXTRA_CAVEAT.careful] : []),
          // 12운성 재료는 작성 재료에 넣지 않으므로 그 사용을 알리는 한계 문장은 옮기지 않는다 (10장 재료와 같다).
          ...statement.caveats.filter((caveat) => !caveat.startsWith("12운성")),
        ]),
      });
    }
  }
  return materials;
}

/**
 * 기간 자료(timing.months)에 따로 살펴본 달을 더한다. 지시가 말하는 '살펴본 기간'에 질문한 기간이 들어가게 해,
 * 계산한 기간을 '보지 않았다'고 답하지 않게 한다. 달 이름·시작·끝 날짜와 표지 구성은 계산 결과 그대로다.
 * 따로 살펴본 달에서 계산하지 않은 분야는 '자료 없음'이고, 계산했지만 표지가 없는 분야는 '중립'이다. 달은 시작일 순서로 둔다.
 */
function withExtraMonths(months: MujinMonths, extra: readonly TimingAnalysis[]): MujinMonths {
  if (!extra.length) return months;
  const known = new Set(months.months.map((month) => month.periodId));
  // 기간 분석은 계산을 마친 결과에만 TIMING_CAVEAT를 붙인다 (computeMujinTiming과 같은 판단).
  const computed = extra.filter((analysis) => analysis.limitations.includes(TIMING_CAVEAT));
  const coveredBy = (domain: MonthDomain, month: string) =>
    computed.some((analysis) => analysis.domain === domain && analysis.window.startMonth <= month && month <= analysis.window.endMonth);

  const added = new Map<string, { readonly statement: ExtraStatement; readonly markers: Map<MonthDomain, MujinMonth["cells"][number]["markers"]> }>();
  for (const analysis of extra) {
    const domain = analysis.domain as MonthDomain;
    if (!MONTH_DOMAINS.includes(domain)) continue;
    for (const statement of analysis.months) {
      if (known.has(statement.periodId)) continue;
      const entry = added.get(statement.periodId) ?? { statement, markers: new Map() };
      entry.markers.set(
        domain,
        statement.markers.map(({ tone, text, activity }) => ({ tone, text, activity })),
      );
      added.set(statement.periodId, entry);
    }
  }
  const extraMonths: MujinMonth[] = [...added].map(([periodId, { statement, markers }]) => {
    const month = (statement.startsOn ?? "").slice(0, 7);
    return {
      periodId,
      label: statement.label,
      startsOn: statement.startsOn,
      endsOn: statement.endsOn,
      startedBeforeReference: false,
      cells: MONTH_DOMAINS.map((domain) => {
        const found = markers.get(domain);
        if (found) return { domain, tone: monthTone(found, true), markers: found };
        return { domain, tone: coveredBy(domain, month) ? ("neutral" as const) : ("no-data" as const), markers: [] };
      }),
    };
  });
  const order = (month: MujinMonth) => month.startsOn ?? "9999";
  const picks = (lists: MujinMonths["notable"], key: "notable" | "careful") =>
    MONTH_DOMAINS.filter((domain) => lists.some((entry) => entry.domain === domain) || extra.some((analysis) => analysis.domain === domain)).map((domain) => ({
      domain,
      periodIds: uniqueList([
        ...lists.filter((entry) => entry.domain === domain).flatMap((entry) => entry.periodIds),
        ...extra.filter((analysis) => analysis.domain === domain).flatMap((analysis) => analysis[key].filter((id) => added.has(id))),
      ]),
    }));
  const extraLabels = extra.map((analysis) => `${spanLabel(analysis)} ${domainLabelOf(analysis.domain)} 분야`);
  return {
    status: months.status === "available" || extraMonths.length ? "available" : months.status,
    window: { ...months.window, label: `${months.window.label}. 질문하신 기간으로 따로 살펴본 ${uniqueList(extraLabels).join(", ")} (절기 기준 월)` },
    months: [...months.months, ...extraMonths].sort((a, b) => order(a).localeCompare(order(b))),
    notable: picks(months.notable, "notable"),
    careful: picks(months.careful, "careful"),
    limitations: uniqueList([...months.limitations, ...extra.flatMap((analysis) => analysis.limitations)]),
  };
}

/**
 * 범위 안 질문에 답할 재료를 고른다 (순수 함수).
 * - 장: 질문 분야와 이어지는 장만, 질문마다 돌아가며 최대 FOLLOWUP_MAX_CHAPTERS개(목차 순서). 장마다 작성 재료와 소질문 상태, 최종문 일부.
 *   9·10장 재료는 고정된 기간 재료로 생성 단계와 같은 규칙(buildTimingSections)으로 다시 만든다.
 * - 특정 장과 이어지지 않는 넓은 질문: 장별 핵심 답(overview)과 마지막 정리의 최종문 일부.
 * - 기간 자료: 9·10장과 이어지는 질문이 있을 때만.
 * - 고정된 12개월 밖을 물은 기간(extra, extraTimingRequests로 고른 것): 10장 재료와 기간 자료에 그 기간의 달을 더한다.
 */
export function followupMaterial(input: {
  readonly plan: MujinPlan;
  readonly product: ScrollProductDefinition;
  readonly items: readonly QuestionItem[];
  readonly finals: ReadonlyMap<string, ScrollSectionContent>;
  readonly timing: MujinTimingBundle | null;
  /** 고정된 12개월 밖을 물은 기간의 기간 분석 (prepareScrollExtraTiming). timing이 있을 때만 쓴다. */
  readonly extra?: readonly TimingAnalysis[];
}): FollowupMaterial {
  const { plan, product, finals } = input;
  const order = product.scroll.sections.map((section) => section.id);
  const questions: MujinFollowupQuestion[] = input.items.map((item) => ({
    ref: item.id,
    summary: item.summary,
    domain: item.domain,
    intent: item.intent,
    answerability: item.answerability,
    missingInfo: item.missingInfo,
    timingSupported: item.timingSupported,
    period: item.period?.kind === "explicit" ? { start: item.period.startMonth, end: item.period.endMonth } : null,
    sectionIds: chaptersOfItem(item),
  }));
  const wanted = pickChapters(questions, order);
  const timingWanted = wanted.some((id) => TIMING_CHAPTERS.has(id));
  const bundle = timingWanted ? input.timing : null;
  const built = bundle ? buildTimingSections({ plan, bundle, product, startRef: lastRefNumber(plan) + 1 }) : null;
  const extra = bundle ? (input.extra ?? []) : [];
  // 따로 살펴본 기간의 재료는 10장 재료 뒤에 붙인다 (ref 번호는 9·10장 재료 다음부터).
  const extraMaterials =
    bundle && built && extra.length
      ? extraTimingMaterials({ extra, startRef: built.nextRef, fixedLabel: bundle.months.window.label, referenceDate: bundle.referenceDate })
      : [];
  const timingSections = (built?.sections ?? []).map((section) =>
    section.sectionId === "ch10" && extraMaterials.length ? { ...section, materials: [...section.materials, ...extraMaterials] } : section,
  );
  const planned = new Map<string, MujinSectionPlan>([...plan.sections, ...timingSections].map((section) => [section.sectionId, section] as const));

  const chapterOf = (sectionId: string): MujinFollowupChapter => {
    const spec = product.scroll.sections.find((section) => section.id === sectionId);
    const section = planned.get(sectionId);
    return {
      sectionId,
      title: section?.title ?? spec?.title ?? sectionId,
      questions: section
        ? section.questions.map(({ id, title, status, note }) => ({ id, title, status, note }))
        : (spec?.questions ?? []).map(({ id, title }) => ({
            id,
            title,
            status: "unavailable" as const,
            note: "이 장의 작성 재료를 다시 만들지 못했다. 이미 보낸 문장(delivered) 안에서만 말하고 새 기간 판단을 더하지 않는다.",
          })),
      materials: section?.materials ?? [],
      delivered: deliveredOf(finals.get(sectionId)),
    };
  };

  if (wanted.length) {
    return {
      questions,
      chapters: wanted.map(chapterOf),
      overview: [],
      timing: bundle ? { luck: bundle.luck, months: withExtraMonths(bundle.months, extra) } : null,
      sectionIds: wanted,
    };
  }

  // 넓은 질문: 장마다 핵심 답만 모으고, 앞 장을 모은 마지막 정리의 최종문 일부를 함께 넘긴다.
  const overview = order
    .filter((id) => id !== "closing" && finals.get(id)?.coreAnswer.trim())
    .map((id) => ({
      sectionId: id,
      title: product.scroll.sections.find((section) => section.id === id)?.title ?? id,
      coreAnswer: clip(plain(finals.get(id)!.coreAnswer), OVERVIEW_ANSWER_MAX_CHARS),
    }));
  const closing = finals.has("closing") ? [chapterOf("closing")] : [];
  return { questions, chapters: closing, overview, timing: null, sectionIds: closing.map((chapter) => chapter.sectionId) };
}

// ─── 검사 ─────────────────────────────────────────────

/** 후속 답변 검사 기준. 묘묘 후속 답변 검사(followupChecker)와 같은 문장 검사를 쓰고 허용 목록만 무진 재료로 만든다. */
export interface MujinFollowupCheckContext {
  readonly questionRefs: readonly string[];
  /** 답의 근거로 쓸 수 있는 ref: 원국 계산 사실, 지금의 나, 함께 보낸 장의 재료와 그 재료가 이어 받은 판단. */
  readonly knownRefs: ReadonlySet<string>;
  readonly percents: ReadonlySet<string>;
  /** 함께 보낸 기간 자료의 달·연도와 재료·최종문·사용자 사실에 이미 있는 날짜. */
  readonly dates: AllowedDates;
  readonly terms: ReadonlySet<string>;
  readonly excluded: readonly ExcludedQuestion[];
}

const luckPeriods = (luck: MujinLuck): MujinLuckPeriod[] => [luck.previous, luck.current, luck.next].filter((period): period is MujinLuckPeriod => period !== null);

function timingTexts(timing: MujinTiming | null): string[] {
  if (!timing) return [];
  return [
    ...luckPeriods(timing.luck).flatMap((period) => [period.label, period.ganzhi, period.stemTenGod ?? ""]),
    timing.months.window.label,
    ...timing.months.months.flatMap((month) => [month.label, ...month.cells.flatMap((cell) => cell.markers.flatMap((marker) => [marker.text, marker.activity]))]),
    ...timing.months.limitations,
  ].filter((text) => text.trim().length > 0);
}

/** 원국 표의 가중 비율 (오행, 다섯 계열). 문장에는 정수로 반올림해 쓸 수 있다. */
function tablePercents(plan: MujinPlan, chart: ChartView): string[] {
  const values = [...Object.values(plan.tables.elements.percents ?? {}), ...Object.values(plan.tables.tenGods.families ?? {}), ...Object.values(chart.elementPercent ?? {})];
  return values.flatMap((value) => [`${value}%`, `${Math.round(value)}%`]);
}

function deliveredTexts(delivered: MujinFollowupDelivered | null): string[] {
  return delivered ? [delivered.coreAnswer, ...delivered.blocks.map((block) => block.text)] : [];
}

const mergeDates = (...list: readonly AllowedDates[]): AllowedDates => ({
  months: new Set(list.flatMap((dates) => [...dates.months])),
  years: new Set(list.flatMap((dates) => [...dates.years])),
  days: new Set(list.flatMap((dates) => [...dates.days])),
});

export function followupCheckContext(input: {
  readonly plan: MujinPlan;
  readonly chart: ChartView;
  readonly material: FollowupMaterial;
  /** 사용자가 알려 준 사실 문장 (처음 궁금한 점, 이번 메시지). 그 안의 날짜는 다시 말할 수 있다. */
  readonly userTexts: readonly string[];
  readonly lastTurn: { readonly question: string; readonly answer: string } | null;
  readonly excluded: readonly ExcludedQuestion[];
}): MujinFollowupCheckContext {
  const { plan, chart, material } = input;
  const materials = [...plan.facts, ...plan.nowFacts, ...material.chapters.flatMap((chapter) => chapter.materials)];
  const texts = materials.flatMap(materialTexts);
  const sent = [...material.chapters.flatMap((chapter) => deliveredTexts(chapter.delivered)), ...material.overview.map((entry) => entry.coreAnswer)];
  const timing = timingTexts(material.timing);
  return {
    questionRefs: material.questions.map((question) => question.ref),
    knownRefs: new Set([...materials.map((item) => item.ref), ...materials.flatMap((item) => item.parentRefs ?? [])]),
    percents: percentsOf([...tablePercents(plan, chart), ...texts, ...timing, ...sent]),
    dates: mergeDates(timingDatesOf(material.timing), datesIn([...texts, ...sent, ...input.userTexts])),
    terms: allowedChartTerms(chart, [...texts, ...timing, ...sent, ...(input.lastTurn ? [input.lastTurn.answer] : [])]),
    excluded: input.excluded,
  };
}

/** 문단이 완성될 때마다 검사하는 도구. 묘묘 후속 답변 검사(followupChecker)와 같은 기준이다. 말투·말버릇은 세지 않는다. */
export function mujinFollowupChecker(context: MujinFollowupCheckContext, chart: ChartView) {
  const textIssues = (text: string) => [...checkTextV2(text, chart, context.percents, context.dates, context.terms), ...checkExcluded([text], context.excluded)];
  return {
    /** 문단보다 먼저 오는 질문 ref와 근거 연결. */
    section: (questionRef: string, refs: readonly string[]): string[] => [
      ...(context.questionRefs.includes(questionRef) ? [] : [`없는 질문에 답했습니다 (${questionRef}).`]),
      // 답하는 질문의 ref는 근거는 아니지만 틀린 참조도 아니다. 이것 때문에 다시 생성하지 않는다.
      ...refs.filter((ref) => !context.knownRefs.has(ref) && !context.questionRefs.includes(ref)).map((ref) => `없는 근거를 참조했습니다 (${ref}).`),
    ],
    paragraph: (text: string): string[] => textIssues(text),
    clarify: (question: string): string[] => [
      ...(question.trim() ? [] : ["되묻는 질문이 비어 있습니다."]),
      ...(question.length > CLARIFY_MAX ? ["되묻는 질문이 너무 깁니다."] : []),
      ...textIssues(question),
    ],
    /** 이미 보낸 뒤라 고칠 수 없는 길이 기준. 넘으면 기록만 한다. */
    overLength: (texts: readonly string[]): boolean =>
      texts.some((text) => text.length > FOLLOWUP_SECTION_MAX) || texts.reduce((sum, text) => sum + text.length, 0) > FOLLOWUP_TOTAL_MAX,
  };
}

// ─── 생성 ─────────────────────────────────────────────

/** 질문 정리 함수(buildQuestionPrompt, buildQuestionAnalysis, inScopeFacts)는 상품의 범위(scope)와 기간 설정(timing)만 읽는다. 족자 상품도 같은 모양이다. */
const asQuestionProduct = (product: ScrollProductDefinition) => product as unknown as ProductDefinition;

/**
 * 후속 질문을 구조화한다. 묘묘와 같은 질문 정리(question-1.3.0, mode followup, 직전 대화 참조)이며 범위는 이 상품 scope로 서버가 정한다.
 * classifyQuestion(narrate.ts)과 같은 호출에 호출 단위 기록(onCall)만 더했다.
 */
async function classifyFollowup(input: {
  readonly product: ScrollProductDefinition;
  readonly referenceDate: string;
  readonly question: string;
  readonly lastTurn: { readonly question: string; readonly answer: string } | null;
  readonly modelId: string;
  readonly deadlineAt: number;
  readonly meter: UsageMeter;
  readonly call: typeof callStructured;
  readonly onCall: (log: LlmCallLog) => void;
}): Promise<{ readonly analysis: QuestionAnalysis; readonly actualModel: string | null }> {
  const product = asQuestionProduct(input.product);
  const task = LLM_SETTINGS.tasks.classify;
  const prompt = buildQuestionPrompt({ product, referenceDate: input.referenceDate, mode: "followup", text: input.question, lastTurn: input.lastTurn });
  const result = await input.call({
    model: input.modelId,
    instructions: prompt.instructions,
    input: prompt.input,
    schemaName: prompt.schemaName,
    jsonSchema: prompt.jsonSchema,
    parser: prompt.parser,
    maxOutputTokens: task.maxOutputTokens,
    reasoningEffort: task.reasoningEffort,
    timeoutMs: task.timeoutMs,
    deadlineAt: input.deadlineAt,
    meter: input.meter,
    onCall: input.onCall,
  });
  return { analysis: buildQuestionAnalysis(product, input.referenceDate, result.parsed), actualModel: result.meta.actualModel };
}

/**
 * 후속 답변을 스트리밍으로 받아, 질문마다 근거 연결을 먼저 확인하고 문단이 완성될 때마다 검사해 보낸다(publish).
 * 묘묘의 answerFollowupProgressive와 같은 순서·재시도 횟수다. 검사에 걸리면 생성을 끊고, 보낸 문단은 둔 채 이어 쓰게 다시 요청한다.
 * 되묻기(clarify)는 짧아서 끝까지 받은 뒤 돌려준다.
 */
export async function answerMujinFollowup(input: {
  readonly prompt: Omit<MujinFollowupPromptInput, "alreadySent" | "previousIssues">;
  readonly check: MujinFollowupCheckContext;
  readonly chart: ChartView;
  readonly modelId: string;
  readonly deadlineAt?: number;
  readonly publish: (answer: string) => Promise<void>;
  readonly stream: typeof callStructuredStream;
  readonly meter: UsageMeter;
  readonly onCall?: (log: LlmCallLog) => void;
}): Promise<{
  readonly output: FollowupOutputV2;
  readonly actualModel: string | null;
  readonly calls: number;
  readonly issueCount: number;
  /** 지시에 넣은 문답 예시 (mujin-followup-1.1.0부터, 그 전 버전은 null). */
  readonly examples: ExampleRecord | null;
}> {
  const task = LLM_SETTINGS.tasks.followup;
  const order = input.check.questionRefs;
  const sent = new Map<string, string[]>();
  const refsOf = new Map<string, Set<string>>();
  const snapshot = () => order.filter((ref) => sent.get(ref)?.length).map((ref) => ({ questionRef: ref, paragraphs: [...sent.get(ref)!] }));
  const published = () => snapshot().map((section) => section.paragraphs.join("\n\n")).join("\n\n");

  let previousIssues: string[] = [];
  let actualModel: string | null = null;
  let calls = 0;
  let issueCount = 0;
  let examples: ExampleRecord | null = null;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    if (round > 0 && input.deadlineAt !== undefined && Date.now() + task.timeoutMs > input.deadlineAt) break;
    const request = buildMujinFollowupRequest({ ...input.prompt, previousIssues, alreadySent: snapshot() });
    examples = request.examples;
    const checker = mujinFollowupChecker(input.check, input.chart);
    const issues: string[] = [];
    const checkedSections = new Set<number>();
    const handled = new Map<number, number>();
    let progressed = false;
    const stop = (...found: string[]): "stop" => {
      issues.push(...found);
      return "stop";
    };

    const handle = async (parts: StreamedFollowup): Promise<"continue" | "stop"> => {
      if (parts.mode !== "answer") return "continue";
      for (const [index, section] of parts.sections.entries()) {
        // 근거 연결(refs)은 문단보다 먼저 온다. 확인하기 전에는 문단을 보내지 않는다.
        if (section.questionRef === undefined || section.refs === undefined) return "continue";
        if (!checkedSections.has(index)) {
          const found = checker.section(section.questionRef, section.refs);
          if (found.length) return stop(...found);
          checkedSections.add(index);
          refsOf.set(section.questionRef, new Set([...(refsOf.get(section.questionRef) ?? []), ...section.refs]));
        }
        for (const paragraph of section.paragraphs.slice(handled.get(index) ?? 0)) {
          const found = checker.paragraph(paragraph);
          if (found.length) return stop(...found);
          sent.set(section.questionRef, [...(sent.get(section.questionRef) ?? []), tidyEmphasis(paragraph)]);
          handled.set(index, (handled.get(index) ?? 0) + 1);
          await input.publish(published());
          progressed = true;
        }
      }
      return "continue";
    };

    let result: StreamedResult<FollowupOutputV2>;
    try {
      result = await input.stream({
        model: input.modelId,
        instructions: request.instructions,
        input: request.input,
        schemaName: request.schemaName,
        jsonSchema: request.jsonSchema,
        parser: request.parser,
        maxOutputTokens: task.maxOutputTokens,
        reasoningEffort: task.reasoningEffort,
        timeoutMs: task.timeoutMs,
        deadlineAt: input.deadlineAt,
        meter: input.meter,
        onCall: input.onCall,
        // 문단 경계(\n)나 닫는 따옴표·괄호가 들어온 때만 다시 읽는다.
        onDelta: (text, delta) => (/["\]\\]/.test(delta) ? handle(followupParts(text)) : Promise.resolve("continue")),
      });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      calls += error.calls;
      if (progressed && isRetryableTransport(error.code) && round < LLM_SETTINGS.validationRetries) continue;
      throw new LlmError(error.code, error.message, calls, error.details);
    }
    calls += result.meta.calls;
    actualModel = result.meta.actualModel ?? actualModel;

    if (!result.stopped && !issues.length) await handle(followupParts(result.text));
    if (!issues.length) {
      const mode = followupParts(result.text).mode;
      if (mode === "clarify") {
        const question = result.parsed?.clarifyQuestion.trim() ?? "";
        if (sent.size) issues.push("이미 답을 보내기 시작했으니 되묻지 말고 이어서 답한다.");
        else {
          const found = checker.clarify(question);
          if (!found.length) return { output: { mode: "clarify", sections: [], clarifyQuestion: question }, actualModel, calls, issueCount, examples };
          issues.push(...found);
        }
      } else {
        const missing = order.filter((ref) => !sent.get(ref)?.length);
        if (missing.length) issues.push(...missing.map((ref) => `질문(${ref})에 대한 답이 없습니다.`));
        else {
          const texts = order.map((ref) => sent.get(ref)!.join("\n\n"));
          const output: FollowupOutputV2 = {
            mode: "answer",
            sections: order.map((ref, index) => ({ questionRef: ref, text: texts[index]!, refs: [...(refsOf.get(ref) ?? [])] })),
            clarifyQuestion: "",
          };
          // 길이 기준은 이미 보낸 뒤라 고칠 수 없다. 넘으면 기록만 한다.
          return { output, actualModel, calls, issueCount: issueCount + (checker.overLength(texts) ? 1 : 0), examples };
        }
      }
    }
    issueCount += issues.length;
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", "후속 답변이 검사를 통과하지 못했습니다.", calls, previousIssues);
}

/** 분석 결과 중 남겨 둘 최소 기록. 질문 원문은 followups.question에 따로 있다. 반응만 보낸 메시지 판단(isReactionOnly)에도 쓴다. */
function analysisRecord(
  analysis: QuestionAnalysis,
  llmCalls: number,
  extra: {
    readonly personaId: string;
    readonly personaVersion: string;
    readonly bundle: string;
    readonly timingReferenceDate: string | null;
    readonly sectionIds: readonly string[];
    /** 고정된 12개월 밖이라 따로 살펴본 분야·기간 (예: career:2028-07..2028-12). 질문 문장은 넣지 않는다. */
    readonly extraPeriods: readonly string[];
    /** 답변 지시에 넣은 문답 예시의 카탈로그·정책 버전과 ID. 모델 없이 고정 문장으로 답했으면 null. */
    readonly examples: ExampleRecord | null;
  },
) {
  return {
    version: analysis.version,
    promptVersion: QUESTION_PROMPT_VERSION,
    referenceDate: analysis.referenceDate,
    items: analysis.items.map(({ id, domain, intent, scope, answerability, timingSupported, period }) => ({ id, domain, intent, scope, answerability, timingSupported, period })),
    needsClarification: analysis.needsClarification,
    reaction: analysis.reaction ?? "none",
    llmCalls,
    ...extra,
  };
}

/** 기록 저장을 기다리되 상한을 둔다. 저장이 늦거나 실패해도 응답은 바뀌지 않는다. */
async function settleCalls(recorder: LlmCallRecorder): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([recorder.flush(), new Promise<void>((resolve) => (timer = setTimeout(resolve, CALL_LOG_FLUSH_MS)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 후속 답변은 요청 하나 안에서 끝나므로 지금 묶음의 후속 지시와 무진 설정을 쓴다 (묘묘의 CURRENT_FOLLOWUP_PROMPT와 같은 방식). */
const CURRENT_BUNDLE: MujinBundle = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;

/** 실패 기록에 남길 코드. 모델 호출 오류와 생성 단계의 고정 코드는 그대로, 그 밖은 internal이다. */
function failureCode(error: unknown): string {
  if (error instanceof LlmError) return error.code;
  if (error instanceof ScrollStepError) return error.code;
  return "internal";
}

/**
 * 족자 상품의 후속 질문 처리. 응답 모양과 오류 코드는 묘묘 후속 질문(askFollowup)과 같다.
 * 범위 안 질문이 없으면 모델 없이 캐릭터의 고정 문장(MUJIN.lines)으로 답한다 (범위 밖·되묻기는 차감 없음, 반응은 무료 횟수까지 차감 없음).
 */
export async function askScrollFollowup(input: FollowupInput, overrides: Partial<ScrollFollowupDeps> = {}): Promise<FollowupResponse> {
  const deps = resolveDeps(overrides);
  const { userId, readingId, question } = input;
  const begin = await deps.store.begin(input);

  if (begin.outcome === "busy") throw new ApiError(409, "busy", "이전 질문의 답변을 만들고 있어요. 잠시만 기다려 주세요.");
  if (begin.outcome === "rate_limited") throw new ApiError(429, "rate_limited", "질문이 너무 빨라요. 잠시 후 다시 시도해 주세요.");
  if (begin.outcome === "exhausted") throw new ApiError(409, "exhausted", "질문을 모두 사용했어요.");

  if (begin.outcome === "duplicate") {
    const previous = begin.followup!;
    if (previous.status === "answered" || previous.status === "off_topic" || previous.status === "clarify") {
      return { status: previous.status, answer: previous.answer ?? "", questionsUsed: begin.used, questionLimit: begin.limit, replayed: true };
    }
    throw new ApiError(409, "busy", "이전 질문을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
  }

  const followupId = begin.followup!.id;
  /** 이 후속 질문에서 보낸 호출(질문 정리, 답변, 재작성)의 사용량. followups.usage에 남는다. */
  const meter = new UsageMeter();
  const recorder = deps.recorder();
  const failFollowup = (code: string) => deps.store.fail({ followupId, userId, code, usage: meter.calls ? meter.summary() : null });
  const startedAt = deps.now();
  const deadlineAt = startedAt + LLM_SETTINGS.followupBudgetMs;

  try {
    const modelId = deps.modelId();
    const context = await deps.store.load(readingId, userId);
    if (!context) throw new Error("load_failed");
    const product = findScrollProduct(context.productId);
    const bundle = CURRENT_BUNDLE;
    const persona: Persona | undefined = findPersona(context.personaId, bundle.personaVersion);
    // 상품의 캐릭터와 풀이 기록의 캐릭터가 다르면(기록 오류) 다른 캐릭터에 무진 지시를 붙이지 않는다.
    if (!product || !persona || persona.id !== product.personaId || context.plan?.planVersion !== MUJIN_PLAN_VERSION) {
      throw new Error("configuration_unavailable");
    }

    const onCall = (step: LlmCallStep) =>
      recorder.forCall({
        readingId,
        userId,
        followupId,
        productId: product.id,
        tier: "paid",
        step,
        unitId: null,
        ...(step === "classify"
          ? { promptVersion: QUESTION_PROMPT_VERSION, schemaVersion: null, personaVersion: null, reasoningEffort: LLM_SETTINGS.tasks.classify.reasoningEffort }
          : { promptVersion: bundle.followupPrompt, schemaVersion: MUJIN_FOLLOWUP_SCHEMA_VERSION, personaVersion: persona.version, reasoningEffort: LLM_SETTINGS.tasks.followup.reasoningEffort }),
      });

    const today = deps.today();
    const classified = await classifyFollowup({
      product,
      referenceDate: today,
      question,
      lastTurn: context.lastTurn,
      modelId,
      deadlineAt,
      meter,
      call: deps.callStructured,
      onCall: onCall("classify"),
    });
    const analysis = classified.analysis;
    let actualModel = classified.actualModel;

    let result: { status: FollowupStatus; answer: string; refs: readonly string[] };
    let timingReferenceDate: string | null = null;
    let sectionIds: readonly string[] = [];
    /** 답변 지시에 넣은 문답 예시. 모델 없이 고정 문장으로 답하면 null이다. */
    let examples: ExampleRecord | null = null;
    /** 고정된 12개월 밖이라 따로 계산(또는 저장된 것을 사용)한 분야·기간. */
    let extraPeriods: readonly string[] = [];
    const items = inScopeItems(analysis);
    if (!items.length) {
      // 반응만 보낸 메시지는 이 풀이에서 앞서 몇 번 보냈는지 센다 (무료 횟수를 넘으면 차감).
      const earlierReactions = isReactionOnly(analysis) ? await deps.store.earlierReactions(readingId) : 0;
      result = { ...routeWithoutItems(product, persona, analysis, question, earlierReactions), refs: [] };
    } else {
      // 기간 재료는 질문한 날이 아니라 첫 유료 생성 때 고정한 기준일로 쓴다. 기준일이 없으면 기간 자료 없이 답한다.
      const timingWanted = items.some((item) => chaptersOfItem(item).some((id) => TIMING_CHAPTERS.has(id)));
      const timing =
        timingWanted && context.referenceDate
          ? await deps.prepareTiming({ readingId, birth: context.birth, referenceDate: context.referenceDate, gender: context.plan.gender })
          : null;
      // 사용자가 말한 기간이 고정된 12개월 밖이면 그 기간만 같은 기준일·같은 계산으로 구해 저장하고 다시 쓴다 (묘묘와 같은 방식).
      const extraRequests = timing ? extraTimingRequests({ items, window: timing.months.window, product }) : [];
      const extra =
        timing && extraRequests.length
          ? await deps.prepareExtraTiming({ readingId, birth: context.birth, referenceDate: timing.referenceDate, requests: extraRequests })
          : [];
      extraPeriods = extraRequests.map((request) => `${request.domain}:${request.period.startMonth}..${request.period.endMonth}`);
      const material = followupMaterial({ plan: context.plan, product, items, finals: context.finals, timing, extra });
      timingReferenceDate = material.timing ? (timing?.referenceDate ?? context.referenceDate) : null;
      sectionIds = material.sectionIds;

      // 처음 궁금한 점에서 정리한 사실(종류 보존)은 생성 단계와 같은 변환(toScrollQuestions)으로 지금 상품 범위 안의 것만 쓴다.
      const concernFacts = context.initialQuestions
        ? toScrollQuestions(context.initialQuestions.analysis, context.initialQuestions.facts, product).concernFacts
        : [];
      const messageFacts = inScopeFacts(asQuestionProduct(product), analysis);
      const userContext: MujinFollowupUserContext[] = [
        ...concernFacts.map((fact) => ({ text: fact.text, from: "concern" as const, kind: fact.kind })),
        ...messageFacts.map((text) => ({ text, from: "message" as const })),
      ];
      const outside = excludedItems(analysis);
      const excluded = outside.map(({ summary, domain }) => ({ summary, domain }));
      const check = followupCheckContext({
        plan: context.plan,
        chart: context.chart,
        material,
        userTexts: userContext.map((item) => item.text),
        lastTurn: context.lastTurn,
        excluded,
      });

      const answered = await answerMujinFollowup({
        prompt: {
          bundle,
          persona,
          nickname: context.plan.nickname,
          hourKnown: context.plan.hourKnown,
          coverageNotes: context.plan.coverageNotes,
          referenceDate: timingReferenceDate,
          today,
          questions: material.questions,
          facts: context.plan.facts,
          nowFacts: context.plan.nowFacts,
          userContext,
          chapters: material.chapters,
          overview: material.overview,
          timing: material.timing,
          lastTurn: context.lastTurn,
          reaction: reactionOf(analysis),
          // 문답 예시(mujin-followup-1.1.0부터)를 고르는 순서 값. 같은 질문의 재작성에서 같은 예시를 받는다.
          exampleSeed: followupId,
        },
        check,
        chart: context.chart,
        modelId,
        deadlineAt,
        meter,
        stream: deps.callStructuredStream,
        onCall: onCall("followup"),
        // 문단이 완성될 때마다 답을 먼저 저장해 화면에 보여 준다. 횟수 차감과 완료 상태는 complete_followup에서 한 번에 바꾼다.
        publish: (partial) => deps.store.publish(followupId, partial),
      });
      actualModel = answered.actualModel ?? actualModel;
      examples = answered.examples;

      if (answered.output.mode === "clarify") {
        result = { status: "clarify", answer: `${answered.output.clarifyQuestion.trim()}\n\n${persona.lines.notCharged}`, refs: [] };
      } else {
        const body = material.questions
          .map((item) => answered.output.sections.find((section) => section.questionRef === item.ref)?.text)
          .filter((text): text is string => Boolean(text?.trim()))
          .map(tidyEmphasis)
          .join("\n\n");
        const note = outside.length ? `\n\n${persona.lines.partialScope(excludedLabel(outside))}` : "";
        result = { status: "answered", answer: `${body}${note}`, refs: [...new Set(answered.output.sections.flatMap((section) => section.refs))] };
      }
    }

    const usage = meter.summary();
    const llmCalls = meter.calls;
    const completed = await deps.store.complete({
      followupId,
      userId,
      status: result.status,
      answer: result.answer,
      refs: result.refs,
      meta: {
        modelId,
        actualModel,
        promptVersion: bundle.followupPrompt,
        schemaVersion: MUJIN_FOLLOWUP_SCHEMA_VERSION,
        personaVersion: persona.version,
        usage,
        durationMs: deps.now() - startedAt,
        analysis: analysisRecord(analysis, llmCalls, {
          personaId: persona.id,
          personaVersion: persona.version,
          bundle: bundle.id,
          timingReferenceDate,
          sectionIds,
          extraPeriods,
          examples,
        }),
      },
    });
    console.info("[followup] done", {
      readingId,
      productId: product.id,
      status: result.status,
      calls: llmCalls,
      durationMs: deps.now() - startedAt,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      usageComplete: usage.complete,
    });
    if (!completed) {
      await failFollowup("save_failed");
      throw new ApiError(500, "save_failed", "답변을 저장하지 못했어요. 질문 횟수는 줄지 않았어요.");
    }
    if (!completed.saved) throw new ApiError(409, "exhausted", "질문을 모두 사용했어요.");
    return { status: result.status, answer: result.answer, questionsUsed: completed.used, questionLimit: completed.limit, replayed: false };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof FollowupHandedOver) throw new ApiError(409, "busy", "답변을 만드는 시간이 지나 처리를 멈췄어요. 질문 횟수는 줄지 않았어요.");
    const code = failureCode(error);
    console.error("[followup] failed", { readingId, code, ...(code === "internal" ? { reason: internalReason(error) } : {}) });
    await failFollowup(code);
    throw new ApiError(502, "generation_failed", "답변을 만들지 못했어요. 질문 횟수는 줄지 않았어요.");
  } finally {
    await settleCalls(recorder);
  }
}

// ─── 저장소 (서버 권한) ─────────────────────────────────────────────

/** 생성 단계가 저장한 질문 정리(SCROLL_QUESTION_KEY)인지. 모양이 다르면 쓰지 않는다 (처음 궁금한 점의 사실 없이 답한다). */
function storedQuestions(value: unknown): Pick<ScrollQuestionAnalysis, "analysis" | "facts"> | null {
  const stored = value as Partial<ScrollQuestionAnalysis> | null;
  if (!stored || stored.version !== SCROLL_QUESTION_VERSION || !stored.analysis || !Array.isArray(stored.analysis.items) || !Array.isArray(stored.facts)) return null;
  return { analysis: stored.analysis, facts: stored.facts };
}

export function supabaseFollowupStore(admin: SupabaseClient): ScrollFollowupStore {
  return {
    begin: async ({ userId, readingId, clientRequestId, question }) => {
      const { data, error } = await admin.rpc("begin_followup", {
        p_user_id: userId,
        p_reading_id: readingId,
        p_client_request_id: clientRequestId,
        p_question: question,
        p_lease_seconds: LLM_SETTINGS.followupLeaseSeconds,
        p_rate_per_minute: LLM_SETTINGS.followupRatePerMinute,
      });
      if (error) {
        if (error.message.includes("not_entitled")) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
        if (error.message.includes("not_ready")) throw new ApiError(409, "not_ready", "풀이가 끝난 뒤에 질문할 수 있어요.");
        throw new ApiError(500, "begin_failed", "질문을 시작하지 못했어요.");
      }
      return data as BeginResult;
    },

    load: async (readingId, userId) => {
      // 소유자의 풀이가 아니면 아무것도 돌려주지 않는다 (user_id 조건으로 다시 확인).
      const loaded = await loadScrollReading(admin, readingId, userId);
      if (!loaded) return null;
      const [finals, referenceDate, previous, questions] = await Promise.all([
        // begin_followup이 구매 권한을 확인한 뒤에만 읽는다. 서버 권한이라 유료 장도 함께 읽는다.
        loadFinalSections(admin, readingId),
        getReferenceDate(admin, readingId),
        admin
          .from("followups")
          .select("question, answer, created_at")
          .eq("reading_id", readingId)
          .eq("status", "answered")
          .order("created_at", { ascending: false })
          .limit(LLM_SETTINGS.followupContextTurns),
        // 질문 정리 결과를 읽지 못해도(없음, 저장소 오류) 처음 궁금한 점의 사실 없이 답한다.
        createScrollStore(admin)
          .loadAnalysis<unknown>(readingId, SCROLL_QUESTION_KEY)
          .catch(() => null),
      ]);
      if (previous.error) throw new Error("followup_history_load_failed");
      const last = ((previous.data ?? []) as { question: string; answer: string | null }[])[0];
      return {
        productId: loaded.reading.product_id,
        personaId: loaded.reading.persona_id,
        chart: loaded.reading.chart,
        birth: loaded.reading.birth_input,
        plan: loaded.plan,
        finals: new Map(finals.map((section) => [section.sectionId, section.content] as const)),
        referenceDate,
        initialQuestions: storedQuestions(questions),
        lastTurn: last ? { question: last.question, answer: truncate(last.answer ?? "", 600) } : null,
      };
    },

    earlierReactions: async (readingId) => {
      const { data } = await admin.from("followups").select("analysis").eq("reading_id", readingId).in("status", ["clarify", "answered"]);
      return ((data ?? []) as { analysis: { reaction?: string; items: unknown[] } | null }[]).filter((row) => isReactionOnly(row.analysis)).length;
    },

    publish: async (followupId, answer) => {
      const { data, error } = await admin.from("followups").update({ answer }).eq("id", followupId).eq("status", "answering").select("id");
      if (error || !data?.length) throw new FollowupHandedOver();
    },

    complete: async ({ followupId, userId, status, answer, refs, meta }) => {
      const { data, error } = await admin.rpc("complete_followup", {
        p_followup_id: followupId,
        p_user_id: userId,
        p_status: status,
        p_answer: answer,
        p_refs: refs,
        p_meta: meta,
      });
      return error ? null : (data as CompleteResult);
    },

    fail: async ({ followupId, userId, code, usage }) => {
      await admin.rpc("fail_followup", { p_followup_id: followupId, p_user_id: userId, p_code: code });
      // 실패한 질문도 이미 쓴 토큰은 남긴다. 기록 실패는 응답에 영향을 주지 않는다.
      if (usage) {
        const { error } = await admin.from("followups").update({ usage }).eq("id", followupId).eq("status", "failed");
        if (error) console.warn("[followup] usage not recorded", { code: error.code ?? "unknown" });
      }
    },
  };
}

function resolveDeps(overrides: Partial<ScrollFollowupDeps>): ScrollFollowupDeps {
  let admin: SupabaseClient | null = null;
  const adminClient = () => (admin ??= createSupabaseAdminClient());
  return {
    store: overrides.store ?? supabaseFollowupStore(adminClient()),
    recorder: overrides.recorder ?? (() => createCallRecorder(supabaseCallWriter(adminClient()))),
    callStructured: overrides.callStructured ?? callStructured,
    callStructuredStream: overrides.callStructuredStream ?? callStructuredStream,
    prepareTiming: overrides.prepareTiming ?? ((timing) => prepareScrollTiming({ admin: adminClient(), ...timing })),
    prepareExtraTiming: overrides.prepareExtraTiming ?? ((timing) => prepareScrollExtraTiming({ admin: adminClient(), ...timing })),
    modelId: overrides.modelId ?? (() => resolveModelId()),
    now: overrides.now ?? (() => Date.now()),
    today: overrides.today ?? (() => seoulDate()),
  };
}
