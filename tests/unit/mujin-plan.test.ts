import {
  PATTERN_LABEL as ENGINE_PATTERN_LABELS,
  PublicBirthInputSchema,
  SEASON_LABEL as ENGINE_SEASON_LABELS,
  SEASON_OF_BRANCH as ENGINE_SEASON_OF_BRANCH,
  STRENGTH_LABEL as ENGINE_STRENGTH_LABELS,
  TWELVE_STAGE_LABELS,
  createFeatureSession,
  createInquiryReader,
  defineFeatureSet,
  toAnalysisInput,
  type AssessmentFacet,
  type FeatureResult,
  type InquiryConclusion,
  type InquiryEvidence,
  type InquiryReader,
  type InquiryResult,
} from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";
import { describe, expect, it } from "vitest";
import { ENGINE_PATTERN_LABEL, ENGINE_STRENGTH_LABEL, SEASON_LABEL, SEASON_OF_BRANCH, STAGE_MEANING, buildSharedFacts } from "@/domain/mujin/basics";
import { MIXED_CAVEAT, SPLIT_CAVEAT } from "@/domain/mujin/natal-links";
import { EMPTY_NOW, type MujinNow } from "@/domain/mujin/now";
import { buildMujinPlan } from "@/domain/mujin/plan";
import { MUJIN_TAGS, TAG_ASSIGNMENTS, TAG_CATALOG_VERSION, tagsFor } from "@/domain/mujin/tags";
import { MUJIN_PLAN_VERSION, type MujinMaterial, type MujinPlan, type MujinTables, type NatalStageCell, type TenGodCell } from "@/domain/mujin/types";
import { MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { buildChartView, elementCounts, type ChartFacts } from "@/domain/reading/chart";
import { buildReadingPlan } from "@/domain/reading/plan";
import type { ChartElement, ChartView } from "@/domain/reading/types";
import { PARTIAL_CAVEAT, detailKey, type RuleDetail, type RuleDetailSink } from "@/domain/rules/common";
import { createFirstOverviewRules } from "@/domain/rules/first-overview";
import { ENERGY_TEXT, FAMILY_CHILDREN, FAMILY_EARLY, FAMILY_PARENTS, FAMILY_SIBLINGS } from "@/domain/rules/life-tables";
import { FAMILIES, type Family } from "@/domain/rules/materials";
import { STRENGTH_REACTION, TEMPERAMENT_CONDITION, WEALTH_INCOME } from "@/domain/rules/natal-tables";

/**
 * 무진 원국 작성 계획 (src/domain/mujin/plan.ts). 엔진을 직접 실행한 가상 출생정보로 확인한다. 실제 사용자 자료는 쓰지 않는다.
 * 원국표(P01)는 글이 없는 표라 섹션 계획에 없고, 원국 구성 사실(plan.facts)에 P01로 남는다.
 */

const set = defineFeatureSet([
  {
    id: "natal",
    version: "1.0.0",
    modules: ["M01", "M02", "M03", "M04"],
    topics: ["temperament", "strengths", "career", "wealth", "romance", "social"],
    targetKind: "none",
    selection: { version: "1.0.0", rules: [{ module: "M01" }, { module: "M02" }, { module: "M03" }, { module: "M04" }] },
  },
]);

const ELEMENTS: readonly ChartElement[] = ["목", "화", "토", "금", "수"];

/** 엔진 결과로 무료 표를 만든다 (엔진 연결 담당의 buildMujinTables와 같은 기준). */
function tablesOf(result: FeatureResult, chart: ChartView): MujinTables {
  const label = (position: string) => chart.pillars.find((pillar) => pillar.key === position)?.label ?? position;
  const stages: NatalStageCell[] = result.facets.twelveStages
    .filter((stage) => stage.scope === "natal" && stage.position !== "period")
    .map((stage) => ({
      position: stage.position as NatalStageCell["position"],
      label: label(stage.position),
      basis: stage.basis,
      stem: stage.stem,
      branch: stage.branch,
      stage: TWELVE_STAGE_LABELS[stage.stage].label,
    }));
  const cells: TenGodCell[] = [];
  for (const pillar of chart.pillars) {
    const position = result.core.document.facts?.positions[pillar.key];
    if (!position) continue;
    cells.push({
      position: pillar.key,
      label: pillar.label,
      stem: position.stem.tenGod,
      branch: position.branch.tenGod,
      hidden: position.branch.hiddenStems.flatMap((entry) => (entry.tenGod ? [entry.tenGod] : [])),
    });
  }
  const assessment = result.facets.assessment ?? null;
  const element = assessment?.elementPercent as Readonly<Record<ChartElement, number>> | undefined;
  const family = assessment?.familyPercent as Readonly<Record<Family, number>> | undefined;
  return {
    elements: { counts: elementCounts(chart), percents: element && ELEMENTS.every((key) => typeof element[key] === "number") ? element : null },
    stages,
    tenGods: { cells, families: family && FAMILIES.every((key) => typeof family[key] === "number") ? family : null },
  };
}

interface Case {
  readonly reader: InquiryReader;
  readonly sink: RuleDetailSink;
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
  readonly tables: MujinTables;
  readonly gender: "male" | "female";
}

function engineCase(birthDate: string, branch: string | null, gender: "male" | "female"): Case {
  const birth = PublicBirthInputSchema.parse({
    birthDate,
    birthTime: branch ? { status: "branch", branch } : { status: "unknown" },
    gender,
    calendar: { type: "solar" },
    birthPlace: { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울", source: "geonames:1835848" },
  });
  const session = createFeatureSession(createDefaultDependencies());
  try {
    const result = session.execute(set, { ...toAnalysisInput(birth), featureId: "natal" });
    const assessment: AssessmentFacet | null = result.facets.assessment ?? null;
    const chart = buildChartView(
      result.core.document.facts as unknown as ChartFacts,
      (assessment?.elementPercent as Readonly<Record<ChartElement, number>> | undefined) ?? null,
    );
    const sink: RuleDetailSink = new Map();
    const reader = createInquiryReader([result], { rules: createFirstOverviewRules(sink) });
    return { reader, sink, chart, assessment, tables: tablesOf(result, chart), gender };
  } finally {
    session.dispose();
  }
}

function planOf(base: Case, now: MujinNow = EMPTY_NOW, overrides: Partial<Case> = {}) {
  const value = { ...base, ...overrides };
  return buildMujinPlan({
    reader: value.reader,
    sink: value.sink,
    product: MUJIN_OVERVIEW,
    persona: MYOMYO,
    chart: value.chart,
    assessment: value.assessment,
    tables: value.tables,
    nickname: "가상",
    gender: value.gender,
    now,
  });
}

/** 신약·식신격 (가상 사례). */
const WEAK = engineCase("1998-09-19", "신", "female");
/** 신강·건록격, 재성 0% (가상 사례). */
const STRONG = engineCase("1994-05-12", "오", "female");
/** 시각 미상, 관측 기둥에서 식상·재성이 보이지 않음 (가상 사례). */
const UNKNOWN_HOUR = engineCase("2001-11-03", null, "male");
const CASES = [WEAK, STRONG, UNKNOWN_HOUR, engineCase("1973-12-25", "사", "male"), engineCase("1995-02-07", "미", "female")];

const EXPECTED_SECTIONS = ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"];
const EXPECTED_QUESTIONS = [
  "P02",
  "P03",
  "P04",
  "P05",
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((chapter) => [1, 2, 3, 4].map((item) => `${chapter}-${item}`)),
];
const STATUSES = ["adopted", "conditional", "deferred", "general", "unavailable"];

const allMaterials = (plan: MujinPlan): MujinMaterial[] => [...plan.facts, ...plan.sections.flatMap((section) => section.materials), ...plan.nowFacts];
const sectionMaterials = (plan: MujinPlan) => plan.sections.flatMap((section) => section.materials);
const question = (plan: MujinPlan, id: string) => plan.sections.flatMap((section) => section.questions).find((item) => item.id === id)!;
const materialsOf = (plan: MujinPlan, id: string) => {
  const refs = new Set(question(plan, id).refs);
  return allMaterials(plan).filter((material) => refs.has(material.ref));
};

/** 재료에서 사람이 읽는 문장을 모두 모은다 (본문, 약점, 행동, 근거, 비교 이유, 명리 설명, 한계). */
function stringsOf(material: MujinMaterial): string[] {
  return [
    material.text,
    ...(material.weakness ? [material.weakness.what, material.weakness.when, material.weakness.cost, material.weakness.change] : []),
    ...(material.action ? [material.action] : []),
    ...(material.upside ? [material.upside] : []),
    ...(material.counterNote ? [material.counterNote] : []),
    ...(material.basis ?? []),
    ...(material.lore ?? []),
    ...(material.caveats ?? []),
    ...(material.compare ? [...material.compare.criteria.flatMap((item) => [item.name, item.reason]), ...material.compare.needs] : []),
  ];
}

// ─── 가짜 reader (태그·혼합·중복 제거 같은 경계 사례) ─────────────────

function evidence(id: string, ruleId: string, disposition: InquiryEvidence["disposition"] = "accepted"): InquiryEvidence {
  return {
    id,
    subject: "primary",
    periodId: null,
    kind: "judgment",
    tags: [],
    assertion: "규칙이 읽지 않는 문장",
    precision: "confirmed",
    disposition,
    ruleId,
    ruleVersion: "2.2.0",
    sourceRefs: [],
    origins: [],
    paths: [],
    caveats: [],
  };
}
const FAMILIES_EVIDENCE = evidence("primary:judgment:families", "m01.assessment.families");

interface FakeConclusion {
  readonly domain: string;
  readonly ruleId: string;
  readonly key: string;
  readonly statement: string;
  readonly status?: "candidate" | "deferred";
  readonly detail: RuleDetail;
}

function fakeReader(items: readonly FakeConclusion[]): { reader: InquiryReader; sink: RuleDetailSink } {
  const sink: RuleDetailSink = new Map();
  const conclusions = new Map<string, InquiryConclusion[]>();
  for (const item of items) {
    sink.set(detailKey(item.ruleId, null, item.statement), item.detail);
    const conclusion = {
      id: `${item.ruleId}:natal:${item.key}`,
      periodId: null,
      statement: item.statement,
      status: item.status ?? "candidate",
      rule: { ruleId: item.ruleId, version: "3.1.0", sourceRefs: ["service:test"], reviewStatus: "unreviewed" },
      supportingEvidence: [FAMILIES_EVIDENCE],
      counterEvidence: [],
      contextualEvidence: [],
      caveats: ["성향을 읽는 해석이며 실제 사건, 금액, 합격 여부를 판단하지 않는다."],
    } as unknown as InquiryConclusion;
    conclusions.set(item.domain, [...(conclusions.get(item.domain) ?? []), conclusion]);
  }
  const reader: InquiryReader = {
    periods: [],
    answer: (input: unknown) => {
      const domain = (input as { domain: string }).domain;
      const found = conclusions.get(domain) ?? [];
      return {
        schemaVersion: "1.0.0",
        policyId: "inquiry.scoped-evidence",
        policyVersion: "1.1.0",
        question: { domain, kind: "natal", subject: "primary", periodIds: [], contextPeriodIds: [], context: {} },
        status: found.length ? "available" : "insufficient-evidence",
        conclusions: found,
        limitations: [],
        evaluatedRules: [],
        provenance: { primaryChart: "fake", otherChart: null, resultKeys: [] },
      } as unknown as InquiryResult;
    },
  };
  return { reader, sink };
}

const fakePlan = (items: readonly FakeConclusion[], now: MujinNow = EMPTY_NOW) => planOf(WEAK, now, fakeReader(items)).plan;

// ─── 테스트 ────────────────────────────────────────────────

describe("무진 원국 작성 계획: 구성", () => {
  it("기초 분석 P02~P05와 1~8장 질문 32개(모두 36개)가 계획에 있고 상태가 정해져 있다. P01은 원국표라 섹션 계획에 없고 사실로 남는다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      expect(plan.planVersion).toBe(MUJIN_PLAN_VERSION);
      expect(plan.sections.map((section) => section.sectionId)).toEqual(EXPECTED_SECTIONS);
      const questions = plan.sections.flatMap((section) => section.questions);
      expect(questions.map((item) => item.id)).toEqual(EXPECTED_QUESTIONS);
      for (const item of questions) expect(STATUSES).toContain(item.status);
      // 원국표(chart)는 앱이 계산값으로 그리는 표라 글을 쓰지 않는다. P01을 합하면 명세의 기초·1~8장 질문 37개다.
      const chart = MUJIN_OVERVIEW.scroll.sections.find((section) => section.id === "chart")!;
      expect(chart.questions.map((item) => item.id)).toEqual(["P01"]);
      expect(questions.some((item) => item.id === "P01")).toBe(false);
      expect(plan.facts.some((fact) => fact.questionIds.includes("P01") && fact.text.startsWith("원국은"))).toBe(true);
      expect(new Set([...questions.map((item) => item.id), "P01"]).size).toBe(37);
      // 9·10장과 마지막 정리는 유료 생성 때 만든다.
      expect(plan.sections.some((section) => ["chart", "ch9", "ch10", "closing"].includes(section.sectionId))).toBe(false);
      for (const section of plan.sections) {
        const spec = MUJIN_OVERVIEW.scroll.sections.find((item) => item.id === section.sectionId)!;
        expect(section.tier).toBe(spec.tier);
        expect(section.title).toBe(spec.title);
        expect(section.weight).toBe("standard");
        expect(section.targetChars).toEqual(spec.targetChars);
      }
    }
  });

  it("버전·규칙 묶음·태그표 버전을 남기고, 모든 규칙은 검토 전(unreviewed)이다", () => {
    const { plan, trace } = planOf(WEAK);
    expect(plan.rulesets).toEqual([
      { id: "first-overview", version: "3.1.0", reviewStatus: "unreviewed" },
      { id: "mujin-overview", version: "1.0.0", reviewStatus: "unreviewed" },
    ]);
    expect(plan.tagCatalogVersion).toBe(TAG_CATALOG_VERSION);
    expect(plan.personaVersion).toBe(MYOMYO.version);
    expect(plan.productId).toBe("mujin-overview");
    expect(trace.map((item) => item.inquiryDomain)).toEqual(["temperament", "strengths", "career", "wealth", "romance", "social", "friends"]);
  });

  it("ref는 m1부터 계획 전체에서 고유하게 이어지고, 질문 ref와 부모 ref는 모두 계획 안의 재료를 가리킨다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base, { work: ["student"], interests: ["ch2"], relationship: "single", family: ["money"] });
      const refs = allMaterials(plan).map((material) => material.ref);
      expect(refs).toEqual(refs.map((_, index) => `m${index + 1}`));
      const known = new Set(refs);
      for (const section of plan.sections) {
        const own = new Set([...plan.facts, ...section.materials].map((material) => material.ref));
        for (const item of section.questions) for (const ref of item.refs) expect(own.has(ref)).toBe(true);
        for (const material of section.materials) for (const parent of material.parentRefs ?? []) expect(known.has(parent)).toBe(true);
      }
    }
  });
});

