import {
  PublicBirthInputSchema,
  createFeatureSession,
  createInquiryReader,
  defineFeatureSet,
  toAnalysisInput,
  type AssessmentFacet,
  type InquiryEvidence,
  type InquiryRuleContext,
} from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";
import { describe, expect, it } from "vitest";
import { detailKey, type RuleDetailSink } from "@/domain/rules/common";
import { createFirstOverviewRules } from "@/domain/rules/first-overview";
import { withJosa } from "@/domain/rules/materials";
import { createTimingRule, selectionScore } from "@/domain/rules/timing";

function evidence(partial: Partial<InquiryEvidence> & Pick<InquiryEvidence, "id" | "ruleId">): InquiryEvidence {
  return {
    subject: "primary",
    periodId: null,
    kind: "judgment",
    tags: [],
    assertion: "이 문장은 규칙이 읽으면 안 된다",
    precision: "confirmed",
    disposition: "accepted",
    ruleVersion: "2.2.0",
    sourceRefs: [],
    origins: [],
    paths: [],
    caveats: [],
    ...partial,
  };
}

const families = evidence({ id: "families", ruleId: "m01.assessment.families" });
const strength = evidence({ id: "strength", ruleId: "m01.assessment.strength" });
const pattern = evidence({ id: "pattern", ruleId: "m01.assessment.pattern" });
const guard = (domain: string) =>
  evidence({ id: `guard-${domain}`, ruleId: `m03.${domain}.context-review`, disposition: "review-required", tags: ["module:M03", `topic:${domain}`] });
const shinsal = (id: string, periodId: string | null = null) =>
  evidence({ id: `shinsal-${id}-${periodId ?? "natal"}`, ruleId: "inquiry.facets.shinsal", kind: "shinsal", periodId, tags: [`shinsal:${id}`, `position:${periodId ? "period" : "day"}`] });
const relation = (type: string, dayBranch: boolean, periodId: string | null = null) =>
  evidence({
    id: `relation-${type}-${dayBranch}-${periodId ?? "natal"}`,
    ruleId: `m02.${type}`,
    kind: "relation",
    periodId,
    tags: [`relation:${type}`, ...(dayBranch ? ["day-branch"] : []), ...(type.includes("combination") ? ["combination"] : [])],
  });

function assessment(overrides: Partial<AssessmentFacet>): AssessmentFacet {
  return {
    coverage: "complete",
    missingPositions: [],
    strength: "weak",
    pattern: "eating-god",
    usefulElement: "토",
    helpfulElement: "화",
    adverseElements: [],
    usefulGodBasis: { adopted: "fuyi", rule: 2, season: "autumn" },
    dominantElement: "금",
    missingElements: [],
    observedMissingElements: [],
    dominantFamily: "output",
    missingFamilies: [],
    observedMissingFamilies: [],
    familyPercent: { resource: 14, output: 41, authority: 10, wealth: 15, peer: 20 },
    elementPercent: { 목: 9, 화: 13, 토: 27, 금: 38, 수: 13 },
    ...overrides,
  } as AssessmentFacet;
}

const position = (stemTenGod: string, branchTenGod: string) => ({ stem: { tenGod: stemTenGod }, branch: { tenGod: branchTenGod } });
const natalFacts = (positions: Record<string, unknown>) => ({ positions });
const DEFAULT_FACTS = natalFacts({
  year: position("겁재", "정관"),
  month: position("식신", "식신"),
  day: position("일간", "정인"),
  hour: position("정재", "상관"),
});

function context(
  domain: string,
  assess: AssessmentFacet | null,
  entries: InquiryEvidence[] = [families, strength, pattern],
  facts: unknown = DEFAULT_FACTS,
): InquiryRuleContext {
  return {
    question: { domain, kind: "natal", subject: "primary", periodIds: [], contextPeriodIds: [], context: {} },
    periodId: null,
    evidence: entries,
    contextEvidence: [],
    limitations: [],
    natalFacts: facts,
    otherNatalFacts: null,
    assessment: assess,
    period: null,
    contextPeriods: [],
    twelveStages: [],
    contextTwelveStages: [],
    monthSequence: null,
    pair: null,
  } as unknown as InquiryRuleContext;
}

