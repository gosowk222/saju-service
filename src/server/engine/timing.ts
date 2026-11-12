import "server-only";
import { createFeatureSession, createInquiryReader, toAnalysisInput, type FeatureResult, type PublicBirthInput } from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";
import { addMonths, monthLabel, monthsBetween, type QuestionPeriod } from "@/domain/reading/question";
import type { TimingAnalysis, TimingPeriodStatement, TimingVerdict } from "@/domain/reading/types";
import { detailKey, type RuleDetailSink } from "@/domain/rules/common";
import { TIMING_CAVEAT, createTimingRule, type TimingDomain } from "@/domain/rules/timing";
import { FEATURE_SET, FEATURE_IDS } from "./features";

export const TIMING_ANALYSIS_VERSION = "timing-analysis-1.0.0";

const SEOUL = "Asia/Seoul";
const seoulDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: SEOUL, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const seoulMonth = (iso: string) => seoulDay(iso).slice(0, 7);

interface PeriodRange {
  readonly periodId: string;
  readonly kind: string;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly precision: string;
  readonly tenGod: string | null;
}

function rangesOf(results: readonly FeatureResult[]): Map<string, PeriodRange> {
  const map = new Map<string, PeriodRange>();
  for (const result of results) {
    for (const period of result.facets.periods) {
      if (!period.range?.startsAt || !period.range.endsAt || map.has(period.periodId)) continue;
      map.set(period.periodId, {
        periodId: period.periodId,
        kind: period.kind,
        label: period.label,
        startsAt: period.range.startsAt,
        endsAt: period.range.endsAt,
        precision: period.range.precision,
        tenGod: period.stemTenGod ?? null,
      });
    }
  }
  return map;
}

/** 절기 기준 월의 이름이 1월이면 앞 사주 연도에 속한다(입춘 전). 필요한 연도만 계산하기 위한 값이다. */
function sajuYearsFor(startMonth: string, endMonth: string): number[] {
  const years = new Set<number>();
  for (let month = addMonths(startMonth, -1); month <= endMonth; month = addMonths(month, 1)) {
    const [year, value] = month.split("-").map(Number) as [number, number];
    years.add(value === 1 ? year - 1 : year);
  }
  return [...years].sort((a, b) => a - b).slice(0, 4);
}

function verdictOf(markers: readonly { readonly tone: string }[]): TimingVerdict {
  const positive = markers.some((marker) => marker.tone === "positive");
  const caution = markers.some((marker) => marker.tone === "caution");
  if (positive && !caution) return "notable";
  if (positive && caution) return "mixed";
  if (caution) return "careful";
  return "quiet";
}

export interface TimingRequest {
  readonly domain: TimingDomain;
  readonly period: QuestionPeriod;
}

/** 기간 계산에 쓰는 기능 ID (FEATURE_SET 안의 정의). */
export interface TimingFeatureIds {
  /** 세운과 그해 12개월 (targetKind year-months). */
  readonly yearMonths: string;
  /** 대운 (targetKind decade). */
  readonly decade: string;
}

/** 첫 상품(묘묘)의 기간 기능. features를 주지 않으면 이 값을 쓴다. */
const DEFAULT_TIMING_FEATURES: TimingFeatureIds = { yearMonths: FEATURE_IDS.yearMonths, decade: FEATURE_IDS.decade };

/**
 * 시기 질문에 필요한 기간 재료만 계산한다. 원국 해석은 저장된 계획을 다시 쓰고, 여기서는
 * 요청 기간이 속한 세운·월운과 대운만 한 세션에서 계산한다. 일운은 계산하지 않는다.
 * features는 선택 인자다. 무진은 시각 미상에서도 세운·월운 결과가 unavailable이 되지 않는 무진 기능을 넘긴다.
 * 주지 않으면 첫 상품의 기능을 써서 지금과 같은 결과를 낸다.
 */
