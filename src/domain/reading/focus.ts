import type { InquiryDomain, ProductDefinition } from "../products/types";
import { targetFor } from "./plan";
import { inScopeFacts, inScopeItems, itemDomain, periodKey, type QuestionAnalysis, type QuestionItem } from "./question";
import type {
  AnyReadingPlan,
  FocusQuestion,
  InterpretationStatement,
  NarrationPlanV2,
  ReadingPlanV2,
  TimingAnalysis,
  TimingPeriodStatement,
  TimingPlanV2,
  TopicPlanV2,
  TopicWeight,
  UserContextStatement,
} from "./types";

export type { FocusQuestion };

/** 질문 의도에 따라 먼저 꺼낼 해석 항목. */
const INTENT_ASPECTS: Readonly<Record<string, readonly string[]>> = {
  "career:compare": ["취업·이직·창업의 조건 비교", "조직과 업무 환경", "전문성·협업·독립성"],
  "career:timing": ["일하는 방식", "조직과 업무 환경"],
  "wealth:timing": ["수입 활동과 관련된 특징", "돈을 유지하고 쓰는 방식"],
  "wealth:compare": ["수입 활동과 관련된 특징", "지출·동업·금전 관계에서 살필 점"],
  "romance:timing": ["매력과 표현 방식", "편안하게 느끼는 관계"],
  "romance:apply": ["갈등과 조율 방식", "관계가 깊어지면서 드러나는 약점"],
  "social:apply": ["갈등 상황의 반응", "거리와 경계 설정"],
};

function prioritized(statements: readonly InterpretationStatement[], aspects: readonly string[]): InterpretationStatement[] {
  if (!aspects.length) return [...statements];
  const rank = (statement: InterpretationStatement) => {
    const index = aspects.indexOf(statement.aspect ?? "");
    return index === -1 ? aspects.length : index;
  };
  return [...statements].sort((a, b) => rank(a) - rank(b));
}

/** 시기 질문이 요청한 기간과 실제로 분석한 기간을 잇는 키. */
export function requestedTimingKey(item: QuestionItem): string | null {
  const domain = itemDomain(item);
  if (!item.timingSupported || !item.period || !domain) return null;
  return `${domain}:${periodKey(item.period)}`;
}

/** 질문과 기간 재료를 붙일 때 필요한 주제 정보. 이전 계획(1.0.0)의 주제도 이 모양으로 바꿔 쓴다. */
export interface FocusTopic {
  readonly topicId: string;
  readonly inquiryDomain: string;
  readonly statements: readonly InterpretationStatement[];
}

function timingPlans(analyses: readonly { readonly requestKey: string; readonly analysis: TimingAnalysis }[], topics: readonly FocusTopic[]) {
  let next = 1;
  const plans: { readonly requestKey: string; readonly plan: TimingPlanV2 }[] = [];
  for (const [index, { requestKey, analysis }] of analyses.entries()) {
    const toRef = (statement: Omit<TimingPeriodStatement, "ref">): TimingPeriodStatement => ({ ...statement, ref: `t${next++}` });
    const months = analysis.months.map(toRef);
    const years = analysis.years.map(toRef);
    const refOf = (periodId: string) => months.find((month) => month.periodId === periodId)?.ref;
    plans.push({ requestKey, plan: {
      id: `tp${index + 1}`,
      domain: analysis.domain,
      topicId: topics.find((topic) => topic.inquiryDomain === analysis.domain)?.topicId ?? analysis.domain,
      windowLabel: analysis.window.label,
      explicit: analysis.window.kind === "explicit",
      status: analysis.status,
      months,
      years,
      decade: analysis.decade,
      notableRefs: analysis.notable.map(refOf).filter((ref): ref is string => Boolean(ref)),
      carefulRefs: analysis.careful.map(refOf).filter((ref): ref is string => Boolean(ref)),
      limitations: analysis.limitations,
    } });
  }
  return plans;
}

/**
 * 저장된 원국 재료에 질문 분석과 기간 재료를 더해 최종 작성 계획을 만든다.
 *
 * - 범위 안의 질문만 쓴다. 범위 밖 질문 문장은 계획에 들어가지 않는다.
 * - 질문 주제는 앞으로 옮기고 분량을 늘린다. 질문이 없으면 여섯 주제를 균형 있게 둔다.
 * - 상황은 예시와 관점을 고르는 데 쓰고, 질문이 있으면 질문이 우선한다.
 */