describe("무진 원국 작성 계획: 지금의 나", () => {
  it("같은 원국에 다른 '지금의 나'를 넣으면 재료와 판단 상태는 같고 비중·상황 관점·사용자 사실만 다르다", () => {
    const empty = planOf(WEAK).plan;
    const now: MujinNow = { work: ["student", "employed"], interests: ["ch3", "ch7"], relationship: "dating", family: ["care"] };
    const filled = planOf(WEAK, now).plan;
    expect(filled.facts).toEqual(empty.facts);
    for (const [index, section] of filled.sections.entries()) {
      const before = empty.sections[index]!;
      expect(section.materials).toEqual(before.materials);
      expect(section.questions).toEqual(before.questions);
    }
    expect(filled.sections.find((section) => section.sectionId === "ch3")!.weight).toBe("interest");
    expect(filled.sections.find((section) => section.sectionId === "ch7")!.weight).toBe("interest");
    expect(filled.sections.find((section) => section.sectionId === "ch1")!.weight).toBe("standard");
    // 관심 장은 편집 목표만 늘린다 (강제 최소가 아니다).
    expect(filled.sections.find((section) => section.sectionId === "ch3")!.targetChars.max).toBeGreaterThan(
      empty.sections.find((section) => section.sectionId === "ch3")!.targetChars.max,
    );
    expect(filled.sections.map((section) => section.situationNotes)).not.toEqual(empty.sections.map((section) => section.situationNotes));
    expect(empty.nowFacts).toEqual([]);
    expect(filled.nowFacts.length).toBeGreaterThan(0);
    for (const fact of filled.nowFacts) {
      expect(fact.kind).toBe("user-fact");
      expect(fact.source).toBe("now-selection");
      expect(fact.factKind).toBe("current");
      expect(fact.caveats?.length).toBeGreaterThan(0);
    }
    const ch7 = filled.sections.find((section) => section.sectionId === "ch7")!;
    expect(ch7.situationNotes.join(" ")).toContain("아픈 가족이나 자녀가 있다고 추정하지 않는다");
    expect(filled.sections.find((section) => section.sectionId === "ch5")!.situationNotes.join(" ")).toContain("연애 중");
  });

  it("일·학업 상태를 두 개 고르면 고른 순서와 관계없이 같은 관점이 한 번씩만 남고 서로 어긋나지 않는다", () => {
    const a = planOf(WEAK, { ...EMPTY_NOW, work: ["employed", "freelancer"] }).plan;
    const b = planOf(WEAK, { ...EMPTY_NOW, work: ["freelancer", "employed"] }).plan;
    expect(a.sections.map((section) => section.situationNotes)).toEqual(b.sections.map((section) => section.situationNotes));
    expect(a.nowFacts.map((fact) => fact.text)).toEqual(b.nowFacts.map((fact) => fact.text));
    for (const section of a.sections) expect(new Set(section.situationNotes).size).toBe(section.situationNotes.length);
    const ch3 = a.sections.find((section) => section.sectionId === "ch3")!.situationNotes;
    expect(ch3.filter((note) => note.includes("주업")).length).toBe(1);
    expect(ch3.filter((note) => note.includes("안정된 월급을 받는다고 추정하지 않는다")).length).toBe(1);
    expect(ch3.filter((note) => note.includes("수입이 불안정하거나 분쟁이 있다고 추정하지 않는다")).length).toBe(1);
    // 고른 상태가 있는데 '고르지 않았다'는 관점이 함께 남지 않는다.
    expect(ch3.some((note) => note.includes("고르지 않았다"))).toBe(false);
    // 그 상태의 맥락이 없는 장(1장)에는 상황 관점을 넣지 않는다.
    expect(a.sections.find((section) => section.sectionId === "ch1")!.situationNotes).toEqual([]);
  });

  it("미응답·비공개·특별히 없음을 구분해 남긴다", () => {
    const unanswered = planOf(WEAK).plan;
    const hidden = planOf(WEAK, { ...EMPTY_NOW, relationship: "private", family: ["private"] }).plan;
    const none = planOf(WEAK, { ...EMPTY_NOW, family: ["none"] }).plan;
    const notes = (plan: MujinPlan, id: string) => plan.sections.find((section) => section.sectionId === id)!.situationNotes.join(" ");
    expect(notes(unanswered, "ch5")).toContain("고르지 않았다");
    expect(notes(unanswered, "ch7")).toContain("고르지 않았다");
    expect(notes(hidden, "ch5")).toContain("답하고 싶지 않다");
    expect(notes(hidden, "ch7")).toContain("답하고 싶지 않다");
    expect(notes(none, "ch7")).toContain("특별히 다루고 싶은 내용이 없다");
    expect(unanswered.nowFacts).toEqual([]);
    expect(hidden.nowFacts.map((fact) => fact.text)).toEqual(["관계 상태는 답하고 싶지 않다고 했다", "가족 이야기는 답하고 싶지 않다고 했다"]);
  });

  it("가족 미응답·비공개·돌봄 관심 어느 쪽이든 기존 가족 규칙의 짐작 문장이 재료에 없다", () => {
    const familyTexts = [
      ...Object.values(FAMILY_PARENTS),
      ...Object.values(FAMILY_SIBLINGS),
      ...Object.values(FAMILY_CHILDREN),
      ...Object.values(FAMILY_EARLY),
    ].flatMap((reading) => [reading.claim, ...(reading.weakness ? [reading.weakness.what, reading.weakness.cost, reading.weakness.change] : [])]);
    const nows: MujinNow[] = [EMPTY_NOW, { ...EMPTY_NOW, family: ["private"] }, { ...EMPTY_NOW, family: ["care"] }, { ...EMPTY_NOW, family: ["none"] }];
    for (const base of CASES) {
      for (const now of nows) {
        const { plan, trace } = planOf(base, now);
        const strings = allMaterials(plan).flatMap(stringsOf);
        for (const text of familyTexts) expect(strings).not.toContain(text);
        expect(allMaterials(plan).some((material) => material.ruleId === "first-overview.family")).toBe(false);
        expect(trace.some((item) => item.inquiryDomain === "family")).toBe(false);
        // 7장은 가족사 판단 없이 채택된 행동 경향의 연결이나 일반 점검으로만 채운다.
        const ch7 = plan.sections.find((section) => section.sectionId === "ch7")!;
        expect(ch7.materials.every((material) => material.kind === "derived" || material.kind === "general")).toBe(true);
      }
    }
  });
});

