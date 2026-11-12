/**
 * 무진 9장(인생의 큰 흐름과 전환점)·10장(앞으로 12개월)과 마지막 정리의 작성 계획. 규칙 설명: docs/rules/mujin-overview.md 11절
 *
 * 유료 생성을 시작할 때 한 번 계산해 저장한 기간 재료(MujinTimingBundle)를 장별 작성 재료로 옮긴다.
 * - 계산하지 않는다. 대운·월운 값과 판단 근거는 엔진과 기간 판단 규칙의 결과를 그대로 쓴다.
 * - 대운 천간의 십성 계열은 중립 활동 주제로만 읽는다. 개인별 길흉 통합 공식이 아니다.
 * - 월운은 분야(직업·재물·연애·인간관계)마다 그 달의 직접 근거만 쓰고, 분야 간 점수를 합치거나 비교하지 않는다.
 * - 보조 기간(세운·대운)의 근거는 evidence.contextual에만 두고 직접 근거로 쓰지 않는다. 월 중간의 세운·대운 경계를
 *   나누는 보조 해석은 하지 않는다. monthSequence·일반 rating·12운성은 작성 재료에 넣지 않는다.
 * - 마지막 정리는 앞 장의 핵심 답과 질문만 재료로 쓰고 새 사주 판단을 더하지 않는다.
 */
import type { ScrollProductDefinition, ScrollSectionSpec } from "../products/types";
import type { TimingAnalysis } from "../reading/types";
import { FAMILY_LABEL, FAMILY_MEANING, withJosa, type Family } from "../rules/materials";
import { TIMING_CAVEAT } from "../rules/timing";
import { RELATIONSHIP_OPTIONS, WORK_OPTIONS, type MujinNow } from "./now";
import {
  LINK_CAVEATS,
  LUCK_THEME_LINKS,
  LUCK_THEME_TAGS,
  MONTH_DOMAINS,
  MONTH_DOMAIN_LABEL,
  adoptedJudgments,
  chapterOfQuestionId,
  chaptersForQuestion,
  inProductScope,
  luckThemeVariant,
  monthActivityVariant,
  refCounter,
  uniqueList,
  type MujinQuestionInput,
} from "./personalize";
import type {
  MaterialEvidence,
  MonthDomain,
  MonthTone,
  MujinLuck,
  MujinLuckPeriod,
  MujinMaterial,
  MujinMonth,
  MujinPlan,
  MujinQuestionPlan,
  MujinSectionPlan,
  MujinTimingBundle,
  QuestionStatus,
} from "./types";

/** 9·10장과 마지막 정리 계획의 형식 버전. 재료 구성이나 선택 순서를 바꾸면 올린다. */
export const MUJIN_TIMING_PLAN_VERSION = "mujin-timing-plan-1.0.0";

/** 대운 활동 주제 대응(9-2·9-3)과 원국 연결(9-4)의 서비스 기준. 사람 검토를 받지 않았다. MujinPlan.rulesets에 기록한다. */
export const LUCK_THEME_RULE = { id: "mujin-overview.luck-theme", version: "1.0.0", reviewStatus: "unreviewed" } as const;

export interface LuckTheme {
  /** 중립 활동 주제. */
  readonly label: string;
  /** 이 계열에서 따로 막는 해석 (활동 주제를 사건·결과로 바꾸지 않는다). */
  readonly caveat: string;
}

/** 대운 천간 십성 계열 → 중립 활동 주제 (02_DECISION_RULES.md 12절 9-2). */
export const LUCK_THEMES: Readonly<Record<Family, LuckTheme>> = {
  peer: { label: "주도성·동료·경쟁", caveat: "비겁 대운을 경쟁에서 이기거나 사람과 다투는 10년으로 바꾸지 않는다." },
  output: { label: "표현·제작·공개", caveat: "식상 대운을 내놓은 결과물이 성공하는 10년으로 바꾸지 않는다." },
  wealth: { label: "수입 활동·거래·비용과 자원 관리", caveat: "재성 대운을 돈 버는 10년으로 바꾸지 않는다." },
  authority: { label: "역할·책임·평가", caveat: "관성 대운을 합격·승진이 정해진 구간으로 바꾸지 않는다." },
  resource: { label: "학습·문서·준비·도움", caveat: "인성 대운을 시험 합격이나 도움을 받는 일이 정해진 10년으로 바꾸지 않는다." },
};

type PeriodStatement = TimingAnalysis["months"][number];
type NewMaterial = Omit<MujinMaterial, "ref">;
type Refs = ReturnType<typeof refCounter>;
type Target = MujinSectionPlan["targetChars"];

// ─── 작성 조건 문장 ──────────────────────────────────────────────────────

const THEME_CAVEATS: readonly string[] = [
  "대운 천간의 십성 계열로 고른 활동 주제이며 개인별 길흉을 합친 판정 공식이 아니다.",
  "재성 대운을 돈 버는 10년, 관성 대운을 합격 구간처럼 사건이나 결과로 바꾸지 않는다.",
];
const BOUNDARY_CAVEAT = "대운 경계는 엔진 계산상 근사값이다. 몇 년 몇 월부터라고 단정하거나 오차 범위를 만들지 않는다.";
const LABEL_AGE_CAVEAT = "대운 이름의 나이와 계산된 시작 시점은 몇 달 어긋날 수 있다.";
const LUCK_FACT_CAVEAT = "대운 구간은 계산 사실이며 길흉 판정이 아니다.";
const COMPARE_CAVEATS: readonly string[] = [
  "같은 항목끼리 비교한 변화와 유지이며, 과거에 실제로 있었던 일이나 앞으로 이룰 성취를 말하지 않는다.",
  "어느 구간이 더 좋은지 순위나 전성기를 정하지 않는다.",
];

const LUCK_LIMIT: Readonly<Record<NonNullable<MujinLuck["reason"]>, string>> = {
  "hour-unknown": "태어난 시간을 몰라 대운을 계산하지 않았다. 대운 구간·간지·나이를 만들지 않고, 태어난 시간을 알면 볼 수 있는 부분이라고만 짧게 말한다.",
  "outside-sequence": "기준일이 계산된 대운 범위 밖이라(첫 대운 전이거나 마지막 대운 뒤) 현재 대운 구간을 고르지 않았다. 구간을 임의로 고르지 않는다.",
  "engine-unavailable": "대운을 계산하지 못했다. 구간을 임의로 고르지 않고 자료가 없다고만 말한다.",
};

