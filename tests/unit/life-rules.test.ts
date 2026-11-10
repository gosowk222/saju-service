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
import { FAMILY_CAVEAT, HEALTH_CAVEAT, INVEST_CAVEAT, JOB_CAVEAT, TRADITION_CAVEAT, type RuleDetailSink } from "@/domain/rules/common";
import { createFirstOverviewRules } from "@/domain/rules/first-overview";
import { createLifeRules } from "@/domain/rules/life";
import { ELEMENT_DRAIN, ELEMENT_INDUSTRY, ELEMENT_LUCK, ENERGY_TEXT, FAMILY_CHILDREN, FAMILY_EARLY, FAMILY_JOBS, FAMILY_PARENTS, FRIENDS_FORTUNE, INVESTMENT_STYLE, MOVE_TEXT } from "@/domain/rules/life-tables";
import { relationPositions } from "@/domain/rules/materials";

/** 가족, 친구와 인복, 잘 맞는 곳과 행운, 에너지 관리, 투자 성향 규칙 (규칙 3.0.0). */

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
const elements = evidence({ id: "elements", ruleId: "m01.assessment.elements" });
const usefulGods = evidence({ id: "useful", ruleId: "m01.assessment.useful-gods" });
const shinsal = (id: string) => evidence({ id: `shinsal-${id}`, ruleId: "inquiry.facets.shinsal", kind: "shinsal", tags: [`shinsal:${id}`, "position:month"] });
/** 엔진 근거 ID 형식 그대로: primary:relation:natal:<종류>:natal:<기둥>:<글자>|natal:<기둥>:<글자> */
const natalRelation = (type: string, pair: string, tags: string[] = []) =>
  evidence({ id: `primary:relation:natal:${type}:${pair}`, ruleId: `m02.${type}.always.1`, kind: "relation", tags: [`relation:${type}`, ...tags] });

function assessment(overrides: Partial<AssessmentFacet>): AssessmentFacet {
  return {
    coverage: "complete",
    missingPositions: [],
    strength: "balanced",
    pattern: "eating-god",
    usefulElement: "수",
    helpfulElement: "금",
    adverseElements: ["토"],
    usefulGodBasis: { adopted: "fuyi", rule: 2, season: "spring" },
    dominantElement: "토",
    missingElements: [],
    observedMissingElements: [],
    dominantFamily: "output",
    missingFamilies: [],
    observedMissingFamilies: [],
    familyPercent: { resource: 14, output: 41, authority: 10, wealth: 15, peer: 20 },
    elementPercent: { 목: 9, 화: 13, 토: 30, 금: 28, 수: 20 },
    ...overrides,
  } as AssessmentFacet;
}

const position = (stemTenGod: string, branchTenGod: string) => ({ stem: { tenGod: stemTenGod }, branch: { tenGod: branchTenGod } });
const WITH_HOUR = { positions: { year: position("겁재", "정관"), month: position("식신", "식신"), day: position("일간", "정인"), hour: position("정재", "상관") } };
const WITHOUT_HOUR = { positions: { year: position("겁재", "정관"), month: position("식신", "식신"), day: position("일간", "정인"), hour: null } };

