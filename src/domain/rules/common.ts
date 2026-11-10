import type { Weakness } from "./natal-tables";

/** 첫 상품 규칙 묶음의 식별자와 버전. 내용을 바꾸면 버전을 올리고 docs/rules/first-overview.md를 함께 고친다. */
export const RULESET_ID = "first-overview";
export const RULESET_VERSION = "3.1.0";
export const SOURCE_REF = `service:docs/rules/first-overview.md@${RULESET_VERSION}`;

export const OUTCOME_CAVEAT = "성향을 읽는 해석이며 실제 사건, 금액, 합격 여부를 판단하지 않는다.";
export const PARTIAL_CAVEAT = "태어난 시간을 몰라 시주를 뺀 범위에서 본 해석이다.";
export const GUARD_CAVEAT = "구조의 불확실성 표지가 함께 있어 단정하지 않고 경향으로 전달한다.";
export const SHINSAL_CAVEAT = "신살은 전통 해석의 보조 표지이며 단독으로 능력이나 사건을 확정하지 않는다.";
export const TRADITION_CAVEAT = "행운의 방향·색·숫자와 잘 맞는 지역은 전통 오행 해석을 재미로 옮긴 것이며 효과를 보장하지 않는다.";
export const FAMILY_CAVEAT = "가족 관계와 성장기는 사주 구조로 짐작한 것이며 실제 사건을 확정하지 않는다.";
export const HEALTH_CAVEAT = "기운을 쓰는 생활 리듬을 읽은 것이며 몸 상태나 질병을 진단하지 않는다.";
export const INVEST_CAVEAT = "돈을 움직이는 습관을 읽은 것이며 종목·시점·수익을 판단하지 않는다.";
export const JOB_CAVEAT = "직업과 업종은 십성과 오행의 전통 대응으로 고른 예시이며 실제 적성, 자격, 시장 상황을 대신하지 않는다.";

export interface CompareDetail {
  readonly options: readonly [string, string];
  readonly criteria: readonly { readonly name: string; readonly leaning: "first" | "second" | "neutral"; readonly reason: string }[];
  /** 사주로 알 수 없고 사용자에게 확인해야 하는 현실 조건. */
  readonly needs: readonly string[];
}

export type MarkerTone = "positive" | "caution" | "neutral";

export interface TimingMarker {
  readonly code: string;
  readonly tone: MarkerTone;
  /** 이 기간에 들어온 표지를 쉬운 말로 쓴 것. */
  readonly text: string;
  /** 그 표지에 맞춰 권하는 활동이나 조심할 점. */
  readonly activity: string;
  readonly evidenceId: string;
}

export interface TimingDetail {
  readonly periodId: string;
  readonly periodKind: string;
  readonly label: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly tenGod: string | null;
  readonly markers: readonly TimingMarker[];
  /** 12운성은 단독 근거로 쓰지 않고 보조 설명으로만 둔다. */
  readonly stageNote: string | null;
  /** 상품 안에서 달을 고르는 선택 기준. 사건 확률이 아니다 (긍정 표지 수 - 조심 표지 수). */
  readonly selectionScore: number;
}

/** 판단 하나를 설명할 때 LLM과 화면 계획이 쓰는 세부 내용. 규칙이 결론과 함께 만든다. */
export interface RuleDetail {
  /** 상품 주제의 어떤 항목에 해당하는지 (ProductTopic.outline의 이름). */
  readonly aspect: string;
  /** 쉬운 말로 쓴 근거. "왜 그렇게 읽는지"를 설명할 때 쓴다. */
  readonly basis: readonly string[];
  readonly upside?: string;
  /** 근거가 있는 약점. 직설적으로 설명할 대상이다. */
  readonly weakness?: Weakness;
  readonly action?: string;
  /** 반대 근거나 예외. */
  readonly counterNote?: string;
  readonly compare?: CompareDetail;
  readonly timing?: TimingDetail;
}

/** 규칙이 결론마다 남기는 세부 내용. 요청 하나에서만 쓰고 버린다. */
export type RuleDetailSink = Map<string, RuleDetail>;

export function detailKey(ruleId: string, periodId: string | null, statement: string): string {
  return `${ruleId}|${periodId ?? "natal"}|${statement}`;
}

export function ruleMetadata(name: string) {
  return {
    ruleId: `${RULESET_ID}.${name}`,
    version: RULESET_VERSION,
    sourceRefs: [SOURCE_REF],
    reviewStatus: "unreviewed" as const,
  };
}
