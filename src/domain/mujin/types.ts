/**
 * 무진 상품의 작성 계획, 결과 블록, 화면 상태 형식.
 *
 * 계산된 사실(engine-fact), 서비스가 채택한 판단(judgment·period), 채택 판단에서 이은 설명(derived),
 * 판단이 없을 때의 일반 점검(general), 사용자가 알려 준 사실(user-fact)을 구분해 보관한다.
 * 작성용 참조(ref)는 서버가 원래 근거 ID·규칙과의 연결을 보존한다. 화면에는 근거 ID를 내보내지 않는다.
 */
import type { CompareDetail } from "../rules/common";
import type { Family } from "../rules/materials";
import type { Weakness } from "../rules/natal-tables";
import type { ScrollTable } from "../products/types";
import type { ChartElement, ChartView, TimingAnalysis } from "../reading/types";
import type { MujinNow } from "./now";

export const MUJIN_PLAN_VERSION = "mujin-plan-1.0.0";

/** 무료 단계와 유료 단계. 유료 단계의 초안·완성문은 권한 확인 뒤에만 만든다. */
export type ScrollTier = "free" | "paid";

/**
 * 질문 하나의 판단 상태 (02_DECISION_RULES.md 2절).
 * adopted: 채택. conditional: 판단은 있으나 조건·한계를 함께 말해야 한다(엔진 tentative 등).
 * deferred: 시각 미상·경계값 근처 등으로 판단을 보류. general: 판단이 없어 일반 점검·일반 상황 제안으로만 다룬다.
 * unavailable: 계산 자료 자체가 없다(예: 시각 미상이라 대운이 없음).
 */
export type QuestionStatus = "adopted" | "conditional" | "deferred" | "general" | "unavailable";

/**
 * 작성 재료 한 줄의 종류.
 * engine-fact: 엔진 계산값. judgment: 규칙의 원국 판단. period: 규칙의 기간 판단(월운·대운).
 * derived: 채택된 판단의 의미 태그에서 이은 설명 연결 (parentRefs 필수, 새 계산 근거가 아니다).
 * general: 판단이 없을 때의 일반 점검·일반 상황 제안 (사주 판단이 아님을 밝힌다).
 * user-fact: 사용자가 알려 준 상황·사실 (source와 factKind로 출처를 보존).
 */
export type MaterialKind = "engine-fact" | "judgment" | "period" | "derived" | "general" | "user-fact";

/** 사용자 사실의 종류 (03_INPUT_AND_PERSONALIZATION.md 6절). 계획·가정을 현재 사실로 올리지 않는다. */
export type UserFactKind = "current" | "past" | "plan" | "hypothetical" | "about-others";

/** now-selection: '지금의 나'에서 고른 항목. concern: 진짜 궁금한 점에서 정리한 사실. */
export type UserFactSource = "now-selection" | "concern";

export interface MaterialEvidence {
  /** 엔진 근거 ID. 원국·대상 기간의 직접 근거. */
  readonly supporting: readonly string[];
  readonly counter: readonly string[];
  /** 명시한 보조 기간(세운·대운)의 근거. 직접 근거로 쓰지 않는다. */
  readonly contextual: readonly string[];
}

export interface MujinMaterial {
  /** 작성용 참조 (m1, m2 …). 계획 안에서 고유하다. */
  readonly ref: string;
  readonly kind: MaterialKind;
  /** 이 재료로 답할 질문 ID (P01~P05, 1-1~10-4). */
  readonly questionIds: readonly string[];
  /** 의미 메모. 모델이 그대로 옮겨 적을 대본이 아니다. */
  readonly text: string;
  readonly scope: "natal" | "period" | "user";
  /** judgment·period: 엔진 결론 상태. */
  readonly status?: "candidate" | "deferred" | "observation";
  readonly ruleId?: string;
  readonly ruleVersion?: string;
  readonly conclusionId?: string;
  /** 규칙이 고른 변형 (태그표의 열쇠). */
  readonly variant?: string;
  readonly aspect?: string;
  readonly basis?: readonly string[];
  readonly upside?: string;
  readonly weakness?: Weakness;
  readonly action?: string;
  readonly counterNote?: string;
  readonly compare?: CompareDetail;
  readonly lore?: readonly string[];
  readonly caveats?: readonly string[];
  /** 규칙 작성자가 채택 판단에 붙인 의미 태그 (src/domain/mujin/tags.ts). 생성 문장에서 찾은 단어가 아니다. */
  readonly tags?: readonly string[];
  /** derived 재료가 이어 받은 판단의 ref. */
  readonly parentRefs?: readonly string[];
  readonly periodId?: string;
  readonly evidence?: MaterialEvidence;
  readonly source?: UserFactSource;
  readonly factKind?: UserFactKind;
}

