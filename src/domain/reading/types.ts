/** 풀이 작성 재료와 메시지의 형식. 계산, 해석, 사용자 상황, 창작을 구분해서 보관한다. */
import type { CompareDetail, Weakness } from "../rules/first-overview";
import type { QuestionDomain, QuestionIntent } from "../products/types";

export type FactStatement = {
  readonly ref: string;
  readonly kind: "engine-fact";
  readonly text: string;
  readonly originPath: string;
};

export type InterpretationStatement = {
  readonly ref: string;
  readonly kind: "service-interpretation";
  readonly text: string;
  readonly status: "candidate" | "deferred" | "observation";
  readonly caveats: readonly string[];
  readonly conclusionId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  /** 2.0.0 계획부터 있다. 상품 주제의 어떤 항목인지. */
  readonly aspect?: string;
  /** 쉬운 말로 쓴 판단 이유. */
  readonly basis?: readonly string[];
  readonly upside?: string;
  /** 근거가 있는 약점. 직설적으로 설명할 대상이다. */
  readonly weakness?: Weakness;
  readonly action?: string;
  readonly counterNote?: string;
  readonly compare?: CompareDetail;
  /**
   * 명리 설명 재료 (상품 3.1.0부터). 이 해석이 쓴 엔진 근거를 원국 글자·십성·신살·합충 문장으로 옮긴 것이다
   * ("월주의 유금(酉金)은 식신이에요."). 이전에 만든 계획에는 없다.
   */
  readonly lore?: readonly string[];
};

export type UserContextStatement = {
  readonly ref: string;
  readonly kind: "user-context";
  readonly text: string;
  /**
   * situation: 고른 상황, concern: 1.0.0 계획의 원문, fact: 궁금한 점(최초 풀이 때 적은 글)에서 정리한 사용자 사실,
   * message: 지금 답하는 후속 메시지에서 정리한 사용자 사실. 생성 입력에서는 지금 한 말과 예전에 한 말을 구분하는 데 쓴다.
   */
  readonly source: "situation" | "concern" | "fact" | "message";
};

export type PlanStatement = FactStatement | InterpretationStatement | UserContextStatement;

export type TopicPlanStatus = "adopted" | "tentative" | "limited";

/** 1.0.0 계획의 주제. 저장된 이전 풀이를 읽을 때 쓴다. */
export interface TopicPlan {
  readonly topicId: string;
  readonly title: string;
  readonly status: TopicPlanStatus;
  readonly limitNote: string | null;
  readonly statements: readonly InterpretationStatement[];
  readonly bubbles: { readonly min: number; readonly target: number; readonly max: number };
  readonly creativeSceneAllowed: boolean;
}

/** 1.0.0 계획. 이전에 만든 풀이의 internals에 저장되어 있다. */
export interface ReadingPlan {
  readonly planVersion: string;
  readonly productId: string;
  readonly productVersion: string;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly personaId: string;
  readonly personaVersion: string;
  readonly nickname: string;
  readonly hourKnown: boolean;
  readonly coverageNotes: readonly string[];
  readonly facts: readonly FactStatement[];
  readonly userContext: readonly UserContextStatement[];
  readonly topics: readonly TopicPlan[];
}

export type TopicWeight = "focus" | "lead" | "standard" | "light";

export interface TopicPlanV2 {
  readonly topicId: string;
  readonly title: string;
  readonly inquiryDomain: string;
  readonly status: TopicPlanStatus;
  readonly limitNote: string | null;
  readonly statements: readonly InterpretationStatement[];
  /** 이 주제에서 다룰 항목. */
  readonly outline: readonly string[];
  readonly depth: { readonly light: number; readonly standard: number; readonly focus: number };
  readonly weight: TopicWeight;
  /** 말풍선 수의 계획 목표. 상한이 아니다. */
  readonly target: number;
  readonly creativeSceneAllowed: boolean;
  /** 고른 상황에서 이 주제를 볼 관점. */
  readonly situationAngle: string | null;
}

