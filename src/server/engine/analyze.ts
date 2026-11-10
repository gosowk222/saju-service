import "server-only";
import {
  PublicBirthInputSchema,
  branchClockRanges,
  createFeatureSession,
  createInquiryReader,
  defineFeatureSet,
  toAnalysisInput,
  type AssessmentFacet,
  type PublicBirthInput,
} from "sajuengine";
import { createDefaultDependencies, manseryeokCalendarConversionAdapter } from "sajuengine/node";
import {
  formatIsoDate,
  parseIsoDate,
  resolveBirthDate,
  seoulToday,
  type CalendarConverter,
  type CalendarKind,
  type ResolvedBirthDate,
} from "@/domain/birth/date";
import type { BranchValue } from "@/domain/birth/input";
import { findPersona } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { buildChartView, type ChartFacts } from "@/domain/reading/chart";
import { buildReadingPlan, buildReadingPreview } from "@/domain/reading/plan";
import type { ChartElement } from "@/domain/reading/types";
import { FIRST_OVERVIEW_RULES } from "@/domain/rules/first-overview";

/** vendor의 tgz와 일치하는 값. tests/unit/engine.test.ts에서 확인한다. */
export const ENGINE_PACKAGE = {
  name: "sajuengine",
  version: "0.1.0",
  tarballSha256: "8596539c819c5fdb18ee2e0c5322dc5130ca1e6d22b1703f41d8ac10b5ce90fd",
} as const;

/**
 * 첫 상품에 필요한 재료만 계산한다. 원국 구조, 관계, 주제 후보, 신살·12운성까지이며
 * 기간 모듈(M05~M07)은 쓰지 않는다.
 */
const NATAL_TOPICS = ["temperament", "strengths", "career", "wealth", "romance", "social"] as const;

const FEATURE_SET = defineFeatureSet([
  {
    id: "first-overview-natal",
    version: "1.0.0",
    modules: ["M01", "M02", "M03", "M04"],
    topics: [...NATAL_TOPICS],
    targetKind: "none",
    selection: {
      version: "1.0.0",
      rules: [{ module: "M01" }, { module: "M02" }, { module: "M03" }, { module: "M04" }],
    },
  },
]);

export const calendarConverter: CalendarConverter = ({ calendar, isLeapMonth, year, month, day }) => {
  try {
    const converted = manseryeokCalendarConversionAdapter.convert(
      calendar === "solar"
        ? { calendarType: "solar", isLeapMonth: false, year, month, day }
        : { calendarType: "lunar", isLeapMonth, year, month, day },
    );
    return { solar: converted.solar };
  } catch {
    return null;
  }
};

export function resolveBirthDateNow(yymmdd: string, calendar: CalendarKind, isLeapMonth: boolean): ResolvedBirthDate {
  return resolveBirthDate({ yymmdd, calendar, isLeapMonth, today: seoulToday(), convert: calendarConverter });
}

/** 선택한 달력의 날짜를 받아 해당 지역 시계로 본 시진 범위를 돌려준다. */
export function branchRangesFor(input: {
  readonly birthDate: string;
  readonly calendar: CalendarKind;
  readonly isLeapMonth: boolean;
  readonly timezoneId: string;
  readonly longitudeDeg: number;
}): Readonly<Record<string, { readonly start: string; readonly end: string }>> {
  const parsed = parseIsoDate(input.birthDate);
  const converted = calendarConverter({ calendar: input.calendar, isLeapMonth: input.isLeapMonth, ...parsed });
  if (!converted) return {};
  const ranges = branchClockRanges({
    birthDate: formatIsoDate(converted.solar),
    timezoneId: input.timezoneId,
    longitudeDeg: input.longitudeDeg,
  });
  return Object.fromEntries(
    ranges.map((range) => [range.value, { start: range.clockStart.slice(11), end: range.clockEnd.slice(11) }]),
  );
}

export interface AnalyzeInput {
  readonly birthDate: string;
  readonly calendar: CalendarKind;
  readonly isLeapMonth: boolean;
  readonly gender: "male" | "female";
  readonly birthTime: { readonly status: "unknown" } | { readonly status: "branch"; readonly branch: BranchValue };
  readonly birthPlace: {
    readonly timezoneId: string;
    readonly longitudeDeg: number;
    readonly latitudeDeg: number;
    readonly label: string;
    readonly source: string;
  };
}

export function toPublicBirthInput(input: AnalyzeInput): PublicBirthInput {
  return PublicBirthInputSchema.parse({
    birthDate: input.birthDate,
    birthTime: input.birthTime,
    gender: input.gender,
    calendar: input.calendar === "solar" ? { type: "solar" } : { type: "lunar", isLeapMonth: input.isLeapMonth },
    birthPlace: input.birthPlace,
  });
}

export function analyzeBirth(input: {
  readonly birth: PublicBirthInput;
  readonly product: ProductDefinition;
  readonly nickname: string;
  readonly situationId: string | null;
  readonly concern: string;
}) {
  const { birth, product, nickname, situationId, concern } = input;
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
    const reader = createInquiryReader([result], { rules: [...FIRST_OVERVIEW_RULES] });
    const { plan, trace } = buildReadingPlan({ reader, product, persona, chart, assessment, nickname, situationId, concern });
    return {
      birth,
      chart,
      plan,
      trace,
      preview: buildReadingPreview(plan, chart),
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
