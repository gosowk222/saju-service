import { describe, expect, it } from "vitest";
import { checkFollowup, checkNarration } from "@/domain/reading/check";
import type { ChartView, NarrationOutput, ReadingPlan } from "@/domain/reading/types";

const topic = (topicId: string, ref: string, creative = false) => ({
  topicId,
  title: topicId,
  status: "adopted" as const,
  limitNote: null,
  bubbles: { min: 2, target: 3, max: 4 },
  creativeSceneAllowed: creative,
  statements: [
    {
      ref,
      kind: "service-interpretation" as const,
      text: "해석",
      status: "candidate" as const,
      caveats: [],
      conclusionId: "c",
      ruleId: "r",
      ruleVersion: "1.0.0",
    },
  ],
});

const plan: ReadingPlan = {
  planVersion: "1.0.0",
  productId: "first-overview",
  productVersion: "1.0.0",
  rulesetId: "first-overview",
  rulesetVersion: "1.0.0",
  personaId: "yeoul",
  personaVersion: "1.0.0",
  nickname: "달빛",
  hourKnown: false,
  coverageNotes: [],
  facts: [
    { ref: "f1", kind: "engine-fact", text: "십성 계열 중 식상이 41%로 가장 큽니다.", originPath: "x" },
  ],
  userContext: [{ ref: "u1", kind: "user-context", text: "직장인", source: "situation" }],
  topics: [topic("a", "s1", true), topic("b", "s2"), topic("c", "s3"), topic("d", "s4"), topic("e", "s5"), topic("f", "s6")],
};

const symbol = (ko: string, hanja: string) => ({ ko, hanja, element: "토" as const, tenGod: null });
const chart: ChartView = {
  pillars: [
    { key: "hour", label: "시주", stem: null, branch: null },
    { key: "day", label: "일주", stem: symbol("기", "己"), branch: symbol("사", "巳") },
    { key: "month", label: "월주", stem: symbol("신", "辛"), branch: symbol("유", "酉") },
    { key: "year", label: "연주", stem: symbol("무", "戊"), branch: symbol("인", "寅") },
  ],
  dayMaster: { ko: "기", hanja: "己", element: "토" },
  elementPercent: null,
  hourKnown: false,
  status: "partial",
  notes: [],
};

function goodOutput(): NarrationOutput {
  return {
    opening: "안녕하세요, 달빛 님.",
    closing: "궁금한 점은 편하게 물어봐 주세요.",
    topics: plan.topics.map((item, index) => ({
      topicId: item.topicId,
      bubbles: [
        { kind: "explanation", refs: [item.statements[0]!.ref], text: `${index}번째 주제의 첫 설명이에요.` },
        { kind: "explanation", refs: ["f1"], text: `${index}번째 주제의 두 번째 설명이에요.` },
      ],
    })),
  };
}

function withFirstBubble(text: string, patch: Partial<NarrationOutput["topics"][number]["bubbles"][number]> = {}): NarrationOutput {
  const output = goodOutput();
  const first = output.topics[0]!;
  return {
    ...output,
    topics: [{ ...first, bubbles: [{ ...first.bubbles[0]!, text, ...patch }, first.bubbles[1]!] }, ...output.topics.slice(1)],
  };
}

