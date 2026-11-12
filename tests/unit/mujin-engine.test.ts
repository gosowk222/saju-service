import { TWELVE_STAGE_LABELS, createFeatureSession, defineFeatureSet, toAnalysisInput, type FeatureResult } from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";
import { SYNTHETIC_BIRTHS, checkFeatureDefinitions, runFeatureDefinitionChecks } from "sajuengine/testing";
import { describe, expect, it } from "vitest";
import type { MujinNow } from "@/domain/mujin/now";
import { MUJIN_PLAN_VERSION, type MonthTone, type MujinTimingBundle } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { buildChartView, elementCounts, type ChartFacts } from "@/domain/reading/chart";
import { seoulDate } from "@/domain/reading/question";
import type { ChartElement, TimingVerdict } from "@/domain/reading/types";
import { FAMILIES } from "@/domain/rules/materials";
import { TIMING_DOMAINS } from "@/domain/rules/timing";
import { ENGINE_PACKAGE, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { FEATURE_IDS, FEATURE_SET, MUJIN_FEATURE_IDS } from "@/server/engine/features";
import { MUJIN_TIMING_VERSION, analyzeMujinBirth, buildMujinTables, computeMujinTiming, monthTone, pickLuckWindow } from "@/server/engine/mujin";
import { analyzeTiming, type TimingRequest } from "@/server/engine/timing";

// 모두 가상 출생 입력이다. 실제 사람의 자료가 아니다.
const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const known: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };
const unknownHour: AnalyzeInput = { ...known, birthTime: { status: "unknown" } };
/** 입동 당일 출생에 시각을 모르면 월주가 정해지지 않아 엔진이 강약·비율을 계산하지 않는다. */
const noMonthPillar: AnalyzeInput = { ...known, birthDate: "1998-11-08", birthTime: { status: "unknown" } };
/** 첫 대운이 2023년에 시작하는 아이. */
const child: AnalyzeInput = { birthDate: "2021-06-10", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "오" }, birthPlace: place };

const REF = "2026-11-12";
const DAY = 86_400_000;

function execute(input: AnalyzeInput, featureId: string, target?: unknown, set = FEATURE_SET): FeatureResult {
  const birth = toPublicBirthInput(input);
  const session = createFeatureSession(createDefaultDependencies());
  try {
    return session.execute(set, { ...toAnalysisInput(birth), featureId, ...(target ? { target } : {}) });
  } finally {
    session.dispose();
  }
}

function natalTables(input: AnalyzeInput, result: FeatureResult = execute(input, MUJIN_FEATURE_IDS.natal)) {
  const chart = buildChartView(
    result.core.document.facts as unknown as ChartFacts,
    (result.facets.assessment?.elementPercent as Readonly<Record<ChartElement, number>> | undefined) ?? null,
  );
  return { result, chart, tables: buildMujinTables(result, chart) };
}

const luckTarget = (at: string) => ({ at, timezoneId: "Asia/Seoul" });
const sum = (values: Readonly<Record<string, number>>) => Object.values(values).reduce((total, value) => total + value, 0);
const decadesOf = (result: FeatureResult) =>
  result.facets.periods.filter((period) => period.kind === "decade").sort((a, b) => Date.parse(a.range!.startsAt!) - Date.parse(b.range!.startsAt!));

const timingMemo = new Map<string, MujinTimingBundle>();
function timingOf(input: AnalyzeInput, referenceDate: string): MujinTimingBundle {
  const key = `${JSON.stringify(input)}@${referenceDate}`;
  const cached = timingMemo.get(key);
  if (cached) return cached;
  const bundle = computeMujinTiming({ birth: toPublicBirthInput(input), referenceDate, gender: input.gender });
  timingMemo.set(key, bundle);
  return bundle;
}

