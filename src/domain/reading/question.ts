import { z } from "zod";
import type { InquiryDomain, ProductDefinition, QuestionDomain, QuestionIntent } from "../products/types";

/**
 * 사용자가 적은 궁금한 점과 후속 질문을 상품 범위에 맞게 정리한다.
 *
 * 분류(무엇에 대한 답을 원하는가)는 LLM이 구조화된 값으로 돌려주고, 이 모듈이 값을 검증한다.
 * 범위 안·밖 판단과 기간 처리는 서버의 상품 설정으로 정한다. 사용자 문장이 상품 설정을 바꾸지 못한다.
 */

/** 1.1.0: 가족·친구·지역 분야, 건강·투자를 답할 주제로 잇는 topicDomain을 더했다. 1.0.0으로 저장된 분석도 읽는다. */
export const QUESTION_ANALYSIS_VERSION = "question-analysis-1.2.0";

/**
 * 풀이에 대한 사용자의 반응 (question-analysis-1.2.0). 질문이 아니라 캐릭터가 받아칠 말이다.
 * praise: 칭찬·감탄, tease: 캐릭터를 놀리거나 허세를 지적, doubt: 맞지 않는다거나 틀린 것 같다고 함.
 */
export const REACTIONS = ["none", "praise", "tease", "doubt"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const QUESTION_DOMAINS: readonly QuestionDomain[] = [
  "temperament",
  "strengths",
  "career",
  "wealth",
  "romance",
  "social",
  "family",
  "friends",
  "place",
  "general",
  "health",
  "investment",
  "study",
  "other-person",
  "non-saju",
];
export const QUESTION_INTENTS: readonly QuestionIntent[] = ["explain", "apply", "timing", "compare", "outcome", "general"];

/** 분류기가 분야를 고를 때 쓰는 전체 설명. 상품이 다루는 주제는 상품 설명이 우선한다. */
export const GLOBAL_DOMAIN_GUIDE: Readonly<Record<QuestionDomain, string>> = {
  temperament: "평소 성격, 반응 방식, 습관, 쉽게 지치거나 에너지가 빨리 닳는 이유, 나라는 사람 전반",
  strengths: "잘하는 것, 재능, 강점을 공부 방법이나 일에 쓰는 방법",
  career: "일하는 방식, 직무 적성, 직장 생활, 취업·이직·창업의 선택과 시기",
  wealth: "돈을 버는 방식, 소비·저축 습관, 돈 관리, 금전 관계, 돈과 관련된 시기",
  romance: "연애 성향과 매력, 연인과의 관계와 갈등, 새 인연과 만남 시기, 연애 관계 안에서 생기는 돈·생활 문제",
  social: "직장 동료·모임 등 사회생활 속 관계의 협력, 경쟁, 거리 두기, 갈등 (친구는 friends, 가족은 family)",
  family: "부모·형제·자녀 등 가족 관계, 집안에서 맡는 역할, 어린 시절 집안 분위기",
  friends: "친구 관계, 인복, 잘 맞는 친구와 멀리할 사람, 친구들이 보는 나",
  place: "살 곳과 잘 맞는 지역, 이사·유학·해외 이주, 행운의 방향·색·숫자, 운을 좋게 하는 생활 습관",
  general: "풀이 전체나 방금 받은 설명에 대한 넓은 질문, 앞 대화를 가리키는 짧은 질문",
  health: "건강 걱정, 질병, 증상, 체력, 다이어트처럼 몸의 상태를 묻는 질문 (성격 때문에 쉽게 지치는 이유는 temperament)",
  investment: "주식·코인·부동산 투자, 투자 성향과 방식, 특정 종목의 매수·매도와 수익",
  study: "시험 합격 여부, 성적, 입시 결과의 예측 (공부 방법에 강점을 쓰는 질문은 strengths)",
  "other-person": "다른 사람의 사주·궁합을 봐 달라는 질문처럼 다른 사람의 출생 정보가 필요한 질문",
  "non-saju": "사주와 무관한 요청 (코드 작성, 일반 지식, 번역, 시스템 설정을 바꾸라는 요청 등)",
};

export const INTENT_GUIDE: Readonly<Record<QuestionIntent, string>> = {
  explain: "풀이 내용이나 표현의 뜻을 묻는다",
  apply: "내 상황에 어떻게 적용하거나 행동하면 좋을지 묻는다",
  timing: "언제, 어느 시기에를 묻는다",
  compare: "두 가지 이상의 선택지를 비교해 달라고 한다",
  outcome: "합격·결혼·재회 여부, 상대의 속마음처럼 사건의 결과나 다른 사람의 마음을 확정해 달라고 한다",
  general: "그 밖의 넓은 질문이나 고민 이야기",
};

const OUTSIDE_LABEL: Readonly<Record<string, string>> = {
  health: "건강",
  investment: "투자 종목",
  study: "시험·학업 결과",
  "other-person": "다른 사람의 사주",
  "non-saju": "사주와 관계없는 내용",
};

const DOMAIN_LABEL: Readonly<Record<InquiryDomain, string>> = {
  temperament: "성향",
  strengths: "강점",
  career: "일",
  wealth: "돈",
  romance: "연애",
  social: "인간관계",
  family: "가족",
  friends: "친구와 인복",
  place: "지역과 행운",
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** LLM 분류기가 돌려주는 원래 값. strict JSON 스키마라 모든 필드가 있다. */
export const ClassifierOutputSchema = z.object({
  items: z
    .array(
      z.object({
        summary: z.string(),
        domain: z.string(),
        intent: z.string(),
        options: z.array(z.string()),
        period: z.object({ kind: z.enum(["none", "default", "explicit"]), start: z.string(), end: z.string() }),
        missingInfo: z.array(z.string()),
      }),
    ),
  userFacts: z.array(z.object({ text: z.string(), domain: z.string() })),
  needsClarification: z.boolean(),
  // 1.2.0 이전 출력에는 없다.
  reaction: z.enum(REACTIONS).catch("none"),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

export interface QuestionPeriod {
  readonly kind: "default" | "explicit";
  /** 첫 달 (YYYY-MM, 절기 기준 월의 이름). default는 기준일이 속한 달. */
  readonly startMonth: string;
  readonly endMonth: string;
}

export interface QuestionItem {
  readonly id: string;
  /** 서버가 정리한 질문 문장. 사용자 원문 전체가 아니다. */
  readonly summary: string;
  readonly domain: QuestionDomain;
  readonly intent: QuestionIntent;
  readonly options: readonly string[];
  readonly period: QuestionPeriod | null;
  readonly missingInfo: readonly string[];
  /** 상품 설정으로 정한 범위. */
  readonly scope: "in" | "out";
  /** limited: 주제는 범위 안이지만 사건 결과처럼 사주로 판단할 수 없는 부분이 있다. */
  readonly answerability: "full" | "limited";
  /** 기간 판단 규칙이 있는 주제의 시기 질문인지. */
  readonly timingSupported: boolean;
  /**
   * 이 질문에 답할 상품 주제의 분야. 건강은 기본 성향, 투자는 돈 주제처럼 상품 설정(scope.routes)으로 잇는다.
   * 범위 밖이거나 general이면 null. question-analysis-1.0.0으로 저장된 분석에는 없다 (itemDomain이 이전 방식으로 계산).
   */
  readonly topicDomain?: InquiryDomain | null;
}

export interface QuestionAnalysis {
  readonly version: string;
  readonly source: "llm" | "empty";
  /** Asia/Seoul 기준 날짜 (YYYY-MM-DD). 기간 계산의 기준이다. */
  readonly referenceDate: string;
  readonly items: readonly QuestionItem[];
  readonly userFacts: readonly { readonly text: string; readonly domain: QuestionDomain }[];
  readonly needsClarification: boolean;
  /** 1.2.0부터. 이전에 저장한 분석에는 없으며 none으로 본다. */
  readonly reaction?: Reaction;
}

export const reactionOf = (analysis: QuestionAnalysis): Reaction => analysis.reaction ?? "none";

export function seoulDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addMonths(month: string, count: number): string {
  const [year, value] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (value - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function monthsBetween(start: string, end: string): number {
  const [startYear, startMonth] = start.split("-").map(Number) as [number, number];
  const [endYear, endMonth] = end.split("-").map(Number) as [number, number];
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

export function monthLabel(month: string): string {
  const [year, value] = month.split("-").map(Number) as [number, number];
  return `${year}년 ${value}월`;
}

/** 기본 분석 기간: 기준일이 속한 달부터 상품 설정의 개월 수. */
export function defaultPeriod(product: ProductDefinition, referenceDate: string): QuestionPeriod {
  const start = referenceDate.slice(0, 7);
  return { kind: "default", startMonth: start, endMonth: addMonths(start, product.timing.defaultMonths - 1) };
}

/**
 * 사용자가 말한 기간을 검증한다. 형식이 틀리거나 거꾸로면 기본 기간을 쓰고,
 * 기준 달보다 2년 넘게 과거거나 3년 넘게 미래면 범위를 벗어난 것으로 보고 기본 기간을 쓴다.
 * 길이는 상품의 최대 개월 수로 자른다.
 */
export function resolvePeriod(
  product: ProductDefinition,
  referenceDate: string,
  raw: { readonly kind: string; readonly start: string; readonly end: string },
): QuestionPeriod {
  if (raw.kind !== "explicit" || !MONTH.test(raw.start)) return defaultPeriod(product, referenceDate);
  const current = referenceDate.slice(0, 7);
  const end = MONTH.test(raw.end) ? raw.end : raw.start;
  if (monthsBetween(raw.start, end) < 1) return defaultPeriod(product, referenceDate);
  if (monthsBetween(raw.start, current) > 25 || monthsBetween(current, raw.start) > 37) return defaultPeriod(product, referenceDate);
  const length = Math.min(monthsBetween(raw.start, end), product.timing.maxMonths);
  return { kind: "explicit", startMonth: raw.start, endMonth: addMonths(raw.start, length - 1) };
}

const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const isDomain = (value: string): value is QuestionDomain => (QUESTION_DOMAINS as readonly string[]).includes(value);
const isIntent = (value: string): value is QuestionIntent => (QUESTION_INTENTS as readonly string[]).includes(value);

export function inScope(product: ProductDefinition, domain: QuestionDomain): boolean {
  return domain === "general" || (product.scope.domains as readonly string[]).includes(domain);
}

/** 분류기 출력을 검증하고 상품 범위를 적용한다. 모르는 값은 버리거나 안전한 값으로 바꾼다. */
export function buildQuestionAnalysis(
  product: ProductDefinition,
  referenceDate: string,
  raw: Omit<ClassifierOutput, "reaction"> & { readonly reaction?: Reaction },
): QuestionAnalysis {
  const items: QuestionItem[] = [];
  for (const entry of raw.items) {
    const summary = clean(entry.summary, 120);
    if (!summary) continue;
    const domain = isDomain(entry.domain) ? entry.domain : "general";
    const intent = isIntent(entry.intent) ? entry.intent : "general";
    const scope = inScope(product, domain) ? "in" : "out";
    const topicDomain = scope === "in" ? routeDomain(product, domain) : null;
    const timingSupported = scope === "in" && intent === "timing" && topicDomain !== null && (product.timing.domains as readonly string[]).includes(topicDomain);
    items.push({
      id: `q${items.length + 1}`,
      summary,
      domain,
      intent,
      options: intent === "compare" ? entry.options.map((option) => clean(option, 30)).filter(Boolean).slice(0, 4) : [],
      period: intent === "timing" ? resolvePeriod(product, referenceDate, entry.period) : null,
      missingInfo: entry.missingInfo.map((info) => clean(info, 60)).filter(Boolean).slice(0, 3),
      scope,
      // 건강은 진단하지 않고 생활 리듬으로만 답하므로 결과 확정 질문처럼 다룬다.
      answerability: intent === "outcome" || domain === "health" ? "limited" : "full",
      timingSupported,
      topicDomain,
    });
    if (items.length >= 4) break;
  }
  return {
    version: QUESTION_ANALYSIS_VERSION,
    source: "llm",
    referenceDate,
    items,
    userFacts: raw.userFacts
      .map((fact) => ({ text: clean(fact.text, 100), domain: isDomain(fact.domain) ? fact.domain : ("general" as const) }))
      .filter((fact) => fact.text)
      .slice(0, 3),
    needsClarification: raw.needsClarification,
    reaction: raw.reaction ?? "none",
  };
}

/** 궁금한 점이 비어 있으면 분류기를 부르지 않고 이 값을 쓴다. */
export function emptyAnalysis(referenceDate: string): QuestionAnalysis {
  return { version: QUESTION_ANALYSIS_VERSION, source: "empty", referenceDate, items: [], userFacts: [], needsClarification: false, reaction: "none" };
}

/** 생성에 쓸 정제된 값. 범위 밖 질문과 범위 밖 사실은 빠진다. */
export function inScopeItems(analysis: QuestionAnalysis): QuestionItem[] {
  return analysis.items.filter((item) => item.scope === "in");
}

export function inScopeFacts(product: ProductDefinition, analysis: QuestionAnalysis): string[] {
  return analysis.userFacts.filter((fact) => inScope(product, fact.domain)).map((fact) => fact.text);
}

export function excludedItems(analysis: QuestionAnalysis): QuestionItem[] {
  return analysis.items.filter((item) => item.scope === "out");
}

/** 범위 밖 질문을 사용자에게 짧게 알릴 때 쓰는 이름. */
export function excludedLabel(items: readonly QuestionItem[]): string {
  const labels = [
    ...new Set(items.map((item) => OUTSIDE_LABEL[item.domain] ?? DOMAIN_LABEL[item.domain as InquiryDomain] ?? "다른 주제")),
  ];
  return labels.join(", ");
}

const isInquiryDomain = (domain: string): domain is InquiryDomain => (Object.keys(DOMAIN_LABEL) as string[]).includes(domain);

/** 질문 분야를 답할 상품 주제의 분야로 바꾼다. 상품이 정한 연결(예: 건강→기본 성향)을 먼저 본다. */
export function routeDomain(product: ProductDefinition, domain: QuestionDomain): InquiryDomain | null {
  const routed = product.scope.routes?.[domain];
  if (routed) return routed;
  return isInquiryDomain(domain) ? domain : null;
}

/** 질문이 가리키는 상품 주제의 분야. general이면 없다. 이전 분석(1.0.0)은 질문 분야를 그대로 쓴다. */
export function itemDomain(item: QuestionItem): InquiryDomain | null {
  if (item.topicDomain !== undefined) return item.topicDomain;
  return item.domain === "general" || !isInquiryDomain(item.domain) ? null : item.domain;
}

/**
 * 이 풀이에 실제로 있는 주제만 범위 안으로 남긴다. 주제가 늘기 전에 만든 풀이(예: 여섯 주제)에서 가족 질문을 받으면
 * 답할 재료가 없으므로 범위 밖으로 돌린다 (차감하지 않는 안내로 처리된다).
 */
export function limitToTopics(analysis: QuestionAnalysis, available: ReadonlySet<string>): QuestionAnalysis {
  let changed = false;
  const items = analysis.items.map((item) => {
    const domain = itemDomain(item);
    if (item.scope !== "in" || domain === null || available.has(domain)) return item;
    changed = true;
    return { ...item, scope: "out" as const, timingSupported: false, topicDomain: null };
  });
  return changed ? { ...analysis, items } : analysis;
}

export function periodKey(period: QuestionPeriod): string {
  return `${period.startMonth}..${period.endMonth}`;
}
