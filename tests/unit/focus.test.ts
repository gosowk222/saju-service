import { describe, expect, it } from "vitest";
import { findLegacyPersona } from "@/domain/personas/legacy";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import type { ProductDefinition } from "@/domain/products/types";
import { buildNarrationPlan, requestedTimingKey } from "@/domain/reading/focus";
import { buildQuestionAnalysis, emptyAnalysis, inScopeItems, itemDomain, type ClassifierOutput, type QuestionAnalysis } from "@/domain/reading/question";
import type { TimingDomain } from "@/domain/rules/timing";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeTiming } from "@/server/engine/timing";
import { getReadingPrompt } from "@/server/llm/prompts";

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const chartA: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };
const chartB: AnalyzeInput = { birthDate: "1994-05-12", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "오" }, birthPlace: place };
const REF = "2026-11-10";

type RawItem = ClassifierOutput["items"][number];
const item = (domain: string, intent: string, summary: string, extra: Partial<RawItem> = {}): RawItem => ({
  summary,
  domain,
  intent,
  options: [],
  period: { kind: intent === "timing" ? "default" : "none", start: "", end: "" },
  missingInfo: [],
  ...extra,
});
const analysisOf = (product: ProductDefinition, items: RawItem[]) => buildQuestionAnalysis(product, REF, { items, userFacts: [], needsClarification: false });

function planFor(input: AnalyzeInput, situationId: string | null, analysis: QuestionAnalysis, product: ProductDefinition = FIRST_OVERVIEW) {
  const birth = toPublicBirthInput(input);
  const base = analyzeBirth({ birth, product, nickname: "가람", situationId });
  const requests = inScopeItems(analysis).filter((entry) => requestedTimingKey(entry));
  const timing = analyzeTiming({
    birth,
    referenceDate: analysis.referenceDate,
    requests: requests.map((entry) => ({ domain: itemDomain(entry) as TimingDomain, period: entry.period! })),
  });
  return buildNarrationPlan({ base: base.plan, product, analysis, timing: requests.map((entry, index) => ({ requestKey: requestedTimingKey(entry)!, analysis: timing[index]! })) });
}

const promptInput = (plan: ReturnType<typeof planFor>) => getReadingPrompt("reading-2.0.0")({ plan, persona: findLegacyPersona("myomyo", "1.0.0")!, previousIssues: [] }).input;
const shape = (plan: ReturnType<typeof planFor>) => plan.topics.map((topic) => `${topic.topicId}:${topic.weight}`);

describe("질문과 상황에 따른 작성 계획", () => {
  it("질문이 없으면 여섯 주제를 균형 있게 두고 답변 영역을 만들지 않는다", () => {
    const plan = planFor(chartA, null, emptyAnalysis(REF));
    expect(plan.questions).toEqual([]);
    expect(plan.timing).toEqual([]);
    expect(plan.topics.map((topic) => topic.topicId)).toEqual(FIRST_OVERVIEW.topics.map((topic) => topic.id));
    expect(new Set(plan.topics.map((topic) => topic.weight))).toEqual(new Set(["standard"]));
  });

  it("같은 사주에서 상황을 바꾸면 비중과 관점이 바뀐다", () => {
    const employee = planFor(chartA, "employee", emptyAnalysis(REF));
    const seeking = planFor(chartA, "job-seeking", emptyAnalysis(REF));
    expect(shape(employee)).not.toEqual(shape(seeking));
    expect(employee.base.situation!.context).not.toBe(seeking.base.situation!.context);
    expect(promptInput(employee)).not.toBe(promptInput(seeking));
  });

  it("같은 사주에서 질문을 바꾸면 주제 순서, 비중, 먼저 꺼낼 판단이 바뀐다", () => {
    const career = planFor(chartA, "job-seeking", analysisOf(FIRST_OVERVIEW, [item("career", "compare", "취업과 창업 중 무엇이 맞는지", { options: ["취업", "창업"] })]));
    const romance = planFor(chartA, "job-seeking", analysisOf(FIRST_OVERVIEW, [item("romance", "apply", "연인과 자꾸 싸우는 이유")]));
    expect(career.topics[0]!.topicId).toBe("work");
    expect(romance.topics[0]!.topicId).toBe("romance");
    expect(career.topics[0]!.weight).toBe("focus");
    // 비교 질문이면 일 주제에서 취업·창업 비교 판단을 먼저 꺼낸다.
    const work = career.topics.find((topic) => topic.topicId === "work")!;
    expect(work.statements[0]!.aspect).toBe("취업·이직·창업의 조건 비교");
    expect(career.questions[0]!.relatedRefs[0]).toBe(work.statements[0]!.ref);
  });

  it("다른 사주는 같은 질문에도 근거에 따라 다른 판단을 쓴다", () => {
    const question = analysisOf(FIRST_OVERVIEW, [item("career", "compare", "취업과 창업 중 무엇이 맞는지", { options: ["취업", "창업"] })]);
    const a = planFor(chartA, "job-seeking", question).topics.find((topic) => topic.topicId === "work")!;
    const b = planFor(chartB, "job-seeking", question).topics.find((topic) => topic.topicId === "work")!;
    expect(a.statements.map((statement) => statement.text)).not.toEqual(b.statements.map((statement) => statement.text));
  });

  it("범위 밖 질문을 섞어도, 그 질문을 뺀 입력과 같은 작성 계획과 프롬프트 입력이 나온다", () => {
    const romanceOnly: ProductDefinition = {
      ...FIRST_OVERVIEW,
      id: "test-romance-only",
      topics: FIRST_OVERVIEW.topics.filter((topic) => topic.inquiryDomain === "romance"),
      scope: { ...FIRST_OVERVIEW.scope, domains: ["romance"] },
      timing: { ...FIRST_OVERVIEW.timing, domains: ["romance"] },
    };
    const mixed = planFor(chartA, null, analysisOf(romanceOnly, [item("romance", "timing", "언제 연애를 시작할지"), item("wealth", "timing", "언제 돈을 많이 벌 수 있을지")]), romanceOnly);
    const clean = planFor(chartA, null, analysisOf(romanceOnly, [item("romance", "timing", "언제 연애를 시작할지")]), romanceOnly);
    expect(promptInput(mixed)).toBe(promptInput(clean));
    expect(promptInput(mixed)).not.toContain("돈을 많이");
    expect(mixed.timing.map((entry) => entry.domain)).toEqual(["romance"]);
  });

  it("궁금한 점의 원문은 작성 재료에 들어가지 않고, 정리된 질문만 생성 단계에서 더해진다", () => {
    const birth = toPublicBirthInput(chartA);
    const base = analyzeBirth({ birth, product: FIRST_OVERVIEW, nickname: "가람", situationId: "job-seeking" });
    expect(base.plan.userContext.every((entry) => entry.source !== "concern")).toBe(true);
    const plan = planFor(chartA, "job-seeking", analysisOf(FIRST_OVERVIEW, [item("career", "timing", "언제 취업할 수 있을지")]));
    expect(plan.questions.map((question) => question.summary)).toEqual(["언제 취업할 수 있을지"]);
  });

  it("기간 규칙이 없는 주제의 시기 질문은 기간 분석 없이 안내를 붙인다", () => {
    const plan = planFor(chartA, null, analysisOf(FIRST_OVERVIEW, [item("temperament", "timing", "성격이 언제쯤 차분해질지")]));
    expect(plan.timing).toEqual([]);
    expect(plan.questions[0]!.timingNote).toContain("기간별 판단 규칙이 없어");
  });
});