const LUCK_NOTE = {
  current: "경계는 근사값이라 '몇 년 무렵'으로만 말하고 정확한 날짜·월이나 오차 범위를 만들지 않는다.",
  theme: "활동 주제를 중립적으로 설명한다. 좋다·나쁘다는 길흉 판정이나 돈·합격 같은 결과로 바꾸지 않는다.",
  noTheme: "대운 천간의 십성 자료가 없어 활동 주제를 정하지 않는다.",
  compare: "같은 항목(천간 십성과 계열, 활동 주제)끼리만 비교해 바뀌는 것과 이어지는 것을 말한다. 과거 사건, 앞으로의 성취, 어느 구간이 더 좋은지 순위를 만들지 않는다.",
  noPrevious: " 직전 구간은 계산된 대운 목록에 없어 말하지 않는다.",
  noNext: " 다음 구간은 계산된 대운 목록에 없어 말하지 않는다.",
  noCompare: "비교할 직전·다음 구간의 천간 십성 자료가 없어 비교하지 않는다.",
  link: "활동 주제와 닿는 원국의 채택 강점·약점을 지금 상황의 준비로 잇는다. 이 구간에 그 일이 반드시 생긴다고 말하지 않는다.",
  noLink: "이 활동 주제와 이어지는 원국의 채택 판단이 없어 활동 주제 설명까지만 한다. 지금 상황이 있으면 사주 판단이 아닌 일반 점검으로 구분해 짧게 다룬다.",
  noLuck: "대운 자료가 없어 구간의 활동 주제와 잇지 않는다. 지금 상황에 맞는 일반 점검만 짧게 하고 사주 판단처럼 말하지 않는다.",
} as const;

const MONTH_CAVEAT = "절기 기준 월이라 달력의 1일과 경계가 다르다.";
const MIXED_CAVEAT = "같은 달에 긍정과 주의 표지가 함께 있으면 둘을 함께 말한다.";
const NEUTRAL_CAVEAT = "중립은 뚜렷한 긍정·주의 표지가 없다는 뜻이며 좋다·나쁘다는 판정이 아니다.";
const NO_DATA_CAVEAT = "자료 부족은 그 분야의 기간 판단을 계산하지 못했다는 뜻이며 나쁜 달이라는 뜻이 아니다.";
const CAREFUL_CAVEAT = "주의 우세 구간은 조건을 더 점검할 달이며 실패·사고·손실이 생기는 날이라는 뜻이 아니다.";
const ACTIVITY_CAVEAT = "지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다.";
const firstMonthCaveat = (month: MujinMonth, referenceDate: string) =>
  `${withJosa(month.label, "은/는")} 기준일(${referenceDate})보다 먼저 시작한 달이다. 이미 지난 날짜를 앞으로 올 일처럼 말하지 않는다.`;

const MONTH_NOTE = {
  overview:
    "분석 기간(절기 기준 월)과 달마다 분야별 표지 구성(긍정·주의 함께, 긍정만, 주의만, 중립, 자료 부족)을 구분해 짧은 개요로 말한다. 같은 달의 긍정과 주의는 함께 말한다. 첫 달이 기준일 전에 시작했으면 지난 날짜를 앞으로 올 일처럼 말하지 않는다. 건강·가족 월운은 만들지 않는다.",
  noData: " 자료 부족인 분야는 계산하지 못했다고만 말하고 좋다·나쁘다로 바꾸지 않는다.",
  notable:
    "주목 구간은 같은 분야 안에서만 고른 달이다(긍정 표지가 주의 표지보다 많은 달). 관심 분야부터 말하고, 전체 상세 설명은 최대 3개월을 목표로 하되 숫자를 채우지 않는다. 같은 달의 주의 표지도 함께 말하고, 분야끼리 점수를 합치거나 비교하지 않는다. 여러 분야가 고른 달은 한 번만 말하고 분야별 이유를 함께 적는다.",
  noNotable: "주목 구간 후보가 없다(긍정 표지가 주의 표지보다 많은 달이 없음). 억지로 고르지 않고 없다고 짧게 말한다.",
  careful:
    "주의 우세 구간은 조건을 더 점검할 달이다. 실패·사고·손실이 생기는 날로 말하지 않는다. 전체 상세 설명은 최대 2개월을 목표로 하되 억지로 채우지 않는다. 같은 달의 긍정 표지도 함께 말한다.",
  noCareful: "주의 우세 구간이 없다. 억지로 만들지 않고 없다고 짧게 말한다.",
  activity:
    "진짜 궁금한 점의 활동이 기간 분야와 같을 때만 원국 판단과 잇는다. 질문이 없으면 관심 분야를 먼저 두고 주목·주의 구간의 활동 방향만 짧게 정리한다. 지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다.",
  noActivity: "주목·주의 구간이 없어 따로 고를 활동 구간이 없다. 질문이 있으면 그 분야가 중립이거나 자료 부족이라고 그대로 말하고 날짜를 만들지 않는다.",
  unavailable: "월운 자료가 부족해 12개월 흐름을 설명하지 않는다. 달·날짜·분야 판단을 만들지 않고 자료가 없다고만 짧게 말한다.",
  unavailableActivity: "기간 자료가 없어 질문과 잇는 활동 구간을 말하지 않는다.",
} as const;

const TONE_LABEL: Readonly<Record<MonthTone, string>> = {
  mixed: "긍정·주의 함께",
  positive: "긍정 표지만",
  caution: "주의 표지만",
  neutral: "중립(뚜렷한 긍정·주의 표지 없음)",
  "no-data": "자료 부족",
};
const MARKER_TONE_LABEL: Readonly<Record<string, string>> = { positive: "긍정", caution: "주의", neutral: "중립" };

/** 기간 규칙(rules/timing.ts describe)의 결론 상태와 같은 대응. 저장된 기간 분석에는 상태 대신 verdict가 남는다. */
const STATUS_OF_VERDICT: Readonly<Record<PeriodStatement["verdict"], NonNullable<MujinMaterial["status"]>>> = {
  notable: "candidate",
  mixed: "deferred",
  careful: "observation",
  quiet: "observation",
};

/** 9-4가 '지금의 나' 사실을 지금 상황으로 잇는 장. 일·학업 상태의 맥락을 쓰는 장이다. */
const NOW_SITUATION_CHAPTERS: ReadonlySet<string> = new Set(["ch2", "ch3", "ch4", "ch6", "ch8"]);