describe("무진 원국 작성 계획: 보류와 시각 미상", () => {
  it("시각 미상이면 coverage와 보류를 그대로 남기고, 관측되지 않은 계열을 결핍으로 확정하지 않는다", () => {
    const { plan } = planOf(UNKNOWN_HOUR);
    expect(plan.hourKnown).toBe(false);
    expect(plan.coverageNotes.length).toBe(1);
    expect(plan.facts.some((fact) => fact.questionIds.includes("P04") && fact.text.includes("시주를 계산하지 않았습니다"))).toBe(true);
    const judgments = sectionMaterials(plan).filter((material) => material.kind === "judgment");
    expect(judgments.some((material) => material.status === "deferred")).toBe(true);
    for (const material of judgments) {
      expect(material.caveats).toContain(PARTIAL_CAVEAT);
      if (material.status === "deferred") expect(material.tags).toBeUndefined();
    }
    // 재성이 관측된 기둥에서만 안 보이므로 '돈보다 의미' 분기를 확정하지 않고 보류한다.
    expect(question(plan, "4-1").status).toBe("deferred");
    expect(question(plan, "4-1").note).toContain("보류");
    expect(allMaterials(plan).flatMap(stringsOf)).not.toContain(WEALTH_INCOME.detached.claim);
    const p05 = materialsOf(plan, "P05");
    expect(p05.some((material) => material.text.includes("원국에 없다고 확정하지 않습니다"))).toBe(true);
    // 판단이 있는 질문도 시주를 뺀 범위라 조건부다.
    for (const item of plan.sections.flatMap((section) => section.questions)) expect(item.status).not.toBe("adopted");
  });

  it("기준값 근처나 시각 미상으로 보류한 판단만 있으면 질문은 deferred로 남는다", () => {
    const plan = fakePlan([
      {
        domain: "temperament",
        ruleId: "first-overview.temperament",
        key: "core",
        statement: "가상 보류 판단",
        status: "deferred",
        detail: { aspect: "핵심 특징", basis: ["가상 근거"], variant: "resource" },
      },
    ]);
    expect(question(plan, "1-1").status).toBe("deferred");
    const core = materialsOf(plan, "1-1").find((material) => material.kind === "judgment")!;
    expect(core.status).toBe("deferred");
    expect(core.tags).toBeUndefined();
    // 보류 판단에는 태그가 없으므로 이어 쓰는 설명도 없다.
    expect(sectionMaterials(plan).some((material) => material.kind === "derived")).toBe(false);
  });

  it("1위 계열이 동률이면 한쪽 성향으로 단정하지 않도록 조건부로 남긴다", () => {
    const tied = { ...WEAK.assessment!, familyPercent: { peer: 30, output: 10, wealth: 10, authority: 20, resource: 30 } } as AssessmentFacet;
    const { reader, sink } = fakeReader([
      { domain: "temperament", ruleId: "first-overview.temperament", key: "core", statement: "가상 중심 판단", detail: { aspect: "핵심 특징", basis: [], variant: "peer" } },
    ]);
    const { plan } = planOf(WEAK, EMPTY_NOW, { reader, sink, assessment: tied });
    expect(question(plan, "1-1").status).toBe("conditional");
    const core = materialsOf(plan, "1-1").find((material) => material.kind === "judgment")!;
    expect(core.caveats!.join(" ")).toContain("비겁·인성이 같은 비율(30%)");
  });

  it("실제 엔진의 보류 판단(취업·창업 비교 등)은 상태를 바꾸지 않는다", () => {
    for (const base of CASES) {
      const { plan, trace } = planOf(base);
      const raw = new Map(trace.flatMap((item) => item.conclusions.map((conclusion) => [conclusion.id, conclusion.status] as const)));
      for (const material of sectionMaterials(plan).filter((item) => item.kind === "judgment")) {
        expect(material.status).toBe(raw.get(material.conclusionId!));
      }
    }
  });
});

