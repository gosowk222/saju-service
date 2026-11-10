import { describe, expect, it } from "vitest";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { CHART_TERMS, allowedChartTerms, chartTermIssues, familyLore, termsIn, usefulLore } from "@/domain/reading/lore";
import type { ChartView } from "@/domain/reading/types";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";

/** 명리 설명 재료 (상품 3.1.0). 엔진 근거를 원국 글자·십성·신살·합충 문장으로 옮기고, 풀이가 재료 밖의 글자를 쓰지 못하게 한다. */

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
// 가상 출생정보: 기토 일간, 월주 신유(辛酉), 일주 기사(己巳), 시주 임신(壬申), 연주 무인(戊寅).
const base: AnalyzeInput = {
  birthDate: "1998-09-19",
  calendar: "solar",
  isLeapMonth: false,
  gender: "female",
  birthTime: { status: "branch", branch: "신" },
  birthPlace: place,
};

const analyze = (input: AnalyzeInput = base) =>
  analyzeBirth({ birth: toPublicBirthInput(input), product: FIRST_OVERVIEW, nickname: "달빛", situationId: null });

const statementsOf = (plan: ReturnType<typeof analyze>["plan"]) => plan.topics.flatMap((topic) => topic.statements);

function chartNames(chart: ChartView): Set<string> {
  return new Set(chart.pillars.flatMap((pillar) => [pillar.stem, pillar.branch]).flatMap((symbol) => (symbol ? [`${symbol.ko}${symbol.element}`] : [])));
}

describe("명리 설명 재료", () => {
  it("신살은 위치와 함께, 합충은 두 기둥의 글자와 함께 옮긴다", () => {
    const { plan } = analyze();
    const lore = statementsOf(plan).flatMap((statement) => statement.lore ?? []);
    expect(lore).toContain("시주의 신금(申金)에 천을귀인이 있어요.");
    expect(lore).toContain("일주의 사화(巳火)에 고신살이 있어요.");
    expect(lore.some((line) => line.startsWith("일주의 사화(巳火)와 시주의 신금(申金)이") && line.includes("형(刑)"))).toBe(true);
    expect(lore).toContain("월주의 유금(酉金)과 연주의 인목(寅木)이 원진(怨嗔) 관계예요.");
  });

  it("십성 계열은 원국에서 그 십성인 글자와 일간과의 생극으로 옮긴다", () => {
    const { plan } = analyze();
    const temperament = plan.topics.find((topic) => topic.topicId === "temperament")!;
    expect(temperament.statements[0]!.lore).toEqual([
      "월주의 신금(辛金), 월주의 유금(酉金)은 식신, 시주의 신금(申金)은 상관이에요. 일간 기토(己土)가 생하는(토생금) 금(金) 기운이라 내 기운을 밖으로 풀어내는 자리예요.",
    ]);
  });

  it("명리 설명에 나오는 글자는 모두 실제 원국 글자이고, 한 해석에 세 줄을 넘지 않는다", () => {
    for (const input of [base, { ...base, birthDate: "1990-02-03", gender: "male" as const, birthTime: { status: "branch" as const, branch: "오" as const } }]) {
      const { plan, chart } = analyze(input);
      const names = chartNames(chart);
      for (const statement of statementsOf(plan)) {
        expect((statement.lore ?? []).length).toBeLessThanOrEqual(3);
        for (const line of statement.lore ?? []) {
          for (const term of termsIn(line).filter((item) => CHART_TERMS.includes(item))) expect(names.has(term)).toBe(true);
        }
      }
    }
  });

  it("일간 비유와 원국 글자의 오행 개수를 사실로 남기고, 신살 근거 문장에 영어 ID를 쓰지 않는다", () => {
    const { plan } = analyze();
    const facts = plan.facts.map((fact) => fact.text);
    expect(facts).toContain("일간 기토(己土)는 전통적으로 기름진 논밭의 흙에 빗댑니다.");
    expect(facts).toContain("원국 8글자의 오행은 목 1개, 화 1개, 토 2개, 금 3개, 수 1개예요.");
    expect(statementsOf(plan).flatMap((statement) => statement.basis ?? []).join(" ")).not.toMatch(/[a-z]{4,}/);
  });

  it("태어난 시간을 모르면 시주 글자를 설명에 쓰지 않는다", () => {
    const { plan } = analyze({ ...base, birthTime: { status: "unknown" } });
    const lore = statementsOf(plan).flatMap((statement) => statement.lore ?? []);
    expect(lore.length).toBeGreaterThan(0);
    expect(lore.some((line) => line.includes("시주"))).toBe(false);
    expect(plan.facts.map((fact) => fact.text)).toContain("원국 6글자의 오행은 목 1개, 화 1개, 토 2개, 금 2개, 수 0개예요. 수는 글자로는 하나도 없어요.");
  });

  it("원국에 없는 계열은 없다고 말하고, 용신 문장의 조사를 오행에 맞춘다", () => {
    const { chart } = analyze({ ...base, birthTime: { status: "unknown" } });
    expect(familyLore(chart, "wealth")).toMatch(/^원국 글자 가운데 재성은 겉으로 드러나 있지 않아요\./);
    expect(usefulLore({ usefulElement: "금", helpfulElement: null, adverseElements: [], usefulGodBasis: { adopted: "climate" } } as never)).toBe(
      "용신은 금(金)으로 계산됐어요. 태어난 계절의 차고 더움을 맞추는 조후(調候) 기준이에요.",
    );
    expect(usefulLore({ usefulElement: "토", helpfulElement: "화", adverseElements: ["수"] } as never)).toBe("용신은 토(土), 희신은 화(火), 기신은 수(水)로 계산됐어요.");
  });
});

describe("풀이의 원국 글자·신살 확인", () => {
  const { chart } = analyze();
  const allowed = allowedChartTerms(chart, ["시주의 신금(申金)에 천을귀인이 있어요.", "역마 표지가 있어요."]);

  it("원국 글자와 재료에 나온 신살은 통과한다", () => {
    expect(chartTermIssues("일주의 사화에 고신살이 있어서 혼자 쉬는 시간이 필요해요.", allowedChartTerms(chart, ["일주의 사화(巳火)에 고신살이 있어요."]))).toEqual([]);
    expect(chartTermIssues("월주의 신금이 식신이라 손으로 만드는 걸 좋아하잖아요.", allowed)).toEqual([]);
    expect(chartTermIssues("시주에 천을귀인이 있어서 도움을 받는 편이에요.", allowed)).toEqual([]);
  });

  it("원국에 없는 글자나 재료에 없는 신살을 말하면 다시 쓰게 한다", () => {
    expect(chartTermIssues("연주의 경금 편인이 일간을 생해 주고 있어요.", allowed)).toEqual(["원국에 없는 글자를 말했습니다: 경금"]);
    expect(chartTermIssues("일지에 도화살이 있어서 눈에 띄는 편이에요.", allowed)).toEqual(["원국 재료에 없는 신살을 말했습니다: 도화살"]);
  });

  it("일상어와 겹치는 말이나 다른 낱말의 일부는 글자 이름으로 보지 않는다", () => {
    expect(chartTermIssues("마음을 정화하는 시간이 필요해요. 해수욕장도 좋아요.", allowed)).toEqual([]);
    expect(termsIn("무토막처럼")).toEqual([]);
  });
});