/** 관심 주제(장)가 가리키는 월운 분야. 10-2·10-3·10-4에서 관심 분야를 먼저 둔다(순서만 바꾼다). */
const INTEREST_MONTH_DOMAIN: Readonly<Partial<Record<string, MonthDomain>>> = { ch3: "career", ch4: "wealth", ch5: "romance", ch6: "social" };

// ─── 도우미 ─────────────────────────────────────────────────────────────

function specOf(product: ScrollProductDefinition, sectionId: string): ScrollSectionSpec {
  const spec = product.scroll.sections.find((section) => section.id === sectionId);
  if (!spec) throw new Error(`${product.id}: section ${sectionId} is not defined`);
  return spec;
}

function collector(refs: Refs) {
  const materials: MujinMaterial[] = [];
  return {
    materials,
    add(material: NewMaterial): string {
      const ref = refs.take();
      materials.push({ ref, ...material });
      return ref;
    },
  };
}

function planFor(spec: ScrollSectionSpec) {
  return (id: string, status: QuestionStatus, refs: readonly string[], note: string | null): MujinQuestionPlan => ({
    id,
    title: spec.questions.find((question) => question.id === id)?.title ?? id,
    status,
    refs,
    note,
  });
}

/** 자료가 없어 대부분 '없다'고 말하는 장의 편집 목표. 분량을 채우려 반복하지 않게 상품 목표의 3분의 1로 줄인다. */
const reducedTarget = (target: Target): Target => ({ min: Math.round(target.min / 3), max: Math.round(target.max / 3) });

/** 받침에 맞는 조사만 돌려준다. */
const josa = (word: string, pair: "이/가" | "과/와" | "은/는" | "을/를") => withJosa(word, pair).slice(word.length);

/** '으로/로'. 받침이 없거나 ㄹ 받침이면 '로'. */
function josaRo(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  const final = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : 0;
  return final === 0 || final === 8 ? "로" : "으로";
}

/** 상품 시간대 기준의 연도. 대운 경계(근사)는 연도 무렵으로만 말한다. */
function yearOf(iso: string, timeZone: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(new Date(time));
}

/** YYYY-MM-DD → "11월 7일". */
function dayText(date: string | null): string | null {
  const match = date ? /^\d{4}-(\d{2})-(\d{2})$/.exec(date) : null;
  return match ? `${Number(match[1])}월 ${Number(match[2])}일` : null;
}

function rangeText(month: Pick<MujinMonth, "startsOn" | "endsOn">): string {
  const start = dayText(month.startsOn);
  const end = dayText(month.endsOn);
  return start && end ? `(${start}~${end})` : "";
}

/** 엔진 대운 이름. 라벨에 간지가 없으면 붙인다 (엔진 라벨 예: "23세부터 대운 갑자"). */
function luckName(period: MujinLuckPeriod): string {
  return period.ganzhi && !period.label.includes(period.ganzhi) ? `${period.label} ${period.ganzhi} 대운` : period.label;
}

function luckSpan(period: MujinLuckPeriod, timeZone: string): string {
  const start = yearOf(period.startsAt, timeZone);
  const end = yearOf(period.endsAt, timeZone);
  if (!start || !end) return "시작·끝 시점이 엔진 결과에 없는 구간";
  return period.approximate ? `${start}년 무렵부터 ${end}년 무렵까지` : `${start}년부터 ${end}년까지`;
}

function tenGodText(period: MujinLuckPeriod): string {
  if (!period.stemTenGod) return "대운 천간의 십성은 엔진 결과에 없다.";
  return `대운 천간의 십성은 ${period.stemTenGod}${period.stemFamily ? `(${FAMILY_LABEL[period.stemFamily]} 계열)` : ""}이다.`;
}

const boundaryCaveats = (period: MujinLuckPeriod) => (period.approximate ? [BOUNDARY_CAVEAT, LABEL_AGE_CAVEAT] : []);

/**
 * 여러 결론의 근거를 한 재료에 모은다. 보조 기간 근거(contextual)는 직접·반대 근거에 넣지 않는다.
 * 여러 분야를 한 달 재료로 묶을 때 한 분야의 직접 근거가 다른 분야의 반대 근거이기도 하면 supporting에만 두고,
 * 반대 역할은 basis·counterNote 문장에 남긴다 (분야별 원래 근거는 bundle.analyses에 그대로 있다).
 */
function evidenceOf(statements: readonly PeriodStatement[]): MaterialEvidence {
  const contextual = uniqueList(statements.flatMap((statement) => statement.contextualEvidenceIds));
  const contextSet = new Set(contextual);
  const supporting = uniqueList(statements.flatMap((statement) => statement.supportingEvidenceIds)).filter((id) => !contextSet.has(id));
  const supportSet = new Set(supporting);
  const counter = uniqueList(statements.flatMap((statement) => statement.counterEvidenceIds)).filter((id) => !contextSet.has(id) && !supportSet.has(id));
  return { supporting, counter, contextual };
}

/** 결론에서 옮길 규칙·근거 정보. 결론이 하나면 결론 ID와 상태도 옮긴다. */
function statementMeta(statements: readonly PeriodStatement[]): Partial<Pick<MujinMaterial, "status" | "ruleId" | "ruleVersion" | "conclusionId" | "evidence">> {
  const first = statements[0];
  if (!first) return {};
  const sameRule = statements.every((statement) => statement.ruleId === first.ruleId && statement.ruleVersion === first.ruleVersion);
  return {
    ...(sameRule ? { ruleId: first.ruleId, ruleVersion: first.ruleVersion } : {}),
    ...(statements.length === 1 ? { conclusionId: first.conclusionId, status: STATUS_OF_VERDICT[first.verdict] } : {}),
    evidence: evidenceOf(statements),
  };
}

/** 12운성 재료를 작성 재료에 넣지 않으므로 그 사용을 알리는 규칙 한계 문장은 옮기지 않는다. */
const statementCaveats = (statements: readonly PeriodStatement[]) =>
  statements.flatMap((statement) => statement.caveats).filter((caveat) => !caveat.startsWith("12운성"));