export interface MujinQuestionPlan {
  readonly id: string;
  readonly title: string;
  readonly status: QuestionStatus;
  /** 이 질문에 쓸 재료 ref. 같은 원인의 근거는 한 번만 넣는다. */
  readonly refs: readonly string[];
  /** 상태에 따라 지켜야 할 작성 조건 (보류 이유, 일반 점검이라는 표시, 자료 없음 설명). */
  readonly note: string | null;
}

/** 설명 비중. question: 진짜 궁금한 점과 직접 관련, interest: 관심 주제로 고른 장, standard: 그 밖. 판단 강도는 바꾸지 않는다. */
export type SectionWeight = "question" | "interest" | "standard";

export interface MujinSectionPlan {
  readonly sectionId: string;
  readonly tier: ScrollTier;
  readonly title: string;
  readonly questions: readonly MujinQuestionPlan[];
  readonly materials: readonly MujinMaterial[];
  readonly weight: SectionWeight;
  /** 비중을 반영한 편집 목표 (공백 포함 글자 수). 강제 최소가 아니다. */
  readonly targetChars: { readonly min: number; readonly max: number };
  /** 고른 상황에서 이 장을 볼 관점. 선택지의 의미이며 사용자가 알려 준 사실이 아니다. */
  readonly situationNotes: readonly string[];
}

/** 원국 12운성 한 칸. scope natal 항목만 쓴다 (월운 항목을 섞지 않는다). */
export interface NatalStageCell {
  readonly position: "year" | "month" | "day" | "hour";
  readonly label: string;
  /** day-master: 일간 기준, self: 그 기둥 천간 기준 (엔진 basis 그대로). */
  readonly basis: "day-master" | "self";
  readonly stem: string;
  readonly branch: string;
  /** 엔진 단계 이름 (장생, 목욕, 관대, 건록, 제왕, 쇠, 병, 사, 묘, 절, 태, 양). */
  readonly stage: string;
}

export interface TenGodCell {
  readonly position: "year" | "month" | "day" | "hour";
  readonly label: string;
  /** 천간 십성. 일간 자리는 "일간". */
  readonly stem: string | null;
  /** 지지 본기 십성. */
  readonly branch: string | null;
  /** 지장간 십성 (본기 포함, 엔진 순서). */
  readonly hidden: readonly string[];
}

/** 화면·PDF의 무료 표. 모두 엔진 계산값이며 LLM이 다시 쓰지 않는다. */
export interface MujinTables {
  readonly elements: {
    /** 겉 여덟 글자(시각 미상이면 여섯 글자)의 단순 개수. */
    readonly counts: Readonly<Record<ChartElement, number>>;
    /** 엔진 가중 비율 (천간 1, 지장간 1·0.5·0.3, 월지 2배). 계산되지 않았으면 null. */
    readonly percents: Readonly<Record<ChartElement, number>> | null;
  };
  readonly stages: readonly NatalStageCell[];
  readonly tenGods: {
    readonly cells: readonly TenGodCell[];
    /** 다섯 계열의 엔진 가중 비율. 계산되지 않았으면 null. */
    readonly families: Readonly<Record<Family, number>> | null;
  };
}