describe("무진 원국 작성 계획: 기초 분석 재료", () => {
  it("오행 글자 수와 세력 비율은 다른 이름의 재료이고, 같은 값으로 가장 크면 공동으로 설명한다", () => {
    const tables: MujinTables = {
      ...WEAK.tables,
      elements: { counts: { 목: 1, 화: 1, 토: 3, 금: 3, 수: 0 }, percents: { 목: 10, 화: 15, 토: 30, 금: 30, 수: 15 } },
      tenGods: { ...WEAK.tables.tenGods, families: { peer: 30, output: 10, wealth: 10, authority: 20, resource: 30 } },
    };
    const { plan } = planOf(WEAK, EMPTY_NOW, { tables });
    const counts = plan.facts.find((fact) => fact.text.startsWith("오행 글자 수"))!;
    const percents = plan.facts.find((fact) => fact.text.startsWith("오행 세력 비율"))!;
    expect(counts.ref).not.toBe(percents.ref);
    expect(counts.text).toContain("단순 개수");
    expect(percents.text).toContain("가중 비율");
    expect(counts.text).toContain("토(土)·금(金)이 각 3개로 공동");
    expect(percents.text).toContain("토(土)·금(金)이 각 30%로 공동");
    expect(plan.facts.find((fact) => fact.text.startsWith("십성 다섯 계열"))!.text).toContain("비겁·인성이 각 30%로 공동");
    const p03 = materialsOf(plan, "P03");
    expect(p03.map((material) => material.ref)).toEqual(expect.arrayContaining([counts.ref, percents.ref]));
    const absent = p03.find((material) => material.text.includes("겉 글자로는 없지만"))!;
    expect(absent.text).toContain("수(水)는 겉 글자로는 없지만 세력 비율로는 15%입니다");
    expect(absent.caveats!.join(" ")).toContain("용신·결핍·질병으로 연결하지 않는다");
    for (const material of p03) expect(material.text).not.toMatch(/용신|결핍|질병/);
    expect(question(plan, "P03").note).toContain("공동");
  });

  it("원국 12운성 재료는 원국 항목만 쓰고 기간 항목이 없으며, 병·사·절을 질병·죽음·불운으로 옮기지 않는다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      const stages = plan.sections.find((section) => section.sectionId === "basics-stages")!.materials;
      expect(stages.length).toBeGreaterThan(0);
      for (const material of stages) {
        expect(material.kind).toBe("engine-fact");
        expect(material.scope).toBe("natal");
        expect(material.periodId).toBeUndefined();
        expect(material.text).not.toMatch(/대운|세운|월운|기간/);
      }
      if (!base.chart.hourKnown) expect(stages.some((material) => material.text.includes("시지"))).toBe(false);
    }
    expect(STAGE_MEANING["병"]).toContain("질병을 뜻하지 않는다");
    expect(STAGE_MEANING["사"]).toContain("죽음을 뜻하지 않는다");
    expect(STAGE_MEANING["절"]).toContain("불운을 뜻하지 않는다");
    // 신약 사례는 연지가 사(死) 단계다. 단계 뜻에 죽음이 아니라는 설명이 붙는다.
    const meanings = planOf(WEAK).plan.sections.find((section) => section.sectionId === "basics-stages")!.materials.find((material) =>
      material.text.startsWith("이 원국에 나온 단계"),
    )!;
    expect(meanings.text).toContain("사는 움직임을 멈추고 정리하는 단계(죽음을 뜻하지 않는다)");
  });

  it("격국·강약·계절 이름은 엔진 표기를 따른다 (편관격·월겁격, 신강·신약)", () => {
    expect(ENGINE_PATTERN_LABEL).toEqual(ENGINE_PATTERN_LABELS);
    expect(ENGINE_STRENGTH_LABEL).toEqual(ENGINE_STRENGTH_LABELS);
    expect(SEASON_LABEL).toEqual(ENGINE_SEASON_LABELS);
    expect(SEASON_OF_BRANCH).toEqual(ENGINE_SEASON_OF_BRANCH);
    const facts = buildSharedFacts(WEAK.chart, { ...WEAK.assessment!, pattern: "seven-killings" } as AssessmentFacet, WEAK.tables);
    expect(facts.find((fact) => fact.key === "fact:pattern")!.text).toContain("편관격");
    expect(facts.find((fact) => fact.key === "fact:strength")!.text).toContain("신약");
    const plan = fakePlan([
      {
        domain: "strengths",
        ruleId: "first-overview.strengths",
        key: "ability",
        statement: "가상 능력 판단",
        detail: { aspect: "발휘하기 좋은 능력", basis: ["격국이 칠살격으로 계산됨"], variant: "seven-killings" },
      },
    ]);
    const ability = materialsOf(plan, "2-1").find((material) => material.kind === "judgment")!;
    expect(ability.basis).toEqual(["격국이 편관격으로 계산됨"]);
    expect(allMaterials(plan).flatMap(stringsOf).some((text) => text.includes("칠살격") || text.includes("양인격"))).toBe(false);
  });

  it("P05 중심·보조 계열은 1장 판단과 같은 결론을 쓰되 약점·행동 제안·태그는 1장에만 둔다", () => {
    const { plan } = planOf(WEAK);
    const p05 = plan.sections.find((section) => section.sectionId === "basics-ten-gods")!.materials.filter((material) => material.kind === "judgment");
    const ch1 = plan.sections.find((section) => section.sectionId === "ch1")!.materials;
    expect(p05.map((material) => material.aspect)).toEqual(["중심 계열", "보조 계열"]);
    for (const material of p05) {
      expect(ch1.some((item) => item.conclusionId === material.conclusionId)).toBe(true);
      expect(material.weakness).toBeUndefined();
      expect(material.action).toBeUndefined();
      expect(material.tags).toBeUndefined();
    }
  });
});