function context(
  domain: string,
  assess: AssessmentFacet | null,
  entries: InquiryEvidence[],
  options: { readonly gender?: "male" | "female"; readonly facts?: unknown } = {},
): InquiryRuleContext {
  return {
    question: { domain, kind: "natal", subject: "primary", periodIds: [], contextPeriodIds: [], context: options.gender ? { gender: options.gender } : {} },
    periodId: null,
    evidence: entries,
    contextEvidence: [],
    limitations: [],
    natalFacts: options.facts ?? WITH_HOUR,
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

function rule(name: string, sink?: RuleDetailSink) {
  return createLifeRules(sink).find((item) => item.metadata.ruleId === `first-overview.${name}`)!;
}

const keys = (drafts: readonly { key: string }[]) => drafts.map((draft) => draft.key);
const byKey = (drafts: readonly { key: string; statement: string; status: string; supportingEvidenceIds: readonly string[]; caveats: readonly string[] }[], key: string) =>
  drafts.find((draft) => draft.key === key)!;

describe("근거 ID에서 기둥 읽기", () => {
  it("관계 근거 ID의 기둥만 읽고, 형식이 다르면 빈 배열이다", () => {
    expect(relationPositions(natalRelation("branch-clash", "natal:month:인|natal:year:신"))).toEqual(["month", "year"]);
    expect(relationPositions(evidence({ id: "relation-without-positions", ruleId: "m02.branch-clash", kind: "relation" }))).toEqual([]);
  });
});

describe("가족 규칙", () => {
  const nurturing = assessment({ familyPercent: { resource: 30, output: 30, authority: 10, wealth: 10, peer: 20 } as AssessmentFacet["familyPercent"] });

  it("인성이 크면 보살핀 어른의 영향으로 읽고, 자녀는 성별에 맞는 계열로 본다", () => {
    const female = rule("family").evaluate(context("family", nurturing, [families], { gender: "female" }));
    const male = rule("family").evaluate(context("family", nurturing, [families], { gender: "male" }));
    expect(keys(female)).toEqual(["parents", "siblings", "children"]);
    expect(byKey(female, "parents").statement).toBe(FAMILY_PARENTS.nurtured.claim);
    // 여성은 식상(30%)으로, 남성은 관성(10%)으로 자녀를 본다.
    expect(byKey(female, "children").statement).toBe(FAMILY_CHILDREN.devoted.claim);
    expect(byKey(male, "children").statement).toBe(FAMILY_CHILDREN.light.claim);
    expect(female.every((draft) => draft.caveats.includes(FAMILY_CAVEAT))).toBe(true);
  });

  it("성별을 모르면 자녀를 판단하지 않고, 시간을 모르면 자녀 결론을 보류한다", () => {
    expect(keys(rule("family").evaluate(context("family", nurturing, [families])))).not.toContain("children");
    const unknownHour = rule("family").evaluate(context("family", nurturing, [families], { gender: "female", facts: WITHOUT_HOUR }));
    expect(byKey(unknownHour, "children").status).toBe("deferred");
  });

  it("연주와 월주 사이의 부딪힘만 성장기 근거로 쓰고, 일지와 연주의 충은 쓰지 않는다", () => {
    const yearMonth = natalRelation("branch-clash", "natal:month:인|natal:year:신");
    const dayYear = natalRelation("branch-clash", "natal:day:사|natal:year:해", ["day-branch"]);
    const drafts = rule("family").evaluate(context("family", nurturing, [families, yearMonth, dayYear], { gender: "female" }));
    expect(byKey(drafts, "early").statement).toBe(FAMILY_EARLY.turbulent.claim);
    expect(byKey(drafts, "early").supportingEvidenceIds).toEqual([yearMonth.id]);

    const only = rule("family").evaluate(context("family", nurturing, [families, dayYear], { gender: "female" }));
    expect(keys(only)).not.toContain("early");
  });

  it("연주와 월주가 합이면 끈끈한 집안으로 읽는다", () => {
    const combination = natalRelation("branch-six-combination", "natal:month:자|natal:year:축", ["combination"]);
    const drafts = rule("family").evaluate(context("family", nurturing, [families, combination], { gender: "female" }));
    expect(byKey(drafts, "early").statement).toBe(FAMILY_EARLY["close-knit"].claim);
  });
});

describe("친구와 인복 규칙", () => {
  it("귀인 신살이 있으면 인복을, 용신·기신으로 곁에 둘 사람과 멀리할 사람을 낸다", () => {
    const drafts = rule("friends").evaluate(context("friends", assessment({ adverseElements: ["목"] } as Partial<AssessmentFacet>), [families, usefulGods, shinsal("cheonul-gwiin")]));
    expect(keys(drafts)).toEqual(["fortune", "image", "match", "drain"]);
    expect(byKey(drafts, "fortune").statement).toBe(FRIENDS_FORTUNE.helped.claim);
    expect(byKey(drafts, "fortune").supportingEvidenceIds).toEqual(["shinsal-cheonul-gwiin"]);
    expect(byKey(drafts, "drain").statement).toContain(ELEMENT_DRAIN.목);
    expect(byKey(drafts, "match").supportingEvidenceIds).toEqual(["useful"]);
  });

  it("귀인 표지가 없으면 비겁 비중으로 인복을 읽고, 용신 판단이 없으면 친구 유형을 만들지 않는다", () => {
    const drafts = rule("friends").evaluate(context("friends", assessment({ familyPercent: { resource: 20, output: 30, authority: 20, wealth: 20, peer: 10 } as AssessmentFacet["familyPercent"] }), [families]));
    expect(byKey(drafts, "fortune").statement).toBe(FRIENDS_FORTUNE.few.claim);
    expect(keys(drafts)).toEqual(["fortune", "image"]);
  });
});

describe("잘 맞는 곳과 행운 규칙", () => {
  it("행운의 방향·색·숫자는 용신 오행의 전통 대응표에서만 고른다", () => {
    const water = rule("place").evaluate(context("place", assessment({ usefulElement: "수" }), [usefulGods]));
    const fire = rule("place").evaluate(context("place", assessment({ usefulElement: "화", helpfulElement: "목" }), [usefulGods]));
    expect(keys(water)).toEqual(["region", "move", "lucky", "habit"]);
    expect(byKey(water, "lucky").statement).toBe(`행운의 방향은 ${ELEMENT_LUCK.수.direction}, 행운의 색은 ${ELEMENT_LUCK.수.colors}, 행운의 숫자는 ${ELEMENT_LUCK.수.numbers}.`);
    expect(byKey(water, "lucky").statement).toContain("북쪽");
    expect(byKey(fire, "lucky").statement).toContain("남쪽");
    expect(byKey(water, "lucky").caveats).toContain(TRADITION_CAVEAT);
  });

  it("역마가 있으면 이동의 인연을 근거와 함께 내고, 없으면 뿌리 내리는 구조를 보류로 낸다", () => {
    const mobile = rule("place").evaluate(context("place", assessment({}), [usefulGods, shinsal("yeokma")]));
    expect(byKey(mobile, "move").statement).toBe(MOVE_TEXT.mobile.claim);
    expect(byKey(mobile, "move").supportingEvidenceIds).toEqual(["shinsal-yeokma"]);
    const rooted = rule("place").evaluate(context("place", assessment({}), [usefulGods]));
    expect(byKey(rooted, "move")).toMatchObject({ statement: MOVE_TEXT.rooted.claim, status: "deferred" });
  });

  it("용신 판단이 없으면 지역과 행운을 지어내지 않는다", () => {
    expect(rule("place").evaluate(context("place", assessment({}), [families]))).toEqual([]);
    expect(rule("place").evaluate(context("place", assessment({ usefulElement: null } as unknown as Partial<AssessmentFacet>), [usefulGods]))).toEqual([]);
  });
});

describe("에너지 관리와 투자 성향 규칙", () => {
  it("일간이 약하면 아껴 쓰는 리듬, 한 오행이 35% 이상이면 그 오행의 리듬으로 읽고 진단하지 않는다는 한계를 붙인다", () => {
    const weak = rule("energy").evaluate(context("temperament", assessment({ strength: "weak" }), [strength, elements]));
    expect(weak[0]!.statement).toBe(ENERGY_TEXT.conserve.claim);
    const metal = rule("energy").evaluate(context("temperament", assessment({ strength: "strong", dominantElement: "금", elementPercent: { 목: 9, 화: 13, 토: 20, 금: 38, 수: 20 } } as Partial<AssessmentFacet>), [strength, elements]));
    expect(metal[0]!.statement).toBe(ENERGY_TEXT.금.claim);
    expect(metal[0]!.caveats).toContain(HEALTH_CAVEAT);
  });

  it("비겁이 크고 겁재가 있으면 따라 하는 투자의 약점을, 종목을 판단하지 않는다는 한계와 함께 낸다", () => {
    const facts = { positions: { year: position("겁재", "정관"), month: position("비견", "겁재"), day: position("일간", "정인"), hour: position("정재", "상관") } };
    const drafts = rule("investment").evaluate(
      context("wealth", assessment({ familyPercent: { resource: 14, output: 20, authority: 10, wealth: 16, peer: 40 } as AssessmentFacet["familyPercent"] }), [families], { facts }),
    );
    expect(drafts[0]!.statement).toBe(INVESTMENT_STYLE.follow.claim);
    expect(drafts[0]!.caveats).toContain(INVEST_CAVEAT);
  });
});

describe("실제 엔진 결과로 실행 (생활 주제)", () => {
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
  const DOMAINS = ["temperament", "strengths", "career", "wealth", "romance", "social", "friends", "family", "place"] as const;

  function run(birthDate: string, branch: string | null, gender: "male" | "female") {
    const birth = PublicBirthInputSchema.parse({
      birthDate,
      birthTime: branch ? { status: "branch", branch } : { status: "unknown" },
      gender,
      calendar: { type: "solar" },
      birthPlace: { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울", source: "geonames:1835848" },
    });
    const session = createFeatureSession(createDefaultDependencies());
    try {
      const natal = session.execute(set, { ...toAnalysisInput(birth), featureId: "natal" });
      const reader = createInquiryReader([natal], { rules: createFirstOverviewRules() });
      return (domain: string) =>
        reader.answer({ domain, kind: "natal", context: { gender } }).conclusions.filter((item) => item.rule.ruleId.startsWith("first-overview."));
    } finally {
      session.dispose();
    }
  }

  it("새 주제 세 개도 근거가 있는 결론을 내고, 사주가 다르면 판단이 달라진다", () => {
    const first = run("1998-09-19", "신", "female");
    const second = run("1973-12-25", "사", "male");
    for (const domain of ["friends", "family", "place"]) {
      const a = first(domain);
      expect(a.length).toBeGreaterThanOrEqual(2);
      for (const conclusion of a) expect(conclusion.supportingEvidence.length).toBeGreaterThan(0);
      expect(a.map((item) => item.statement)).not.toEqual(second(domain).map((item) => item.statement));
    }
  });

  it("아홉 주제 전체에서 같은 문장을 두 번 쓰지 않는다", () => {
    const answer = run("1995-02-07", "미", "female");
    const statements = DOMAINS.flatMap((domain) => answer(domain).map((item) => item.statement));
    expect(new Set(statements).size).toBe(statements.length);
  });

  it("시간을 모르면 생활 주제도 한계를 남기고 자녀 결론은 보류한다", () => {
    const answer = run("2001-11-03", null, "male");
    const children = answer("family").find((item) => item.id.includes(":children"));
    expect(children?.status).toBe("deferred");
  });
});

describe("어울리는 직업과 업종 규칙 (3.1.0)", () => {
  it("가장 큰 계열로 직업군을, 용신 오행으로 업종을 고르고 예시라는 한계를 붙인다", () => {
    const drafts = rule("jobs").evaluate(context("career", assessment({ usefulElement: "토" }), [families, usefulGods]));
    expect(keys(drafts)).toEqual(["family", "industry"]);
    expect(byKey(drafts, "family").statement).toBe(FAMILY_JOBS.output.claim);
    expect(byKey(drafts, "industry").statement).toContain(ELEMENT_INDUSTRY.토);
    expect(byKey(drafts, "industry").supportingEvidenceIds).toEqual([usefulGods.id]);
    expect(drafts.every((draft) => draft.caveats.includes(JOB_CAVEAT))).toBe(true);
  });

  it("용신 판단이 없으면 업종을 만들지 않고, 시간을 몰라 1·2위 계열이 가까우면 직업군을 보류한다", () => {
    const percent = { resource: 14, output: 30, authority: 10, wealth: 18, peer: 28 } as AssessmentFacet["familyPercent"];
    const close = assessment({ familyPercent: percent, coverage: "partial", missingPositions: ["hour"] } as Partial<AssessmentFacet>);
    const drafts = rule("jobs").evaluate(context("career", close, [families], { facts: WITHOUT_HOUR }));
    expect(keys(drafts)).toEqual(["family"]);
    expect(byKey(drafts, "family").status).toBe("deferred");
    const known = rule("jobs").evaluate(context("career", assessment({ familyPercent: percent }), [families]));
    expect(byKey(known, "family").status).toBe("candidate");
  });
});