function workNotes(now: MujinNow): string[] {
  const notes = now.work.flatMap((id) => {
    const option = WORK_OPTIONS.find((entry) => entry.id === id);
    return option ? [`고른 일·학업 상태 '${option.label}': ${withJosa(option.context, "과/와")} 이어 볼 수 있다. ${option.avoid}.`] : [];
  });
  if (now.work.length > 1) notes.push("일·학업 상태를 두 개 골랐다. 선택 순서를 주업 순서로 보지 않고 이 장의 질문에 더 맞는 쪽을 쓴다.");
  return notes;
}

function relationshipNote(now: MujinNow): string {
  if (now.relationship === null) return "관계 상태는 답하지 않았다. 연애 분야의 활동은 연애 여부를 전제하지 않고 조건부로 말한다.";
  if (now.relationship === "private") return "관계 상태는 답하고 싶지 않다고 했다. 연애 분야의 활동은 관계 상태를 추정하지 않고 조건부로 말한다.";
  const option = RELATIONSHIP_OPTIONS.find((entry) => entry.id === now.relationship);
  return option
    ? `고른 관계 상태 '${option.label}': 연애 분야의 활동을 이 상태에 맞춰 말한다. ${option.avoid}.`
    : "관계 상태를 추정하지 않고 연애 분야의 활동을 조건부로 말한다.";
}

/** 관심 분야를 앞에 두는 월운 분야 순서. 점수가 아니라 편집 순서다. */
function orderedDomains(now: MujinNow): MonthDomain[] {
  const first = now.interests.map((id) => INTEREST_MONTH_DOMAIN[id]).filter((domain): domain is MonthDomain => Boolean(domain));
  return uniqueList([...first, ...MONTH_DOMAINS]);
}

// ─── 9장 ────────────────────────────────────────────────────────────────

function compareText(from: { readonly name: string; readonly period: MujinLuckPeriod }, to: { readonly name: string; readonly period: MujinLuckPeriod }): string {
  const a = from.period.stemFamily;
  const b = to.period.stemFamily;
  if (!a || !b) return `${from.name}${josa(from.name, "과/와")} ${to.name} 중 천간 십성 자료가 없는 구간이 있어 활동 주제를 비교하지 않는다.`;
  if (a === b) {
    const label = LUCK_THEMES[a].label;
    const keep = `${from.name}${josa(from.name, "과/와")} ${to.name}${josa(to.name, "은/는")} 같은 ${FAMILY_LABEL[a]} 계열이라 활동 주제 '${label}'${josa(label, "이/가")} 이어진다`;
    const changed = from.period.stemTenGod && to.period.stemTenGod && from.period.stemTenGod !== to.period.stemTenGod;
    return changed
      ? `${keep}. 천간 십성만 ${from.period.stemTenGod}에서 ${to.period.stemTenGod}${josaRo(to.period.stemTenGod!)} 바뀐다.`
      : `${keep}.`;
  }
  const labelA = LUCK_THEMES[a].label;
  const labelB = LUCK_THEMES[b].label;
  return `${from.name}의 활동 주제는 '${labelA}'(${FAMILY_LABEL[a]} 계열)이고, ${to.name}${josa(to.name, "은/는")} '${labelB}'(${FAMILY_LABEL[b]} 계열)${josaRo(labelB)} 바뀐다.`;
}