describe("무진 기능 정의", () => {
  it("첫 상품 정의는 그대로 두고 무진 정의 세 개를 같은 묶음에 더한다", () => {
    expect(FEATURE_IDS).toEqual({ natal: "first-overview-natal", yearMonths: "first-overview-year-months", decade: "first-overview-decade" });
    expect(FEATURE_SET.ids).toEqual([...Object.values(FEATURE_IDS), ...Object.values(MUJIN_FEATURE_IDS)]);
    expect(MUJIN_OVERVIEW.featureId).toBe(MUJIN_FEATURE_IDS.natal);
    expect(FEATURE_SET.get(FEATURE_IDS.yearMonths)).toMatchObject({ modules: ["M01", "M02", "M04", "M06", "M07"], optional: [], processors: [], targetKind: "year-months" });
    expect(FEATURE_SET.get(FEATURE_IDS.decade)).toMatchObject({ modules: ["M01", "M02", "M04", "M05", "M07"], optional: [], processors: [], targetKind: "decade" });

    const natal = FEATURE_SET.get(FEATURE_IDS.natal)!;
    expect(FEATURE_SET.get(MUJIN_FEATURE_IDS.natal)).toMatchObject({ modules: natal.modules, topics: natal.topics, targetKind: "none" });
    expect(FEATURE_SET.get(MUJIN_FEATURE_IDS.luck)).toMatchObject({ targetKind: "decade", processors: ["luck-sequence"] });
    const yearMonths = FEATURE_SET.get(MUJIN_FEATURE_IDS.yearMonths)!;
    expect(yearMonths).toMatchObject({ targetKind: "year-months", optional: ["M05"] });
    expect(yearMonths.modules).toContain("M05");
  });

  it("공개 검사 도우미로 정의와 합성 출생(시각 유무, 남녀) 실행을 검사한다", () => {
    expect(checkFeatureDefinitions(FEATURE_SET.ids.map((id) => FEATURE_SET.get(id)))).toEqual([]);
    const mujin = defineFeatureSet(Object.values(MUJIN_FEATURE_IDS).map((id) => FEATURE_SET.get(id)));
    expect(SYNTHETIC_BIRTHS.some((birth) => birth.birthTime.status === "unknown")).toBe(true);
    expect(runFeatureDefinitionChecks(mujin, createDefaultDependencies(), SYNTHETIC_BIRTHS)).toEqual([]);
  });

  it("무진 정의를 더해도 첫 상품 기능의 결과와 cacheKey는 그대로다", () => {
    const original = defineFeatureSet(Object.values(FEATURE_IDS).map((id) => FEATURE_SET.get(id)));
    const cases: [string, unknown][] = [
      [FEATURE_IDS.natal, undefined],
      [FEATURE_IDS.yearMonths, { kind: "year-months", year: 2026, timezoneId: "Asia/Seoul" }],
      [FEATURE_IDS.decade, luckTarget("2026-11-15T12:00:00+09:00")],
    ];
    for (const [featureId, target] of cases) {
      expect(execute(known, featureId, target).cacheKey).toBe(execute(known, featureId, target, original).cacheKey);
    }
  });

  it("시각 미상에서 무진 year-months는 M05를 optional로 두어 unavailable이 되지 않는다", () => {
    const target = { kind: "year-months", year: 2026, timezoneId: "Asia/Seoul" };
    const mujin = execute(unknownHour, MUJIN_FEATURE_IDS.yearMonths, target);
    expect(mujin.status).toBe("partial");
    expect(mujin.limitations).toContain("BIRTH_TIME_REQUIRED");
    expect(mujin.judgments.length).toBeGreaterThan(0);
    expect(mujin.facets.periods.filter((period) => period.kind === "monthly")).toHaveLength(12);
    expect(mujin.facets.periods.some((period) => period.kind === "decade")).toBe(false);
    // optional 선언이 없는 첫 상품 정의는 같은 입력에서 unavailable이고 선택 판단이 비어 있다.
    const first = execute(unknownHour, FEATURE_IDS.yearMonths, target);
    expect(first.status).toBe("unavailable");
    expect(first.judgments).toEqual([]);
  });

  it("대운 목록 기능은 대운 전부를 받고 기준 시각이 든 대운 하나만 focus로 둔다", () => {
    const decades = decadesOf(execute(known, MUJIN_FEATURE_IDS.luck, luckTarget("2026-11-12T12:00:00+09:00")));
    expect(decades).toHaveLength(10);
    expect(decades.filter((period) => period.focus)).toHaveLength(1);
    expect(decades.every((period) => period.range?.precision === "approximate")).toBe(true);
    // 시간순과 ID 문자열순이 다르다 ("decade:14" < "decade:4"). 그래서 range로 정렬한다.
    expect(decades.map((period) => period.periodId)).not.toEqual(decades.map((period) => period.periodId).sort());
  });
});

