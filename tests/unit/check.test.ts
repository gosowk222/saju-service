import { describe, expect, it } from "vitest";
import { checkFollowup, checkFollowupV2, checkNarration, checkNarrationV2 } from "@/domain/reading/check";
import type { ChartView, NarrationOutput, NarrationOutputV2, NarrationPlanV2, ReadingPlan, ReadingPlanV2, TimingPeriodStatement } from "@/domain/reading/types";

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

// ─── 2.0.0 검사 ──────────────────────────────────────────────


const statementV2 = (ref: string, aspect: string, extra: Record<string, unknown> = {}) => ({
  ref,
  kind: "service-interpretation" as const,
  text: `${aspect} 해석`,
  status: "candidate" as const,
  caveats: [],
  conclusionId: `c-${ref}`,
  ruleId: "first-overview.career",
  ruleVersion: "2.0.0",
  aspect,
  basis: ["식상(표현·산출) 41%가 가장 큼"],
  weakness: { what: "마무리를 미루는 것", when: "정리만 남았을 때", cost: "평가를 잃어요", change: "마지막 10% 작업을 따로 일정에 잡아 두기" },
  ...extra,
});

const topicV2 = (topicId: string, inquiryDomain: string, refs: string[], creative = false) => ({
  topicId,
  title: topicId,
  inquiryDomain,
  status: "adopted" as const,
  limitNote: null,
  statements: refs.map((ref) => statementV2(ref, `${topicId}-${ref}`)),
  outline: [],
  depth: { light: 3, standard: 4, focus: 6 },
  weight: "standard" as const,
  target: 4,
  creativeSceneAllowed: creative,
  situationAngle: null,
});

const month = (ref: string, label: string, startsOn: string, endsOn: string): TimingPeriodStatement => ({
  ref,
  kind: "timing",
  periodId: `monthly:${startsOn.slice(0, 7)}`,
  periodKind: "monthly",
  label,
  engineLabel: label,
  startsOn,
  endsOn,
  verdict: "notable",
  statement: "표지",
  markers: [{ tone: "positive", text: "관성의 기운", activity: "지원" }],
  stageNote: null,
  selectionScore: 1,
  conclusionId: `t-${ref}`,
  ruleId: "first-overview.timing",
  ruleVersion: "2.0.0",
  supportingEvidenceIds: [],
  counterEvidenceIds: [],
  contextualEvidenceIds: [],
  caveats: [],
});

const baseV2 = {
  planVersion: "2.0.0",
  productId: "first-overview",
  productVersion: "2.0.0",
  rulesetId: "first-overview",
  rulesetVersion: "2.0.0",
  personaId: "yeoul",
  personaVersion: "2.0.0",
  nickname: "가람",
  hourKnown: false,
  gender: "female",
  coverageNotes: [],
  facts: [{ ref: "f1", kind: "engine-fact", text: "십성 계열 중 식상이 41%로 가장 큽니다.", originPath: "x" }],
  userContext: [{ ref: "u1", kind: "user-context", text: "사용자가 고른 현재 상황: 취업 준비 중", source: "situation" }],
  situation: { id: "job-seeking", label: "취업 준비 중", context: "구직" },
  topics: [],
} as unknown as ReadingPlanV2;

const planV2: NarrationPlanV2 = {
  base: baseV2,
  topics: [topicV2("work", "career", ["s1", "s2"], true), topicV2("romance", "romance", ["s3", "s4"])],
  userContext: baseV2.userContext,
  questions: [
    { ref: "q1", summary: "언제 취업할 수 있을지", domain: "career", topicId: "work", intent: "timing", options: [], answerability: "full", missingInfo: [], relatedRefs: ["s1"], timingId: "tp1", timingNote: null },
    { ref: "q2", summary: "취업과 창업 중 무엇이 맞는지", domain: "career", topicId: "work", intent: "compare", options: ["취업", "창업"], answerability: "full", missingInfo: [], relatedRefs: ["s2"], timingId: null, timingNote: null },
  ],
  timing: [
    {
      id: "tp1",
      domain: "career",
      topicId: "work",
      windowLabel: "2026년 11월부터 2027년 10월까지 (절기 기준 월)",
      explicit: false,
      status: "available",
      months: [month("t1", "2027년 3월", "2027-03-06", "2027-04-04"), month("t2", "2026년 12월", "2026-12-07", "2027-01-04")],
      years: [],
      decade: null,
      notableRefs: ["t1"],
      carefulRefs: [],
      limitations: [],
    },
  ],
  focusSection: { id: "focus", title: "궁금한 점에 대한 답" },
  length: { bubbleChars: 260, bubbleHardMax: 700, focusBubblesPerQuestion: 4, totalBubbles: { min: 6, max: 90 } },
  expression: { directness: "blunt", humor: "playful", scenes: "rich" },
};