/** 2.0.0 계획. 풀이를 만들 때 저장하는 원국 재료이며, 생성할 때 질문 분석과 기간 재료를 더한다. */
export interface ReadingPlanV2 {
  readonly planVersion: "2.0.0";
  readonly productId: string;
  readonly productVersion: string;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly personaId: string;
  readonly personaVersion: string;
  readonly nickname: string;
  readonly hourKnown: boolean;
  readonly gender: "male" | "female";
  readonly coverageNotes: readonly string[];
  readonly facts: readonly FactStatement[];
  /** 고른 상황. 원문 궁금한 점은 여기에 넣지 않는다 (readings.concern에만 있다). */
  readonly userContext: readonly UserContextStatement[];
  readonly situation: { readonly id: string; readonly label: string; readonly context: string } | null;
  readonly topics: readonly TopicPlanV2[];
}

export type AnyReadingPlan = ReadingPlan | ReadingPlanV2;

export function isPlanV2(plan: AnyReadingPlan): plan is ReadingPlanV2 {
  return plan.planVersion === "2.0.0";
}

export type TimingVerdict = "notable" | "mixed" | "careful" | "quiet";

/** 한 기간(월운·세운)의 판단. 그 기간의 근거만 연결한다. */
export interface TimingPeriodStatement {
  readonly ref: string;
  readonly kind: "timing";
  readonly periodId: string;
  readonly periodKind: string;
  /** 사용자에게 쓰는 이름: "2027년 3월" 또는 "2027년". */
  readonly label: string;
  readonly engineLabel: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly verdict: TimingVerdict;
  readonly statement: string;
  readonly markers: readonly { readonly tone: string; readonly text: string; readonly activity: string }[];
  readonly stageNote: string | null;
  readonly selectionScore: number;
  readonly conclusionId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly counterEvidenceIds: readonly string[];
  readonly contextualEvidenceIds: readonly string[];
  readonly caveats: readonly string[];
}

/** 한 주제와 기간에 대한 기간 분석 결과. 엔진 계산 뒤 캐시에 저장하고 다시 쓴다. */
export interface TimingAnalysis {
  readonly version: string;
  readonly domain: string;
  readonly window: { readonly kind: "default" | "explicit"; readonly startMonth: string; readonly endMonth: string; readonly label: string };
  readonly status: "available" | "insufficient" | "unsupported";
  readonly months: readonly Omit<TimingPeriodStatement, "ref">[];
  readonly years: readonly Omit<TimingPeriodStatement, "ref">[];
  readonly decade: { readonly label: string; readonly tenGod: string | null; readonly approximate: boolean } | null;
  /** 판단 기준. 사건 확률이 아니다. */
  readonly notable: readonly string[];
  readonly careful: readonly string[];
  readonly limitations: readonly string[];
  readonly referenceDate: string;
}

export interface TimingPlanV2 {
  readonly id: string;
  readonly domain: string;
  readonly topicId: string;
  readonly windowLabel: string;
  readonly explicit: boolean;
  readonly status: TimingAnalysis["status"];
  readonly months: readonly TimingPeriodStatement[];
  readonly years: readonly TimingPeriodStatement[];
  readonly decade: TimingAnalysis["decade"];
  readonly notableRefs: readonly string[];
  readonly carefulRefs: readonly string[];
  readonly limitations: readonly string[];
}

export interface FocusQuestion {
  readonly ref: string;
  readonly summary: string;
  readonly domain: QuestionDomain;
  readonly topicId: string | null;
  readonly intent: QuestionIntent;
  readonly options: readonly string[];
  readonly answerability: "full" | "limited";
  readonly missingInfo: readonly string[];
  /** 질문에 직접 관련된 해석 ref. */
  readonly relatedRefs: readonly string[];
  readonly timingId: string | null;
  /** 기간을 묻지만 기간 판단 규칙이 없는 주제일 때의 안내. */
  readonly timingNote: string | null;
}