describe("무진 무료 표 (buildMujinTables)", () => {
  it("시각을 아는 사례: 원국 12운성은 natal 항목만, 네 기둥 칸마다 일간 기준과 자좌 두 줄", () => {
    const { result, chart, tables } = natalTables(known);
    const natal = result.facets.twelveStages.filter((stage) => stage.scope === "natal");
    expect(new Set(tables.stages.map((cell) => cell.position))).toEqual(new Set(["year", "month", "day", "hour"]));
    expect(tables.stages).toHaveLength(natal.length);
    expect(tables.stages).toHaveLength(8);
    // 줄은 일간 기준 → 자좌, 칸은 원국표 순서(시주 → 연주).
    expect(tables.stages.map((cell) => `${cell.basis}:${cell.position}`)).toEqual([
      "day-master:hour",
      "day-master:day",
      "day-master:month",
      "day-master:year",
      "self:hour",
      "self:day",
      "self:month",
      "self:year",
    ]);
    for (const cell of tables.stages) {
      const source = natal.find((stage) => stage.basis === cell.basis && stage.position === cell.position)!;
      expect(cell).toEqual({
        position: source.position,
        label: chart.pillars.find((pillar) => pillar.key === cell.position)!.label,
        basis: source.basis,
        stem: source.stem,
        branch: source.branch,
        stage: TWELVE_STAGE_LABELS[source.stage].label,
      });
    }
    expect(new Set(tables.stages.filter((cell) => cell.basis === "day-master").map((cell) => cell.stem))).toEqual(new Set([chart.dayMaster!.ko]));
  });

  it("대운·월운 12운성이 섞인 결과를 넣어도 원국 항목만 고른다", () => {
    const luck = execute(known, MUJIN_FEATURE_IDS.luck, luckTarget("2026-11-12T12:00:00+09:00"));
    expect(luck.facets.twelveStages.some((stage) => stage.scope === "period")).toBe(true);
    const { chart, tables } = natalTables(known);
    expect(buildMujinTables(luck, chart)).toEqual(tables);
  });

  it("십성 칸: 천간(일간 자리는 '일간'), 지지 본기, 지장간 목록", () => {
    const { result, chart, tables } = natalTables(known);
    const facts = result.core.document.facts!;
    expect(tables.tenGods.cells.map((cell) => cell.position)).toEqual(["hour", "day", "month", "year"]);
    for (const cell of tables.tenGods.cells) {
      const pillar = facts.positions[cell.position]!;
      expect(cell.label).toBe(chart.pillars.find((entry) => entry.key === cell.position)!.label);
      expect(cell.stem).toBe(cell.position === "day" ? "일간" : pillar.stem.tenGod);
      expect(cell.branch).toBe(pillar.branch.hiddenStems[0]!.tenGod);
      expect(cell.hidden).toEqual(pillar.branch.hiddenStems.map((hidden) => hidden.tenGod));
      expect(cell.hidden[0]).toBe(cell.branch);
    }
  });

  it("오행: 단순 개수(합 8)와 엔진 가중 비율(합 100)을 따로 두고, 다섯 계열 비율도 합 100이다", () => {
    const { result, chart, tables } = natalTables(known);
    expect(tables.elements.counts).toEqual(elementCounts(chart));
    expect(tables.elements.counts).toEqual(result.core.document.facts!.distribution.surface);
    expect(sum(tables.elements.counts)).toBe(8);
    expect(tables.elements.percents).toEqual(result.facets.assessment!.elementPercent);
    expect(sum(tables.elements.percents!)).toBe(100);
    // 가중 비율(지장간·월지 가중)은 개수의 단순 백분율과 다르다.
    expect(tables.elements.percents).not.toEqual(Object.fromEntries(Object.entries(tables.elements.counts).map(([key, count]) => [key, (count / 8) * 100])));
    expect(Object.keys(tables.tenGods.families!).sort()).toEqual([...FAMILIES].sort());
    expect(tables.tenGods.families).toEqual(result.facets.assessment!.familyPercent);
    expect(sum(tables.tenGods.families!)).toBe(100);
  });

  it("시각 미상: 시주 칸 없이 여섯 글자만 센다", () => {
    const { result, chart, tables } = natalTables(unknownHour);
    expect(chart.hourKnown).toBe(false);
    expect(tables.stages.some((cell) => cell.position === "hour")).toBe(false);
    expect(tables.stages).toHaveLength(6);
    expect(tables.tenGods.cells.map((cell) => cell.position)).toEqual(["day", "month", "year"]);
    expect(sum(tables.elements.counts)).toBe(6);
    expect(result.facets.assessment!.coverage).toBe("partial");
    expect(sum(tables.elements.percents!)).toBe(100);
    expect(sum(tables.tenGods.families!)).toBe(100);
  });

  it("엔진이 비율을 계산하지 않았으면(월주 미상) 비율은 null이고 개수와 표는 관측된 기둥만 쓴다", () => {
    const { result, tables } = natalTables(noMonthPillar);
    expect(result.core.document.facts!.positions.month).toBeNull();
    expect(result.facets.assessment).toBeNull();
    expect(tables.elements.percents).toBeNull();
    expect(tables.tenGods.families).toBeNull();
    expect(sum(tables.elements.counts)).toBe(4);
    expect(tables.tenGods.cells.map((cell) => cell.position)).toEqual(["day", "year"]);
    expect(new Set(tables.stages.map((cell) => cell.position))).toEqual(new Set(["day", "year"]));
  });
});