function goodV2(): NarrationOutputV2 {
  return {
    opening: "가람 님, 오늘은 취업 고민을 중심으로 볼게요.",
    focus: [
      { kind: "explanation", refs: ["q1", "t1"], text: "결론부터 말하면 2027년 3월에 지원을 몰아 보세요. 역할과 평가의 기운이 들어오는 달이에요." },
      { kind: "explanation", refs: ["q2", "s2"], text: "취업과 창업을 같은 기준으로 놓으면 지금은 취업 쪽 조건이 더 많이 맞아요." },
    ],
    topics: [
      {
        topicId: "work",
        bubbles: [
          { kind: "explanation", refs: ["s1"], text: "약점은 마무리를 미루는 거예요. 그래서 마감 품질에서 점수를 잃어요. 마지막 10%를 따로 일정에 잡으세요." },
          { kind: "creative-scene", refs: ["s1"], text: "예를 들면 면접 전날 밤, \"이 부분은 화면으로 보여 드릴게요\" 하며 작업물을 다시 여는 장면이에요." },
        ],
      },
      {
        topicId: "romance",
        bubbles: [
          { kind: "explanation", refs: ["s3"], text: "연애에서는 호감을 숨기지 못하는 직진형이에요." },
          { kind: "explanation", refs: ["s4", "f1"], text: "서운하면 바로 말해야 풀리는 타입이에요." },
        ],
      },
    ],
    closing: "다음엔 지원할 직무를 물어봐 주세요.",
  };
}

const withTopicBubble = (text: string, patch: Partial<NarrationOutputV2["topics"][number]["bubbles"][number]> = {}): NarrationOutputV2 => {
  const output = goodV2();
  const [work, ...rest] = output.topics;
  return { ...output, topics: [{ ...work!, bubbles: [{ ...work!.bubbles[0]!, text, ...patch }, ...work!.bubbles.slice(1)] }, ...rest] };
};

