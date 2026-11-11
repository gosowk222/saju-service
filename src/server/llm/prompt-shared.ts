import type { Persona } from "@/domain/personas";
import type { LegacyPersona } from "@/domain/personas/legacy";
import type { FocusQuestion, NarrationPlanV2, ReadingPlan, TimingPlanV2, UserContextStatement } from "@/domain/reading/types";

/** 최초 풀이와 후속 답변, 이전 지시(prompts-legacy.ts)와 현재 지시(prompts.ts)가 함께 쓰는 입력 조각. */

/** 지시가 받는 캐릭터 설정. 현재 지시는 현재 설정(Persona), 이전 지시는 그 버전과 함께 쓰던 이전 설정을 받는다. */
export type PromptPersona = Persona | LegacyPersona;

export function isCurrentPersona(persona: PromptPersona): persona is Persona {
  return "character" in persona;
}

export interface ReadingPromptArgs {
  readonly plan: ReadingPlan;
  readonly persona: PromptPersona;
  readonly previousIssues: readonly string[];
}

/**
 * 사용자 상황의 출처. 생성 입력에서 고른 상황, 처음 궁금한 점에 적은 말, 지금 메시지에서 한 말을 구분해
 * 상황 선택이나 예전에 한 말 때문에 지금의 말투를 바꾸지 않게 한다 (reading-2.6.0, followup-2.6.0).
 */
export const CONTEXT_FROM: Readonly<Record<UserContextStatement["source"], "situation" | "concern" | "message">> = {
  situation: "situation",
  concern: "concern",
  fact: "concern",
  message: "message",
};
export const contextInputWithSource = (items: readonly UserContextStatement[]) => items.map(({ ref, text, source }) => ({ ref, text, from: CONTEXT_FROM[source] }));

export function timingInput(plan: TimingPlanV2) {
  // 12운성 메모는 단독 근거로 쓰지 않도록 작성 재료에 넣지 않는다 (저장된 분석에는 남아 있다).
  const period = (item: TimingPlanV2["months"][number]) => ({
    ref: item.ref,
    label: item.label,
    verdict: item.verdict,
    markers: item.markers,
  });
  return {
    id: plan.id,
    topicId: plan.topicId,
    windowLabel: plan.windowLabel,
    status: plan.status,
    decade: plan.decade ? plan.decade.label : null,
    years: plan.years.map(period),
    months: plan.months.map(period),
    notable: plan.notableRefs,
    careful: plan.carefulRefs,
    limits: plan.limitations,
  };
}

export function questionInput(question: FocusQuestion, focusBubbles: number) {
  return {
    ref: question.ref,
    summary: question.summary,
    intent: question.intent,
    topicId: question.topicId,
    options: question.options,
    answerability: question.answerability,
    missingInfo: question.missingInfo,
    relatedRefs: question.relatedRefs,
    timingId: question.timingId,
    timingNote: question.timingNote,
    focusBubbles,
  };
}

export const contextInput = (items: readonly UserContextStatement[]) => items.map(({ ref, text }) => ({ ref, text }));

/** 이미 화면에 보낸 부분 (굵게 표시를 뺀 문장). 이어 쓰기(reading-2.4.0부터)에서만 입력에 넣는다. */
export interface AlreadySent {
  readonly opening: string | null;
  readonly focus: readonly string[];
  readonly topics: readonly { readonly topicId: string; readonly texts: readonly string[] }[];
}

export interface ReadingPromptV2Args {
  readonly plan: NarrationPlanV2;
  readonly persona: PromptPersona;
  readonly previousIssues: readonly string[];
  readonly alreadySent?: AlreadySent | null;
}