function evaluate(domain: string, ctx: InquiryRuleContext, sink?: RuleDetailSink) {
  const rule = createFirstOverviewRules(sink).find((item) => item.domains.includes(domain) && item.kinds.includes("natal"))!;
  return rule.evaluate(ctx);
}

const keys = (drafts: readonly { key: string }[]) => drafts.map((draft) => draft.key);

describe("기본 성향 규칙", () => {
  it("적용: 핵심 특징, 섞인 성향, 반응, 조건을 각각 다른 재료로 낸다", () => {
    const sink: RuleDetailSink = new Map();
    const drafts = evaluate("temperament", context("temperament", assessment({})), sink);
    expect(keys(drafts)).toEqual(["core", "mix", "reaction", "condition"]);
    expect(drafts[0]!.supportingEvidenceIds).toEqual(["families"]);
    expect(drafts[2]!.supportingEvidenceIds).toEqual(["strength"]);
    const core = sink.get(detailKey("first-overview.temperament", null, drafts[0]!.statement))!;
    expect(core.aspect).toBe("핵심 특징");
    expect(core.weakness).toMatchObject({ what: expect.any(String), when: expect.any(String), cost: expect.any(String), change: expect.any(String) });
  });

  it("비적용: 판단 재료가 없으면 결론을 내지 않는다", () => {
    expect(evaluate("temperament", context("temperament", null))).toEqual([]);
    expect(evaluate("temperament", context("temperament", assessment({}), []))).toEqual([]);
  });

  it("고르게 분포하면 두드러진 계열 대신 균형 구조로 읽는다", () => {
    const flat = assessment({ familyPercent: { resource: 20, output: 22, authority: 20, wealth: 19, peer: 19 } as AssessmentFacet["familyPercent"] });
    const [core] = evaluate("temperament", context("temperament", flat));
    expect(core!.statement).toContain("고르게");
  });

  it("반대 근거: 해당 주제의 검토 표지만 연결한다", () => {
    const drafts = evaluate("temperament", context("temperament", assessment({}), [families, strength, guard("temperament"), guard("career")]));
    expect(drafts[0]!.counterEvidenceIds).toEqual(["guard-temperament"]);
    expect(drafts[0]!.caveats.some((caveat) => caveat.includes("단정하지"))).toBe(true);
  });

  it("보류: 시주 미상이고 1, 2위가 가까우면 deferred다", () => {
    const close = assessment({
      coverage: "partial",
      familyPercent: { resource: 20, output: 30, authority: 13, wealth: 12, peer: 25 } as AssessmentFacet["familyPercent"],
    });
    expect(evaluate("temperament", context("temperament", close))[0]!.status).toBe("deferred");
  });

  it("assertion 문장이 달라도 결과가 같다", () => {
    const changed = [families, strength, pattern].map((entry) => ({ ...entry, assertion: "전혀 다른 문장" }));
    expect(evaluate("temperament", context("temperament", assessment({}), changed))).toEqual(evaluate("temperament", context("temperament", assessment({}))));
  });
});