describe("무진 9장 대운 (computeMujinTiming.luck)", () => {
  const luck = execute(known, MUJIN_FEATURE_IDS.luck, luckTarget("2026-11-12T12:00:00+09:00"));
  const decades = decadesOf(luck);

  it("구간 경계는 엔진 계약대로 [시작, 끝)이다", () => {
    const [, second, third, fourth] = decades;
    const at = third!.range!.startsAt!;
    const onStart = pickLuckWindow(luck.facets.periods, at);
    expect(onStart).toMatchObject({ status: "available", reason: null, referenceAt: at });
    expect([onStart.previous?.periodId, onStart.current?.periodId, onStart.next?.periodId]).toEqual([second!.periodId, third!.periodId, fourth!.periodId]);
    const before = pickLuckWindow(luck.facets.periods, new Date(Date.parse(at) - 1).toISOString());
    expect(before.current?.periodId).toBe(second!.periodId);
    expect(before.next?.periodId).toBe(third!.periodId);
  });

  it("기준일이 대운 경계를 넘으면 현재 대운이 바뀐다", () => {
    const current = timingOf(known, REF).luck.current!;
    const boundary = Date.parse(current.startsAt);
    // 기준 시각은 기준일 정오(Asia/Seoul)다. 경계 전날과 다음 날을 고른다.
    const dayBefore = seoulDate(new Date(boundary - DAY));
    const dayAfter = seoulDate(new Date(boundary + DAY));
    const earlier = timingOf(known, dayBefore).luck;
    const later = timingOf(known, dayAfter).luck;
    expect(earlier.referenceAt).toBe(`${dayBefore}T12:00:00+09:00`);
    expect(earlier.next?.periodId).toBe(current.periodId);
    expect(earlier.current?.periodId).toBe(timingOf(known, REF).luck.previous?.periodId);
    expect(later.current?.periodId).toBe(current.periodId);
    expect(later.previous?.periodId).toBe(earlier.current?.periodId);
    // 경계 당일은 그날 정오가 경계보다 앞인지 뒤인지로 정해진다.
    const boundaryDay = seoulDate(new Date(boundary));
    const noonAfterBoundary = Date.parse(`${boundaryDay}T12:00:00+09:00`) >= boundary;
    expect(timingOf(known, boundaryDay).luck.current?.periodId).toBe(noonAfterBoundary ? current.periodId : earlier.current?.periodId);
  });

  it("각 구간은 엔진 라벨·경계·간지·천간 십성·계열을 그대로 옮긴다", () => {
    const window = timingOf(known, REF).luck;
    expect(window.status).toBe("available");
    // 엔진이 기준 시각으로 고른 현재 대운(focus)과 같다.
    expect(window.current?.periodId).toBe(decades.find((period) => period.focus)!.periodId);
    for (const picked of [window.previous, window.current, window.next]) {
      const source = decades.find((period) => period.periodId === picked!.periodId)!;
      expect(picked).toEqual({
        periodId: source.periodId,
        label: source.label,
        startsAt: source.range!.startsAt,
        endsAt: source.range!.endsAt,
        approximate: true,
        ganzhi: `${source.pillar.heavenlyStem}${source.pillar.earthlyBranch}`,
        stemTenGod: source.stemTenGod,
        stemFamily: source.stemTenGodFamily,
      });
    }
    expect(Date.parse(window.previous!.endsAt)).toBe(Date.parse(window.current!.startsAt));
    expect(Date.parse(window.current!.endsAt)).toBe(Date.parse(window.next!.startsAt));
  });

  it("첫 대운 전에는 현재·직전 없이 다음 대운만, 마지막 대운 뒤에는 직전만 남기고 outside-sequence로 둔다", () => {
    const young = timingOf(child, "2021-06-11").luck;
    expect(young).toMatchObject({ status: "unavailable", reason: "outside-sequence", previous: null, current: null });
    expect(young.next?.periodId).toBe(decadesOf(execute(child, MUJIN_FEATURE_IDS.luck, luckTarget("2021-06-11T12:00:00+09:00")))[0]!.periodId);
    expect(Date.parse(young.next!.startsAt)).toBeGreaterThan(Date.parse(young.referenceAt));

    const last = decades.at(-1)!;
    const after = pickLuckWindow(luck.facets.periods, last.range!.endsAt!);
    expect(after).toMatchObject({ status: "unavailable", reason: "outside-sequence", current: null, next: null });
    expect(after.previous?.periodId).toBe(last.periodId);
  });

  it("시각 미상이면 엔진이 대운을 계산하지 않아 hour-unknown으로 남기고 임의로 고르지 않는다", () => {
    const window = timingOf(unknownHour, REF).luck;
    expect(window).toEqual({ status: "unavailable", reason: "hour-unknown", referenceAt: `${REF}T12:00:00+09:00`, previous: null, current: null, next: null });
  });

  it("대운 자료가 없는 목록은 engine-unavailable이다", () => {
    expect(pickLuckWindow([], `${REF}T12:00:00+09:00`)).toMatchObject({ status: "unavailable", reason: "engine-unavailable", current: null });
  });
});

