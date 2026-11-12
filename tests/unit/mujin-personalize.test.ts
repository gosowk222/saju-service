import { describe, expect, it } from "vitest";
import { EMPTY_NOW, type MujinNow } from "@/domain/mujin/now";
import {
  chaptersForQuestion,
  personalizeSections,
  weightedTarget,
  type MujinConcernFact,
  type MujinQuestionInput,
} from "@/domain/mujin/personalize";
import { buildClosingSection, buildTimingSections } from "@/domain/mujin/timing-plan";
import type { MonthDomain, MujinMaterial, MujinPlan, MujinSectionPlan, MujinTimingBundle, QuestionStatus } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import type { TimingAnalysis } from "@/domain/reading/types";
import { TIMING_CAVEAT } from "@/domain/rules/timing";

// 모두 가상 입력이다. 엔진·LLM을 부르지 않고 작성 계획의 개인화만 확인한다.
const product = MUJIN_OVERVIEW;
const specOf = (id: string) => product.scroll.sections.find((section) => section.id === id)!;
const weakness = { what: "약점", when: "조건", cost: "비용", change: "조정" };

// ─── 원국 장 (가짜) ───────────────────────────────────────────────────────

let nextFixtureRef = 0;
function natalChapter(sectionId: string, statuses: Readonly<Record<string, QuestionStatus>> = {}): MujinSectionPlan {
  const spec = specOf(sectionId);
  const materials: MujinMaterial[] = spec.questions.map((question) => ({
    ref: `m${++nextFixtureRef}`,
    kind: "judgment",
    questionIds: [question.id],
    text: `${question.id} 원국 판단`,
    scope: "natal",
    status: "candidate",
    ruleId: "first-overview.test",
    ruleVersion: "3.1.0",
    conclusionId: `first-overview.test:natal:${question.id}`,
    upside: `${question.id} 강점`,
    weakness,
  }));
  return {
    sectionId,
    tier: spec.tier,
    title: spec.title,
    questions: spec.questions.map((question, index) => ({
      id: question.id,
      title: question.title,
      status: statuses[question.id] ?? "adopted",
      refs: statuses[question.id] === "general" ? [] : [materials[index]!.ref],
      note: statuses[question.id] ? "작성 조건" : null,
    })),
    materials: materials.filter((_, index) => statuses[spec.questions[index]!.id] !== "general"),
    weight: "standard",
    targetChars: spec.targetChars,
    situationNotes: [`${sectionId} 상황 관점`],
  };
}

const NATAL: readonly MujinSectionPlan[] = [
  natalChapter("basics-structure"),
  natalChapter("ch1"),
  natalChapter("ch2"),
  natalChapter("ch3"),
  natalChapter("ch4"),
  natalChapter("ch5"),
  natalChapter("ch6"),
  natalChapter("ch7", { "7-4": "general" }),
  natalChapter("ch8"),
];

// ─── 9·10장 (가짜 기간 재료로 만든 실제 계획) ─────────────────────────────

const MONTH_IDS = Array.from({ length: 12 }, (_, index) => `monthly:${2026 + Math.floor((10 + index) / 12)}-${String(((10 + index) % 12) + 1).padStart(2, "0")}`);
const POSITIVE = { tone: "positive", text: "관성 기운", activity: "지원서 제출" };
const CAUTION = { tone: "caution", text: "비겁 기운", activity: "충동 지출 조심" };

function statement(domain: MonthDomain, periodId: string, marker: typeof POSITIVE) {
  return {
    kind: "timing" as const,
    periodId,
    periodKind: "monthly",
    label: periodId,
    engineLabel: periodId,
    startsOn: null,
    endsOn: null,
    verdict: marker.tone === "positive" ? ("notable" as const) : ("careful" as const),
    statement: `${domain} ${periodId} 결론 문장`,
    markers: [marker],
    stageNote: null,
    selectionScore: marker.tone === "positive" ? 1 : -1,
    conclusionId: `first-overview.timing:${periodId}:${domain}`,
    ruleId: "first-overview.timing",
    ruleVersion: "3.1.0",
    supportingEvidenceIds: [`primary:period:${periodId}`],
    counterEvidenceIds: [],
    contextualEvidenceIds: ["primary:period:annual:2026"],
    caveats: [TIMING_CAVEAT],
  };
}