describe("무진 원국 작성 계획: 의미 태그와 연결", () => {
  it("의미 태그는 채택된 판단에만 붙고, 연결 재료는 같은 태그를 가진 채택 판단을 부모로 가리킨다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      const byRef = new Map(allMaterials(plan).map((material) => [material.ref, material] as const));
      for (const material of allMaterials(plan)) {
        if (material.kind === "judgment" && material.tags) {
          expect(material.status).toBe("candidate");
          expect(material.tags).toEqual(tagsFor(material.ruleId!, material.conclusionId!.split(":").at(-1)!, material.variant));
        }
        if (material.kind === "derived") {
          expect(material.parentRefs?.length).toBeGreaterThan(0);
          for (const ref of material.parentRefs!) {
            const parent = byRef.get(ref)!;
            expect(parent.kind).toBe("judgment");
            expect(parent.status).toBe("candidate");
            expect(parent.tags?.some((tag) => material.tags!.includes(tag))).toBe(true);
          }
        }
        if (!["judgment", "derived"].includes(material.kind)) expect(material.tags).toBeUndefined();
      }
    }
  });

  it("태그표에 없는 변형이면 연결 재료 없이 일반 점검으로 남는다", () => {
    expect(tagsFor("first-overview.temperament", "core", "wealth")).toEqual([]);
    expect(tagsFor("first-overview.temperament", "core", "없는 변형")).toEqual([]);
    expect(tagsFor("first-overview.temperament", "core", undefined)).toEqual([]);
    const plan = fakePlan([
      {
        domain: "temperament",
        ruleId: "first-overview.temperament",
        key: "core",
        statement: "가상 현실파 판단",
        detail: { aspect: "핵심 특징", basis: ["가상 근거"], variant: "wealth" },
      },
    ]);
    expect(sectionMaterials(plan).some((material) => material.kind === "derived")).toBe(false);
    for (const id of ["2-3", "3-3", "3-4", "5-4", "6-3", "6-4", "7-1", "7-2", "7-3", "7-4", "8-1", "8-2", "8-3", "8-4"]) {
      expect(question(plan, id).status).toBe("general");
      const [general] = materialsOf(plan, id).filter((material) => material.kind === "general");
      expect(general!.text.startsWith("일반 점검")).toBe(true);
      expect(general!.caveats).toContain("사주 판단이 아닌 일반 점검이다.");
      expect(question(plan, id).note).toContain("일반 점검");
    }
  });

  it("상반된 경향이 같은 판단에서 나오면 혼합으로, 다른 판단에서 나오면 조건별로 남긴다", () => {
    const mixed = fakePlan([
      { domain: "career", ruleId: "first-overview.career", key: "org-fit", statement: "가상 균형형", detail: { aspect: "조직과 업무 환경", basis: [], variant: "mixed" } },
    ]);
    const merged = materialsOf(mixed, "7-1").filter((material) => material.kind === "derived");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tags).toEqual(["autonomy-need", "role-clarity"]);
    expect(merged[0]!.caveats).toContain(MIXED_CAVEAT);

    const split = fakePlan([
      { domain: "temperament", ruleId: "first-overview.temperament", key: "core", statement: "가상 자기 기준", detail: { aspect: "핵심 특징", basis: [], variant: "peer" } },
      { domain: "career", ruleId: "first-overview.career", key: "org-fit", statement: "가상 조직형", detail: { aspect: "조직과 업무 환경", basis: [], variant: "structured" } },
    ]);
    const parts = materialsOf(split, "7-1").filter((material) => material.kind === "derived");
    expect(parts.map((material) => material.tags)).toEqual([["autonomy-need"], ["role-clarity"]]);
    for (const material of parts) expect(material.caveats).toContain(SPLIT_CAVEAT);
  });

  it("같은 원인(태그)은 질문마다 한 재료로 합치고, 고정 카탈로그 순서로 고른다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      for (const section of plan.sections) {
        for (const item of section.questions) {
          const derived = section.materials.filter((material) => material.kind === "derived" && material.questionIds.includes(item.id));
          const tags = derived.flatMap((material) => material.tags ?? []);
          expect(new Set(tags).size).toBe(tags.length);
          const order = derived.map((material) => MUJIN_TAGS.findIndex((tag) => tag.id === material.tags![0]));
          if (!["7-4", "8-3"].includes(item.id)) expect(order).toEqual([...order].sort((a, b) => a - b));
        }
      }
    }
  });

  it("한 질문에 같은 원인(같은 계열 비중)의 판단이 함께 들어가면 뒤의 판단에 근거를 한 번만 설명하라는 한계를 붙인다", () => {
    // 신강 사례: 비겁이 1위(47%)라 친구 관계 이미지(비겁)와 협력(어울림, 비겁 25% 이상)이 같은 원인이다.
    const { plan } = planOf(STRONG);
    const image = materialsOf(plan, "6-1").find((material) => material.conclusionId === "first-overview.friends:natal:image")!;
    const cooperation = materialsOf(plan, "6-1").find((material) => material.conclusionId === "first-overview.social:natal:cooperation")!;
    expect(image.variant).toBe("peer");
    expect(cooperation.variant).toBe("crew");
    expect(image.caveats!.some((caveat) => caveat.includes("같은 원인"))).toBe(false);
    expect(cooperation.caveats!.some((caveat) => caveat.includes("같은 원인(비겁 비중)"))).toBe(true);
    const jobs = materialsOf(plan, "3-1").find((material) => material.conclusionId === "first-overview.jobs:natal:family")!;
    expect(jobs.caveats!.some((caveat) => caveat.includes("같은 원인(비겁 비중)"))).toBe(true);
  });

  it("2-4는 고른 능력과 관련된 보완 행동만 보조로 쓴다", () => {
    const ability: FakeConclusion = {
      domain: "strengths",
      ruleId: "first-overview.strengths",
      key: "ability",
      statement: "가상 정인격 능력",
      detail: { aspect: "발휘하기 좋은 능력", basis: [], variant: "direct-resource" },
    };
    const action = (variant: string): FakeConclusion => ({
      domain: "strengths",
      ruleId: "first-overview.strengths",
      key: "action",
      statement: `가상 보완 행동 ${variant}`,
      detail: { aspect: "능력을 실제 행동으로 연결하는 방법", basis: [], variant },
    });
    const related = materialsOf(fakePlan([ability, action("output")]), "2-4");
    expect(related.some((material) => material.conclusionId === "first-overview.strengths:natal:action")).toBe(true);
    const unrelated = materialsOf(fakePlan([ability, action("peer")]), "2-4");
    expect(unrelated.some((material) => material.conclusionId === "first-overview.strengths:natal:action")).toBe(false);
  });

  it("태그표의 열쇠는 실제 규칙 변형과 카탈로그 태그만 쓴다", () => {
    const known = new Set(MUJIN_TAGS.map((tag) => tag.id));
    for (const keys of Object.values(TAG_ASSIGNMENTS)) {
      for (const parts of Object.values(keys)) {
        for (const entry of Object.values(parts)) for (const tag of [...entry.tags, ...(entry.addresses ?? [])]) expect(known.has(tag)).toBe(true);
      }
    }
    // 명세 14절의 격국 능력 열 개가 모두 태그로 있다.
    expect(MUJIN_TAGS.filter((tag) => tag.kind === "ability").map((tag) => tag.label)).toEqual(["식신", "상관", "정재", "편재", "정관", "편관", "정인", "편인", "건록", "월겁"]);
  });
});