export function analyzeTiming(input: {
  readonly birth: PublicBirthInput;
  readonly referenceDate: string;
  readonly requests: readonly TimingRequest[];
  readonly features?: TimingFeatureIds;
}): TimingAnalysis[] {
  const { birth, referenceDate, requests } = input;
  const features = input.features ?? DEFAULT_TIMING_FEATURES;
  if (!requests.length) return [];
  const analysisInput = toAnalysisInput(birth);
  const timezoneId = birth.birthPlace.timezoneId;
  const session = createFeatureSession(createDefaultDependencies());
  const sink: RuleDetailSink = new Map();
  try {
    const years = new Set<number>();
    const decadeAt = new Set<string>();
    for (const request of requests) {
      for (const year of sajuYearsFor(request.period.startMonth, request.period.endMonth)) years.add(year);
      decadeAt.add(`${request.period.startMonth}-15T12:00:00+09:00`);
      decadeAt.add(`${request.period.endMonth}-15T12:00:00+09:00`);
    }
    const results: FeatureResult[] = [];
    const limitations = new Set<string>();
    for (const year of [...years].sort()) {
      try {
        results.push(session.execute(FEATURE_SET, { ...analysisInput, featureId: features.yearMonths, target: { kind: "year-months", year, timezoneId } }));
      } catch {
        limitations.add(`${year}년 세운·월운을 계산하지 못했다.`);
      }
    }
    for (const at of decadeAt) {
      try {
        results.push(session.execute(FEATURE_SET, { ...analysisInput, featureId: features.decade, target: { at, timezoneId } }));
      } catch {
        limitations.add("대운을 계산하지 못했다.");
      }
    }
    if (!results.length) {
      return requests.map((request) => emptyAnalysis(request, referenceDate, [...limitations]));
    }

    const ranges = rangesOf(results);
    const reader = createInquiryReader(results, { rules: [createTimingRule(sink)] });
    const known = new Set(reader.periods.map((period) => period.id));
    const all = [...ranges.values()].filter((range) => known.has(range.periodId));
    const monthly = all.filter((range) => range.kind === "monthly").sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const now = Date.parse(`${referenceDate}T12:00:00+09:00`);

    return requests.map((request) => {
      let targets: PeriodRange[];
      if (request.period.kind === "default") {
        const months = request.period;
        const length = monthsBetween(months.startMonth, months.endMonth);
        const startIndex = monthly.findIndex((range) => Date.parse(range.startsAt) <= now && now < Date.parse(range.endsAt));
        targets = startIndex >= 0 ? monthly.slice(startIndex, startIndex + length) : [];
      } else {
        targets = monthly.filter((range) => {
          const month = seoulMonth(range.startsAt);
          return month >= request.period.startMonth && month <= request.period.endMonth;
        });
      }
      if (!targets.length) return emptyAnalysis(request, referenceDate, [...limitations, "요청한 기간의 월운을 찾지 못했다."]);

      const windowStart = Date.parse(targets[0]!.startsAt);
      const windowEnd = Date.parse(targets[targets.length - 1]!.endsAt);
      const overlaps = (range: PeriodRange) => Date.parse(range.startsAt) < windowEnd && windowStart < Date.parse(range.endsAt);
      const annual = all.filter((range) => range.kind === "annual" && overlaps(range)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const decades = all.filter((range) => range.kind === "decade" && overlaps(range));
      const context = { gender: birth.gender };

      const monthAnswer = reader.answer({
        domain: request.domain,
        kind: "timing",
        periodIds: targets.map((range) => range.periodId),
        contextPeriodIds: [...annual, ...decades].map((range) => range.periodId),
        context,
      });
      const yearAnswer = annual.length
        ? reader.answer({ domain: request.domain, kind: "timing", periodIds: annual.map((range) => range.periodId), contextPeriodIds: decades.map((range) => range.periodId), context })
        : null;

      const toStatement = (conclusion: (typeof monthAnswer.conclusions)[number]): Omit<TimingPeriodStatement, "ref"> | null => {
        if (conclusion.rule.ruleId !== "first-overview.timing" || !conclusion.periodId) return null;
        const detail = sink.get(detailKey(conclusion.rule.ruleId, conclusion.periodId, conclusion.statement))?.timing;
        const range = ranges.get(conclusion.periodId);
        if (!detail || !range) return null;
        return {
          kind: "timing",
          periodId: conclusion.periodId,
          periodKind: range.kind,
          label: range.kind === "annual" ? `${seoulMonth(range.startsAt).slice(0, 4)}년` : monthLabel(seoulMonth(range.startsAt)),
          engineLabel: range.label,
          startsOn: seoulDay(range.startsAt),
          endsOn: seoulDay(new Date(Date.parse(range.endsAt) - 1).toISOString()),
          verdict: verdictOf(detail.markers),
          statement: conclusion.statement,
          markers: detail.markers.map(({ tone, text, activity }) => ({ tone, text, activity })),
          stageNote: detail.stageNote,
          selectionScore: detail.selectionScore,
          conclusionId: conclusion.id,
          ruleId: conclusion.rule.ruleId,
          ruleVersion: conclusion.rule.version,
          supportingEvidenceIds: conclusion.supportingEvidence.map((entry) => entry.id),
          counterEvidenceIds: conclusion.counterEvidence.map((entry) => entry.id),
          contextualEvidenceIds: conclusion.contextualEvidence.map((entry) => entry.id),
          caveats: conclusion.caveats,
        };
      };

      const months = monthAnswer.conclusions.map(toStatement).filter((item): item is NonNullable<typeof item> => item !== null);
      const yearsOut = (yearAnswer?.conclusions ?? []).map(toStatement).filter((item): item is NonNullable<typeof item> => item !== null);
      const order = (a: { startsOn: string | null }, b: { startsOn: string | null }) => (a.startsOn ?? "").localeCompare(b.startsOn ?? "");
      const notable = months
        .filter((month) => (month.verdict === "notable" || month.verdict === "mixed") && month.selectionScore >= 1)
        .sort((a, b) => b.selectionScore - a.selectionScore || order(a, b))
        .slice(0, 3)
        .map((month) => month.periodId);
      const careful = months
        .filter((month) => month.verdict === "careful" || (month.verdict === "mixed" && month.selectionScore < 0))
        .sort((a, b) => a.selectionScore - b.selectionScore || order(a, b))
        .slice(0, 2)
        .map((month) => month.periodId);
      const decade = decades[0];
      const firstMonth = seoulMonth(targets[0]!.startsAt);
      const lastMonth = seoulMonth(targets[targets.length - 1]!.startsAt);

      return {
        version: TIMING_ANALYSIS_VERSION,
        domain: request.domain,
        window: {
          kind: request.period.kind,
          startMonth: firstMonth,
          endMonth: lastMonth,
          label: `${monthLabel(firstMonth)}부터 ${monthLabel(lastMonth)}까지 (절기 기준 월)`,
        },
        status: months.length ? "available" : "insufficient",
        months: months.sort(order),
        years: yearsOut,
        decade: decade ? { label: decade.label, tenGod: decade.tenGod, approximate: decade.precision !== "confirmed" } : null,
        notable,
        careful,
        limitations: [
          ...limitations,
          TIMING_CAVEAT,
          ...(monthAnswer.limitations.includes("CONTEXT_BOUNDARIES_APPROXIMATE") ? ["대운의 경계는 근사값이라 참고 맥락으로만 썼다."] : []),
          ...(monthAnswer.limitations.includes("MISSING_PILLARS") ? ["태어난 시간을 몰라 시주와 관련된 표지는 보지 못했다."] : []),
          ...(months.length ? [] : ["살펴본 기간 안에서 이 주제와 직접 연결되는 표지를 찾지 못했다."]),
        ],
        referenceDate,
      } satisfies TimingAnalysis;
    });
  } finally {
    session.dispose();
  }
}

function emptyAnalysis(request: TimingRequest, referenceDate: string, limitations: string[]): TimingAnalysis {
  return {
    version: TIMING_ANALYSIS_VERSION,
    domain: request.domain,
    window: {
      kind: request.period.kind,
      startMonth: request.period.startMonth,
      endMonth: request.period.endMonth,
      label: `${monthLabel(request.period.startMonth)}부터 ${monthLabel(request.period.endMonth)}까지 (절기 기준 월)`,
    },
    status: "insufficient",
    months: [],
    years: [],
    decade: null,
    notable: [],
    careful: [],
    limitations,
    referenceDate,
  };
}