/** 직업은 2027년 1월 주목, 재물은 2027년 4월 주의. 연애·인간관계는 표지 없음. 현재 대운은 재성 계열. */
function bundle(): MujinTimingBundle {
  const marks: Partial<Record<MonthDomain, Readonly<Record<number, typeof POSITIVE>>>> = { career: { 2: POSITIVE }, wealth: { 5: CAUTION } };
  const domains: readonly MonthDomain[] = ["career", "wealth", "romance", "social"];
  const analyses: TimingAnalysis[] = domains.map((domain) => ({
    version: "timing-analysis-1.0.0",
    domain,
    window: { kind: "default", startMonth: "2026-11", endMonth: "2027-10", label: "2026년 11월부터 2027년 10월까지 (절기 기준 월)" },
    status: "available",
    months: Object.entries(marks[domain] ?? {}).map(([index, marker]) => statement(domain, MONTH_IDS[Number(index)]!, marker)),
    years: [],
    decade: null,
    notable: domain === "career" ? [MONTH_IDS[2]!] : [],
    careful: domain === "wealth" ? [MONTH_IDS[5]!] : [],
    limitations: [TIMING_CAVEAT],
    referenceDate: "2026-11-12",
  }));
  const decade = (age: number, ganzhi: string, tenGod: string, family: "resource" | "wealth" | "authority", year: number) => ({
    periodId: `decade:${age}`,
    label: `${age}세부터 대운 ${ganzhi}`,
    startsAt: `${year}-03-05T10:00:00.000Z`,
    endsAt: `${year + 10}-03-05T10:00:00.000Z`,
    approximate: true,
    ganzhi,
    stemTenGod: tenGod,
    stemFamily: family,
  });
  return {
    version: "mujin-timing-1.0.0",
    referenceDate: "2026-11-12",
    luck: {
      status: "available",
      reason: null,
      referenceAt: "2026-11-12T12:00:00+09:00",
      previous: decade(13, "계해", "정인", "resource", 2011),
      current: decade(23, "갑자", "편재", "wealth", 2021),
      next: decade(33, "을축", "정관", "authority", 2031),
    },
    months: {
      status: "available",
      window: { startMonth: "2026-11", endMonth: "2027-10", label: "2026년 11월부터 2027년 10월까지 (절기 기준 월)" },
      months: MONTH_IDS.map((periodId, index) => ({
        periodId,
        label: `${periodId.slice(8, 12)}년 ${Number(periodId.slice(13))}월`,
        startsOn: null,
        endsOn: null,
        startedBeforeReference: index === 0,
        cells: domains.map((domain) => {
          const marker = marks[domain]?.[index];
          return { domain, tone: marker ? (marker.tone === "positive" ? "positive" : "caution") : "neutral", markers: marker ? [marker] : [] };
        }),
      })),
      notable: domains.map((domain) => ({ domain, periodIds: domain === "career" ? [MONTH_IDS[2]!] : [] })),
      careful: domains.map((domain) => ({ domain, periodIds: domain === "wealth" ? [MONTH_IDS[5]!] : [] })),
      limitations: [],
    },
    analyses,
  };
}

const plan: MujinPlan = {
  planVersion: "mujin-plan-1.0.0",
  productId: product.id,
  productVersion: product.version,
  personaId: "mujin",
  personaVersion: "1.0.0",
  rulesets: [],
  tagCatalogVersion: "test",
  nickname: "가람",
  gender: "female",
  hourKnown: true,
  coverageNotes: [],
  now: EMPTY_NOW,
  nowFacts: [],
  facts: [],
  tables: { elements: { counts: { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 }, percents: null }, stages: [], tenGods: { cells: [], families: null } },
  sections: NATAL,
};
const timing = buildTimingSections({ plan, bundle: bundle(), product, startRef: 100 });
const BASE: readonly MujinSectionPlan[] = [...NATAL, ...timing.sections];
const START = timing.nextRef;

// ─── 도우미 ─────────────────────────────────────────────────────────────

const ask = (ref: string, domain: MujinQuestionInput["domain"], intent: MujinQuestionInput["intent"], extra: Partial<MujinQuestionInput> = {}): MujinQuestionInput => ({
  ref,
  summary: `${ref} ${domain} ${intent} 질문`,
  domain,
  topicDomain: null,
  intent,
  answerability: "full",
  missingInfo: [],
  timingSupported: false,
  ...extra,
});
const fact = (text: string, domain: string, kind: MujinConcernFact["kind"]): MujinConcernFact => ({ text, domain, kind });