export function buildNarrationPlan(input: {
  readonly base: ReadingPlanV2;
  readonly product: ProductDefinition;
  readonly analysis: QuestionAnalysis;
  readonly timing: readonly { readonly requestKey: string; readonly analysis: TimingAnalysis }[];
}): NarrationPlanV2 {
  const { base, product, analysis } = input;
  const items = inScopeItems(analysis);
  const focusDomains = [...new Set(items.map(itemDomain).filter((domain): domain is InquiryDomain => domain !== null))];
  const situationDomains = product.situation.options.find((option) => option.id === base.situation?.id)?.focusDomains ?? [];

  const weightOf = (topic: TopicPlanV2): TopicWeight => {
    if (topic.status === "limited") return "light";
    if (!focusDomains.length) return topic.weight;
    if (focusDomains.includes(topic.inquiryDomain as InquiryDomain)) return "focus";
    return situationDomains.includes(topic.inquiryDomain as InquiryDomain) ? "standard" : "light";
  };

  const reweighted = base.topics.map((topic) => {
    const weight = weightOf(topic);
    const productTopic = product.topics.find((entry) => entry.id === topic.topicId);
    const intents = items.filter((item) => itemDomain(item) === topic.inquiryDomain).map((item) => `${topic.inquiryDomain}:${item.intent}`);
    const aspects = intents.flatMap((key) => INTENT_ASPECTS[key] ?? []);
    return {
      ...topic,
      weight,
      target: topic.status === "limited" ? 1 : targetFor(productTopic ?? topic, weight),
      statements: prioritized(topic.statements, aspects),
    };
  });
  const order = (topic: TopicPlanV2) => {
    const index = focusDomains.indexOf(topic.inquiryDomain as InquiryDomain);
    return index === -1 ? focusDomains.length + base.topics.indexOf(base.topics.find((entry) => entry.topicId === topic.topicId)!) : index;
  };
  const topics = [...reweighted].sort((a, b) => order(a) - order(b));

  const { questions, timing } = assembleFocus({ items, topics, timing: input.timing });
  const facts = inScopeFacts(product, analysis);
  const userContext: UserContextStatement[] = [
    ...base.userContext,
    ...facts.map((text, index) => ({
      ref: `u${base.userContext.length + index + 1}`,
      kind: "user-context" as const,
      text: `사용자가 직접 알려 준 상황: ${text}`,
      source: "fact" as const,
    })),
  ];

  return {
    base,
    topics,
    userContext,
    questions,
    timing,
    focusSection: product.focusSection,
    length: product.length,
    expression: product.expression,
  };
}

/**
 * 범위 안 질문마다 관련 해석과 기간 판단을 연결한다. 최초 풀이와 후속 질문이 함께 쓴다.
 * 질문 순서는 사용자가 쓴 순서를 따른다.
 */
export function assembleFocus(input: {
  readonly items: readonly QuestionItem[];
  readonly topics: readonly FocusTopic[];
  readonly timing: readonly { readonly requestKey: string; readonly analysis: TimingAnalysis }[];
}): { readonly questions: FocusQuestion[]; readonly timing: TimingPlanV2[] } {
  const { items, topics } = input;
  const plans = timingPlans(input.timing, topics);
  const questions = items.map((item): FocusQuestion => {
    const domain = itemDomain(item);
    const topic = domain ? topics.find((entry) => entry.inquiryDomain === domain) : undefined;
    const key = requestedTimingKey(item);
    const plan = key ? plans.find((entry) => entry.requestKey === key)?.plan : undefined;
    const aspects = domain ? (INTENT_ASPECTS[`${domain}:${item.intent}`] ?? []) : [];
    return {
      ref: item.id,
      summary: item.summary,
      domain: item.domain,
      topicId: topic?.topicId ?? null,
      intent: item.intent,
      options: item.options,
      answerability: item.answerability,
      missingInfo: item.missingInfo,
      relatedRefs: topic
        ? prioritized(topic.statements, aspects).slice(0, 3).map((statement) => statement.ref)
        : topics.flatMap((entry) => entry.statements.slice(0, 1).map((statement) => statement.ref)),
      timingId: plan?.id ?? null,
      timingNote:
        item.intent === "timing" && !item.timingSupported
          ? "이 주제는 기간별 판단 규칙이 없어, 시기 대신 원국 성향과 지금 할 수 있는 행동으로 답한다."
          : null,
    };
  });
  return { questions, timing: plans.map((entry) => entry.plan) };
}

/** 저장된 계획(1.0.0 또는 2.0.0)의 주제를 질문 연결에 쓰는 모양으로 바꾼다. */
export function focusTopicsOf(plan: AnyReadingPlan, product: ProductDefinition): FocusTopic[] {
  return plan.topics.map((topic) => ({
    topicId: topic.topicId,
    inquiryDomain: "inquiryDomain" in topic ? topic.inquiryDomain : (product.topics.find((entry) => entry.id === topic.topicId)?.inquiryDomain ?? topic.topicId),
    statements: topic.statements,
  }));
}

/** 검사와 프롬프트가 쓰는, 계획에 있는 모든 기간 판단. */
export function timingStatements(plan: NarrationPlanV2): TimingPeriodStatement[] {
  return plan.timing.flatMap((entry) => [...entry.months, ...entry.years]);
}
