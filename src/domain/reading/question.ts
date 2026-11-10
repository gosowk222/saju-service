import { z } from "zod";
import type { InquiryDomain, ProductDefinition, QuestionDomain, QuestionIntent } from "../products/types";

/**
 * 사용자가 적은 궁금한 점과 후속 질문을 상품 범위에 맞게 정리한다.
 *
 * 분류(무엇에 대한 답을 원하는가)는 LLM이 구조화된 값으로 돌려주고, 이 모듈이 값을 검증한다.
 * 범위 안·밖 판단과 기간 처리는 서버의 상품 설정으로 정한다. 사용자 문장이 상품 설정을 바꾸지 못한다.
 */

export const QUESTION_ANALYSIS_VERSION = "question-analysis-1.0.0";

export const QUESTION_DOMAINS: readonly QuestionDomain[] = [
  "temperament",
  "strengths",
  "career",
  "wealth",
  "romance",
  "social",
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
  social: "친구·동료·가족 등 사람 관계의 협력, 경쟁, 거리 두기, 갈등",
  general: "풀이 전체나 방금 받은 설명에 대한 넓은 질문, 앞 대화를 가리키는 짧은 질문",
  health: "질병, 증상, 진단, 치료, 수술, 다이어트처럼 몸의 상태나 의료 판단을 묻는 질문 (성격 때문에 쉽게 지치는 이유는 temperament)",
  investment: "특정 주식·코인·부동산의 매수와 매도, 수익률, 종목 선택",
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
}

export interface QuestionAnalysis {
  readonly version: string;
  readonly source: "llm" | "empty";
  /** Asia/Seoul 기준 날짜 (YYYY-MM-DD). 기간 계산의 기준이다. */
  readonly referenceDate: string;
  readonly items: readonly QuestionItem[];
  readonly userFacts: readonly { readonly text: string; readonly domain: QuestionDomain }[];
  readonly needsClarification: boolean;
}

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
export function buildQuestionAnalysis(product: ProductDefinition, referenceDate: string, raw: ClassifierOutput): QuestionAnalysis {
  const items: QuestionItem[] = [];
  for (const entry of raw.items) {
    const summary = clean(entry.summary, 120);
    if (!summary) continue;
    const domain = isDomain(entry.domain) ? entry.domain : "general";
    const intent = isIntent(entry.intent) ? entry.intent : "general";
    const scope = inScope(product, domain) ? "in" : "out";
    const timingSupported = scope === "in" && intent === "timing" && (product.timing.domains as readonly string[]).includes(domain);
    items.push({
      id: `q${items.length + 1}`,
      summary,
      domain,
      intent,
      options: intent === "compare" ? entry.options.map((option) => clean(option, 30)).filter(Boolean).slice(0, 4) : [],
      period: intent === "timing" ? resolvePeriod(product, referenceDate, entry.period) : null,
      missingInfo: entry.missingInfo.map((info) => clean(info, 60)).filter(Boolean).slice(0, 3),
      scope,
      answerability: intent === "outcome" ? "limited" : "full",
      timingSupported,
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
  };
}

/** 궁금한 점이 비어 있으면 분류기를 부르지 않고 이 값을 쓴다. */
export function emptyAnalysis(referenceDate: string): QuestionAnalysis {
  return { version: QUESTION_ANALYSIS_VERSION, source: "empty", referenceDate, items: [], userFacts: [], needsClarification: false };
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

/** 질문이 가리키는 상품 주제의 분야. general이면 없다. */
export function itemDomain(item: QuestionItem): InquiryDomain | null {
  return item.domain === "general" || !(Object.keys(DOMAIN_LABEL) as string[]).includes(item.domain) ? null : (item.domain as InquiryDomain);
}

export function periodKey(period: QuestionPeriod): string {
  return `${period.startMonth}..${period.endMonth}`;
}