describe("강점 규칙", () => {
  it("적용: 격국으로 능력과 과해졌을 때의 약점을 낸다", () => {
    const sink: RuleDetailSink = new Map();
    const [ability] = evaluate("strengths", context("strengths", assessment({ pattern: "hurting-officer" })), sink);
    expect(ability!.supportingEvidenceIds).toEqual(["pattern"]);
    expect(sink.get(detailKey("first-overview.strengths", null, ability!.statement))!.weakness!.what).toContain("지적");
  });

  it("신살 표지가 있을 때만 환경 해석을 내고 그 근거를 연결한다", () => {
    expect(keys(evaluate("strengths", context("strengths", assessment({}))))).not.toContain("environment");
    const drafts = evaluate("strengths", context("strengths", assessment({}), [families, pattern, shinsal("munchang")]));
    const environment = drafts.find((draft) => draft.key === "environment")!;
    expect(environment.supportingEvidenceIds).toEqual(["shinsal-munchang-natal"]);
    expect(environment.caveats.some((caveat) => caveat.includes("보조 표지"))).toBe(true);
  });

  it("보류: 시주를 몰라 안 보이는 계열은 없다고 단정하지 않는다", () => {
    const partial = assessment({
      coverage: "partial",
      familyPercent: { resource: 20, output: 43, authority: 13, wealth: 0, peer: 24 } as AssessmentFacet["familyPercent"],
      observedMissingFamilies: ["wealth"],
      missingFamilies: [],
    });
    expect(evaluate("strengths", context("strengths", partial)).find((draft) => draft.key === "action")!.status).toBe("deferred");
  });
});

describe("일과 직업 규칙", () => {
  it("규칙·역할 기운이 약하고 자기 기준·표현이 크면 재량형 환경으로 읽는다", () => {
    const sink: RuleDetailSink = new Map();
    const drafts = evaluate(
      "career",
      context("career", assessment({ familyPercent: { resource: 10, output: 35, authority: 8, wealth: 12, peer: 35 } as AssessmentFacet["familyPercent"] })),
      sink,
    );
    const fit = drafts.find((draft) => draft.key === "org-fit")!;
    expect(fit.statement).toContain("맡겨 주는 환경");
  });

  it("취업·창업 비교는 같은 기준으로 양쪽을 보고, 반대 방향의 기준을 반대 근거로 남긴다", () => {
    const sink: RuleDetailSink = new Map();
    // 자율성은 창업 쪽, 일간의 힘이 약해 안정성은 취업 쪽
    const drafts = evaluate(
      "career",
      context("career", assessment({ strength: "weak", familyPercent: { resource: 10, output: 35, authority: 8, wealth: 12, peer: 35 } as AssessmentFacet["familyPercent"] })),
      sink,
    );
    const compare = drafts.find((draft) => draft.key === "path-compare")!;
    const detail = sink.get(detailKey("first-overview.career", null, compare.statement))!;
    expect(detail.compare!.criteria.map((item) => item.name)).toEqual(expect.arrayContaining(["자율성과 업무 구조", "안정성과 변동성"]));
    expect(detail.compare!.needs.length).toBeGreaterThan(0);
    expect(compare.status).toBe("deferred");
    expect(compare.caveats.join()).toContain("현실 조건");
  });

  it("자기 주도성 하나만으로 창업을 확정하지 않는다", () => {
    const sink: RuleDetailSink = new Map();
    const drafts = evaluate(
      "career",
      context("career", assessment({ strength: "strong", familyPercent: { resource: 10, output: 30, authority: 8, wealth: 12, peer: 40 } as AssessmentFacet["familyPercent"] })),
      sink,
    );
    const compare = drafts.find((draft) => draft.key === "path-compare")!;
    expect(compare.statement).toContain("사주가 정해 주지는 않아요");
    expect(compare.statement).not.toMatch(/창업해야/);
  });
});

