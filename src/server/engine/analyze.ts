import "server-only";
import {
  PublicBirthInputSchema,
  branchClockRanges,
  createFeatureSession,
  createInquiryReader,
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
import type { RuleDetailSink } from "@/domain/rules/common";
import { createFirstOverviewRules } from "@/domain/rules/first-overview";
import { FEATURE_SET } from "./features";

/** vendor의 tgz와 일치하는 값. tests/unit/engine.test.ts에서 확인한다. */
export const ENGINE_PACKAGE = {
  name: "sajuengine",
  version: "0.1.0",
  tarballSha256: "8596539c819c5fdb18ee2e0c5322dc5130ca1e6d22b1703f41d8ac10b5ce90fd",
} as const;

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

/**
 * 풀이 기록을 만들 때 한 번 원국을 계산하고 원국 작성 재료를 만든다.
 * 궁금한 점은 여기서 쓰지 않는다. 질문 분석과 기간 재료는 결제 후 생성 단계에서 더한다.
 */
export function analyzeBirth(input: {
  readonly birth: PublicBirthInput;
  readonly product: ProductDefinition;
  readonly nickname: string;
  readonly situationId: string | null;
}) {
  const { birth, product, nickname, situationId } = input;
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
    const sink: RuleDetailSink = new Map();
    const reader = createInquiryReader([result], { rules: createFirstOverviewRules(sink) });
    const { plan, trace } = buildReadingPlan({
      reader,
      sink,
      product,
      persona,
      chart,
      assessment,
      nickname,
      gender: birth.gender === "male" ? "male" : "female",
      situationId,
    });
    return {
      birth,
      chart,
      plan,
      trace,
      preview: buildReadingPreview(plan, chart, persona),
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