/** 결제 전 저장하는 원국 작성 계획. 질문 분석·기간 재료는 생성 단계에서 더한다. */
export interface MujinPlan {
  readonly planVersion: typeof MUJIN_PLAN_VERSION;
  readonly productId: string;
  readonly productVersion: string;
  readonly personaId: string;
  readonly personaVersion: string;
  /** 판단에 쓴 규칙 묶음과 버전 (재사용한 first-overview 규칙 포함). */
  readonly rulesets: readonly { readonly id: string; readonly version: string; readonly reviewStatus: string }[];
  readonly tagCatalogVersion: string;
  readonly nickname: string;
  readonly gender: "male" | "female";
  readonly hourKnown: boolean;
  readonly coverageNotes: readonly string[];
  readonly now: MujinNow;
  /** '지금의 나'에서 고른 항목 (user-fact, source now-selection). */
  readonly nowFacts: readonly MujinMaterial[];
  /** 여러 장이 함께 쓰는 계산 사실 (일간, 계절, 강약, 격국, 분포). */
  readonly facts: readonly MujinMaterial[];
  readonly tables: MujinTables;
  /** 기초 분석과 1~8장 (원국 판단). 9·10장과 마지막 정리는 유료 생성 때 기간 재료로 만든다. */
  readonly sections: readonly MujinSectionPlan[];
}

/** 9장 대운 한 구간. 경계는 엔진 계약상 항상 근사값이다. */
export interface MujinLuckPeriod {
  readonly periodId: string;
  /** 엔진 라벨 (예: "23세부터"). */
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly approximate: boolean;
  /** 간지 한글 (예: "갑자"). */
  readonly ganzhi: string;
  readonly stemTenGod: string | null;
  readonly stemFamily: Family | null;
}

export interface MujinLuck {
  readonly status: "available" | "unavailable";
  /** hour-unknown: 시각 미상이라 엔진이 대운을 계산하지 않음. outside-sequence: 기준일이 계산된 대운 범위 밖. */
  readonly reason: "hour-unknown" | "outside-sequence" | "engine-unavailable" | null;
  /** 현재 구간을 고른 기준 시각 (Asia/Seoul 기준일 정오). */
  readonly referenceAt: string;
  readonly previous: MujinLuckPeriod | null;
  readonly current: MujinLuckPeriod | null;
  readonly next: MujinLuckPeriod | null;
}

export type MonthDomain = "career" | "wealth" | "romance" | "social";

/** 같은 달의 표지 구성. 긍정·주의 혼합, 긍정만, 주의만, 중립, 자료 부족을 구분한다. 점수가 아니다. */
export type MonthTone = "mixed" | "positive" | "caution" | "neutral" | "no-data";

export interface MujinMonthCell {
  readonly domain: MonthDomain;
  readonly tone: MonthTone;
  readonly markers: readonly { readonly tone: string; readonly text: string; readonly activity: string }[];
}

export interface MujinMonth {
  /** 엔진 월운 ID (monthly:YYYY-MM, 절기 기준). */
  readonly periodId: string;
  readonly label: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  /** 첫 달은 기준일 이전 날짜가 이미 지났다. 지난 날짜를 미래처럼 설명하지 않는다. */
  readonly startedBeforeReference: boolean;
  readonly cells: readonly MujinMonthCell[];
}

export interface MujinMonths {
  readonly status: "available" | "insufficient";
  readonly window: { readonly startMonth: string; readonly endMonth: string; readonly label: string };
  /** 기준일이 속한 절기 월부터 연속 12개. 표지가 없는 달도 남긴다. */
  readonly months: readonly MujinMonth[];
  /** 분야 안에서 고른 주목 구간 (긍정 표지 수 − 주의 표지 수 ≥ 1, 최대 3, 동점은 이른 달). 없으면 비어 있다. */
  readonly notable: readonly { readonly domain: MonthDomain; readonly periodIds: readonly string[] }[];
  /** 분야 안에서 고른 주의 우세 구간 (최대 2). 없으면 비어 있다. */
  readonly careful: readonly { readonly domain: MonthDomain; readonly periodIds: readonly string[] }[];
  readonly limitations: readonly string[];
}