describe("무진 원국 작성 계획: 제외한 연결", () => {
  const forbidden = [
    STRENGTH_REACTION.weak.claim,
    STRENGTH_REACTION.weak.weakness!.what,
    STRENGTH_REACTION.weak.weakness!.cost,
    STRENGTH_REACTION.weak.weakness!.change,
    STRENGTH_REACTION.strong.claim,
    TEMPERAMENT_CONDITION["weak-outer"].claim,
    TEMPERAMENT_CONDITION["weak-outer"].action!,
    TEMPERAMENT_CONDITION["strong-inner"].action!,
    ...Object.values(ENERGY_TEXT).flatMap((reading) => [reading.claim, ...(reading.weakness ? [reading.weakness.what, reading.weakness.cost] : [])]),
  ];
  const fragments = ["수입 굴곡을 혼자 버티는", "변동을 버티는 힘", "같은 일을 해도 덜 지쳐요", "혼자서도 버티는 힘이 좋아요", "에너지가 쉽게 바닥나"];

  it("강약을 체력·회복·수입 변동 감당과 잇는 문장이 무진 재료 어디에도 없다", () => {
    // 신약 사례의 원래 규칙 결론에는 그런 문장이 있다 (빼는 대상이 실제로 있었는지 확인).
    const raw = WEAK.reader.answer({ domain: "temperament", kind: "natal", context: { gender: "female" } }).conclusions.map((item) => item.statement);
    expect(raw).toContain(STRENGTH_REACTION.weak.claim);
    expect(raw.some((statement) => Object.values(ENERGY_TEXT).some((reading) => reading.claim === statement))).toBe(true);
    for (const base of CASES) {
      const { plan } = planOf(base);
      const strings = allMaterials(plan).flatMap(stringsOf);
      for (const text of forbidden) expect(strings).not.toContain(text);
      for (const fragment of fragments) expect(strings.some((text) => text.includes(fragment))).toBe(false);
      expect(allMaterials(plan).some((material) => material.ruleId === "first-overview.energy")).toBe(false);
      // 3-3 비교에는 강약 기준과 강약 근거가 없다.
      const strengthIds = new Set(
        base.reader
          .answer({ domain: "temperament", kind: "natal", context: { gender: base.gender } })
          .conclusions.flatMap((item) => item.supportingEvidence)
          .filter((entry) => entry.ruleId === "m01.assessment.strength")
          .map((entry) => entry.id),
      );
      for (const material of materialsOf(plan, "3-3")) {
        expect(material.compare?.criteria.some((item) => item.name === "안정성과 변동성") ?? false).toBe(false);
        for (const id of [...(material.evidence?.supporting ?? []), ...(material.evidence?.counter ?? [])]) expect(strengthIds.has(id)).toBe(false);
      }
      // 용신·기신으로 사람을 고르는 친구 판단도 쓰지 않는다 (6-4).
      expect(allMaterials(plan).some((material) => /friends:natal:(match|drain)$/.test(material.conclusionId ?? ""))).toBe(false);
    }
  });

  it("주변 사람의 평가를 단정하거나 과거를 짐작하는 기존 문장을 쓰지 않고, 엔진 강약과 다른 숫자의 설명 줄을 넣지 않는다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      const texts = allMaterials(plan).map((material) => material.text);
      for (const text of texts) {
        expect(text).not.toMatch(/(있었을|들어 봤을|들었을|나였을|했을) 거예요/);
        expect(text).not.toContain("친구들 눈에는");
      }
      const strengthLine = allMaterials(plan).flatMap((material) => material.lore ?? []).filter((line) => line.includes("기운이 합쳐"));
      expect(strengthLine).toEqual([]);
    }
  });
});

