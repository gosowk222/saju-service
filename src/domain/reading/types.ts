/** 풀이 작성 재료와 메시지의 형식. 계산, 해석, 사용자 상황, 창작을 구분해서 보관한다. */

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
};

export type UserContextStatement = {
  readonly ref: string;
  readonly kind: "user-context";
  readonly text: string;
  readonly source: "situation" | "concern";
};

export type PlanStatement = FactStatement | InterpretationStatement | UserContextStatement;

export type TopicPlanStatus = "adopted" | "tentative" | "limited";

export interface TopicPlan {
  readonly topicId: string;
  readonly title: string;
  readonly status: TopicPlanStatus;
  readonly limitNote: string | null;
  readonly statements: readonly InterpretationStatement[];
  readonly bubbles: { readonly min: number; readonly target: number; readonly max: number };
  readonly creativeSceneAllowed: boolean;
}

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
}

export interface NarrationTopic {
  readonly topicId: string;
  readonly bubbles: readonly NarrationBubble[];
}

export interface NarrationOutput {
  readonly opening: string;
  readonly topics: readonly NarrationTopic[];
  readonly closing: string;
}

export interface FollowupOutput {
  readonly relevance: "related" | "unrelated";
  readonly answer: string;
  readonly refs: readonly string[];
}

/** 저장되는 메시지 한 줄. */
export interface StoredMessage {
  readonly seq: number;
  readonly topicId: string | null;
  readonly kind: MessageKind;
  readonly text: string;
  readonly refs: readonly string[];
}