describe("기간 분석", () => {
  const birth = toPublicBirthInput(chartA);

  it("기본 기간은 Asia/Seoul 기준일이 속한 절기 월부터 12개월이다", () => {
    // 11월 3일은 11월 절입(입동) 전이라 절기 기준으로 10월 월운에 속한다.
    const [early] = analyzeTiming({ birth, referenceDate: "2026-11-03", requests: [{ domain: "career", period: { kind: "default", startMonth: "2026-11", endMonth: "2027-10" } }] });
    expect(early!.months[0]!.label).toBe("2026년 10월");
    expect(early!.months).toHaveLength(12);
    const [late] = analyzeTiming({ birth, referenceDate: REF, requests: [{ domain: "career", period: { kind: "default", startMonth: "2026-11", endMonth: "2027-10" } }] });
    expect(late!.months[0]!.label).toBe("2026년 11월");
    expect(late!.months.at(-1)!.label).toBe("2027년 10월");
    expect(late!.window.label).toBe("2026년 11월부터 2027년 10월까지 (절기 기준 월)");
  });

  it("말한 기간을 우선하고 연도를 넘어가는 기간을 처리한다", () => {
    const [analysis] = analyzeTiming({ birth, referenceDate: REF, requests: [{ domain: "wealth", period: { kind: "explicit", startMonth: "2026-12", endMonth: "2027-02" } }] });
    expect(analysis!.months.map((month) => month.label)).toEqual(["2026년 12월", "2027년 1월", "2027년 2월"]);
    expect(analysis!.years.map((year) => year.label)).toEqual(expect.arrayContaining(["2026년", "2027년"]));
  });

  it("고른 달은 상품 내부 선택 기준(긍정 표지 수 - 조심 표지 수)을 따르고, 사건 확률을 쓰지 않는다", () => {
    const [analysis] = analyzeTiming({ birth, referenceDate: REF, requests: [{ domain: "career", period: { kind: "default", startMonth: "2026-11", endMonth: "2027-10" } }] });
    for (const periodId of analysis!.notable) {
      const month = analysis!.months.find((entry) => entry.periodId === periodId)!;
      expect(month.selectionScore).toBeGreaterThanOrEqual(1);
    }
    for (const month of analysis!.months) {
      expect(month.caveats.join()).toContain("사건이 생긴다는 뜻이 아니다");
      expect(month.markers.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(analysis)).not.toMatch(/확률|%/);
  });

  it("두 분야를 함께 물어도 한 세션에서 계산하고 서로의 근거를 섞지 않는다", () => {
    const [career, romance] = analyzeTiming({
      birth,
      referenceDate: REF,
      requests: [
        { domain: "career", period: { kind: "explicit", startMonth: "2027-03", endMonth: "2027-05" } },
        { domain: "romance", period: { kind: "explicit", startMonth: "2027-03", endMonth: "2027-05" } },
      ],
    });
    expect(career!.domain).toBe("career");
    expect(romance!.domain).toBe("romance");
    // 같은 달이라도 분야마다 표지를 다르게 읽는다.
    expect(career!.months.map((month) => month.markers.map((marker) => marker.activity))).not.toEqual(romance!.months.map((month) => month.markers.map((marker) => marker.activity)));
    for (const month of [...career!.months, ...romance!.months]) expect(month.conclusionId).toContain(month.periodId);
  });
});
