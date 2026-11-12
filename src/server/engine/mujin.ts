import "server-only";
import {
  TWELVE_STAGE_LABELS,
  createFeatureSession,
  createInquiryReader,
  toAnalysisInput,
  type AssessmentFacet,
  type FeatureFacets,
  type FeatureResult,
  type FeatureSession,
  type PublicBirthInput,
  type TwelveStageFacet,
} from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";
import type { MujinNow } from "@/domain/mujin/now";
import { buildMujinPlan } from "@/domain/mujin/plan";
import type {
  MonthDomain,
  MonthTone,
  MujinLuck,
  MujinLuckPeriod,
  MujinMonth,
  MujinMonths,
  MujinTables,
  MujinTimingBundle,
  NatalStageCell,
  TenGodCell,
} from "@/domain/mujin/types";
import { findPersona } from "@/domain/personas";
import type { ScrollProductDefinition } from "@/domain/products/types";
import { buildChartView, elementCounts, type ChartFacts } from "@/domain/reading/chart";
import { addMonths, monthLabel, type QuestionPeriod } from "@/domain/reading/question";
import type { ChartElement, ChartView, TimingAnalysis } from "@/domain/reading/types";
import type { RuleDetailSink } from "@/domain/rules/common";
import { createFirstOverviewRules } from "@/domain/rules/first-overview";
import { FAMILIES, type Family } from "@/domain/rules/materials";
import { TIMING_CAVEAT, TIMING_DOMAINS } from "@/domain/rules/timing";
import { ENGINE_PACKAGE } from "./analyze";
import { FEATURE_SET, MUJIN_FEATURE_IDS } from "./features";
import { analyzeTiming } from "./timing";

/**
 * 무진의 종합 사주와 엔진의 연결. 무료 표(원국표 옆의 오행·12운성·십성), 결제 전 원국 작성 계획,
 * 유료 생성을 시작할 때 한 번 계산하는 기간 재료(9장 대운, 10장 12개월)를 만든다.
 * 계산은 엔진 결과만 옮긴다. 대운·월운을 앱에서 다시 계산하지 않는다.
 */

/** 9·10장 기간 재료의 형식 버전. 기준 시각, 구간 고르기, 칸 판정 방식을 바꾸면 올린다. */
export const MUJIN_TIMING_VERSION = "mujin-timing-1.0.0";

/** 10장의 분석 개월 수. 장 이름('앞으로 12개월')과 같다. */
const MONTH_COUNT = 12;

/** 10장 네 분야. 재사용하는 기간 판단 규칙(first-overview.timing)이 다루는 분야와 같다. */
const MONTH_DOMAINS: readonly MonthDomain[] = TIMING_DOMAINS;
const DOMAIN_LABEL: Readonly<Record<MonthDomain, string>> = { career: "직업", wealth: "재물", romance: "연애", social: "인간관계" };

const ELEMENTS: readonly ChartElement[] = ["목", "화", "토", "금", "수"];
const STAGE_BASES = ["day-master", "self"] as const;
const REFERENCE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SEOUL = "Asia/Seoul";
const seoulDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: SEOUL, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const seoulMonth = (iso: string) => seoulDay(iso).slice(0, 7);

/** 기준일 정오(Asia/Seoul). 기존 기간 분석(server/engine/timing.ts)과 같은 관례다. */
const referenceInstantOf = (referenceDate: string) => `${referenceDate}T12:00:00+09:00`;

type NatalPosition = "year" | "month" | "day" | "hour";
type NatalStage = TwelveStageFacet & { readonly position: NatalPosition };
type PeriodFacet = FeatureFacets["periods"][number];
type RangedPeriod = PeriodFacet & {
  readonly range: { readonly startsAt: string; readonly endsAt: string; readonly timezoneId: string; readonly precision: string };
};
type AnalysisInput = ReturnType<typeof toAnalysisInput>;

