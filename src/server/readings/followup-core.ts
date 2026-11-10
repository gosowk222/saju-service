import "server-only";
import type { Persona } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { statementTexts } from "@/domain/reading/check";
import { tidyEmphasis } from "@/domain/reading/emphasis";
import { assembleFocus, focusTopicsOf } from "@/domain/reading/focus";
import { excludedItems, excludedLabel, inScopeFacts, inScopeItems, itemDomain, type QuestionAnalysis } from "@/domain/reading/question";
import { isPlanV2, type AnyReadingPlan, type ChartView, type StoredMessage, type TimingAnalysis, type UserContextStatement } from "@/domain/reading/types";
import { LLM_SETTINGS } from "@/server/llm/config";
import { answerFollowup, type GenerationMeta } from "@/server/llm/narrate";

export type FollowupStatus = "answered" | "off_topic" | "clarify";


/** 이전 계획(1.0.0)의 사용자 상황에는 궁금한 점의 원문이 들어 있다. 범위 판정 전 원문이라 후속 답변 재료로 쓰지 않는다. */
function baseContext(plan: AnyReadingPlan): UserContextStatement[] {
  return plan.userContext.filter((item) => item.source !== "concern");
}

/**
 * 질문이 범위 안 질문을 하나도 갖지 않을 때의 처리. 둘 다 횟수를 차감하지 않는다.
 * 모델 없이 보내는 문장이라 풀이를 맡은 캐릭터의 고정 문장(persona.lines)을 쓴다.
 */
export function routeWithoutItems(
  product: ProductDefinition,
  persona: Persona,
  analysis: QuestionAnalysis,
): { status: FollowupStatus; answer: string } {
  const clarify = analysis.needsClarification && !excludedItems(analysis).length;
  return clarify
    ? { status: "clarify", answer: persona.lines.clarify }
    : { status: "off_topic", answer: persona.lines.outOfScope(product.scope.topicsLabel) };
}

/**
 * 범위 안 질문에 답한다. 저장된 원국 재료와 이미 준비한 기간 재료만 쓰고 원국을 다시 계산하지 않는다.
 * 이전 풀이 말풍선은 질문 주제의 것만 고르고, 직전 대화 한 번만 함께 보낸다.
 */
export async function answerAnalyzedFollowup(input: {
  readonly plan: AnyReadingPlan;
  readonly product: ProductDefinition;
  readonly persona: Persona;
  readonly chart: ChartView;
  readonly analysis: QuestionAnalysis;
  readonly initialAnalysis: QuestionAnalysis | null;
  readonly timing: readonly { readonly requestKey: string; readonly analysis: TimingAnalysis }[];
  readonly messages: readonly Pick<StoredMessage, "topicId" | "text">[];
  readonly lastTurn: { readonly question: string; readonly answer: string } | null;
  readonly modelId: string;
  readonly deadlineAt?: number;
}): Promise<{ readonly status: FollowupStatus; readonly answer: string; readonly refs: readonly string[]; readonly meta: GenerationMeta }> {
  const { plan, product, analysis } = input;
  const items = inScopeItems(analysis);
  const excluded = excludedItems(analysis);
  const topics = focusTopicsOf(plan, product);
  const { questions, timing } = assembleFocus({ items, topics, timing: input.timing });
  const domains = new Set<string>(items.map(itemDomain).filter((domain): domain is NonNullable<typeof domain> => domain !== null));
  const relevant = domains.size ? topics.filter((topic) => domains.has(topic.inquiryDomain)) : topics;
  const statements = domains.size ? relevant.flatMap((topic) => topic.statements) : topics.flatMap((topic) => topic.statements.slice(0, 2));
  const relevantIds = new Set([...relevant.map((topic) => topic.topicId), product.focusSection.id]);
  const delivered = input.messages
    .filter((message) => message.topicId !== null && (!domains.size || relevantIds.has(message.topicId)))
    .slice(-LLM_SETTINGS.followupDeliveredMessages);

  const facts = [...(input.initialAnalysis ? inScopeFacts(product, input.initialAnalysis) : []), ...inScopeFacts(product, analysis)];
  const base = baseContext(plan);
  const userContext: UserContextStatement[] = [
    ...base,
    ...facts.map((text, index) => ({ ref: `u${base.length + index + 1}`, kind: "user-context" as const, text: `사용자가 직접 알려 준 상황: ${text}`, source: "fact" as const })),
  ];
  const timingAll = timing.flatMap((entry) => [...entry.months, ...entry.years]);

  const answer = await answerFollowup({
    persona: input.persona,
    nickname: plan.nickname,
    hourKnown: plan.hourKnown,
    expression: product.expression,
    situation: isPlanV2(plan) && plan.situation ? { label: plan.situation.label, context: plan.situation.context } : null,
    facts: plan.facts.map(({ ref, text }) => ({ ref, text })),
    userContext,
    questions,
    statements,
    timing,
    delivered,
    lastTurn: input.lastTurn,
    chart: input.chart,
    modelId: input.modelId,
    deadlineAt: input.deadlineAt,
    check: {
      questionRefs: questions.map((item) => item.ref),
      knownRefs: new Set([...plan.facts.map((fact) => fact.ref), ...userContext.map((item) => item.ref), ...statements.map((item) => item.ref), ...timingAll.map((item) => item.ref)]),
      timing: timingAll,
      percentSources: [...plan.facts.map((fact) => fact.text), ...statements.flatMap(statementTexts)],
      termSources: [...topics.flatMap((topic) => topic.statements).flatMap(statementTexts), ...input.messages.map((message) => message.text), ...(input.lastTurn ? [input.lastTurn.answer] : [])],
      excluded: excluded.map(({ summary, domain }) => ({ summary, domain })),
      persona: input.persona,
    },
  });

  if (answer.output.mode === "clarify") {
    return { status: "clarify", answer: `${answer.output.clarifyQuestion.trim()}\n\n${input.persona.lines.notCharged}`, refs: [], meta: answer.meta };
  }
  const body = questions
    .map((item) => answer.output.sections.find((section) => section.questionRef === item.ref)?.text)
    .filter((text): text is string => Boolean(text?.trim()))
    .map(tidyEmphasis)
    .join("\n\n");
  const note = excluded.length ? `\n\n${input.persona.lines.partialScope(excludedLabel(excluded))}` : "";
  return {
    status: "answered",
    answer: `${body}${note}`,
    refs: [...new Set(answer.output.sections.flatMap((section) => section.refs))],
    meta: answer.meta,
  };
}