describe("무진 원국 작성 계획: 중복", () => {
  it("한 질문에 같은 결론이 두 번 들어가지 않고, 같은 행동 문장은 목차 순서에서 처음 나온 재료에만 남는다", () => {
    for (const base of CASES) {
      const { plan } = planOf(base);
      for (const item of plan.sections.flatMap((section) => section.questions)) {
        const ids = materialsOf(plan, item.id).flatMap((material) => (material.conclusionId ? [material.conclusionId] : []));
        expect(new Set(ids).size).toBe(ids.length);
      }
      const actions = allMaterials(plan).flatMap((material) => [material.action, material.weakness?.change].filter((text): text is string => Boolean(text?.trim())));
      expect(new Set(actions.map((text) => text.trim())).size).toBe(actions.length);
    }
    const repeated = "가상 행동 제안: 오늘 할 일 하나를 끝까지 닫기";
    const plan = fakePlan([
      { domain: "temperament", ruleId: "first-overview.temperament", key: "core", statement: "가상 1장 판단", detail: { aspect: "핵심 특징", basis: [], variant: "resource", action: repeated } },
      {
        domain: "career",
        ruleId: "first-overview.career",
        key: "style",
        statement: "가상 3장 판단",
        detail: { aspect: "일하는 방식", basis: [], variant: "resource", action: "다른 행동", weakness: { what: "가", when: "나", cost: "다", change: repeated } },
      },
    ]);
    const first = materialsOf(plan, "1-1").find((material) => material.kind === "judgment")!;
    const later = materialsOf(plan, "3-1").find((material) => material.kind === "judgment")!;
    expect(first.action).toBe(repeated);
    expect(later.action).toBe("다른 행동");
    expect(later.weakness).toEqual({ what: "가", when: "나", cost: "다", change: "" });
  });
});