function luckSection(input: { readonly plan: MujinPlan; readonly bundle: MujinTimingBundle; readonly product: ScrollProductDefinition; readonly refs: Refs }): MujinSectionPlan {
  const { plan, bundle, product } = input;
  const spec = specOf(product, "ch9");
  const timeZone = product.timing.timezoneId;
  const { luck, referenceDate } = bundle;
  const { materials, add } = collector(input.refs);
  const question = planFor(spec);
  const section = (questions: MujinQuestionPlan[], targetChars: Target): MujinSectionPlan => ({
    sectionId: spec.id,
    tier: spec.tier,
    title: spec.title,
    questions,
    materials,
    weight: "standard",
    targetChars,
    situationNotes: workNotes(plan.now),
  });

  const current = luck.status === "available" ? luck.current : null;
  if (!current) {
    // 기준 시각이 든 대운이 없으면 구간을 임의로 고르지 않는다. 범위 밖이면 엔진이 준 첫(마지막) 대운만 사실로 남긴다.
    const reason = luck.status === "unavailable" && luck.reason ? luck.reason : "engine-unavailable";
    const limit = LUCK_LIMIT[reason];
    const facts: string[] = [];
    if (reason === "outside-sequence" && luck.next) {
      facts.push(
        add({
          kind: "engine-fact",
          questionIds: ["9-1"],
          text: `기준일(${referenceDate})은 계산된 첫 대운이 시작되기 전이다. 첫 대운은 '${luckName(luck.next)}'이고 ${luckSpan(luck.next, timeZone)}이다.`,
          scope: "period",
          periodId: luck.next.periodId,
          caveats: [...boundaryCaveats(luck.next), LUCK_FACT_CAVEAT],
        }),
      );
    }
    if (reason === "outside-sequence" && luck.previous) {
      facts.push(
        add({
          kind: "engine-fact",
          questionIds: ["9-1"],
          text: `기준일(${referenceDate})은 계산된 마지막 대운이 끝난 뒤다. 마지막으로 계산된 대운은 '${luckName(luck.previous)}'이다.`,
          scope: "period",
          periodId: luck.previous.periodId,
          caveats: [...boundaryCaveats(luck.previous), LUCK_FACT_CAVEAT],
        }),
      );
    }
    return section(
      [
        question("9-1", "unavailable", facts, limit),
        question("9-2", "unavailable", [], `${limit} 활동 주제를 고르지 않는다.`),
        question("9-3", "unavailable", [], `${limit} 직전·다음 구간을 비교하지 않는다.`),
        question("9-4", "general", [], LUCK_NOTE.noLuck),
      ],
      reducedTarget(spec.targetChars),
    );
  }

  // 9-1 현재 대운 구간: 엔진의 실제 시작·끝과 기준 시각으로 고른 구간 (경계는 근사값).
  const currentRef = add({
    kind: "engine-fact",
    questionIds: ["9-1"],
    text: `현재 대운은 '${luckName(current)}'이다. 엔진이 계산한 구간은 ${luckSpan(current, timeZone)}이고, 기준일(${referenceDate})이 이 구간 안에 든다. ${tenGodText(current)}`,
    scope: "period",
    periodId: current.periodId,
    caveats: [...boundaryCaveats(current), LUCK_FACT_CAVEAT],
  });

  // 9-2 구간의 활동 주제: 대운 천간 십성 계열 → 중립 활동 주제 (엔진 계산값 + 서비스 해설).
  const family = current.stemFamily;
  const theme = family ? LUCK_THEMES[family] : null;
  const themeRef =
    family && theme
      ? add({
          kind: "period",
          // 9-4는 활동 주제를 지금 상황의 준비로 잇는다. 원국 연결이 없으면 활동 설명까지만 이 재료로 한다.
          questionIds: ["9-2", "9-4"],
          text: current.stemTenGod
            ? `현재 대운 천간의 십성 ${withJosa(current.stemTenGod, "은/는")} ${FAMILY_LABEL[family]} 계열이라, 이 구간의 활동 주제를 '${theme.label}'${josaRo(theme.label)} 읽는다.`
            : `현재 대운 천간은 ${FAMILY_LABEL[family]} 계열이라, 이 구간의 활동 주제를 '${theme.label}'${josaRo(theme.label)} 읽는다.`,
          scope: "period",
          status: "observation",
          ruleId: LUCK_THEME_RULE.id,
          ruleVersion: LUCK_THEME_RULE.version,
          variant: luckThemeVariant(family),
          aspect: "대운 활동 주제",
          basis: [
            ...(current.stemTenGod ? [`대운 천간 십성: ${current.stemTenGod}`] : []),
            `십성 계열: ${FAMILY_LABEL[family]}(${FAMILY_MEANING[family]})`,
          ],
          caveats: [...THEME_CAVEATS, theme.caveat, ...(current.approximate ? [BOUNDARY_CAVEAT] : [])],
          // 근거는 9-1의 대운 계산 사실이다.
          parentRefs: [currentRef],
          periodId: current.periodId,
        })
      : null;

  // 9-3 앞뒤 구간의 차이: 같은 항목(천간 십성·계열·활동 주제)끼리만 비교한다.
  const neighbors = [
    luck.previous ? { name: "직전 구간", period: luck.previous, role: "직전" } : null,
    luck.next ? { name: "다음 구간", period: luck.next, role: "다음" } : null,
  ].filter((entry): entry is { name: string; period: MujinLuckPeriod; role: string } => entry !== null);
  const comparable = Boolean(themeRef) && neighbors.some((entry) => entry.period.stemFamily);
  let compareRefs: string[] = [];
  if (themeRef && comparable) {
    const neighborRefs = neighbors.map((entry) =>
      add({
        kind: "engine-fact",
        questionIds: ["9-3"],
        text: `${entry.role} 대운은 '${luckName(entry.period)}'이다. 엔진이 계산한 구간은 ${luckSpan(entry.period, timeZone)}이다. ${tenGodText(entry.period)}`,
        scope: "period",
        periodId: entry.period.periodId,
        caveats: [...boundaryCaveats(entry.period), LUCK_FACT_CAVEAT],
      }),
    );
    const here = { name: "현재 구간", period: current };
    const lines = [
      ...(luck.previous ? [compareText({ name: "직전 구간", period: luck.previous }, here)] : []),
      ...(luck.next ? [compareText(here, { name: "다음 구간", period: luck.next })] : []),
    ];
    const compareRef = add({
      kind: "derived",
      questionIds: ["9-3"],
      text: lines.join(" "),
      scope: "period",
      ruleId: LUCK_THEME_RULE.id,
      ruleVersion: LUCK_THEME_RULE.version,
      aspect: "앞뒤 대운의 변화와 유지",
      parentRefs: [themeRef, ...neighborRefs],
      caveats: [...COMPARE_CAVEATS, ...(current.approximate ? [BOUNDARY_CAVEAT] : [])],
    });
    compareRefs = [compareRef, ...neighborRefs];
  }
  const compareNote = comparable
    ? `${LUCK_NOTE.compare}${luck.previous ? "" : LUCK_NOTE.noPrevious}${luck.next ? "" : LUCK_NOTE.noNext}`
    : LUCK_NOTE.noCompare;

  // 9-4 현재 상황의 준비: 활동 주제와 닿는 원국 채택 판단(강점·약점)과 '지금의 나' 사실을 잇는다.
  let prepareQuestion: MujinQuestionPlan;
  if (themeRef && family && theme) {
    const linkQuestions = LUCK_THEME_LINKS[family];
    const links = adoptedJudgments(plan.sections, linkQuestions, 3, LUCK_THEME_TAGS[family]).map((parent) =>
      add({
        kind: "derived",
        questionIds: ["9-4"],
        text: `현재 대운의 활동 주제 '${theme.label}'${josa(theme.label, "과/와")} 닿는 원국 판단을 지금 상황의 준비로 잇는다: ${parent.text}`,
        scope: "period",
        ruleId: LUCK_THEME_RULE.id,
        ruleVersion: LUCK_THEME_RULE.version,
        ...(parent.aspect ? { aspect: parent.aspect } : {}),
        ...(parent.upside ? { upside: parent.upside } : {}),
        ...(parent.weakness ? { weakness: parent.weakness } : {}),
        parentRefs: [themeRef, parent.ref],
        caveats: [...LINK_CAVEATS],
      }),
    );
    // '지금의 나' 사실은 계획 공용 재료(plan.nowFacts)를 그대로 가리킨다. 계획·가정·타인에 대한 관찰은 지금 상황으로 쓰지 않고,
    // 관계·가족 선택(답하고 싶지 않음 포함)은 다룰 주제이지 대운 준비의 상황이 아니므로 일·학업 맥락의 장에 닿는 것만 잇는다.
    const nowRefs = plan.nowFacts
      .filter((fact) => fact.kind === "user-fact" && (fact.factKind === undefined || fact.factKind === "current" || fact.factKind === "past"))
      .filter(
        (fact) =>
          fact.questionIds.includes("9-4") ||
          fact.questionIds.some((id) => linkQuestions.includes(id) && NOW_SITUATION_CHAPTERS.has(chapterOfQuestionId(id) ?? "")),
      )
      .map((fact) => fact.ref);
    prepareQuestion = question("9-4", links.length ? "adopted" : "general", [...links, themeRef, ...nowRefs], links.length ? LUCK_NOTE.link : LUCK_NOTE.noLink);
  } else {
    prepareQuestion = question("9-4", "general", [], LUCK_NOTE.noLuck);
  }

  return section(
    [
      question("9-1", current.approximate ? "conditional" : "adopted", [currentRef], current.approximate ? LUCK_NOTE.current : null),
      question("9-2", themeRef ? "adopted" : "unavailable", themeRef ? [themeRef] : [], themeRef ? LUCK_NOTE.theme : LUCK_NOTE.noTheme),
      question("9-3", comparable ? "adopted" : "unavailable", compareRefs, compareNote),
      prepareQuestion,
    ],
    spec.targetChars,
  );
}

