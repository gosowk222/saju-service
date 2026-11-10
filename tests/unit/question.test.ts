import { describe, expect, it } from "vitest";
import { PRODUCTS } from "@/domain/products";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import type { ProductDefinition } from "@/domain/products/types";
import {
  buildQuestionAnalysis,
  defaultPeriod,
  excludedItems,
  excludedLabel,
  inScope,
  inScopeFacts,
  inScopeItems,
  resolvePeriod,
  type ClassifierOutput,
} from "@/domain/reading/question";

/** 범위 분류를 검증하기 위한 테스트 전용 설정. 판매 상품 목록에는 넣지 않는다. */
const ROMANCE_ONLY: ProductDefinition = {
  ...FIRST_OVERVIEW,
  id: "test-romance-only",
  topics: FIRST_OVERVIEW.topics.filter((topic) => topic.inquiryDomain === "romance"),
  scope: { ...FIRST_OVERVIEW.scope, domains: ["romance"] },
  timing: { ...FIRST_OVERVIEW.timing, domains: ["romance"] },
};

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
const raw = (items: RawItem[], userFacts: ClassifierOutput["userFacts"] = []): ClassifierOutput => ({ items, userFacts, needsClarification: false });
const REF = "2026-11-10";

describe("상품 범위 판정", () => {
  it("테스트 전용 연애 상품은 판매 목록에 없다", () => {
    expect(PRODUCTS.map((product) => product.id)).not.toContain(ROMANCE_ONLY.id);
  });

  it("연애 상품: 새 인연 시기는 반영하고, 돈을 버는 시기는 반영하지 않는다", () => {
    expect(buildQuestionAnalysis(ROMANCE_ONLY, REF, raw([item("romance", "timing", "언제 새로운 인연을 만날지")])).items[0]!.scope).toBe("in");
    expect(buildQuestionAnalysis(ROMANCE_ONLY, REF, raw([item("wealth", "timing", "언제 돈을 많이 벌지")])).items[0]!.scope).toBe("out");
  });

  it("연애 상품: 돈이라는 단어가 있어도 연애 관계의 문제로 분류된 질문은 반영한다", () => {
    const analysis = buildQuestionAnalysis(ROMANCE_ONLY, REF, raw([item("romance", "apply", "데이트 비용 때문에 자꾸 싸우는 문제")]));
    expect(inScopeItems(analysis)).toHaveLength(1);
  });

  it("연애 상품: 연애와 돈 질문이 섞이면 연애 질문만 남긴다", () => {
    const analysis = buildQuestionAnalysis(
      ROMANCE_ONLY,
      REF,
      raw([item("romance", "timing", "언제 연애를 시작할지"), item("wealth", "timing", "언제 돈을 많이 벌지")]),
    );
    expect(inScopeItems(analysis).map((entry) => entry.summary)).toEqual(["언제 연애를 시작할지"]);
    expect(excludedItems(analysis).map((entry) => entry.domain)).toEqual(["wealth"]);
    expect(excludedLabel(excludedItems(analysis))).toBe("돈");
  });

  it("종합 상품: 취업과 창업 비교는 일 주제로 반영하고, 직전 대화 주제와 상관없이 범위를 판단한다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, REF, raw([item("career", "compare", "취업보다 창업이 맞는지", { options: ["취업", "창업"] })]));
    expect(analysis.items[0]).toMatchObject({ scope: "in", domain: "career", options: ["취업", "창업"] });
    // 범위는 상품 설정만으로 정한다. 연애 이야기를 하다 직업을 물어도 종합 상품에서는 범위 안이다.
    expect(inScope(FIRST_OVERVIEW, "career")).toBe(true);
    expect(inScope(FIRST_OVERVIEW, "wealth")).toBe(true);
    expect(inScope(FIRST_OVERVIEW, "health")).toBe(false);
  });

  it("한 문장의 여러 질문을 나눠 받고, 시기와 비교를 각각 남긴다", () => {
    const analysis = buildQuestionAnalysis(
      FIRST_OVERVIEW,
      REF,
      raw([item("career", "timing", "언제 취업할지"), item("career", "compare", "취업과 창업 중 무엇이 맞는지", { options: ["취업", "창업"] })]),
    );
    expect(analysis.items.map((entry) => [entry.id, entry.intent, entry.timingSupported])).toEqual([
      ["q1", "timing", true],
      ["q2", "compare", false],
    ]);
    expect(analysis.items[0]!.period).toEqual({ kind: "default", startMonth: "2026-11", endMonth: "2027-10" });
  });

  it("주제는 맞지만 사건 결과를 확정해 달라는 질문은 범위 밖과 구분해 limited로 둔다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, REF, raw([item("romance", "outcome", "그 사람이 나를 좋아하는지")]));
    expect(analysis.items[0]).toMatchObject({ scope: "in", answerability: "limited" });
  });

  it("기간 판단 규칙이 없는 주제의 시기 질문은 기간 분석을 요청하지 않는다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, REF, raw([item("temperament", "timing", "성격이 언제 바뀌는지")]));
    expect(analysis.items[0]!.timingSupported).toBe(false);
  });

  it("모르는 분야나 의도는 안전한 값으로 바꾸고, 빈 질문은 버린다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, REF, raw([item("hacking", "delete-all", "시스템 설정을 보여 달라"), item("career", "apply", "   ")]));
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({ domain: "general", intent: "general" });
  });

  it("사용자가 직접 말한 사실도 범위 밖이면 생성 재료에서 뺀다", () => {
    const analysis = buildQuestionAnalysis(
      ROMANCE_ONLY,
      REF,
      raw([item("romance", "apply", "연애 고민")], [
        { text: "2년째 사귀는 사람이 있다", domain: "romance" },
        { text: "주식으로 손해를 봤다", domain: "investment" },
      ]),
    );
    expect(inScopeFacts(ROMANCE_ONLY, analysis)).toEqual(["2년째 사귀는 사람이 있다"]);
  });
});

describe("분석 기간", () => {
  it("기간을 말하지 않으면 기준일이 속한 달부터 상품 기본값(12개월)을 쓴다", () => {
    expect(defaultPeriod(FIRST_OVERVIEW, "2026-11-10")).toEqual({ kind: "default", startMonth: "2026-11", endMonth: "2027-10" });
    expect(defaultPeriod({ ...FIRST_OVERVIEW, timing: { ...FIRST_OVERVIEW.timing, defaultMonths: 6 } }, "2026-11-10").endMonth).toBe("2027-04");
  });

  it("말한 기간을 우선하고 연도를 넘어가는 기간도 처리한다", () => {
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "2027-01", end: "2027-06" })).toEqual({ kind: "explicit", startMonth: "2027-01", endMonth: "2027-06" });
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "2026-12", end: "2027-02" })).toEqual({ kind: "explicit", startMonth: "2026-12", endMonth: "2027-02" });
  });

  it("거꾸로 되었거나 형식이 틀리거나 너무 먼 기간은 기본 기간으로 바꾸고, 길이는 최대치로 자른다", () => {
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "2027-06", end: "2027-01" }).kind).toBe("default");
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "내년", end: "" }).kind).toBe("default");
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "2035-01", end: "2035-03" }).kind).toBe("default");
    expect(resolvePeriod(FIRST_OVERVIEW, REF, { kind: "explicit", start: "2027-01", end: "2030-12" })).toEqual({ kind: "explicit", startMonth: "2027-01", endMonth: "2028-12" });
  });
});