/** 유료 생성을 시작할 때 한 번 계산해 저장하고, 재시도·재열람·후속 질문에서 그대로 쓰는 기간 재료. */
export interface MujinTimingBundle {
  readonly version: string;
  /** 첫 유료 분석 때 고정한 Asia/Seoul 기준일 (YYYY-MM-DD). */
  readonly referenceDate: string;
  readonly luck: MujinLuck;
  readonly months: MujinMonths;
  /** 분야별 원래 기간 분석 (근거 ID·규칙 버전 보존). */
  readonly analyses: readonly TimingAnalysis[];
}

/** 족자 결과 블록의 종류 (05_UX_AND_ASSETS.md 3절). 장 제목·기간표·원국표는 앱이 그린다. */
export const SCROLL_BLOCK_TYPES = ["paragraph", "basis", "condition", "compare", "apply", "checklist", "scene"] as const;
export type ScrollBlockType = (typeof SCROLL_BLOCK_TYPES)[number];

export interface ScrollBlockItem {
  /** compare: 선택지 이름, checklist: 비워 둔다. */
  readonly label: string;
  readonly text: string;
}

/**
 * paragraph: 설명 문단, basis: 짧은 근거 설명, condition: 조건·반대 근거, compare: 비교(items),
 * apply: 생활 적용, checklist: 점검 항목(items), scene: 가정해 보는 생활 장면(실제 이력·예언이 아님).
 */
export interface ScrollBlock {
  readonly type: ScrollBlockType;
  /** 이 블록이 답하는 질문 ID. */
  readonly questionIds: readonly string[];
  /** 쓴 재료 ref. 화면에는 보이지 않는다. */
  readonly refs: readonly string[];
  readonly text: string;
  readonly items: readonly ScrollBlockItem[];
}

export interface ScrollSectionContent {
  readonly sectionId: string;
  /** 핵심 답. 장 첫머리에 보인다. */
  readonly coreAnswer: string;
  readonly blocks: readonly ScrollBlock[];
}

/** Pass 1 초안. 서버에만 저장한다. */
export interface ScrollDraftContent extends ScrollSectionContent {
  /** 이 장에서 쓴 생활 장면·조언의 짧은 요약. 다음 묶음이 같은 장면을 되풀이하지 않게 넘긴다 (금칙어 목록이 아니다). */
  readonly scenes: readonly string[];
}

/** 화면에 보이는 장 상태. locked: 구매 전 유료 장, waiting: 아직 차례가 아님, writing: 실제로 작성 중. */
export type SectionViewState = "locked" | "waiting" | "writing" | "done" | "failed";

export type PhaseStatus = "idle" | "queued" | "running" | "completed" | "failed" | "locked";

export interface ScrollSectionView {
  readonly id: string;
  readonly kind: "chart" | "basics" | "chapter" | "closing";
  readonly number: number | null;
  readonly title: string;
  readonly tier: ScrollTier;
  readonly summary: string;
  readonly questions: readonly { readonly id: string; readonly title: string }[];
  readonly tables: readonly ScrollTable[];
  readonly state: SectionViewState;
  /** 완성되었고 볼 권한이 있을 때만 있다. 유료 장은 권한이 없으면 항상 null이다. */
  readonly content: ScrollSectionContent | null;
}

export interface ScrollPhaseView {
  readonly status: PhaseStatus;
  readonly canRetry: boolean;
  readonly errorCode: string | null;
}

/** GET 상태 API가 브라우저에 보내는 값. 유료 본문과 기간표는 권한이 있을 때만 들어간다. */
export interface ScrollStateView {
  readonly readingId: string;
  readonly productId: string;
  readonly productName: string;
  readonly personaId: string;
  readonly personaName: string;
  readonly nickname: string;
  readonly createdAt: string;
  readonly hourKnown: boolean;
  readonly chart: ChartView;
  readonly tables: MujinTables;
  readonly entitled: boolean;
  readonly free: ScrollPhaseView;
  readonly paid: ScrollPhaseView & { readonly referenceDate: string | null };
  readonly sections: readonly ScrollSectionView[];
  readonly timing: { readonly luck: MujinLuck; readonly months: MujinMonths } | null;
}