/** 생성할 때 만드는 최종 작성 계획. 저장된 원국 계획에 질문과 기간 재료를 더한 것이다. */
export interface NarrationPlanV2 {
  readonly base: ReadingPlanV2;
  readonly topics: readonly TopicPlanV2[];
  readonly userContext: readonly UserContextStatement[];
  readonly questions: readonly FocusQuestion[];
  readonly timing: readonly TimingPlanV2[];
  readonly focusSection: { readonly id: string; readonly title: string };
  readonly length: { readonly bubbleChars: number; readonly bubbleHardMax: number; readonly focusBubblesPerQuestion: number; readonly totalBubbles: { readonly min: number; readonly max: number } };
  readonly expression: { readonly directness: string; readonly humor: string; readonly scenes: string };
}

/** 나중에 어떤 판단과 근거로 만들었는지 확인하기 위한 기록. 화면에는 내보내지 않는다. */
export interface TopicTrace {
  readonly topicId: string;
  readonly inquiryDomain: string;
  readonly inquiryStatus: string;
  readonly policyVersion: string;
  readonly limitations: readonly string[];
  readonly evaluatedRules: unknown;
  readonly conclusions: readonly {
    readonly id: string;
    readonly status: string;
    readonly statement: string;
    readonly rule: unknown;
    readonly supportingEvidenceIds: readonly string[];
    readonly counterEvidenceIds: readonly string[];
    readonly contextualEvidenceIds: readonly string[];
    readonly sourceRefs: readonly string[];
    readonly caveats: readonly string[];
    readonly adopted: boolean;
  }[];
}

export type ChartElement = "목" | "화" | "토" | "금" | "수";

export interface ChartSymbol {
  readonly ko: string;
  readonly hanja: string;
  readonly element: ChartElement;
  readonly tenGod: string | null;
}

export interface ChartPillar {
  readonly key: "hour" | "day" | "month" | "year";
  readonly label: string;
  readonly stem: ChartSymbol | null;
  readonly branch: ChartSymbol | null;
}

export interface ChartView {
  readonly pillars: readonly ChartPillar[];
  readonly dayMaster: { readonly ko: string; readonly hanja: string; readonly element: ChartElement } | null;
  readonly elementPercent: Readonly<Record<ChartElement, number>> | null;
  readonly hourKnown: boolean;
  readonly status: string;
  readonly notes: readonly string[];
}

export interface ReadingPreview {
  readonly bubbles: readonly string[];
  readonly limitNotes: readonly string[];
}

export type MessageKind = "explanation" | "creative-scene" | "transition";

/** LLM이 돌려주는 구조. 내용이 옳다는 보장은 아니므로 check.ts에서 다시 검사한다. */
export interface NarrationBubble {
  readonly kind: MessageKind;
  readonly refs: readonly string[];
  readonly text: string;
  /** narration-2.1.0부터. 굵게 보일 핵심 구절(text 안의 글자 그대로). 저장할 때 **표시**로 바꾸고 따로 보관하지 않는다. */
  readonly highlight?: string;
}

export interface NarrationTopic {
  readonly topicId: string;
  readonly bubbles: readonly NarrationBubble[];
}

/** narration-1.0.0 출력. */
export interface NarrationOutput {
  readonly opening: string;
  readonly topics: readonly NarrationTopic[];
  readonly closing: string;
}

/** narration-2.0.0 출력. focus는 궁금한 점에 직접 답하는 영역이며 질문이 없으면 비어 있다. */
export interface NarrationOutputV2 {
  readonly opening: string;
  readonly focus: readonly NarrationBubble[];
  readonly topics: readonly NarrationTopic[];
  readonly closing: string;
}

/** followup-output-1.0.0 출력. */
export interface FollowupOutput {
  readonly relevance: "related" | "unrelated";
  readonly answer: string;
  readonly refs: readonly string[];
}

/** followup-output-2.0.0 출력. 소질문마다 답을 나눠 받는다. */
export interface FollowupOutputV2 {
  readonly mode: "answer" | "clarify";
  readonly sections: readonly { readonly questionRef: string; readonly text: string; readonly refs: readonly string[] }[];
  readonly clarifyQuestion: string;
}

/** 저장되는 메시지 한 줄. */
export interface StoredMessage {
  readonly seq: number;
  readonly topicId: string | null;
  readonly kind: MessageKind;
  readonly text: string;
  readonly refs: readonly string[];
}