describe("풀이 검사 2.0.0", () => {
  it("정상 응답은 통과하고, 직설적인 약점 표현이나 긴 설명만으로는 문제 삼지 않는다", () => {
    expect(checkNarrationV2(goodV2(), planV2, chart)).toEqual([]);
    const long = "자기 기준이 뚜렷한 만큼, 피드백을 간섭으로 받아들이는 게 약점이에요. 그러면 문제를 고칠 기회보다 내 판단을 지키는 데 힘을 써요. ".repeat(4);
    expect(long.length).toBeGreaterThan(220);
    expect(checkNarrationV2(withTopicBubble(long), planV2, chart)).toEqual([]);
  });

  it("여러 질문 중 하나라도 답하지 않으면 거부한다", () => {
    const output = goodV2();
    const issues = checkNarrationV2({ ...output, focus: [output.focus[0]!, { ...output.focus[1]!, refs: ["s2"] }] }, planV2, chart);
    expect(issues.join()).toContain("q2");
  });

  it("시기 질문에 기간 분석을 쓰지 않으면 거부한다", () => {
    const output = goodV2();
    const issues = checkNarrationV2({ ...output, focus: [{ ...output.focus[0]!, refs: ["q1", "s1"] }, output.focus[1]!] }, planV2, chart);
    expect(issues.join()).toContain("기간 분석");
  });

  it("분석한 달은 허용하고, 분석하지 않은 달이나 일 단위 날짜는 거부한다", () => {
    expect(checkNarrationV2(withTopicBubble("2026년 12월에도 서류를 다듬어 보세요."), planV2, chart)).toEqual([]);
    expect(checkNarrationV2(withTopicBubble("2028년 5월에 합격 소식이 와요."), planV2, chart).join()).toContain("분석하지 않은");
    expect(checkNarrationV2(withTopicBubble("3월 15일에 면접을 보세요."), planV2, chart).join()).toContain("날짜");
    expect(checkNarrationV2(withTopicBubble("8월에는 쉬세요."), planV2, chart).join()).toContain("분석하지 않은 달");
  });

  it("다른 주제의 해석이나 기간 판단을 근거로 쓰면 거부하고, 답변 영역은 모두 쓸 수 있다", () => {
    expect(checkNarrationV2(withTopicBubble("설명이에요.", { refs: ["s3"] }), planV2, chart).join()).toContain("없는 근거");
    const output = goodV2();
    const romance = output.topics[1]!;
    const issues = checkNarrationV2({ ...output, topics: [output.topics[0]!, { ...romance, bubbles: [{ ...romance.bubbles[0]!, refs: ["t1"] }, romance.bubbles[1]!] }] }, planV2, chart);
    expect(issues.join()).toContain("없는 근거");
  });

  it("범위 밖으로 뺀 질문이 다시 나오면 거부한다", () => {
    const excluded = [{ summary: "요즘 건강이 괜찮을지", domain: "health" as const }];
    expect(checkNarrationV2(goodV2(), planV2, chart, excluded)).toEqual([]);
    expect(checkNarrationV2(withTopicBubble("요즘 건강도 챙기세요."), planV2, chart, excluded).join()).toContain("범위 밖");
  });

  it("창작 장면을 사실처럼 쓰거나 날짜를 넣으면 거부하고, 허용하지 않은 주제의 장면도 거부한다", () => {
    const output = goodV2();
    const work = output.topics[0]!;
    const scene = (text: string) => ({ ...output, topics: [{ ...work, bubbles: [work.bubbles[0]!, { ...work.bubbles[1]!, text }] }, output.topics[1]!] });
    expect(checkNarrationV2(scene("사주에 나와 있으니 반드시 합격해요."), planV2, chart).join()).toContain("창작 장면");
    expect(checkNarrationV2(scene("예를 들면 2027년 3월의 면접장이에요."), planV2, chart).join()).toContain("날짜");
    const romance = output.topics[1]!;
    const issues = checkNarrationV2({ ...output, topics: [work, { ...romance, bubbles: [{ ...romance.bubbles[0]!, kind: "creative-scene" }, romance.bubbles[1]!] }] }, planV2, chart);
    expect(issues.join()).toContain("허용하지 않은");
  });

  it("질문이 없는데 답변 영역을 쓰거나, 주제 순서가 다르면 거부한다", () => {
    const noQuestions = { ...planV2, questions: [], timing: [] };
    expect(checkNarrationV2(goodV2(), noQuestions, chart).join()).toContain("궁금한 점이 없는데");
    const output = goodV2();
    expect(checkNarrationV2({ ...output, topics: [...output.topics].reverse() }, planV2, chart).join()).toContain("주제 구성");
  });

  it("화면이 깨질 만큼 긴 말풍선은 나눠 쓰게 한다", () => {
    expect(checkNarrationV2(withTopicBubble("가".repeat(701)), planV2, chart).join()).toContain("너무 깁니다");
  });
});

describe("후속 답변 검사 2.0.0", () => {
  const context = {
    questionRefs: ["q1", "q2"],
    knownRefs: new Set(["s1", "s2", "t1", "f1"]),
    timing: planV2.timing[0]!.months,
    percentSources: ["식상 41%"],
    excluded: [{ summary: "어떤 주식을 살지", domain: "investment" as const }],
  };

  it("소질문마다 답이 있어야 하고 없는 근거를 참조하면 거부한다", () => {
    const ok = { mode: "answer" as const, clarifyQuestion: "", sections: [{ questionRef: "q1", text: "2027년 3월에 지원해 보세요.", refs: ["t1"] }, { questionRef: "q2", text: "취업 쪽이 더 맞아요.", refs: ["s2"] }] };
    expect(checkFollowupV2(ok, context, chart)).toEqual([]);
    expect(checkFollowupV2({ ...ok, sections: ok.sections.slice(0, 1) }, context, chart).join()).toContain("q2");
    expect(checkFollowupV2({ ...ok, sections: [{ ...ok.sections[0]!, refs: ["s99"] }, ok.sections[1]!] }, context, chart).join()).toContain("없는 근거");
  });

  it("되묻기는 짧은 질문만 검사하고, 범위 밖 주제가 섞이면 거부한다", () => {
    expect(checkFollowupV2({ mode: "clarify", sections: [], clarifyQuestion: "어떤 직무를 생각하고 있나요?" }, context, chart)).toEqual([]);
    expect(checkFollowupV2({ mode: "clarify", sections: [], clarifyQuestion: "" }, context, chart).join()).toContain("비어");
    const leaked = { mode: "answer" as const, clarifyQuestion: "", sections: [{ questionRef: "q1", text: "주식은 이 종목이 좋아요.", refs: [] }, { questionRef: "q2", text: "취업이요.", refs: [] }] };
    expect(checkFollowupV2(leaked, context, chart).join()).toContain("범위 밖");
  });
});