function personalize(input: { readonly now?: MujinNow; readonly questions?: MujinQuestionInput[]; readonly concernFacts?: MujinConcernFact[]; readonly sections?: readonly MujinSectionPlan[] } = {}) {
  return personalizeSections({
    sections: input.sections ?? BASE,
    product,
    now: input.now ?? EMPTY_NOW,
    questions: input.questions ?? [],
    concernFacts: input.concernFacts ?? [],
    startRef: START,
  });
}

const sectionOf = (sections: readonly MujinSectionPlan[], id: string) => sections.find((section) => section.sectionId === id)!;
const questionRefs = (sections: readonly MujinSectionPlan[], sectionId: string, questionId: string) =>
  sectionOf(sections, sectionId).questions.find((question) => question.id === questionId)!.refs;
const added = (sections: readonly MujinSectionPlan[]) => {
  const known = new Set(BASE.flatMap((section) => section.materials.map((material) => material.ref)));
  return sections.flatMap((section) => section.materials.filter((material) => !known.has(material.ref)).map((material) => ({ sectionId: section.sectionId, material })));
};

// ─── 테스트 ─────────────────────────────────────────────────────────────

describe("질문이 이어지는 장", () => {
  const route = (domain: MujinQuestionInput["domain"], intent: MujinQuestionInput["intent"] = "explain", topicDomain: MujinQuestionInput["topicDomain"] = null) =>
    chaptersForQuestion({ domain, intent, topicDomain });

  it("분야마다 정해진 장으로 잇고, 시기 질문은 기간 규칙 4분야면 10장, 그 밖이면 9장을 더한다", () => {
    expect(route("temperament")).toEqual(["ch1"]);
    expect(route("strengths")).toEqual(["ch2"]);
    expect(route("study", "outcome", "strengths")).toEqual(["ch2"]);
    expect(route("career", "compare")).toEqual(["ch3"]);
    expect(route("career", "timing")).toEqual(["ch3", "ch10"]);
    expect(route("wealth", "apply")).toEqual(["ch4"]);
    expect(route("investment", "timing", "wealth")).toEqual(["ch4", "ch10"]);
    expect(route("romance", "timing")).toEqual(["ch5", "ch10"]);
    expect(route("social", "timing")).toEqual(["ch6", "ch10"]);
    expect(route("friends", "timing")).toEqual(["ch6", "ch10"]);
    expect(route("family", "apply")).toEqual(["ch7"]);
    expect(route("family", "timing")).toEqual(["ch7", "ch9"]);
    expect(route("health", "apply", "temperament")).toEqual(["ch8"]);
    expect(route("health", "timing", "temperament")).toEqual(["ch8", "ch9"]);
    expect(route("temperament", "timing")).toEqual(["ch1", "ch9"]);
    // '몇 년 뒤', '인생 흐름', '전환점'처럼 분야 없는 시기 질문은 9장(큰 흐름)과 10장(12개월)을 함께 잇는다.
    expect(route("general", "timing")).toEqual(["ch9", "ch10"]);
    // 넓은 질문은 장 없이 마지막 정리에서만 답한다.
    expect(route("general", "general")).toEqual([]);
    expect(route("non-saju", "general")).toEqual([]);
  });

  it("같은 입력이면 언제나 같은 장을 돌려준다", () => {
    const question = { domain: "career", intent: "timing", topicDomain: "career" } as const;
    expect(chaptersForQuestion(question)).toEqual(chaptersForQuestion({ ...question }));
    expect(chaptersForQuestion(question)).toEqual(["ch3", "ch10"]);
  });
});