const isNatalStage = (stage: TwelveStageFacet): stage is NatalStage => stage.scope === "natal" && stage.position !== "period";
const hasRange = (period: PeriodFacet): period is RangedPeriod => Boolean(period.range?.startsAt && period.range.endsAt);
const startOf = (period: RangedPeriod) => Date.parse(period.range.startsAt);
const endOf = (period: RangedPeriod) => Date.parse(period.range.endsAt);
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** 키가 모두 숫자일 때만 비율로 본다. 엔진이 계산하지 않았으면(월주·일주 미상 등) null. */
function percentsOf<K extends string>(value: Readonly<Partial<Record<K, number>>> | null | undefined, keys: readonly K[]): Readonly<Record<K, number>> | null {
  if (!value || !keys.every((key) => typeof value[key] === "number")) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<K, number>;
}

function familyOf(value: string | null | undefined): Family | null {
  return value && (FAMILIES as readonly string[]).includes(value) ? (value as Family) : null;
}

/**
 * 무료 표를 엔진 계산값으로 만든다. 칸 순서는 원국표(chart.pillars, 시주→연주)를 따른다.
 * - 12운성: facets.twelveStages 중 원국(scope natal) 항목만 쓴다. 월운·대운 같은 기간 항목은 섞지 않는다.
 *   basis(일간 기준·자좌)마다 한 줄이며, 시각 미상이면 엔진이 시주를 건너뛰어 시주 칸이 없다.
 * - 십성: 천간(일간 자리는 "일간"), 지지 본기, 지장간(본기 포함, 엔진 순서). 모르는 기둥은 칸을 만들지 않는다.
 * - 오행: 겉 글자의 단순 개수(elementCounts와 같은 기준)와 엔진 가중 비율(assessment.elementPercent)을 따로 둔다.
 *   다섯 계열 가중 비율은 assessment.familyPercent다. 계산되지 않았으면 null.
 */
export function buildMujinTables(result: FeatureResult, chart: ChartView): MujinTables {
  const order: readonly NatalPosition[] = chart.pillars.map((pillar) => pillar.key);
  const labelOf = (position: NatalPosition) => chart.pillars.find((pillar) => pillar.key === position)?.label ?? position;
  const rank = (position: NatalPosition) => order.indexOf(position);

  const stages: NatalStageCell[] = result.facets.twelveStages
    .filter(isNatalStage)
    .sort((a, b) => STAGE_BASES.indexOf(a.basis) - STAGE_BASES.indexOf(b.basis) || rank(a.position) - rank(b.position))
    .map((stage) => ({
      position: stage.position,
      label: labelOf(stage.position),
      basis: stage.basis,
      stem: stage.stem,
      branch: stage.branch,
      stage: TWELVE_STAGE_LABELS[stage.stage].label,
    }));

  const facts = result.core.document.facts;
  const cells: TenGodCell[] = [];
  for (const position of order) {
    const pillar = facts?.positions[position];
    if (!pillar) continue;
    cells.push({
      position,
      label: labelOf(position),
      stem: pillar.stem.tenGod,
      branch: pillar.branch.tenGod,
      hidden: pillar.branch.hiddenStems.flatMap((entry) => (entry.tenGod ? [entry.tenGod] : [])),
    });
  }

  const assessment = result.facets.assessment ?? result.profileBasis?.assessment ?? null;
  return {
    elements: { counts: elementCounts(chart), percents: percentsOf(assessment?.elementPercent, ELEMENTS) },
    stages,
    tenGods: { cells, families: percentsOf(assessment?.familyPercent, FAMILIES) },
  };
}

/**
 * 결제 전 원국 작성 계획을 만든다. analyzeBirth처럼 원국을 한 번 계산하고, 기존 첫 상품 규칙으로 판단을 읽은 뒤
 * 무진 작성 계획(buildMujinPlan)에 넘긴다. 기간 재료는 여기서 계산하지 않는다(computeMujinTiming).
 */