// ─── 10장 ───────────────────────────────────────────────────────────────

interface MonthPick {
  readonly domain: MonthDomain;
  readonly selection: "notable" | "careful";
  readonly statement: PeriodStatement;
}

function counterNoteOf(picks: readonly MonthPick[]): string | null {
  const notes = picks.flatMap((pick) => {
    const label = MONTH_DOMAIN_LABEL[pick.domain];
    const opposite = pick.statement.markers.filter((marker) => marker.tone === (pick.selection === "notable" ? "caution" : "positive"));
    if (!opposite.length) return [];
    const texts = opposite.map((marker) => marker.text).join(", ");
    return pick.selection === "notable"
      ? [`${withJosa(label, "은/는")} 주목 구간이지만 같은 달에 주의 표지(${texts})도 있다.`]
      : [`${withJosa(label, "은/는")} 주의 우세 구간이지만 같은 달에 긍정 표지(${texts})도 있다.`];
  });
  return notes.length ? notes.join(" ") : null;
}

function monthsSection(input: { readonly plan: MujinPlan; readonly bundle: MujinTimingBundle; readonly product: ScrollProductDefinition; readonly refs: Refs }): MujinSectionPlan {
  const { plan, bundle, product } = input;
  const spec = specOf(product, "ch10");
  const { months, referenceDate } = bundle;
  const { materials, add } = collector(input.refs);
  const question = planFor(spec);
  const section = (questions: MujinQuestionPlan[], targetChars: Target): MujinSectionPlan => ({
    sectionId: spec.id,
    tier: spec.tier,
    title: spec.title,
    questions,
    materials,
    weight: "standard",
    targetChars,
    situationNotes: [...workNotes(plan.now), relationshipNote(plan.now)],
  });

  if (months.status !== "available" || !months.months.length) {
    return section(
      [
        question("10-1", "unavailable", [], MONTH_NOTE.unavailable),
        question("10-2", "unavailable", [], MONTH_NOTE.unavailable),
        question("10-3", "unavailable", [], MONTH_NOTE.unavailable),
        question("10-4", "unavailable", [], MONTH_NOTE.unavailableActivity),
      ],
      reducedTarget(spec.targetChars),
    );
  }

  const byId = new Map(months.months.map((month) => [month.periodId, month] as const));
  const statementOf = (domain: MonthDomain, periodId: string): PeriodStatement | null =>
    bundle.analyses.find((analysis) => analysis.domain === domain)?.months.find((statement) => statement.periodId === periodId) ?? null;
  // 네 분야만 본다(건강·가족 월운은 만들지 않는다). 칸이 없으면 자료 부족이다.
  const cellsOf = (month: MujinMonth) =>
    MONTH_DOMAINS.map((domain) => ({ domain, tone: month.cells.find((cell) => cell.domain === domain)?.tone ?? ("no-data" as const) }));

  // 10-1 실제 분석 기간과 월별 개요.
  const windowRef = add({
    kind: "engine-fact",
    questionIds: ["10-1"],
    text: `분석 기간은 ${months.window.label}이다. 기준일(${referenceDate})이 속한 절기 월부터 ${months.months.length}개월이다.`,
    scope: "period",
    caveats: uniqueList([MONTH_CAVEAT, ...months.limitations]),
  });
  const anyNoData = months.months.some((month) => cellsOf(month).some((cell) => cell.tone === "no-data"));
  const overviewRefs = months.months.map((month) => {
    const cells = cellsOf(month);
    const statements = cells
      .filter((cell) => cell.tone !== "no-data")
      .map((cell) => statementOf(cell.domain, month.periodId))
      .filter((statement): statement is PeriodStatement => statement !== null);
    return add({
      kind: "period",
      questionIds: ["10-1"],
      text: `${month.label}${rangeText(month)}: ${cells.map((cell) => `${MONTH_DOMAIN_LABEL[cell.domain]} ${TONE_LABEL[cell.tone]}`).join(", ")}.`,
      scope: "period",
      aspect: "월별 개요",
      periodId: month.periodId,
      ...statementMeta(statements),
      caveats: uniqueList([
        ...(month.startedBeforeReference ? [firstMonthCaveat(month, referenceDate)] : []),
        ...(cells.some((cell) => cell.tone === "mixed") ? [MIXED_CAVEAT] : []),
        ...(cells.some((cell) => cell.tone === "neutral") ? [NEUTRAL_CAVEAT] : []),
        ...(cells.some((cell) => cell.tone === "no-data") ? [NO_DATA_CAVEAT] : []),
      ]),
    });
  });

  // 10-2·10-3: 분야 안에서 고른 주목·주의 구간. 관심 분야를 먼저 두고(순서만), 같은 달은 한 재료에 분야별 이유를 함께 적는다.
  const domains = orderedDomains(plan.now);
  const picks = new Map<string, MonthPick[]>();
  const notableOrder: string[] = [];
  const carefulOrder: string[] = [];
  const collect = (selection: MonthPick["selection"], lists: MujinTimingBundle["months"]["notable"], order: string[]) => {
    for (const domain of domains) {
      for (const periodId of lists.filter((entry) => entry.domain === domain).flatMap((entry) => entry.periodIds)) {
        const statement = statementOf(domain, periodId);
        // 계산한 12개월 밖이거나 원래 결론이 없는 달은 고르지 않는다 (새 월운이나 근거를 만들지 않는다).
        if (!statement || !byId.has(periodId)) continue;
        const list = picks.get(periodId) ?? [];
        if (list.some((pick) => pick.domain === domain && pick.selection === selection)) continue;
        picks.set(periodId, [...list, { domain, selection, statement }]);
        if (!order.includes(periodId)) order.push(periodId);
      }
    }
  };
  collect("notable", months.notable, notableOrder);
  collect("careful", months.careful, carefulOrder);

  const detailRefs = new Map<string, string>();
  for (const periodId of uniqueList([...notableOrder, ...carefulOrder])) {
    const month = byId.get(periodId)!;
    const monthPicks = picks.get(periodId)!;
    const statements = monthPicks.map((pick) => pick.statement);
    const hasNotable = monthPicks.some((pick) => pick.selection === "notable");
    const hasCareful = monthPicks.some((pick) => pick.selection === "careful");
    const counterNote = counterNoteOf(monthPicks);
    detailRefs.set(
      periodId,
      add({
        kind: "period",
        questionIds: [...(hasNotable ? ["10-2"] : []), ...(hasCareful ? ["10-3"] : [])],
        text: `${month.label}${rangeText(month)}: ${monthPicks
          .map((pick) => `${MONTH_DOMAIN_LABEL[pick.domain]} ${pick.selection === "notable" ? "주목" : "주의"} 구간 — ${pick.statement.statement}`)
          .join(" / ")}`,
        scope: "period",
        aspect: hasNotable && hasCareful ? "주목·주의 구간" : hasNotable ? "주목 구간" : "주의 구간",
        periodId,
        basis: monthPicks.flatMap((pick) =>
          pick.statement.markers.map((marker) => `${MONTH_DOMAIN_LABEL[pick.domain]} ${MARKER_TONE_LABEL[marker.tone] ?? "중립"} 표지: ${marker.text}`),
        ),
        action: monthPicks
          .map((pick) => `${MONTH_DOMAIN_LABEL[pick.domain]}: ${uniqueList(pick.statement.markers.map((marker) => marker.activity)).join("; ")}`)
          .join(" / "),
        ...(counterNote ? { counterNote } : {}),
        ...statementMeta(statements),
        caveats: uniqueList([
          TIMING_CAVEAT,
          MONTH_CAVEAT,
          ...(hasCareful ? [CAREFUL_CAVEAT] : []),
          ...(month.startedBeforeReference ? [firstMonthCaveat(month, referenceDate)] : []),
          ...statementCaveats(statements),
        ]),
      }),
    );
  }

  // 10-4: 분야별로 이을 수 있는 기간 활동 재료. 질문과 원국 판단은 personalizeSections가 활동 분야가 같을 때만 붙인다.
  // parentRefs는 고른 순서(분야 안 우선순위)를 지키고, 문장 속 달 목록만 시간 순으로 적는다.
  const position = new Map(months.months.map((month, index) => [month.periodId, index] as const));
  const labels = (ids: readonly string[]) =>
    [...ids]
      .sort((a, b) => position.get(a)! - position.get(b)!)
      .map((id) => byId.get(id)!.label)
      .join(", ");
  const activityRefs = domains.flatMap((domain) => {
    const has = (id: string, selection: MonthPick["selection"]) => picks.get(id)!.some((pick) => pick.domain === domain && pick.selection === selection);
    const notable = notableOrder.filter((id) => has(id, "notable"));
    const careful = carefulOrder.filter((id) => has(id, "careful"));
    if (!notable.length && !careful.length) return [];
    return [
      add({
        kind: "derived",
        questionIds: ["10-4"],
        text: `${MONTH_DOMAIN_LABEL[domain]} 분야의 기간 활동 방향: 주목 구간 ${labels(notable) || "없음"}, 주의 구간 ${labels(careful) || "없음"}. 달마다 해 볼 일과 점검할 일은 이어진 달 재료를 따른다.`,
        scope: "period",
        variant: monthActivityVariant(domain),
        aspect: `${MONTH_DOMAIN_LABEL[domain]} 활동 방향`,
        parentRefs: uniqueList([...notable, ...careful]).map((id) => detailRefs.get(id)!),
        caveats: [ACTIVITY_CAVEAT, TIMING_CAVEAT],
      }),
    ];
  });

  const notableRefs = notableOrder.map((id) => detailRefs.get(id)!);
  const carefulRefs = carefulOrder.map((id) => detailRefs.get(id)!);
  return section(
    [
      question("10-1", anyNoData ? "conditional" : "adopted", [windowRef, ...overviewRefs], anyNoData ? `${MONTH_NOTE.overview}${MONTH_NOTE.noData}` : MONTH_NOTE.overview),
      question("10-2", notableRefs.length ? "adopted" : "general", notableRefs, notableRefs.length ? MONTH_NOTE.notable : MONTH_NOTE.noNotable),
      question("10-3", carefulRefs.length ? "adopted" : "general", carefulRefs, carefulRefs.length ? MONTH_NOTE.careful : MONTH_NOTE.noCareful),
      question("10-4", activityRefs.length ? "adopted" : "general", activityRefs, activityRefs.length ? MONTH_NOTE.activity : MONTH_NOTE.noActivity),
    ],
    spec.targetChars,
  );
}