describe("돈 규칙", () => {
  it("비겁이 평균 수준이고 겁재가 하나뿐이면 금전 관계의 약점으로 단정하지 않는다", () => {
    const drafts = evaluate("wealth", context("wealth", assessment({})));
    expect(keys(drafts)).not.toContain("relations");
  });

  it("비겁이 크고 겁재가 있으면 동업·빌려주기 약점을 낸다", () => {
    const strong = assessment({ familyPercent: { resource: 10, output: 20, authority: 10, wealth: 15, peer: 45 } as AssessmentFacet["familyPercent"] });
    const relations = evaluate("wealth", context("wealth", strong)).find((draft) => draft.key === "relations")!;
    expect(relations.statement).toContain("동업");
  });

  it("편재와 정재 개수에 따라 수입 방식이 달라진다", () => {
    const base = assessment({ familyPercent: { resource: 20, output: 15, authority: 20, wealth: 25, peer: 20 } as AssessmentFacet["familyPercent"] });
    const opportunity = evaluate("wealth", context("wealth", base, undefined, natalFacts({ year: position("편재", "편재"), month: position("정관", "정인"), day: position("일간", "비견"), hour: null })));
    const steady = evaluate("wealth", context("wealth", base, undefined, natalFacts({ year: position("정재", "정재"), month: position("정관", "정인"), day: position("일간", "비견"), hour: null })));
    expect(opportunity.find((draft) => draft.key === "income")!.statement).not.toBe(steady.find((draft) => draft.key === "income")!.statement);
  });
});

describe("연애 규칙", () => {
  it("일지 십성에 따라 편안한 관계가 달라진다", () => {
    const resource = evaluate("romance", context("romance", assessment({})));
    const peer = evaluate("romance", context("romance", assessment({}), undefined, natalFacts({ day: position("일간", "비견"), month: position("식신", "식신"), year: null, hour: null })));
    expect(resource.find((draft) => draft.key === "comfort")!.statement).not.toBe(peer.find((draft) => draft.key === "comfort")!.statement);
  });

  it("일지에 걸린 합과 충이 모두 있으면 끌림과 마찰을 함께 설명하고 그 관계 근거를 연결한다", () => {
    const drafts = evaluate("romance", context("romance", assessment({}), [families, strength, relation("branch-clash", true), relation("branch-six-combination", true)]));
    const deepening = drafts.find((draft) => draft.key === "deepening")!;
    expect(deepening.statement).toContain("끌림과 마찰");
    expect(deepening.supportingEvidenceIds).toEqual(expect.arrayContaining(["relation-branch-clash-true-natal", "relation-branch-six-combination-true-natal"]));
  });

  it("일지와 무관한 관계 표지는 연애 깊이의 근거로 쓰지 않는다", () => {
    const drafts = evaluate("romance", context("romance", assessment({}), [families, strength, relation("branch-clash", false)]));
    expect(keys(drafts)).not.toContain("deepening");
  });
});

describe("인간관계 규칙", () => {
  it("협력, 경쟁, 경계, 갈등을 각각 다른 조건으로 고른다", () => {
    const strong = assessment({ strength: "strong", familyPercent: { resource: 10, output: 30, authority: 8, wealth: 12, peer: 40 } as AssessmentFacet["familyPercent"] });
    const drafts = evaluate("social", context("social", strong, [families, strength, shinsal("hwagae")]));
    expect(keys(drafts)).toEqual(["cooperation", "competition", "boundary", "conflict"]);
    expect(drafts.find((draft) => draft.key === "boundary")!.supportingEvidenceIds).toEqual(["shinsal-hwagae-natal"]);
  });
});