export function analyzeMujinBirth(input: {
  readonly birth: PublicBirthInput;
  readonly product: ScrollProductDefinition;
  readonly nickname: string;
  readonly now: MujinNow;
}) {
  const { birth, product, nickname, now } = input;
  const persona = findPersona(product.personaId);
  if (!persona) throw new Error(`Unknown persona: ${product.personaId}`);

  const analysisInput = toAnalysisInput(birth);
  const session = createFeatureSession(createDefaultDependencies());
  try {
    const result = session.execute(FEATURE_SET, { ...analysisInput, featureId: product.featureId });
    const facts = result.core.document.facts as unknown as ChartFacts;
    const assessment: AssessmentFacet | null = result.facets.assessment ?? null;
    const chart = buildChartView(
      facts,
      (assessment?.elementPercent as Readonly<Record<ChartElement, number>> | undefined) ?? null,
    );
    const tables = buildMujinTables(result, chart);
    const sink: RuleDetailSink = new Map();
    const reader = createInquiryReader([result], { rules: createFirstOverviewRules(sink) });
    const { plan, trace } = buildMujinPlan({
      reader,
      sink,
      product,
      persona,
      chart,
      assessment,
      tables,
      nickname,
      gender: birth.gender === "male" ? "male" : "female",
      now,
    });
    return {
      birth,
      chart,
      tables,
      plan,
      trace,
      persona,
      engineMeta: {
        package: ENGINE_PACKAGE,
        resultStatus: result.status,
        limitations: result.limitations,
        fingerprint: result.core.fingerprint.hash,
        cacheKey: result.cacheKey,
        provenance: result.provenance,
        calculationPolicy: analysisInput.calculationPolicy,
        inquiryPolicyVersion: trace[0]?.policyVersion ?? null,
      },
    };
  } finally {
    session.dispose();
  }
}

function toLuckPeriod(period: RangedPeriod): MujinLuckPeriod {
  return {
    periodId: period.periodId,
    label: period.label,
    startsAt: period.range.startsAt,
    endsAt: period.range.endsAt,
    approximate: period.range.precision === "approximate",
    ganzhi: `${period.pillar.heavenlyStem}${period.pillar.earthlyBranch}`,
    stemTenGod: period.stemTenGod ?? null,
    stemFamily: familyOf(period.stemTenGodFamily),
  };
}

function unavailableLuck(referenceAt: string, reason: NonNullable<MujinLuck["reason"]>): MujinLuck {
  return { status: "unavailable", reason, referenceAt, previous: null, current: null, next: null };
}

/**
 * 대운 목록에서 기준 시각이 든 대운과 그 직전·다음을 고른다. 구간은 엔진 계약대로 [startsAt, endsAt)로 판정하고
 * 시작 시각 순으로 정렬한다(reader.periods는 ID 문자열순이라 쓰지 않는다). 기준 시각이 계산된 대운 범위 밖이면
 * 현재 구간을 고르지 않고 outside-sequence로 남긴다. 그때 첫 대운 전이면 다음만, 마지막 대운 뒤면 직전만 있다.
 */
export function pickLuckWindow(periods: readonly PeriodFacet[], referenceAt: string): MujinLuck {
  const at = Date.parse(referenceAt);
  if (Number.isNaN(at)) throw new Error("pickLuckWindow: referenceAt is not a date-time");
  const byId = new Map<string, RangedPeriod>();
  for (const period of periods) if (period.kind === "decade" && hasRange(period) && !byId.has(period.periodId)) byId.set(period.periodId, period);
  const decades = [...byId.values()].sort((a, b) => startOf(a) - startOf(b));
  if (!decades.length) return unavailableLuck(referenceAt, "engine-unavailable");

  const index = decades.findIndex((period) => startOf(period) <= at && at < endOf(period));
  if (index < 0) {
    const previous = decades.filter((period) => endOf(period) <= at).at(-1) ?? null;
    const next = decades.find((period) => at < startOf(period)) ?? null;
    return {
      status: "unavailable",
      reason: "outside-sequence",
      referenceAt,
      previous: previous ? toLuckPeriod(previous) : null,
      current: null,
      next: next ? toLuckPeriod(next) : null,
    };
  }
  const previous = decades[index - 1];
  const next = decades[index + 1];
  return {
    status: "available",
    reason: null,
    referenceAt,
    previous: previous ? toLuckPeriod(previous) : null,
    current: toLuckPeriod(decades[index]!),
    next: next ? toLuckPeriod(next) : null,
  };
}