describe("무진 10장 12개월 (computeMujinTiming.months)", () => {
  const VERDICT_TONE: Readonly<Record<TimingVerdict, MonthTone>> = { notable: "positive", mixed: "mixed", careful: "caution", quiet: "neutral" };

  it("두 사주 연도에 걸치는 기준일: 11월 초는 절기 10월부터 연속 12개", () => {
    const { months } = timingOf(known, "2026-11-03");
    expect(months.status).toBe("available");
    expect(months.months).toHaveLength(12);
    expect(months.months.map((month) => month.periodId)).toEqual([
      "monthly:2026-10",
      "monthly:2026-11",
      "monthly:2026-12",
      "monthly:2027-01",
      "monthly:2027-02",
      "monthly:2027-03",
      "monthly:2027-04",
      "monthly:2027-05",
      "monthly:2027-06",
      "monthly:2027-07",
      "monthly:2027-08",
      "monthly:2027-09",
    ]);
    expect(months.window).toEqual({ startMonth: "2026-10", endMonth: "2027-09", label: "2026년 10월부터 2027년 9월까지 (절기 기준 월)" });
    expect(months.months[0]!.label).toBe("2026년 10월");
    // 시간순이고 빈틈없이 이어진다. 앞 달의 끝 날짜에 다음 달 절입이 든다.
    for (const [index, month] of months.months.entries()) {
      if (index === 0) continue;
      const previous = months.months[index - 1]!;
      expect(month.startsOn! >= previous.startsOn!).toBe(true);
      expect(month.startsOn).toBe(previous.endsOn);
    }
    expect(months.months.map((month) => month.startedBeforeReference)).toEqual([true, ...Array(11).fill(false)]);
    // 사주 연도 2026(축월 monthly:2027-01까지)과 2027(인월 monthly:2027-02부터)에 걸친다.
    expect(months.months.findIndex((month) => month.periodId === "monthly:2027-02")).toBe(4);
  });

  it("기준 시각은 기준일 정오다: 입동 당일이라도 정오가 절입 전이면 앞 달부터 센다", () => {
    const year = execute(known, MUJIN_FEATURE_IDS.yearMonths, { kind: "year-months", year: 2026, timezoneId: "Asia/Seoul" });
    const november = year.facets.periods.find((period) => period.periodId === "monthly:2026-11")!;
    expect(seoulDate(new Date(november.range!.startsAt!))).toBe("2026-11-07");
    expect(Date.parse("2026-11-07T12:00:00+09:00")).toBeLessThan(Date.parse(november.range!.startsAt!));
    expect(timingOf(known, "2026-11-07").months.months[0]!.periodId).toBe("monthly:2026-10");
    expect(timingOf(known, "2026-11-08").months.months[0]!.periodId).toBe("monthly:2026-11");
  });

  it("입춘 전날은 앞 사주 연도의 축월부터, 입춘 당일 정오가 지나면 새 사주 연도의 인월부터 센다", () => {
    const year = execute(known, MUJIN_FEATURE_IDS.yearMonths, { kind: "year-months", year: 2027, timezoneId: "Asia/Seoul" });
    const lichun = Date.parse(year.facets.periods.find((period) => period.periodId === "annual:2027")!.range!.startsAt!);
    expect(seoulDate(new Date(lichun))).toBe("2027-02-04");
    expect(Date.parse("2027-02-04T12:00:00+09:00")).toBeGreaterThan(lichun);
    const before = timingOf(known, "2027-02-03").months.months;
    expect([before[0]!.periodId, before.at(-1)!.periodId]).toEqual(["monthly:2027-01", "monthly:2027-12"]);
    const after = timingOf(known, "2027-02-04").months.months;
    expect([after[0]!.periodId, after.at(-1)!.periodId]).toEqual(["monthly:2027-02", "monthly:2028-01"]);
  });

  it("기준일이 그 달 절입일과 같으면 지난 날짜가 없어 startedBeforeReference는 false다", () => {
    const { months } = timingOf(known, "2026-12-07");
    expect(months.months[0]).toMatchObject({ periodId: "monthly:2026-12", startsOn: "2026-12-07", startedBeforeReference: false });
    expect(months.months.every((month) => !month.startedBeforeReference)).toBe(true);
    expect(months.months.at(-1)!.periodId).toBe("monthly:2027-11");
  });

  it("칸은 기존 기간 분석의 표지를 옮기고, 주목·주의는 분야별 기존 선택을 그대로 쓴다", () => {
    const bundle = timingOf(known, REF);
    expect(bundle.version).toBe(MUJIN_TIMING_VERSION);
    expect(bundle.referenceDate).toBe(REF);
    expect(bundle.analyses.map((analysis) => analysis.domain)).toEqual([...TIMING_DOMAINS]);
    const ids = bundle.months.months.map((month) => month.periodId);
    for (const analysis of bundle.analyses) {
      expect(analysis.referenceDate).toBe(REF);
      expect(analysis.window).toMatchObject({ kind: "default", startMonth: bundle.months.window.startMonth, endMonth: bundle.months.window.endMonth });
      for (const statement of analysis.months) {
        expect(ids).toContain(statement.periodId);
        expect(statement.ruleId).toBe("first-overview.timing");
        expect(statement.supportingEvidenceIds.length).toBeGreaterThan(0);
      }
    }
    for (const month of bundle.months.months) {
      expect(month.cells.map((cell) => cell.domain)).toEqual([...TIMING_DOMAINS]);
      for (const cell of month.cells) {
        const statement = bundle.analyses.find((analysis) => analysis.domain === cell.domain)!.months.find((entry) => entry.periodId === month.periodId);
        if (statement) {
          expect(cell.tone).toBe(VERDICT_TONE[statement.verdict]);
          expect(cell.markers).toEqual(statement.markers.map(({ tone, text, activity }) => ({ tone, text, activity })));
        } else {
          expect(cell).toMatchObject({ tone: "neutral", markers: [] });
        }
      }
    }
    expect(bundle.months.notable).toEqual(bundle.analyses.map((analysis) => ({ domain: analysis.domain, periodIds: analysis.notable })));
    expect(bundle.months.careful).toEqual(bundle.analyses.map((analysis) => ({ domain: analysis.domain, periodIds: analysis.careful })));
    for (const entry of bundle.months.notable) expect(entry.periodIds.length).toBeLessThanOrEqual(3);
    for (const entry of bundle.months.careful) expect(entry.periodIds.length).toBeLessThanOrEqual(2);
    expect(bundle.months.limitations).toContain("절기 기준 월이라 달력의 1일과 경계가 다르다.");
    // 저장(jsonb)해도 같은 값이 돌아오고, 같은 입력·기준일로 다시 계산해도 같다 (재시도에서 같은 기준).
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
    expect(computeMujinTiming({ birth: toPublicBirthInput(known), referenceDate: REF, gender: "female" })).toEqual(bundle);
  });

  it("시각 미상이어도 year-months가 unavailable이 되지 않아 12개월과 네 분야 판단을 계산한다", () => {
    const bundle = timingOf(unknownHour, REF);
    expect(bundle.months.status).toBe("available");
    expect(bundle.months.months).toHaveLength(12);
    expect(bundle.months.months.flatMap((month) => month.cells).some((cell) => cell.tone === "no-data")).toBe(false);
    expect(bundle.analyses.every((analysis) => analysis.decade === null)).toBe(true);
    expect(bundle.months.limitations).toContain("태어난 시간을 몰라 대운을 계산하지 않았고, 월운에 대운 맥락을 붙이지 않았다.");
    expect(bundle.months.limitations).toContain("태어난 시간을 몰라 시주와 관련된 표지는 보지 못했다.");
  });

  it("표지 구성으로 칸을 나눈다 (점수가 아니다)", () => {
    const marker = (tone: string) => ({ tone });
    expect(monthTone([marker("positive"), marker("caution")], true)).toBe("mixed");
    expect(monthTone([marker("positive"), marker("neutral")], true)).toBe("positive");
    expect(monthTone([marker("caution"), marker("neutral")], true)).toBe("caution");
    expect(monthTone([marker("neutral")], true)).toBe("neutral");
    expect(monthTone([], true)).toBe("neutral");
    expect(monthTone([], false)).toBe("no-data");
    expect(monthTone([marker("positive")], false)).toBe("no-data");
  });

  it("잘못된 기준일과 출생 입력과 다른 성별은 거부한다", () => {
    const birth = toPublicBirthInput(known);
    expect(() => computeMujinTiming({ birth, referenceDate: "2026-11", gender: "female" })).toThrow();
    expect(() => computeMujinTiming({ birth, referenceDate: "2026-02-30", gender: "female" })).toThrow();
    expect(() => computeMujinTiming({ birth, referenceDate: REF, gender: "male" })).toThrow();
  });
});