/**
 * 9장(9-1~9-4)과 10장(10-1~10-4)의 작성 계획을 만든다. 둘 다 weight standard이며 비중은 personalizeSections가 정한다.
 * - 9장: bundle.luck의 직전·현재·다음 대운. 자료가 없으면(시각 미상·범위 밖) 구간을 고르지 않고 9-1~9-3은 unavailable,
 *   9-4는 활동 설명 없이 한계만 남긴다.
 * - 10장: bundle.months의 12개월 개요와 분야별 주목·주의 구간, 분야별 기간 활동 재료. 후보가 없으면 비워 둔다.
 */
export function buildTimingSections(input: {
  readonly plan: MujinPlan;
  readonly bundle: MujinTimingBundle;
  readonly product: ScrollProductDefinition;
  readonly startRef: number;
}): { readonly sections: readonly MujinSectionPlan[]; readonly nextRef: number } {
  const refs = refCounter(input.startRef);
  const luck = luckSection({ ...input, refs });
  const months = monthsSection({ ...input, refs });
  return { sections: [luck, months], nextRef: refs.next };
}

// ─── 마지막 정리 ─────────────────────────────────────────────────────────

/** 질문이 없을 때 마지막 정리의 소질문. */
export const CLOSING_CORE_QUESTION = { id: "closing-core", title: "핵심 선택 기준과 확인할 조건" } as const;