describe("기간 규칙", () => {
  const periodId = "monthly:2027-03";
  const otherPeriod = "monthly:2027-04";
  const periodEntry = (id: string, family: string) =>
    evidence({ id: `period-${id}`, ruleId: "inquiry.facets.period", kind: "period", periodId: id, tags: ["period-kind:monthly", `family:${family}`] });

  function timingContext(domain: string, family: string, entries: InquiryEvidence[], gender: string | null = "female"): InquiryRuleContext {
    return {
      ...context(domain, assessment({}), entries),
      question: { domain, kind: "timing", subject: "primary", periodIds: [periodId], contextPeriodIds: [], context: gender ? { gender } : {} },
      periodId,
      period: {
        periodId,
        kind: "monthly",
        pillar: { heavenlyStem: "계", earthlyBranch: "묘" },
        label: "2027년 3월 절입 기준 월운 계묘",
        stemTenGod: "정관",
        stemTenGodFamily: family,
        relationTypes: [],
        focus: false,
        range: { startsAt: "2027-03-05T21:00:00Z", endsAt: "2027-04-04T23:00:00Z", timezoneId: "Asia/Seoul", precision: "confirmed" },
      },
    } as unknown as InquiryRuleContext;
  }

  it("대상 기간의 근거만 직접 근거로 쓴다", () => {
    const sink: RuleDetailSink = new Map();
    const drafts = createTimingRule(sink).evaluate(
      timingContext("career", "authority", [periodEntry(periodId, "authority"), shinsal("yeokma", periodId), shinsal("yeokma", otherPeriod), relation("branch-clash", true, otherPeriod)]),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe("candidate");
    expect(drafts[0]!.supportingEvidenceIds).toEqual([`period-${periodId}`, `shinsal-yeokma-${periodId}`]);
    expect(drafts[0]!.counterEvidenceIds).toEqual([]);
    expect(drafts[0]!.caveats.join()).toContain("사건이 생긴다는 뜻이 아니다");
  });

  it("긍정 표지와 조심 표지가 함께 있으면 보류하고 조심 표지를 반대 근거로 둔다", () => {
    const drafts = createTimingRule().evaluate(timingContext("career", "authority", [periodEntry(periodId, "authority"), relation("branch-clash", true, periodId)]));
    expect(drafts[0]!.status).toBe("deferred");
    expect(drafts[0]!.counterEvidenceIds).toEqual([`relation-branch-clash-true-${periodId}`]);
  });

  it("표지가 없으면 결론을 지어내지 않는다", () => {
    expect(createTimingRule().evaluate(timingContext("career", "authority", []))).toEqual([]);
  });

  it("연애의 인연 표지는 전통 관법의 성별 기준을 따르고, 성별이 없으면 인연 표지로 보지 않는다", () => {
    const sink: RuleDetailSink = new Map();
    const female = createTimingRule(sink).evaluate(timingContext("romance", "authority", [periodEntry(periodId, "authority")], "female"));
    const unknown = createTimingRule().evaluate(timingContext("romance", "authority", [periodEntry(periodId, "authority")], null));
    expect(female[0]!.status).toBe("candidate");
    expect(unknown[0]!.status).toBe("observation");
  });

  it("선택 기준은 긍정 표지 수에서 조심 표지 수를 뺀 값이다", () => {
    expect(
      selectionScore([
        { code: "a", tone: "positive", text: "", activity: "", evidenceId: "1" },
        { code: "b", tone: "positive", text: "", activity: "", evidenceId: "2" },
        { code: "c", tone: "caution", text: "", activity: "", evidenceId: "3" },
        { code: "d", tone: "neutral", text: "", activity: "", evidenceId: "4" },
      ]),
    ).toBe(1);
  });
});

describe("문장 조사", () => {
  it("받침에 맞춰 조사를 고른다", () => {
    expect(withJosa("관성의 기운", "이/가")).toBe("관성의 기운이");
    expect(withJosa("역마 표지", "이/가")).toBe("역마 표지가");
    expect(withJosa("이성 인연과 연결해 읽는 기운(관성)", "과/와")).toBe("이성 인연과 연결해 읽는 기운(관성)과");
  });
});

describe("규칙 메타데이터", () => {
  it("AI 초안을 사람이 검토한 규칙으로 표시하지 않는다", () => {
    for (const rule of createFirstOverviewRules()) {
      expect(rule.metadata.reviewStatus).toBe("unreviewed");
      expect(rule.metadata.sourceRefs.length).toBeGreaterThan(0);
      expect(rule.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("실제 엔진 결과로 실행", () => {
  const TOPICS = ["temperament", "strengths", "career", "wealth", "romance", "social"] as const;
  const set = defineFeatureSet([
    { id: "natal", version: "1.0.0", modules: ["M01", "M02", "M03", "M04"], topics: [...TOPICS], targetKind: "none", selection: { version: "1.0.0", rules: [{ module: "M01" }, { module: "M02" }, { module: "M03" }, { module: "M04" }] } },
    { id: "ym", version: "1.0.0", modules: ["M01", "M02", "M04", "M06", "M07"], targetKind: "year-months", selection: { version: "1.0.0", rules: [{ module: "M04" }, { module: "M06" }, { module: "M07" }] } },
  ]);

  function run(birthDate: string, branch: string | null) {
    const birth = PublicBirthInputSchema.parse({
      birthDate,
      birthTime: branch ? { status: "branch", branch } : { status: "unknown" },
      gender: "female",
      calendar: { type: "solar" },
      birthPlace: { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울", source: "geonames:1835848" },
    });
    const input = toAnalysisInput(birth);
    const session = createFeatureSession(createDefaultDependencies());
    try {
      const natal = session.execute(set, { ...input, featureId: "natal" });
      const ym = session.execute(set, { ...input, featureId: "ym", target: { kind: "year-months", year: 2027, timezoneId: "Asia/Seoul" } });
      return createInquiryReader([natal, ym], { rules: createFirstOverviewRules() });
    } finally {
      session.dispose();
    }
  }

  it("여섯 주제 모두 앱 규칙 결론이 나오고, 다른 사주에서는 근거에 따라 다른 판단이 나온다", () => {
    const first = run("1998-09-19", "신");
    const second = run("1994-05-12", "오");
    for (const domain of TOPICS) {
      const a = first.answer({ domain, kind: "natal" }).conclusions.filter((item) => item.rule.ruleId.startsWith("first-overview."));
      const b = second.answer({ domain, kind: "natal" }).conclusions.filter((item) => item.rule.ruleId.startsWith("first-overview."));
      expect(a.length).toBeGreaterThanOrEqual(2);
      expect(a.map((item) => item.statement)).not.toEqual(b.map((item) => item.statement));
    }
  });

  it("주제마다 다른 판단을 쓴다", () => {
    const reader = run("1998-09-19", "신");
    const statements = TOPICS.flatMap((domain) => reader.answer({ domain, kind: "natal" }).conclusions.filter((item) => item.rule.ruleId.startsWith("first-overview.")).map((item) => item.statement));
    expect(new Set(statements).size).toBe(statements.length);
  });

  it("월운 결론은 그 달의 근거만 직접 근거로 쓴다", () => {
    const reader = run("1998-09-19", "신");
    const months = reader.periods.filter((period) => period.kind === "monthly").map((period) => period.id);
    const annual = reader.periods.filter((period) => period.kind === "annual").map((period) => period.id);
    for (const domain of ["career", "wealth", "romance", "social"]) {
      const answer = reader.answer({ domain, kind: "timing", periodIds: months, contextPeriodIds: annual, context: { gender: "female" } });
      const conclusions = answer.conclusions.filter((item) => item.rule.ruleId === "first-overview.timing");
      expect(conclusions.length).toBeGreaterThan(0);
      for (const conclusion of conclusions) {
        expect(conclusion.supportingEvidence.some((entry) => entry.periodId === conclusion.periodId)).toBe(true);
        for (const entry of [...conclusion.supportingEvidence, ...conclusion.counterEvidence]) {
          expect([null, conclusion.periodId]).toContain(entry.periodId);
          expect(entry.kind).not.toBe("rating");
        }
        for (const entry of conclusion.contextualEvidence) expect(annual).toContain(entry.periodId);
      }
    }
  });

  it("시주를 모르면 한계를 남기고 결론을 지어내지 않는다", () => {
    const reader = run("2001-11-03", null);
    const temperament = reader.answer({ domain: "temperament", kind: "natal" });
    expect(temperament.limitations).toContain("MISSING_PILLARS");
    const app = temperament.conclusions.filter((item) => item.rule.ruleId.startsWith("first-overview."));
    expect(app.every((item) => item.caveats.some((caveat) => caveat.includes("시주")))).toBe(true);
  });
});