describe("묘묘 계획과 규칙 변형 기록", () => {
  it("규칙은 고른 변형 키를 RuleDetail.variant에 남기고, 묘묘 작성 계획에는 그 칸이 들어가지 않는다", () => {
    const base = engineCase("1998-09-19", "신", "female");
    const { plan } = buildReadingPlan({
      reader: base.reader,
      sink: base.sink,
      product: FIRST_OVERVIEW,
      persona: MYOMYO,
      chart: base.chart,
      assessment: base.assessment,
      nickname: "가상",
      gender: "female",
      situationId: null,
    });
    const statements = plan.topics.flatMap((topic) => topic.statements);
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) expect(Object.keys(statement)).not.toContain("variant");
    const details = [...base.sink.values()].filter((detail) => !detail.timing);
    expect(details.length).toBe(statements.length);
    for (const detail of details) expect(typeof detail.variant).toBe("string");
  });
});

describe("무진 원국 작성 계획: 계산 자료가 없을 때", () => {
  it("판단 재료가 없으면 질문을 unavailable로 두고 결론이나 일반 점검을 만들지 않는다", () => {
    const { reader, sink } = fakeReader([]);
    const { plan } = planOf(WEAK, EMPTY_NOW, { reader, sink, assessment: null });
    for (const section of plan.sections.filter((item) => item.sectionId.startsWith("ch"))) {
      for (const item of section.questions) {
        expect(item.status).toBe("unavailable");
        expect(item.refs.filter((ref) => section.materials.some((material) => material.ref === ref))).toEqual([]);
      }
    }
  });
});