/** 9장: luck-sequence 기능으로 대운 전부를 받아 고른다. 시각 미상이면 엔진이 대운을 계산하지 않는다. */
function luckFor(session: FeatureSession, birth: PublicBirthInput, analysisInput: AnalysisInput, referenceAt: string): MujinLuck {
  let result: FeatureResult | null = null;
  try {
    result = session.execute(FEATURE_SET, {
      ...analysisInput,
      featureId: MUJIN_FEATURE_IDS.luck,
      // 대운 구간의 시간대는 엔진이 출생지 시간대로 정한다. 기존 기간 분석과 같이 출생지 시간대를 넘긴다.
      target: { at: referenceAt, timezoneId: birth.birthPlace.timezoneId },
    });
  } catch {
    result = null;
  }
  const hourUnknown = birth.birthTime.status === "unknown" || (result?.limitations.includes("BIRTH_TIME_REQUIRED") ?? false);
  const periods = result?.facets.periods ?? [];
  if (!periods.some((period) => period.kind === "decade" && hasRange(period))) {
    return unavailableLuck(referenceAt, hourUnknown ? "hour-unknown" : "engine-unavailable");
  }
  return pickLuckWindow(periods, referenceAt);
}

/** 기간 안의 절기 월이 속하는 사주 연도. 1월 이름의 월운은 앞 사주 연도(입춘 전)에 속한다. 기존 기간 분석과 같다. */
function sajuYearsOf(period: QuestionPeriod): number[] {
  const years = new Set<number>();
  for (let month = addMonths(period.startMonth, -1); month <= period.endMonth; month = addMonths(month, 1)) {
    const [year, value] = month.split("-").map(Number) as [number, number];
    years.add(value === 1 ? year - 1 : year);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * 10장 기간: 기준 시각이 속한 절기 월부터 연속 12개 월운을 엔진 결과(facets.periods의 range)에서 고른다.
 * 기존 기간 분석의 months에는 표지가 있는 달만 남으므로, 표지 없는 달까지 남기려고 따로 구한다.
 * 12개가 빈틈없이 이어지지 않으면 비워 둔다.
 */
function monthWindowFor(
  session: FeatureSession,
  birth: PublicBirthInput,
  analysisInput: AnalysisInput,
  period: QuestionPeriod,
  referenceAt: string,
): { readonly months: readonly RangedPeriod[]; readonly failures: readonly string[] } {
  const byId = new Map<string, RangedPeriod>();
  const failures: string[] = [];
  for (const year of sajuYearsOf(period)) {
    try {
      const result = session.execute(FEATURE_SET, {
        ...analysisInput,
        featureId: MUJIN_FEATURE_IDS.yearMonths,
        target: { kind: "year-months", year, timezoneId: birth.birthPlace.timezoneId },
      });
      for (const entry of result.facets.periods) {
        if (entry.kind === "monthly" && hasRange(entry) && !byId.has(entry.periodId)) byId.set(entry.periodId, entry);
      }
    } catch {
      failures.push(`${year}년 세운·월운을 계산하지 못했다.`);
    }
  }
  const monthly = [...byId.values()].sort((a, b) => startOf(a) - startOf(b));
  const at = Date.parse(referenceAt);
  const start = monthly.findIndex((entry) => startOf(entry) <= at && at < endOf(entry));
  const months = start >= 0 ? monthly.slice(start, start + MONTH_COUNT) : [];
  const continuous = months.every((entry, index) => index === 0 || startOf(entry) === endOf(months[index - 1]!));
  return { months: months.length === MONTH_COUNT && continuous ? months : [], failures };
}

/**
 * 같은 달·분야 칸의 표지 구성. 점수가 아니다.
 * 긍정과 주의가 함께면 mixed, 긍정만 positive, 주의만 caution, 중립 표지만 있거나 판단은 계산됐는데 표지가 없으면 neutral,
 * 그 분야를 계산한 자료가 없으면(computed false) no-data.
 */
export function monthTone(markers: readonly { readonly tone: string }[], computed: boolean): MonthTone {
  if (!computed) return "no-data";
  const positive = markers.some((marker) => marker.tone === "positive");
  const caution = markers.some((marker) => marker.tone === "caution");
  if (positive && caution) return "mixed";
  if (positive) return "positive";
  if (caution) return "caution";
  return "neutral";
}

function windowLabel(startMonth: string, endMonth: string): string {
  return `${monthLabel(startMonth)}부터 ${monthLabel(endMonth)}까지 (절기 기준 월)`;
}

function buildMonths(input: {
  readonly birth: PublicBirthInput;
  readonly referenceDate: string;
  readonly period: QuestionPeriod;
  readonly window: { readonly months: readonly RangedPeriod[]; readonly failures: readonly string[] };
  readonly analyses: readonly TimingAnalysis[];
  readonly timingFailed: boolean;
}): MujinMonths {
  const { birth, referenceDate, period, window, analyses, timingFailed } = input;
  const failureNotes = [
    ...window.failures,
    ...(timingFailed ? ["분야별 기간 판단을 계산하지 못했다."] : []),
  ];
  const first = window.months[0];
  const last = window.months.at(-1);
  if (!first || !last) {
    return {
      status: "insufficient",
      window: { startMonth: period.startMonth, endMonth: period.endMonth, label: windowLabel(period.startMonth, period.endMonth) },
      months: [],
      notable: [],
      careful: [],
      limitations: unique([...failureNotes, "기준일이 속한 절기 월부터 12개월을 계산하지 못했다."]),
    };
  }

  const startMonth = seoulMonth(first.range.startsAt);
  const endMonth = seoulMonth(last.range.startsAt);
  // 같은 12개월을 계산한 분야만 쓴다. 기존 기간 분석은 계산을 마친 결과에만 TIMING_CAVEAT를 붙인다.
  const computed = new Map<MonthDomain, TimingAnalysis>();
  for (const domain of MONTH_DOMAINS) {
    const analysis = analyses.find((entry) => entry.domain === domain);
    if (analysis && analysis.window.startMonth === startMonth && analysis.window.endMonth === endMonth && analysis.limitations.includes(TIMING_CAVEAT)) {
      computed.set(domain, analysis);
    }
  }

  const months: MujinMonth[] = window.months.map((entry, index) => {
    const startsOn = seoulDay(entry.range.startsAt);
    return {
      periodId: entry.periodId,
      label: monthLabel(seoulMonth(entry.range.startsAt)),
      startsOn,
      endsOn: seoulDay(new Date(endOf(entry) - 1).toISOString()),
      startedBeforeReference: index === 0 && referenceDate > startsOn,
      cells: MONTH_DOMAINS.map((domain) => {
        const analysis = computed.get(domain);
        const markers = analysis?.months.find((statement) => statement.periodId === entry.periodId)?.markers ?? [];
        return {
          domain,
          tone: monthTone(markers, Boolean(analysis)),
          markers: markers.map(({ tone, text, activity }) => ({ tone, text, activity })),
        };
      }),
    };
  });

  const inWindow = new Set(months.map((month) => month.periodId));
  const picked = [...computed].map(([domain, analysis]) => ({
    domain,
    notable: analysis.notable.filter((id) => inWindow.has(id)),
    careful: analysis.careful.filter((id) => inWindow.has(id)),
  }));
  // 분야와 관계없는 한계(대운 경계 근사, 시주 미상 등)는 계산한 모든 분야가 함께 가진 것만 모은다.
  const sets = [...computed.values()].map((analysis) => new Set(analysis.limitations));
  const shared = sets.length ? [...sets[0]!].filter((text) => sets.every((set) => set.has(text))) : [];
  const decadeLinked = [...computed.values()].some((analysis) => analysis.decade !== null);

  return {
    status: computed.size ? "available" : "insufficient",
    window: { startMonth, endMonth, label: windowLabel(startMonth, endMonth) },
    months,
    notable: picked.map(({ domain, notable }) => ({ domain, periodIds: notable })),
    careful: picked.map(({ domain, careful }) => ({ domain, periodIds: careful })),
    limitations: unique([
      ...failureNotes,
      ...MONTH_DOMAINS.filter((domain) => !computed.has(domain)).map((domain) => `${DOMAIN_LABEL[domain]} 분야의 기간 판단 자료가 없다.`),
      ...shared,
      "절기 기준 월이라 달력의 1일과 경계가 다르다.",
      ...(computed.size && !decadeLinked
        ? [
            birth.birthTime.status === "unknown"
              ? "태어난 시간을 몰라 대운을 계산하지 않았고, 월운에 대운 맥락을 붙이지 않았다."
              : "이 기간과 겹치는 대운을 찾지 못해 월운에 대운 맥락을 붙이지 않았다.",
          ]
        : []),
    ]),
  };
}

/**
 * 9·10장 기간 재료를 계산한다. 유료 생성을 시작할 때 한 번 부르고 결과를 저장해 재시도·재열람·후속 질문에서 다시 쓴다.
 * referenceDate는 첫 유료 분석 때 고정한 Asia/Seoul 날짜(YYYY-MM-DD)이며, 기준 시각은 그날 정오다.
 * - luck: 대운 목록에서 직전·현재·다음 대운. 시각 미상이면 hour-unknown, 기준 시각이 대운 범위 밖이면 outside-sequence.
 * - months: 기준 시각이 속한 절기 월부터 12개 월운과 네 분야(직업·재물·연애·인간관계) 칸. 판단은 기존 기간 분석
 *   (analyzeTiming, 규칙 first-overview.timing)을 한 세션에서 네 분야로 계산해 옮긴다.
 * - analyses: 분야별 원래 기간 분석(근거 ID·규칙 버전 보존).
 */
export function computeMujinTiming(input: {
  readonly birth: PublicBirthInput;
  readonly referenceDate: string;
  readonly gender: "male" | "female";
}): MujinTimingBundle {
  const { birth, referenceDate, gender } = input;
  const referenceAt = referenceInstantOf(referenceDate);
  // 형식과 실제 날짜(예: 2월 30일 거부)를 함께 확인한다. 기준 시각의 서울 날짜가 기준일과 같아야 한다.
  if (!REFERENCE_DATE.test(referenceDate) || Number.isNaN(Date.parse(referenceAt)) || seoulDay(referenceAt) !== referenceDate) {
    throw new Error("computeMujinTiming: referenceDate must be a valid YYYY-MM-DD date");
  }
  // 대운 방향과 연애 표지의 성별은 출생 입력의 성별로 계산한다. 두 값이 다르면 계산 기록이 어긋나므로 멈춘다.
  if (birth.gender !== gender) throw new Error("computeMujinTiming: gender does not match birth.gender");

  const startMonth = referenceDate.slice(0, 7);
  const period: QuestionPeriod = { kind: "default", startMonth, endMonth: addMonths(startMonth, MONTH_COUNT - 1) };
  const analysisInput = toAnalysisInput(birth);
  const session = createFeatureSession(createDefaultDependencies());
  let luck: MujinLuck;
  let window: ReturnType<typeof monthWindowFor>;
  try {
    luck = luckFor(session, birth, analysisInput, referenceAt);
    window = monthWindowFor(session, birth, analysisInput, period, referenceAt);
  } finally {
    session.dispose();
  }

  let analyses: TimingAnalysis[] = [];
  let timingFailed = false;
  try {
    analyses = analyzeTiming({
      birth,
      referenceDate,
      requests: MONTH_DOMAINS.map((domain) => ({ domain, period })),
      features: { yearMonths: MUJIN_FEATURE_IDS.yearMonths, decade: MUJIN_FEATURE_IDS.luck },
    });
  } catch {
    timingFailed = true;
  }

  return {
    version: MUJIN_TIMING_VERSION,
    referenceDate,
    luck,
    months: buildMonths({ birth, referenceDate, period, window, analyses, timingFailed }),
    analyses,
  };
}