describe("기존 기간 분석 (analyzeTiming)", () => {
  const birth = toPublicBirthInput(known);
  const requests: TimingRequest[] = TIMING_DOMAINS.map((domain) => ({ domain, period: { kind: "default", startMonth: "2026-11", endMonth: "2027-10" } }));

  it("features를 주지 않으면 첫 상품 기능으로 계산한 결과와 같다", () => {
    expect(analyzeTiming({ birth, referenceDate: REF, requests })).toEqual(
      analyzeTiming({ birth, referenceDate: REF, requests, features: { yearMonths: FEATURE_IDS.yearMonths, decade: FEATURE_IDS.decade } }),
    );
  });

  it("무진 기능으로 계산해도 시각을 아는 사례의 판단·근거·대운 맥락은 같다", () => {
    expect(analyzeTiming({ birth, referenceDate: REF, requests, features: { yearMonths: MUJIN_FEATURE_IDS.yearMonths, decade: MUJIN_FEATURE_IDS.luck } })).toEqual(
      analyzeTiming({ birth, referenceDate: REF, requests }),
    );
  });
});

describe("analyzeMujinBirth", () => {
  const now: MujinNow = { work: ["job-seeking"], interests: ["ch3"], relationship: null, family: [] };

  it("원국을 한 번 계산해 원국표·무료 표·작성 계획·엔진 기록을 돌려준다", () => {
    const out = analyzeMujinBirth({ birth: toPublicBirthInput(known), product: MUJIN_OVERVIEW, nickname: "가람", now });
    const direct = natalTables(known);
    expect(out.persona.id).toBe("mujin");
    expect(out.chart).toEqual(direct.chart);
    expect(out.tables).toEqual(direct.tables);
    expect(out.engineMeta).toMatchObject({
      package: ENGINE_PACKAGE,
      resultStatus: direct.result.status,
      fingerprint: direct.result.core.fingerprint.hash,
      cacheKey: direct.result.cacheKey,
      provenance: direct.result.provenance,
      inquiryPolicyVersion: "1.1.0",
    });
    expect(out.plan).toMatchObject({ planVersion: MUJIN_PLAN_VERSION, productId: MUJIN_OVERVIEW.id, personaId: "mujin", hourKnown: true, now });
    expect(out.plan.tables).toEqual(out.tables);
    expect(out.trace.length).toBeGreaterThan(0);
  });

  it("시각 미상 입력도 시주 칸 없이 계획을 만든다", () => {
    const out = analyzeMujinBirth({ birth: toPublicBirthInput(unknownHour), product: MUJIN_OVERVIEW, nickname: "가람", now });
    expect(out.chart.hourKnown).toBe(false);
    expect(out.plan.hourKnown).toBe(false);
    expect(out.tables.stages.some((cell) => cell.position === "hour")).toBe(false);
    expect(sum(out.tables.elements.counts)).toBe(6);
  });
});