const CLOSING_CAVEAT = "앞 장에서 쓴 핵심 답이다. 마지막 정리에서 새 사주 판단·날짜·수치를 더하지 않는다.";
const CLOSING_NOTE = {
  question: "관련 장의 핵심 답을 모아 이 질문의 선택 기준과 확인할 조건으로 정리한다. 새 사주 판단·날짜·수치를 더하지 않는다.",
  noAnswer: "이 질문과 이어지는 장의 핵심 답이 없어, 새 판단 없이 확인할 조건만 짧게 정리한다.",
  core: "진짜 궁금한 점이 없어 앞 장의 핵심 답에서 선택 기준 몇 가지만 간결하게 정리한다. 새 사주 판단을 더하지 않는다.",
  limited: "결과(합격·결혼·재회·수익 등)나 다른 사람의 마음을 확정하지 않고 판단할 수 있는 조건만 말한다.",
  health: "진단·병명·치료 없이 생활 리듬과 일정 조절로만 말한다.",
  compare: "선택지의 정답을 고르지 않고 각 선택에 필요한 조건을 비교한다.",
  timing: "시기는 9·10장에서 말한 구간만 다시 쓰고 새 날짜를 만들지 않는다.",
} as const;
const PERIOD_SECTIONS: ReadonlySet<string> = new Set(["ch9", "ch10"]);

/** 질문이 없을 때는 핵심만 간결하게: 상품 목표의 하한 쪽. */
const lowerTarget = (target: Target): Target => ({ min: target.min, max: target.min + Math.round((target.max - target.min) / 4) });

function closingNote(question: MujinQuestionInput, hasAnswers: boolean): string {
  return [
    hasAnswers ? CLOSING_NOTE.question : CLOSING_NOTE.noAnswer,
    ...(question.domain === "health" ? [CLOSING_NOTE.health] : question.answerability === "limited" || question.intent === "outcome" ? [CLOSING_NOTE.limited] : []),
    ...(question.intent === "compare" ? [CLOSING_NOTE.compare] : []),
    ...(question.intent === "timing" ? [CLOSING_NOTE.timing] : []),
    ...(question.missingInfo.length ? [`사주로 알 수 없어 확인할 정보: ${question.missingInfo.join(", ")}.`] : []),
  ].join(" ");
}

/**
 * 마지막 정리. 질문마다 소질문을 하나 두고(id는 질문 ref), 이어지는 장(chaptersForQuestion)의 핵심 답을 derived 재료
 * (parentRefs는 그 장 ID)로 모은다. 분야가 없는 넓은 질문은 모든 장의 핵심 답을 쓴다. 새 사주 판단을 더하지 않는다.
 * 질문이 없으면 핵심 선택 기준 하나를 간결하게 정리한다(편집 목표는 하한 쪽).
 */
export function buildClosingSection(input: {
  readonly product: ScrollProductDefinition;
  readonly questions: readonly MujinQuestionInput[];
  readonly chapterAnswers: readonly { readonly sectionId: string; readonly title: string; readonly coreAnswer: string }[];
  readonly startRef: number;
}): { readonly section: MujinSectionPlan; readonly nextRef: number } {
  const { product } = input;
  const refs = refCounter(input.startRef);
  const spec = product.scroll.sections.find((section) => section.kind === "closing");
  if (!spec) throw new Error(`${product.id}: closing section is not defined`);

  // 장마다 처음 받은 핵심 답 하나를 목차 순서로 쓴다. 빈 답(생성 실패 등)은 쓰지 않는다.
  const rank = new Map(product.scroll.sections.map((section, index) => [section.id, index] as const));
  const answers: (typeof input.chapterAnswers)[number][] = [];
  for (const answer of input.chapterAnswers) {
    if (answer.sectionId === spec.id || !answer.coreAnswer.trim() || answers.some((entry) => entry.sectionId === answer.sectionId)) continue;
    answers.push(answer);
  }
  answers.sort((a, b) => (rank.get(a.sectionId) ?? rank.size) - (rank.get(b.sectionId) ?? rank.size));

  const questions = input.questions.filter((question) => inProductScope(product, question.domain));
  const seen = new Set<string>();
  for (const question of questions) {
    if (!question.ref || seen.has(question.ref)) throw new Error(`buildClosingSection: question ref "${question.ref}" is empty or duplicated`);
    seen.add(question.ref);
  }

  const entries = questions.length
    ? questions.map((question) => {
        const chapters = chaptersForQuestion(question);
        const used = chapters.length ? answers.filter((answer) => chapters.includes(answer.sectionId)) : answers;
        return { id: question.ref, sectionIds: used.map((answer) => answer.sectionId), question };
      })
    : [{ id: CLOSING_CORE_QUESTION.id, sectionIds: answers.map((answer) => answer.sectionId), question: null }];

  const materials: MujinMaterial[] = [];
  const answerRef = new Map<string, string>();
  for (const answer of answers) {
    const users = entries.filter((entry) => entry.sectionIds.includes(answer.sectionId)).map((entry) => entry.id);
    if (!users.length) continue;
    const ref = refs.take();
    if (seen.has(ref)) throw new Error(`buildClosingSection: question ref "${ref}" collides with a material ref`);
    answerRef.set(answer.sectionId, ref);
    materials.push({
      ref,
      kind: "derived",
      questionIds: users,
      text: answer.coreAnswer.trim(),
      scope: PERIOD_SECTIONS.has(answer.sectionId) ? "period" : "natal",
      aspect: answer.title,
      parentRefs: [answer.sectionId],
      caveats: [CLOSING_CAVEAT],
    });
  }

  const questionPlans: MujinQuestionPlan[] = entries.map((entry) => {
    const answerRefs = entry.sectionIds.map((id) => answerRef.get(id)!);
    if (!entry.question) {
      return { id: entry.id, title: CLOSING_CORE_QUESTION.title, status: answerRefs.length ? "adopted" : "general", refs: answerRefs, note: CLOSING_NOTE.core };
    }
    const status: QuestionStatus = !answerRefs.length ? "general" : entry.question.answerability === "limited" ? "conditional" : "adopted";
    return { id: entry.id, title: entry.question.summary, status, refs: [entry.question.ref, ...answerRefs], note: closingNote(entry.question, answerRefs.length > 0) };
  });

  return {
    section: {
      sectionId: spec.id,
      tier: spec.tier,
      title: spec.title,
      questions: questionPlans,
      materials,
      weight: questions.length ? "question" : "standard",
      targetChars: questions.length ? spec.targetChars : lowerTarget(spec.targetChars),
      situationNotes: [],
    },
    nextRef: refs.next,
  };
}
