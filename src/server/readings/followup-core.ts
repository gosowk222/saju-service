import "server-only";
import type { Persona } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { statementTexts } from "@/domain/reading/check";
import { tidyEmphasis } from "@/domain/reading/emphasis";
import { assembleFocus, focusTopicsOf } from "@/domain/reading/focus";
import { excludedItems, excludedLabel, inScopeFacts, inScopeItems, itemDomain, reactionOf, type QuestionAnalysis } from "@/domain/reading/question";
import { isPlanV2, type AnyReadingPlan, type ChartView, type StoredMessage, type TimingAnalysis, type UserContextStatement } from "@/domain/reading/types";
import { LLM_SETTINGS } from "@/server/llm/config";
import { answerFollowup, answerFollowupProgressive, type GenerationMeta } from "@/server/llm/narrate";

export type FollowupStatus = "answered" | "off_topic" | "clarify";


/** 이전 계획(1.0.0)의 사용자 상황에는 궁금한 점의 원문이 들어 있다. 범위 판정 전 원문이라 후속 답변 재료로 쓰지 않는다. */
function baseContext(plan: AnyReadingPlan): UserContextStatement[] {
  return plan.userContext.filter((item) => item.source !== "concern");
}

/** 질문 없이 반응(칭찬·놀림·의심)만 보낸 메시지인지. 저장된 분석 기록(followups.analysis)에도 쓴다. */
export function isReactionOnly(analysis: { readonly reaction?: string; readonly items: readonly unknown[] } | null | undefined): boolean {
  return Boolean(analysis && analysis.reaction && analysis.reaction !== "none" && analysis.items.length === 0);
}

/**
 * 질문이 범위 안 질문을 하나도 갖지 않을 때의 처리. 모델 없이 보내는 문장이라 풀이를 맡은 캐릭터의 고정 문장(persona.lines)을 쓴다.
 * 범위 밖 안내와 되묻기는 차감하지 않는다. 반응만 보낸 메시지는 상품의 무료 횟수(earlierReactions가 그보다 적을 때)까지만
 * 차감하지 않고, 넘으면 같은 반응 문장으로 답하되 질문 1회로 센다 (answered).
 */
export function routeWithoutItems(
  product: ProductDefinition,
  persona: Persona,
  analysis: QuestionAnalysis,
  question = "",
  earlierReactions = 0,
): { status: FollowupStatus; answer: string } {
  const reaction = reactionOf(analysis);
  if (reaction !== "none" && isReactionOnly(analysis)) {
    const charged = earlierReactions >= product.freeReactions;
    const line = persona.lines.reaction(reaction, question);
    return charged
      ? { status: "answered", answer: `${line}\n\n${persona.lines.reactionCharged}` }
      : { status: "clarify", answer: `${line}\n\n${persona.lines.reactionFree}` };
  }
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
  /**
   * 문단이 완성될 때마다 그때까지의 답(문단을 빈 줄로 이은 것)을 저장한다. 있으면 스트리밍으로 받아 먼저 보여 준다.
   * 이 요청이 더는 이 질문을 맡지 않으면 오류를 던진다.
   */
  readonly publish?: (answer: string) => Promise<void>;
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

  // 처음 궁금한 점에서 알려 준 사실(fact)과 이번 메시지에서 알려 준 사실(message)을 나눠 둔다.
  // 생성 입력에서 출처(from)로 구분해, 예전에 한 '힘들다'는 말 때문에 지금 답의 말투가 바뀌지 않게 한다.
  const earlier = input.initialAnalysis ? inScopeFacts(product, input.initialAnalysis) : [];
  const current = inScopeFacts(product, analysis);
  const base = baseContext(plan);
  const added: Pick<UserContextStatement, "text" | "source">[] = [
    ...earlier.map((text) => ({ text: `사용자가 직접 알려 준 상황: ${text}`, source: "fact" as const })),
    ...current.map((text) => ({ text: `이번 메시지에서 사용자가 알려 준 상황: ${text}`, source: "message" as const })),
  ];
  const userContext: UserContextStatement[] = [
    ...base,
    ...added.map((item, index) => ({ ref: `u${base.length + index + 1}`, kind: "user-context" as const, ...item })),
  ];
  const timingAll = timing.flatMap((entry) => [...entry.months, ...entry.years]);

  const args = {
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
    reaction: reactionOf(analysis),
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
  };
  const publish = input.publish;
  const answer = publish
    ? await answerFollowupProgressive({
        ...args,
        publish: (sections) => publish(sections.map((section) => section.paragraphs.join("\n\n")).join("\n\n")),
      })
    : await answerFollowup(args);

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