describe("풀이 검사", () => {
  it("정상 응답은 통과한다", () => {
    expect(checkNarration(goodOutput(), plan, chart)).toEqual([]);
  });

  it("없는 근거 ID를 거부한다", () => {
    const issues = checkNarration(withFirstBubble("설명이에요.", { refs: ["s99"] }), plan, chart);
    expect(issues.join()).toContain("없는 근거");
  });

  it("다른 주제의 해석을 근거로 쓰면 거부한다", () => {
    const issues = checkNarration(withFirstBubble("설명이에요.", { refs: ["s2"] }), plan, chart);
    expect(issues.join()).toContain("없는 근거");
  });

  it("상품에 없는 주제를 거부한다", () => {
    const output = goodOutput();
    const issues = checkNarration({ ...output, topics: [{ ...output.topics[0]!, topicId: "health" }, ...output.topics.slice(1)] }, plan, chart);
    expect(issues.join()).toContain("주제");
  });

  it("주제가 빠지거나 말풍선 수가 범위를 벗어나면 거부한다", () => {
    const output = goodOutput();
    expect(checkNarration({ ...output, topics: output.topics.slice(1) }, plan, chart).join()).toContain("주제 구성");
    const short = { ...output.topics[0]!, bubbles: output.topics[0]!.bubbles.slice(0, 1) };
    expect(checkNarration({ ...output, topics: [short, ...output.topics.slice(1)] }, plan, chart).join()).toContain("개수");
  });

  it("일간을 계산값과 다르게 말하면 거부한다", () => {
    expect(checkNarration(withFirstBubble("일간은 갑목이라 곧게 뻗어요."), plan, chart).join()).toContain("일간");
    expect(checkNarration(withFirstBubble("일간은 기토예요."), plan, chart)).toEqual([]);
  });

  it("기둥을 다르게 말하거나 없는 시주를 말하면 거부한다", () => {
    expect(checkNarration(withFirstBubble("갑자 일주라서요."), plan, chart).join()).toContain("기둥");
    expect(checkNarration(withFirstBubble("기사 일주라서요."), plan, chart)).toEqual([]);
    expect(checkNarration(withFirstBubble("경오 시주라서요."), plan, chart).join()).toContain("계산하지 않은");
  });

  it("근거 없는 날짜, 금액, 비율, 확률을 거부한다", () => {
    expect(checkNarration(withFirstBubble("2027년에 만나요."), plan, chart).join()).toContain("날짜");
    expect(checkNarration(withFirstBubble("3월 5일에 좋아요."), plan, chart).join()).toContain("날짜");
    expect(checkNarration(withFirstBubble("500만원을 벌어요."), plan, chart).join()).toContain("금액");
    expect(checkNarration(withFirstBubble("99% 맞아요."), plan, chart).join()).toContain("비율");
    expect(checkNarration(withFirstBubble("식상이 41%로 커요."), plan, chart)).toEqual([]);
    expect(checkNarration(withFirstBubble("만날 확률이 높아요."), plan, chart).join()).toContain("확률");
  });

  it("창작 장면을 사실로 표현하면 거부한다", () => {
    const issues = checkNarration(withFirstBubble("사주에 나와 있으니 반드시 만나요.", { kind: "creative-scene" }), plan, chart);
    expect(issues.join()).toContain("창작 장면");
  });

  it("허용하지 않은 주제의 창작 장면을 거부한다", () => {
    const output = goodOutput();
    const second = output.topics[1]!;
    const issues = checkNarration(
      {
        ...output,
        topics: [output.topics[0]!, { ...second, bubbles: [{ ...second.bubbles[0]!, kind: "creative-scene" }, second.bubbles[1]!] }, ...output.topics.slice(2)],
      },
      plan,
      chart,
    );
    expect(issues.join()).toContain("허용하지 않은");
  });

  it("같은 문장의 반복을 거부한다", () => {
    const output = goodOutput();
    const first = output.topics[0]!;
    const issues = checkNarration(
      { ...output, topics: [{ ...first, bubbles: [first.bubbles[0]!, { ...first.bubbles[0]! }] }, ...output.topics.slice(1)] },
      plan,
      chart,
    );
    expect(issues.join()).toContain("반복");
  });

  it("설명 말풍선에는 근거 연결이 필요하다", () => {
    expect(checkNarration(withFirstBubble("설명이에요.", { refs: [] }), plan, chart).join()).toContain("근거 연결");
  });
});

describe("후속 답변 검사", () => {
  it("관련 없는 질문은 내용 검사를 하지 않는다", () => {
    expect(checkFollowup({ relevance: "unrelated", answer: "", refs: [] }, plan, chart)).toEqual([]);
  });

  it("없는 근거와 만들어 낸 날짜를 거부한다", () => {
    expect(checkFollowup({ relevance: "related", answer: "좋아요.", refs: ["s99"] }, plan, chart).join()).toContain("없는 근거");
    expect(checkFollowup({ relevance: "related", answer: "2028년에 좋아져요.", refs: ["s1"] }, plan, chart).join()).toContain("날짜");
  });

  it("다른 주제의 근거도 후속 답변에서는 쓸 수 있다", () => {
    expect(checkFollowup({ relevance: "related", answer: "강점을 일에 이렇게 쓰면 돼요.", refs: ["s1", "s3", "f1"] }, plan, chart)).toEqual([]);
  });
});