describe("질문·관심·상황 개인화", () => {
  it("같은 원국 재료에 질문·관심·상황만 다르면 판단 상태와 재료 문장은 그대로이고 비중·편집 목표·질문 재료만 바뀐다", () => {
    const plain = personalize();
    const rich = personalize({
      now: { work: ["employed"], interests: ["ch2", "ch9"], relationship: "dating", family: ["care"] },
      questions: [ask("q1", "career", "compare"), ask("q2", "wealth", "timing", { timingSupported: true, topicDomain: "wealth" })],
      concernFacts: [fact("지금 회사에 다니고 있다", "career", "current")],
    });
    for (const result of [plain, rich]) {
      result.sections.forEach((section, index) => {
        const base = BASE[index]!;
        expect(section.sectionId).toBe(base.sectionId);
        expect(section.questions.map(({ id, title, status, note }) => ({ id, title, status, note }))).toEqual(
          base.questions.map(({ id, title, status, note }) => ({ id, title, status, note })),
        );
        // 기존 재료는 문장·상태·근거가 그대로 앞에 남고, 기존 refs는 하나도 빠지지 않는다.
        // (질문과 같은 분야의 10-4 활동 재료만 앞으로 옮긴다. 순서만 바뀐다.)
        expect(section.materials.slice(0, base.materials.length)).toEqual(base.materials);
        section.questions.forEach((question, at) => {
          const before = base.questions[at]!.refs;
          expect(question.refs).toEqual(expect.arrayContaining([...before]));
          if (question.id !== "10-4") expect(question.refs.filter((ref) => before.includes(ref))).toEqual(before);
        });
        expect(section.situationNotes).toEqual(base.situationNotes);
      });
    }
    expect(plain.sections).toEqual(BASE);
    expect(plain.questionMaterials).toEqual([]);
    expect(plain.nextRef).toBe(START);

    const weights = Object.fromEntries(rich.sections.map((section) => [section.sectionId, section.weight]));
    expect(weights).toEqual({
      "basics-structure": "standard",
      ch1: "standard",
      ch2: "interest",
      ch3: "question",
      ch4: "question",
      ch5: "standard",
      ch6: "standard",
      ch7: "standard",
      ch8: "standard",
      ch9: "interest",
      ch10: "question",
    });
    const target = (id: string) => sectionOf(rich.sections, id).targetChars;
    expect(target("ch3")).toEqual({ min: 1150, max: 1560 });
    expect(target("ch2")).toEqual({ min: 713, max: 990 });
    expect(target("ch1")).toEqual(specOf("ch1").targetChars);
    expect(rich.questionMaterials.map((question) => question.ref)).toEqual(["q1", "q2"]);
    // 새로 생긴 재료는 사용자 사실과 10-4의 설명 연결뿐이며 판단·기간 재료를 새로 만들지 않는다.
    expect(new Set(added(rich.sections).map(({ material }) => material.kind))).toEqual(new Set(["user-fact", "derived"]));
  });

  it("계획·가정·다른 사람에 대한 관찰을 현재 사실로 올리지 않는다", () => {
    const { sections } = personalize({
      concernFacts: [
        fact("내년에 창업할 생각이다", "career", "plan"),
        fact("만약 이직하면 어떨지 궁금하다", "career", "hypothetical"),
        fact("팀장이 나를 싫어하는 것 같다", "social", "about-others"),
        fact("집을 사려고 돈을 모을 계획이다", "wealth", "plan"),
        fact("적금을 붓고 있다", "wealth", "current"),
      ],
    });
    const facts = added(sections);
    expect(facts.every(({ material }) => material.kind === "user-fact" && material.source === "concern" && material.scope === "user")).toBe(true);
    const kindsOf = (text: string) => facts.filter(({ material }) => material.text === text).map(({ sectionId, material }) => [sectionId, material.factKind]);
    expect(kindsOf("내년에 창업할 생각이다")).toEqual([["ch3", "plan"]]);
    expect(kindsOf("만약 이직하면 어떨지 궁금하다")).toEqual([["ch3", "hypothetical"]]);
    expect(kindsOf("팀장이 나를 싫어하는 것 같다")).toEqual([["ch6", "about-others"]]);
    // 재물 사실은 현재 대운의 활동 주제(재성: 수입 활동·거래·비용과 자원 관리)와 닿아 9-4에도 붙지만 종류는 그대로다.
    expect(kindsOf("집을 사려고 돈을 모을 계획이다")).toEqual([["ch4", "plan"], ["ch9", "plan"]]);
    expect(kindsOf("적금을 붓고 있다")).toEqual([["ch4", "current"], ["ch9", "current"]]);
    const caveatsOf = (text: string) => facts.find(({ material }) => material.text === text)!.material.caveats!.join(" ");
    expect(caveatsOf("내년에 창업할 생각이다")).toContain("아직 일어난 사실이 아니다");
    expect(caveatsOf("만약 이직하면 어떨지 궁금하다")).toContain("가정해 본 상황");
    expect(caveatsOf("팀장이 나를 싫어하는 것 같다")).toContain("속마음이나 사정을 아는 사실처럼 쓰지 않는다");
    // 사실은 장의 적용 소질문에 붙는다.
    const ref = facts.find(({ material }) => material.text === "적금을 붓고 있다" && material.questionIds[0] === "9-4")!.material.ref;
    expect(questionRefs(sections, "ch9", "9-4")).toContain(ref);
    expect(questionRefs(sections, "ch3", "3-4")[0]).toBe(facts.find(({ material }) => material.text === "내년에 창업할 생각이다")!.material.ref);
  });

  it("여러 자유 질문을 각각 잇고 빠뜨리지 않으며, 같은 질문은 여러 장에 붙고 마지막 정리에서 모인다", () => {
    const questions = [
      ask("q1", "career", "compare", { topicDomain: "career" }),
      ask("q2", "wealth", "apply", { topicDomain: "wealth" }),
      ask("q3", "romance", "timing", { topicDomain: "romance", timingSupported: true }),
      ask("q4", "general", "general"),
    ];
    const { sections, questionMaterials } = personalize({ questions });
    expect(questionMaterials.map(({ ref, kind, sectionIds, chapterQuestionIds }) => ({ ref, kind, sectionIds, chapterQuestionIds }))).toEqual([
      { ref: "q1", kind: "question", sectionIds: ["ch3"], chapterQuestionIds: ["3-3"] },
      { ref: "q2", kind: "question", sectionIds: ["ch4"], chapterQuestionIds: ["4-4"] },
      { ref: "q3", kind: "question", sectionIds: ["ch5", "ch10"], chapterQuestionIds: ["5-3", "10-4"] },
      { ref: "q4", kind: "question", sectionIds: [], chapterQuestionIds: [] },
    ]);
    for (const question of questionMaterials) {
      question.sectionIds.forEach((sectionId, index) => {
        expect(questionRefs(sections, sectionId, question.chapterQuestionIds[index]!)[0]).toBe(question.ref);
      });
    }
    expect(questionMaterials[3]!.notes[0]).toContain("마지막 정리에서");
    // 질문 재료는 사용자 사실이 아니다. 사용자 사실 재료가 생기지 않는다.
    expect(added(sections).some(({ material }) => material.kind === "user-fact")).toBe(false);

    const closing = buildClosingSection({
      product,
      questions,
      chapterAnswers: ["ch3", "ch4", "ch5", "ch10"].map((sectionId) => ({ sectionId, title: specOf(sectionId).title, coreAnswer: `${sectionId} 답` })),
      startRef: 900,
    }).section;
    expect(closing.questions.map((question) => question.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(closing.questions.find((question) => question.id === "q3")!.refs).toHaveLength(3);
  });

  it("관심 주제는 최대 2개만 설명 비중에 반영하고 판단은 바꾸지 않는다", () => {
    const now = { ...EMPTY_NOW, interests: ["ch2", "ch5", "ch7"] } as unknown as MujinNow;
    const { sections } = personalize({ now });
    expect(sectionOf(sections, "ch2").weight).toBe("interest");
    expect(sectionOf(sections, "ch5").weight).toBe("interest");
    expect(sectionOf(sections, "ch7").weight).toBe("standard");
    expect(sections.flatMap((section) => section.questions.map((question) => question.status))).toEqual(
      BASE.flatMap((section) => section.questions.map((question) => question.status)),
    );
  });

  it("가족 이야기를 답하고 싶지 않거나 답하지 않았으면 가족 사실을 만들지 않는다", () => {
    for (const family of [["private"], []] as MujinNow["family"][]) {
      const { sections } = personalize({ now: { ...EMPTY_NOW, family }, concernFacts: [fact("지금 회사에 다니고 있다", "career", "current")] });
      expect(sectionOf(sections, "ch7")).toEqual(sectionOf(BASE, "ch7"));
      expect(added(sections).map(({ sectionId }) => sectionId)).toEqual(["ch3"]);
      expect(added(sections).some(({ material }) => material.text.includes("가족"))).toBe(false);
    }
  });

  it("최근 변화가 '지금의 나'와 같은 영역이면 최근 사실을 따르고 충돌한 부분만 중립으로 다루는 조건을 붙인다", () => {
    const now: MujinNow = { ...EMPTY_NOW, work: ["employed"] };
    const caveatsOf = (input: Parameters<typeof personalize>[0]) => added(personalize(input).sections)[0]!.material.caveats!.join(" ");
    const recent = caveatsOf({ now, concernFacts: [fact("지난달 회사를 그만뒀다", "career", "past")] });
    expect(recent).toContain("'지금의 나'에서 고른 항목(직장에 다니는 중)");
    expect(recent).toContain("최근 사실을 지금 상황으로 쓰고");
    expect(recent).toContain("맞지 않는 부분만 단정하지 않고 중립으로");
    expect(caveatsOf({ concernFacts: [fact("지난달 회사를 그만뒀다", "career", "past")] })).not.toContain("지금의 나");
    expect(caveatsOf({ now, concernFacts: [fact("내년에 이직할 계획이다", "career", "plan")] })).not.toContain("지금의 나");
  });

  it("10-4는 시기 질문의 분야와 같은 기간 활동만 원국 판단과 잇는다", () => {
    const base10 = questionRefs(BASE, "ch10", "10-4");
    const ch10 = sectionOf(BASE, "ch10");
    const activityOf = (domain: MonthDomain) => ch10.materials.find((material) => material.variant === `month-activity:${domain}`)!;

    const career = personalize({ questions: [ask("q1", "career", "timing", { topicDomain: "career", timingSupported: true })] }).sections;
    const refs = questionRefs(career, "ch10", "10-4");
    expect(refs.slice(0, 2)).toEqual(["q1", activityOf("career").ref]);
    const links = added(career).filter(({ sectionId }) => sectionId === "ch10").map(({ material }) => material);
    expect(links).toHaveLength(2);
    const ch3Refs = new Set(sectionOf(BASE, "ch3").materials.map((material) => material.ref));
    for (const link of links) {
      expect(link.kind).toBe("derived");
      expect(link.parentRefs![0]).toBe(activityOf("career").ref);
      expect(ch3Refs.has(link.parentRefs![1]!)).toBe(true);
      expect(link.caveats).toContain("지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다.");
    }
    expect(refs.slice(2, 4)).toEqual(links.map((link) => link.ref));
    // 기존 활동 재료(재물)는 지우지 않고 뒤에 남긴다.
    expect(refs).toContain(activityOf("wealth").ref);

    // 활동 재료가 없는 분야(연애)의 시기 질문은 원국 판단과 잇지 않는다.
    const romance = personalize({ questions: [ask("q2", "romance", "timing", { topicDomain: "romance", timingSupported: true })] });
    expect(questionRefs(romance.sections, "ch10", "10-4")).toEqual(["q2", ...base10]);
    expect(added(romance.sections)).toEqual([]);
    expect(romance.questionMaterials[0]!.notes.join(" ")).toContain("연애 분야의 주목·주의 구간과 활동으로만");

    // 질문이 없으면 10-4를 바꾸지 않는다.
    expect(questionRefs(personalize().sections, "ch10", "10-4")).toEqual(base10);
  });

  it("결과 확정·건강·투자·학업 질문에는 판단할 수 있는 범위만 답하는 조건을 단다", () => {
    const { questionMaterials } = personalize({
      questions: [
        ask("q1", "romance", "outcome", { answerability: "limited", topicDomain: "romance" }),
        ask("q2", "health", "apply", { answerability: "limited", topicDomain: "temperament" }),
        ask("q3", "investment", "timing", { topicDomain: "wealth", timingSupported: true }),
        ask("q4", "study", "outcome", { answerability: "limited", topicDomain: "strengths", missingInfo: ["시험 일정"] }),
      ],
    });
    const notes = (ref: string) => questionMaterials.find((question) => question.ref === ref)!.notes.join(" ");
    expect(notes("q1")).toContain("확정하지 않고");
    expect(notes("q2")).toContain("진단·병명·치료 없이");
    expect(questionMaterials[1]).toMatchObject({ sectionIds: ["ch8"], chapterQuestionIds: ["8-3"] });
    expect(notes("q3")).toContain("특정 종목·사고팔 시점·수익률 대신");
    expect(notes("q3")).toContain("재물 분야의 주목·주의 구간");
    expect(questionMaterials[2]).toMatchObject({ sectionIds: ["ch4", "ch10"], chapterQuestionIds: ["4-4", "10-4"] });
    expect(notes("q4")).toContain("합격 여부 대신");
    expect(notes("q4")).toContain("확인해야 할 정보: 시험 일정");
    expect(questionMaterials[3]).toMatchObject({ sectionIds: ["ch2"], chapterQuestionIds: ["2-4"] });
  });

  it("이어진 소질문에 채택 판단이 없으면 일반 상황 제안으로 구분하라는 조건을 단다", () => {
    const { questionMaterials } = personalize({ questions: [ask("q1", "family", "apply", { topicDomain: "family" })] });
    expect(questionMaterials[0]).toMatchObject({ sectionIds: ["ch7"], chapterQuestionIds: ["7-4"] });
    expect(questionMaterials[0]!.notes.join(" ")).toContain("7-4: 채택 판단이 없어");
  });

  it("범위 밖 질문은 쓰지 않고, 질문 ref가 재료 ref와 겹치면 멈춘다", () => {
    const outside = personalize({ questions: [ask("q1", "non-saju", "general"), ask("q2", "other-person", "outcome")] });
    expect(outside.questionMaterials).toEqual([]);
    expect(outside.sections).toEqual(BASE);
    expect(() => personalize({ questions: [ask("m1", "career", "apply")] })).toThrow();
    expect(() => personalize({ questions: [ask("q1", "career", "apply"), ask("q1", "wealth", "apply")] })).toThrow();
  });

  it("마지막 정리가 함께 들어와도 비중과 재료를 바꾸지 않는다 (마지막 정리의 비중은 buildClosingSection이 정한다)", () => {
    const questions = [ask("q1", "career", "apply")];
    const closing = buildClosingSection({ product, questions, chapterAnswers: [{ sectionId: "ch3", title: "직업", coreAnswer: "직업 답" }], startRef: 800 }).section;
    const { sections } = personalize({ sections: [...BASE, closing], questions });
    expect(sectionOf(sections, "closing")).toBe(closing);
    expect(sectionOf(sections, "ch3").weight).toBe("question");
  });

  it("무료 단계처럼 일부 장만 넘기면 있는 장에만 잇는다", () => {
    const free = BASE.filter((section) => section.sectionId === "basics-structure" || section.sectionId === "ch1");
    const { sections, questionMaterials } = personalize({
      sections: free,
      questions: [ask("q1", "temperament", "apply"), ask("q2", "career", "timing", { timingSupported: true })],
      concernFacts: [fact("요즘 쉽게 예민해진다", "temperament", "current"), fact("지금 회사에 다니고 있다", "career", "current")],
    });
    expect(questionMaterials.map((question) => question.sectionIds)).toEqual([["ch1"], []]);
    expect(sections.map((section) => section.weight)).toEqual(["standard", "question"]);
    expect(added(sections).map(({ sectionId, material }) => [sectionId, material.questionIds])).toEqual([["ch1", ["1-3"]]]);
  });

  it("비중을 반영한 편집 목표는 상한의 20% 안에서만 늘리고, 이미 반영한 계획을 다시 넣어도 커지지 않는다", () => {
    expect(weightedTarget({ min: 1000, max: 1300 }, "standard")).toEqual({ min: 1000, max: 1300 });
    expect(weightedTarget({ min: 1000, max: 1300 }, "question")).toEqual({ min: 1150, max: 1560 });
    expect(weightedTarget({ min: 1000, max: 1300 }, "interest")).toEqual({ min: 1075, max: 1430 });
    expect(weightedTarget({ min: 0, max: 0 }, "question")).toEqual({ min: 0, max: 0 });
    const input = { now: { ...EMPTY_NOW, interests: ["ch4"] } as MujinNow, questions: [ask("q1", "career", "apply")] };
    const once = personalize(input);
    const twice = personalize({ ...input, sections: once.sections });
    expect(twice.sections.map((section) => section.targetChars)).toEqual(once.sections.map((section) => section.targetChars));
    expect(twice.sections.map((section) => section.weight)).toEqual(once.sections.map((section) => section.weight));
  });
});
