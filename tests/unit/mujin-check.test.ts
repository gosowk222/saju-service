import { describe, expect, it } from "vitest";
import { buildCheckContext, checkDraftSection, checkVoiceSection, luckYears, timingDatesOf, usesTiming, type MujinCheckContext } from "@/domain/mujin/check";
import { EMPTY_NOW } from "@/domain/mujin/now";
import {
  MUJIN_PLAN_VERSION,
  type MujinLuck,
  type MujinMaterial,
  type MujinMonths,
  type MujinPlan,
  type MujinSectionPlan,
  type ScrollBlock,
  type ScrollDraftContent,
  type ScrollSectionContent,
} from "@/domain/mujin/types";
import { issueSummary } from "@/domain/reading/check";
import type { ChartElement, ChartView } from "@/domain/reading/types";

/** 무진 족자 장 단위 검사. 정확히 비교할 수 있는 값만 보고, 말투·말버릇·어미 개수와 길이로는 실패시키지 않는다. */

const symbol = (ko: string, hanja: string, element: ChartElement, tenGod: string | null = null) => ({ ko, hanja, element, tenGod });

/** 기사 일주. 캐릭터 이름 '무진 도사'와 같은 글자인 무진(戊辰) 기둥은 이 원국에 없다. */
const chart: ChartView = {
  pillars: [
    { key: "hour", label: "시주", stem: symbol("경", "庚", "금", "상관"), branch: symbol("오", "午", "화", "편인") },
    { key: "day", label: "일주", stem: symbol("기", "己", "토"), branch: symbol("사", "巳", "화", "정인") },
    { key: "month", label: "월주", stem: symbol("신", "辛", "금", "식신"), branch: symbol("유", "酉", "금", "식신") },
    { key: "year", label: "연주", stem: symbol("무", "戊", "토", "겁재"), branch: symbol("인", "寅", "목", "정관") },
  ],
  dayMaster: { ko: "기", hanja: "己", element: "토" },
  elementPercent: { 목: 10, 화: 15, 토: 25, 금: 45, 수: 5 },
  hourKnown: true,
  status: "complete",
  notes: [],
};

const judgment = (ref: string, questionIds: string[], text: string, extra: Partial<MujinMaterial> = {}): MujinMaterial => ({
  ref,
  kind: "judgment",
  questionIds,
  text,
  scope: "natal",
  status: "candidate",
  ruleId: "first-overview.temperament",
  ruleVersion: "3.1.0",
  conclusionId: `conclusion-${ref}`,
  ...extra,
});

const question = (id: string, refs: string[]) => ({ id, title: "이 장에서 답할 질문", status: "adopted" as const, refs, note: null });

const section = (sectionId: string, tier: "free" | "paid", questions: ReturnType<typeof question>[], materials: MujinMaterial[]): MujinSectionPlan => ({
  sectionId,
  tier,
  title: "장 제목",
  questions,
  materials,
  weight: "standard",
  targetChars: { min: 650, max: 900 },
  situationNotes: [],
});

const ch1 = section(
  "ch1",
  "free",
  [question("1-1", ["m1"]), question("1-2", ["m1"]), question("1-3", ["m2"]), question("1-4", ["m3", "m4"])],
  [
    judgment("m1", ["1-1", "1-2"], "스스로 정한 기준을 지키는 쪽에 무게가 실려요.", { basis: ["비겁 30%, 식상 40%"] }),
    judgment("m2", ["1-3"], "요구가 몰리면 혼자 끝내려는 편이에요.", {
      weakness: { what: "혼자 떠안기", when: "요구가 몰릴 때", cost: "일정이 밀린다", change: "나눌 일을 먼저 정한다" },
    }),
    judgment("m3", ["1-4"], "끝낸 일을 적어 두면 범위를 정하기 쉬워요.", { action: "하루 10분 동안 끝낸 일을 적는다." }),
    judgment("m4", ["1-4"], "기준이 흐려지면 판단이 늦어져요.", { caveats: ["태어난 시각의 경계값 근처라 단정하지 않는다."] }),
  ],
);

const ch3 = section(
  "ch3",
  "paid",
  [question("3-1", ["m5"]), question("3-2", ["m5"]), question("3-3", ["m6"]), question("3-4", ["m5"])],
  [
    judgment("m5", ["3-1", "3-2", "3-4"], "역할이 분명한 환경에서 힘을 써요."),
    judgment("m6", ["3-3"], "취업과 프리랜서를 같은 기준으로 비교해요.", {
      compare: { options: ["취업", "프리랜서"], criteria: [{ name: "역할 명확성", leaning: "first", reason: "역할이 분명하면 힘을 쓴다" }], needs: ["관련 경력"] },
    }),
  ],
);

const period = (ref: string, questionIds: string[], text: string): MujinMaterial => ({
  ref,
  kind: "period",
  questionIds,
  text,
  scope: "period",
  status: "candidate",
  ruleId: "first-overview.timing",
  ruleVersion: "3.1.0",
  conclusionId: `conclusion-${ref}`,
  periodId: "monthly:2026-12",
  evidence: { supporting: ["period:monthly:2026-12:branch"], counter: [], contextual: [] },
});

const ch9 = section("ch9", "paid", [question("9-1", ["m7"]), question("9-2", ["m7"]), question("9-3", ["m7"]), question("9-4", ["m7"])], [
  period("m7", ["9-1", "9-2", "9-3", "9-4"], "현재 대운은 재성 계열이라 수입 활동과 비용 관리를 다루는 구간이에요."),
]);

const ch10 = section("ch10", "paid", [question("10-1", ["m8"]), question("10-2", ["m8"]), question("10-3", ["m8"]), question("10-4", ["m8"])], [
  period("m8", ["10-1", "10-2", "10-3", "10-4"], "2026년 12월에는 일 분야의 표지가 들어와요."),
]);

const luck: MujinLuck = {
  status: "available",
  reason: null,
  referenceAt: "2026-11-12T12:00:00+09:00",
  previous: { periodId: "decade:a", label: "13세부터", startsAt: "2009-03-01T00:00:00+09:00", endsAt: "2019-03-01T00:00:00+09:00", approximate: true, ganzhi: "임술", stemTenGod: "정재", stemFamily: "wealth" },
  current: { periodId: "decade:b", label: "23세부터", startsAt: "2019-03-01T00:00:00+09:00", endsAt: "2029-03-01T00:00:00+09:00", approximate: true, ganzhi: "계해", stemTenGod: "편재", stemFamily: "wealth" },
  next: { periodId: "decade:c", label: "33세부터", startsAt: "2029-03-01T00:00:00+09:00", endsAt: "2039-03-01T00:00:00+09:00", approximate: true, ganzhi: "갑자", stemTenGod: "정관", stemFamily: "authority" },
};

const month = (id: string, label: string, startsOn: string, endsOn: string, startedBeforeReference = false) => ({
  periodId: id,
  label,
  startsOn,
  endsOn,
  startedBeforeReference,
  cells: [{ domain: "career" as const, tone: "positive" as const, markers: [{ tone: "positive", text: "일을 넓힐 표지", activity: "지원 자료 정비" }] }],
});

const months: MujinMonths = {
  status: "available",
  window: { startMonth: "2026-11", endMonth: "2027-01", label: "2026년 11월~2027년 1월" },
  months: [
    month("monthly:2026-11", "2026년 11월", "2026-11-07", "2026-12-06", true),
    month("monthly:2026-12", "2026년 12월", "2026-12-07", "2027-01-04"),
    month("monthly:2027-01", "2027년 1월", "2027-01-05", "2027-02-03"),
  ],
  notable: [{ domain: "career", periodIds: ["monthly:2026-12"] }],
  careful: [],
  limitations: ["절기 기준 월이라 달력의 1일과 경계가 다르다."],
};

const plan: MujinPlan = {
  planVersion: MUJIN_PLAN_VERSION,
  productId: "mujin-overview",
  productVersion: "1.0.0",
  personaId: "mujin",
  personaVersion: "1.0.0",
  rulesets: [{ id: "first-overview", version: "3.1.0", reviewStatus: "unreviewed" }],
  tagCatalogVersion: "mujin-tags-1.0.0",
  nickname: "달빛",
  gender: "female",
  hourKnown: true,
  coverageNotes: [],
  now: { ...EMPTY_NOW, work: ["employed"] },
  nowFacts: [{ ref: "u1", kind: "user-fact", questionIds: [], text: "직장에 다니는 중", scope: "user", source: "now-selection", factKind: "current" }],
  facts: [{ ref: "f1", kind: "engine-fact", questionIds: ["P02"], text: "일간은 기토(己土)이고 금 기운이 45%로 가장 많아요.", scope: "natal" }],
  tables: {
    elements: { counts: { 목: 1, 화: 2, 토: 2, 금: 3, 수: 0 }, percents: { 목: 10, 화: 15, 토: 25, 금: 45, 수: 5 } },
    stages: [],
    tenGods: { cells: [], families: { peer: 30, output: 40, wealth: 5, authority: 10, resource: 15 } },
  },
  sections: [ch1],
};

const questionMaterials: MujinMaterial[] = [
  { ref: "qm1", kind: "user-fact", questionIds: [], text: "프리랜서를 고민하고 있다", scope: "user", source: "concern", factKind: "plan" },
];

const context: MujinCheckContext = buildCheckContext({
  plan,
  sections: [ch1, ch3, ch9, ch10],
  questionMaterials,
  chart,
  timing: { luck, months },
  excluded: [{ summary: "옆집 사람의 사주도 같이 봐 주세요", domain: "other-person" }],
});

const block = (type: ScrollBlock["type"], questionIds: string[], refs: string[], text: string, items: ScrollBlock["items"] = []): ScrollBlock => ({
  type,
  questionIds,
  refs,
  text,
  items,
});

const ch1Draft: ScrollDraftContent = {
  sectionId: "ch1",
  coreAnswer: "스스로 정한 기준을 지키는 쪽에 무게가 실린다.",
  blocks: [
    block("paragraph", ["1-1", "1-2"], ["m1", "f1"], "비겁 30%와 식상 40%가 함께 있어 기준을 세우고 꾸준히 밀고 가는 편이다."),
    block("condition", ["1-3"], ["m2"], "요구가 몰리면 혼자 다 끝내려다 일정이 밀릴 수 있다."),
    block("apply", ["1-4"], ["m3", "u1"], "직장에서 하루 10분씩 끝낸 일을 적어 두면 범위를 넓히기 전에 멈출 수 있다."),
    block("checklist", ["1-4"], [], "", [{ label: "", text: "이번 주에 혼자 떠안은 일이 있었는가" }]),
  ],
  scenes: ["퇴근 뒤 할 일 목록을 정리하는 장면"],
};

/** 초안의 블록을 합치고 순서를 바꾼 무진 문장. 직설적인 지적과 건조한 농담, '무진 도사'라는 이름이 들어 있다. */
const ch1Voice: ScrollSectionContent = {
  sectionId: "ch1",
  coreAnswer: "달빛 님은 스스로 정한 기준을 지키는 쪽에 무게가 실립니다.",
  blocks: [
    block(
      "paragraph",
      ["1-1", "1-2"],
      ["m1", "f1"],
      "원국을 펼쳐 보면 비겁 30%와 식상 40%가 먼저 눈에 들어옵니다. 무진 도사가 보기에 이건 꽤 믿을 만한 고집이죠. 솔직히 말씀드리면, 이 고집 덕분에 손해도 꽤 보셨을 겁니다.",
    ),
    block(
      "condition",
      ["1-3", "1-4"],
      ["m2", "m3", "u1"],
      "요구가 한꺼번에 몰리면 혼자 다 끝내려다 일정이 밀리기 쉽습니다. 직장에서 하루 10분씩 끝낸 일을 적어 두시면 범위를 넓히기 전에 멈출 수 있어요. 차가 식기 전에 끝나는 일은 생각보다 적거든요.",
    ),
    block("checklist", ["1-4"], [], "", [{ label: "", text: "이번 주에 혼자 떠안은 일이 있었는지 확인해 보세요." }]),
  ],
};

const ch10Draft: ScrollDraftContent = {
  sectionId: "ch10",
  coreAnswer: "앞으로 12개월은 일 분야에서 준비할 거리가 먼저 보인다.",
  blocks: [
    block("paragraph", ["10-1", "10-2"], ["m8"], "2026년 12월에는 일 분야의 표지가 들어와 지원 자료를 정비하기 좋다."),
    block("condition", ["10-3", "10-4"], ["m8", "qm1"], "11월은 이미 시작된 달이라 남은 날만 본다. 표지가 있다고 결과가 정해지지는 않는다."),
  ],
  scenes: [],
};

const ch9Draft: ScrollDraftContent = {
  sectionId: "ch9",
  coreAnswer: "지금은 수입 활동과 비용 관리를 다루는 구간이다.",
  blocks: [
    block("paragraph", ["9-1", "9-2"], ["m7"], "현재 대운 구간은 2019년부터 2029년까지 이어지고 재성 계열이다."),
    block("compare", ["9-3", "9-4"], ["m7"], "같은 칸끼리 비교한다.", [
      { label: "직전 구간", text: "2009년부터 이어진 같은 재성 계열 구간" },
      { label: "다음 구간", text: "2029년부터 관성 계열로 바뀐다" },
    ]),
  ],
  scenes: [],
};

const withBlock = <T extends ScrollSectionContent>(content: T, index: number, patch: Partial<ScrollBlock>): T => ({
  ...content,
  blocks: content.blocks.map((item, at) => (at === index ? { ...item, ...patch } : item)),
});

describe("초안 검사 (Pass 1)", () => {
  it("정상 초안은 통과한다 (공통 사실·지금의 나·질문 재료 ref는 어느 장에서든 쓸 수 있다)", () => {
    expect(checkDraftSection(ch1Draft, ch1, context)).toEqual([]);
    expect(checkDraftSection(ch10Draft, ch10, context)).toEqual([]);
    expect(checkDraftSection(ch9Draft, ch9, context)).toEqual([]);
  });

  it("장의 질문에 답한 블록이 없으면 잡는다", () => {
    const missing = { ...ch1Draft, blocks: ch1Draft.blocks.filter((item) => !item.questionIds.includes("1-3")) };
    expect(checkDraftSection(missing, ch1, context)).toContain("ch1: 질문에 답한 블록이 없습니다 (1-3).");
  });

  it("모르는 ref와 다른 장의 재료 ref, 이 장에 없는 질문 ID를 잡는다", () => {
    expect(checkDraftSection(withBlock(ch1Draft, 0, { refs: ["m99"] }), ch1, context)).toContain("ch1 블록 1: 이 장에서 쓸 수 없는 근거를 참조했습니다 (m99).");
    expect(checkDraftSection(withBlock(ch1Draft, 0, { refs: ["m5"] }), ch1, context)).toContain("ch1 블록 1: 이 장에서 쓸 수 없는 근거를 참조했습니다 (m5).");
    expect(checkDraftSection(withBlock(ch1Draft, 0, { questionIds: ["1-1", "1-2", "3-1"] }), ch1, context)).toContain("ch1 블록 1: 이 장에 없는 질문 ID입니다 (3-1).");
  });

  it("장 ID, 핵심 답, 블록 수와 블록 종류별 형식을 본다", () => {
    expect(checkDraftSection({ ...ch1Draft, sectionId: "ch2" }, ch1, context)).toContain("ch1: 장 ID가 계획과 다릅니다 (ch2).");
    expect(checkDraftSection({ ...ch1Draft, coreAnswer: " " }, ch1, context)).toContain("ch1: 핵심 답이 비어 있습니다.");
    expect(checkDraftSection({ ...ch1Draft, blocks: [] }, ch1, context)).toContain("ch1: 블록이 없습니다.");
    expect(checkDraftSection(withBlock(ch1Draft, 1, { text: "" }), ch1, context)).toContain("ch1 블록 2: 블록의 글이 비어 있습니다.");
    expect(checkDraftSection(withBlock(ch1Draft, 1, { items: [{ label: "", text: "항목" }] }), ch1, context)).toContain(
      "ch1 블록 2: 비교·점검이 아닌 블록에 항목을 넣었습니다.",
    );
    expect(checkDraftSection(withBlock(ch1Draft, 3, { items: [] }), ch1, context)).toContain("ch1 블록 4: 점검 항목이 없습니다.");
    const compare = withBlock(ch9Draft, 1, { items: [{ label: "직전 구간", text: "재성 계열" }] });
    expect(checkDraftSection(compare, ch9, context)).toContain("ch9 블록 2: 비교 항목이 두 개보다 적습니다.");
    const unnamed = withBlock(ch9Draft, 1, { items: [{ label: "", text: "재성 계열" }, { label: "다음 구간", text: "" }] });
    expect(checkDraftSection(unnamed, ch9, context)).toEqual(
      expect.arrayContaining(["ch9 블록 2: 비교 항목의 이름이 비어 있습니다.", "ch9 블록 2: 비교 항목의 설명이 비어 있습니다."]),
    );
  });

  it("날짜는 9·10장에서만, 기간 자료에 있는 달과 대운 시작·끝 연도만 허용한다", () => {
    const dated = (content: ScrollDraftContent, text: string) => withBlock(content, 0, { text });
    expect(checkDraftSection(dated(ch1Draft, "2027년 3월부터 기준이 흔들릴 수 있다."), ch1, context).join()).toContain("분석하지 않은 기간을 말했습니다");
    expect(checkDraftSection(dated(ch1Draft, "3월에는 일정이 몰린다."), ch1, context).join()).toContain("분석하지 않은 달을 말했습니다");
    expect(checkDraftSection(dated(ch10Draft, "2027년 1월에도 같은 표지가 이어진다."), ch10, context)).toEqual([]);
    expect(checkDraftSection(dated(ch10Draft, "2028년 5월에는 표지가 있다."), ch10, context).join()).toContain("분석하지 않은 기간을 말했습니다");
    expect(checkDraftSection(dated(ch10Draft, "12월 7일부터 다음 달이 시작된다."), ch10, context)).toEqual([]);
    expect(checkDraftSection(dated(ch10Draft, "12월 20일에 지원한다."), ch10, context).join()).toContain("근거 없는 날짜가 있습니다");
    expect(checkDraftSection(dated(ch9Draft, "2029년에 다음 구간으로 넘어간다."), ch9, context)).toEqual([]);
    expect(checkDraftSection(dated(ch9Draft, "2031년에 큰 변화가 온다."), ch9, context).join()).toContain("분석하지 않은 연도를 말했습니다");
    // 대운 경계는 근사값이라 연도만 허용한다.
    expect(checkDraftSection(dated(ch9Draft, "2029년 3월에 구간이 바뀐다."), ch9, context).join()).toContain("분석하지 않은 기간을 말했습니다");
  });

  it("기간 자료가 없으면(무료 단계) 재료 문장에 이미 있는 날짜 말고는 어느 장에서도 날짜를 허용하지 않는다", () => {
    const free = buildCheckContext({ plan, sections: [ch1, ch10], questionMaterials, chart, timing: null, excluded: [] });
    // '2026년 12월'은 10장 재료 문장에 있어 다시 말할 수 있고, '11월'은 기간 자료가 없어 허용하지 않는다.
    expect(checkDraftSection(ch10Draft, ch10, free)).toEqual(["ch10 블록 2: 분석하지 않은 달을 말했습니다: 11월"]);
  });

  it("계산에 없는 비율, 금액, 확률, 결과 단정, 진단·매매 지시, 강한 욕설을 잡는다", () => {
    const said = (text: string) => checkDraftSection(withBlock(ch1Draft, 0, { text }), ch1, context).join("\n");
    expect(said("금 기운이 45%로 가장 많다.")).toBe("");
    expect(said("금 기운이 47%로 가장 많다.")).toContain("계산에 없는 비율입니다: 47%");
    expect(said("한 달에 30만 원씩 모으면 된다.")).toContain("근거 없는 금액이 있습니다");
    expect(said("이 판단이 맞을 확률이 높다.")).toContain("확률 표현이 있습니다");
    expect(said("내년에는 취업합니다.")).toContain("결과를 단정하거나 진단·매매를 지시했습니다");
    expect(said("지금 매수하세요.")).toContain("결과를 단정하거나 진단·매매를 지시했습니다");
    expect(said("병신 같은 습관이다.")).toContain("강한 욕설이나 비속어가 있습니다");
  });

  it("핵심 답과 비교·점검 항목의 글도 같은 문장 검사를 받는다", () => {
    expect(checkDraftSection({ ...ch1Draft, coreAnswer: "2027년 3월에 크게 바뀐다." }, ch1, context).join()).toContain("ch1 핵심 답: 분석하지 않은 기간을 말했습니다");
    const items = withBlock(ch1Draft, 3, { items: [{ label: "", text: "통장에 100만 원이 있는가" }] });
    expect(checkDraftSection(items, ch1, context).join()).toContain("ch1 블록 4: 근거 없는 금액이 있습니다");
  });

  it("범위 밖으로 뺀 질문이 다시 나오면 잡는다", () => {
    const issues = checkDraftSection(withBlock(ch1Draft, 0, { text: "옆집 사람의 사주도 같이 봐 주세요라고 하셨는데" }), ch1, context);
    expect(issues).toContain("ch1: 범위 밖으로 뺀 질문 문장이 다시 나왔습니다.");
  });

  it("장면을 사실처럼 쓰거나 장면에 날짜를 넣으면 잡는다", () => {
    const scene = (text: string) => ({ ...ch1Draft, blocks: [...ch1Draft.blocks, block("scene", [], ["m2"], text)] });
    expect(checkDraftSection(scene("퇴근길에 할 일 목록을 다시 펼쳐 보는 날이 있다고 해 보자."), ch1, context)).toEqual([]);
    expect(checkDraftSection(scene("사주에 나와 있듯 퇴근길에 목록을 펼친다."), ch1, context)).toContain("ch1 블록 5: 장면을 사실처럼 표현했습니다.");
    expect(checkDraftSection(scene("5월의 어느 퇴근길에 목록을 펼친다."), ch1, context)).toContain("ch1 블록 5: 장면에 날짜를 넣었습니다.");
  });
});

describe("최종문 검사 (Pass 2)", () => {
  it("블록을 합치고 순서를 바꾼 최종문은 통과한다. 말투·농담·직설 표현과 길이로는 실패시키지 않는다", () => {
    expect(checkVoiceSection(ch1Voice, ch1Draft, ch1, context)).toEqual([]);
    const long = withBlock(ch1Voice, 0, { text: `${ch1Voice.blocks[0]!.text} 그렇죠. 그렇군요. 그렇습니다.`.repeat(40) });
    expect(checkVoiceSection(long, ch1Draft, ch1, context)).toEqual([]);
  });

  it("초안이 답한 질문을 빠뜨리면 잡는다", () => {
    const dropped = withBlock(ch1Voice, 1, { questionIds: ["1-3"] });
    const checklistless = { ...dropped, blocks: dropped.blocks.slice(0, 2) };
    expect(checkVoiceSection(checklistless, ch1Draft, ch1, context)).toContain("ch1: 질문에 답한 블록이 없습니다 (1-4).");
  });

  it("초안에 없던 ref는 그 장의 재료라도 잡는다", () => {
    const issues = checkVoiceSection(withBlock(ch1Voice, 0, { refs: ["m1", "f1", "m4"] }), ch1Draft, ch1, context);
    expect(issues).toContain("ch1 블록 1: 초안에 없던 근거를 참조했습니다 (m4).");
  });

  it("초안에 없던 장면을 더하면 잡는다", () => {
    const added = { ...ch1Voice, blocks: [...ch1Voice.blocks, block("scene", [], ["m2"], "퇴근길에 목록을 다시 펼쳐 보는 날이 있다고 해 보죠.")] };
    expect(checkVoiceSection(added, ch1Draft, ch1, context)).toContain("ch1: 초안에 없던 장면을 더했습니다.");
  });

  it("새 날짜와 새 숫자를 잡는다. 초안이나 허용 목록에 있는 값은 통과한다", () => {
    const said = (content: ScrollSectionContent, draft: ScrollDraftContent, target: MujinSectionPlan, text: string) =>
      checkVoiceSection(withBlock(content, 0, { text }), draft, target, context).join("\n");
    expect(said(ch1Voice, ch1Draft, ch1, "2027년부터는 달라집니다.")).toContain("분석하지 않은 연도를 말했습니다");
    expect(said(ch1Voice, ch1Draft, ch1, "하루 20분씩 적어 두세요.")).toContain("ch1 블록 1: 초안에 없던 숫자를 썼습니다 (20).");
    expect(said(ch1Voice, ch1Draft, ch1, "3개월만 해 보시면 압니다.")).toContain("초안에 없던 숫자를 썼습니다 (3).");
    expect(said(ch1Voice, ch1Draft, ch1, "주 2회로 늘리세요.")).toContain("초안에 없던 숫자를 썼습니다 (2).");
    // 원국 표의 개수(금 3개)처럼 최종문 작성 단계가 받지 않는 재료의 숫자는 초안에 없으면 새 숫자다.
    expect(said(ch1Voice, ch1Draft, ch1, "금 글자가 3개라서 그렇습니다.")).toContain("초안에 없던 숫자를 썼습니다 (3).");
    expect(said(ch1Voice, ch1Draft, ch1, "하루 10분씩 적어 두세요.")).toBe("");
    // 장 번호(장 ID)로 자기 장을 가리키는 말은 새 숫자가 아니다.
    expect(said(ch1Voice, ch1Draft, ch1, "이번 1장에서는 기준부터 봅니다.")).toBe("");
    // 그 장에 붙은 사용자 사실의 숫자는 최종문 작성 단계도 받는 자료다.
    const withFact = { ...ch1, materials: [...ch1.materials, { ref: "m21", kind: "user-fact" as const, questionIds: ["1-3"], text: "주 4일 일한다", scope: "user" as const, source: "concern" as const, factKind: "current" as const }] };
    expect(checkVoiceSection(withBlock(ch1Voice, 0, { text: "주 4일 일하신다고 하셨죠." }), ch1Draft, withFact, context)).toEqual([]);

    const ch10Voice: ScrollSectionContent = {
      sectionId: "ch10",
      coreAnswer: "앞으로 12개월은 일 분야에서 준비할 거리가 먼저 보입니다.",
      blocks: [
        block("paragraph", ["10-1", "10-2"], ["m8"], "2026년 12월에는 일 분야의 표지가 들어옵니다. 지원 자료를 정비해 두기 좋은 달이죠."),
        block("condition", ["10-3", "10-4"], ["m8", "qm1"], "11월은 이미 시작된 달이라 남은 날만 봅니다. 표지가 있다고 결과가 정해지지는 않습니다."),
      ],
    };
    expect(checkVoiceSection(ch10Voice, ch10Draft, ch10, context)).toEqual([]);
    // 초안에 없어도 기간 자료에 있는 달은 허용 목록에 있다 (초안이나 허용 집합).
    expect(said(ch10Voice, ch10Draft, ch10, "2027년 1월에도 표지가 이어집니다.")).toBe("");
    expect(said(ch10Voice, ch10Draft, ch10, "2029년 1월에 다시 봅니다.")).toContain("분석하지 않은 기간을 말했습니다");
    // 9장의 나이 라벨은 기간 자료의 숫자다.
    const ch9Voice: ScrollSectionContent = {
      sectionId: "ch9",
      coreAnswer: "지금은 수입 활동과 비용 관리를 다루는 구간입니다.",
      blocks: [
        block("paragraph", ["9-1", "9-2"], ["m7"], "23세부터 시작된 지금 구간은 2019년부터 2029년까지 이어집니다."),
        block("compare", ["9-3", "9-4"], ["m7"], "같은 칸끼리 놓고 보죠.", [
          { label: "직전 구간", text: "2009년부터 이어진 같은 재성 계열 구간" },
          { label: "다음 구간", text: "2029년부터 관성 계열로 바뀝니다" },
        ]),
      ],
    };
    expect(checkVoiceSection(ch9Voice, ch9Draft, ch9, context)).toEqual([]);
  });

  it("최종문도 장 ID·형식·범위 밖 재유입·계산값 검사를 받는다", () => {
    expect(checkVoiceSection({ ...ch1Voice, sectionId: "ch3" }, ch1Draft, ch1, context)).toContain("ch1: 장 ID가 계획과 다릅니다 (ch3).");
    expect(checkVoiceSection(withBlock(ch1Voice, 2, { items: [] }), ch1Draft, ch1, context)).toContain("ch1 블록 3: 점검 항목이 없습니다.");
    expect(checkVoiceSection(withBlock(ch1Voice, 0, { text: "옆집 사람의 사주도 같이 봐 주세요라는 말씀은" }), ch1Draft, ch1, context)).toContain(
      "ch1: 범위 밖으로 뺀 질문 문장이 다시 나왔습니다.",
    );
    expect(checkVoiceSection(withBlock(ch1Voice, 0, { text: "일간이 갑목이라 곧게 뻗습니다." }), ch1Draft, ch1, context).join()).toContain("일간을 계산값(기)과 다르게 설명했습니다");
  });
});

describe("캐릭터 이름 '무진 도사'와 무진(戊辰) 기둥", () => {
  it("이름은 기둥이나 글자로 잡지 않고, '무진 일주'처럼 기둥 이름이 붙을 때만 계산값과 비교한다", () => {
    const said = (target: MujinCheckContext, text: string) => checkVoiceSection(withBlock(ch1Voice, 0, { text }), ch1Draft, ch1, target).join("\n");
    for (const text of ["무진 도사가 보기에는 기준을 세우는 힘이 먼저입니다.", "저 무진이 일주를 보니 기준이 먼저 보입니다.", "무진 도사의 신당에서는 차가 자주 식습니다."]) {
      expect(said(context, text)).toBe("");
    }
    expect(said(context, "무진 일주라서 기준이 단단합니다.")).toContain("기둥을 계산값과 다르게 설명했습니다");

    const mujinDay: ChartView = {
      ...chart,
      pillars: chart.pillars.map((pillar) => (pillar.key === "day" ? { ...pillar, stem: symbol("무", "戊", "토"), branch: symbol("진", "辰", "토", "비견") } : pillar)),
      dayMaster: { ko: "무", hanja: "戊", element: "토" },
    };
    const own = buildCheckContext({ plan, sections: [ch1], chart: mujinDay, timing: null, excluded: [] });
    expect(said(own, "무진 일주라서 기준이 단단합니다. 무진 도사도 같은 일주는 반갑네요.")).toBe("");
  });
});

describe("검사 기준", () => {
  it("기간 자료의 날짜를 쓰는 장은 9·10장과 기간 판단 재료(kind period)를 받은 장이다", () => {
    expect([ch1, ch3, ch9, ch10].map(usesTiming)).toEqual([false, false, true, true]);
    expect(usesTiming({ ...ch3, materials: [...ch3.materials, period("m9", ["3-4"], "2026년 12월 표지")] })).toBe(true);
  });

  it("재료 문장에 이미 있는 날짜(사용자가 말한 날짜, 마지막 정리가 받은 9·10장의 핵심 답)는 다시 말할 수 있다", () => {
    const planned: MujinMaterial = { ref: "m20", kind: "user-fact", questionIds: ["3-4"], text: "내년 3월에 이직할 계획이다", scope: "user", source: "concern", factKind: "plan" };
    const ch3WithFact = { ...ch3, materials: [...ch3.materials, planned] };
    const ch3Draft: ScrollDraftContent = {
      sectionId: "ch3",
      coreAnswer: "역할이 분명한 환경에서 힘을 쓴다.",
      blocks: [
        block("paragraph", ["3-1", "3-2", "3-4"], ["m5", "m20"], "3월에 이직할 계획이라면 역할이 분명한지부터 확인한다."),
        block("compare", ["3-3"], ["m6"], "같은 기준으로 본다.", [
          { label: "취업", text: "역할이 분명하다" },
          { label: "프리랜서", text: "역할을 스스로 정한다" },
        ]),
      ],
      scenes: [],
    };
    const local = buildCheckContext({ plan, sections: [ch3WithFact], chart, timing: { luck, months }, excluded: [] });
    expect(checkDraftSection(ch3Draft, ch3WithFact, local)).toEqual([]);
    expect(checkDraftSection(withBlock(ch3Draft, 0, { text: "4월에 이직하면 좋다." }), ch3WithFact, local).join()).toContain("분석하지 않은 달을 말했습니다");
    // 연도 없이 말한 달은 연도를 붙여 허용하지 않는다.
    expect(checkDraftSection(withBlock(ch3Draft, 0, { text: "2027년 3월에 이직할 계획이라면" }), ch3WithFact, local).join()).toContain("분석하지 않은 기간을 말했습니다");

    // 마지막 정리: 질문 ID가 사용자 질문의 ref이고, 9·10장의 핵심 답을 scope period 재료로 받는다.
    const closing = section("closing", "paid", [{ id: "q1", title: "프리랜서를 언제 준비할지", status: "adopted", refs: ["q1", "m30"], note: null }], [
      { ref: "m30", kind: "derived", questionIds: ["q1"], text: "2026년 12월에는 직업 분야에서 지원 자료를 정비하기 좋다.", scope: "period", parentRefs: ["ch10"] },
    ]);
    expect(usesTiming(closing)).toBe(false);
    const closingDraft: ScrollDraftContent = {
      sectionId: "closing",
      coreAnswer: "지원 자료부터 정비한다.",
      blocks: [block("paragraph", ["q1"], ["q1", "m30"], "10장에서 본 대로 2026년 12월에는 지원 자료를 정비하기 좋다.")],
      scenes: [],
    };
    const withClosing = buildCheckContext({ plan, sections: [closing], chart, timing: { luck, months }, excluded: [] });
    expect(checkDraftSection(closingDraft, closing, withClosing)).toEqual([]);
    // 기간 자료에는 있지만 마지막 정리가 받은 핵심 답에는 없는 달은 새 날짜다.
    expect(checkDraftSection(withBlock(closingDraft, 0, { text: "2027년 1월에도 기회가 있다." }), closing, withClosing).join()).toContain("분석하지 않은 기간을 말했습니다");
  });

  it("사용자 질문의 ref는 그 질문을 이어 받은 장(질문 refs)이나 생성 입력의 questions로 넘긴 경우 블록 refs에 쓸 수 있다", () => {
    const linked = { ...ch1, questions: ch1.questions.map((item) => (item.id === "1-1" ? { ...item, refs: ["q1", ...item.refs] } : item)) };
    const cited = withBlock(ch1Draft, 0, { refs: ["q1", "m1", "f1"] });
    expect(checkDraftSection(cited, ch1, context)).toContain("ch1 블록 1: 이 장에서 쓸 수 없는 근거를 참조했습니다 (q1).");
    expect(checkDraftSection(cited, linked, context)).toEqual([]);
    const withQuestions = buildCheckContext({ plan, sections: [ch1], questions: [{ ref: "q1" }], chart, timing: null, excluded: [] });
    expect(checkDraftSection(cited, ch1, withQuestions)).toEqual([]);
  });

  it("허용 날짜는 12개월의 달·경계일과 대운 시작·끝 연도(Asia/Seoul)다", () => {
    const dates = timingDatesOf({ luck, months });
    expect([...dates.months].sort()).toEqual(["2026-11", "2026-12", "2027-1"]);
    expect([...dates.years].sort()).toEqual(["2009", "2019", "2026", "2027", "2029", "2039"]);
    expect(dates.days.has("11-7")).toBe(true);
    // UTC 자정 전후에 걸친 경계도 서울 날짜의 연도로 읽는다.
    expect(luckYears({ startsAt: "2018-12-31T16:00:00Z", endsAt: "2028-12-31T16:00:00Z" })).toEqual({ startYear: "2019", endYear: "2029" });
    expect(timingDatesOf(null).years.size).toBe(0);
  });

  it("허용 ref와 비율은 장별·계획 전체 재료에서 만든다", () => {
    expect([...context.sharedRefs].sort()).toEqual(["f1", "qm1", "u1"]);
    expect([...context.sectionRefs.ch1!].sort()).toEqual(["f1", "m1", "m2", "m3", "m4", "qm1", "u1"]);
    expect(context.sectionRefs.ch3!.has("m1")).toBe(false);
    for (const value of ["10", "15", "25", "45", "5", "30", "40"]) expect(context.percents.has(value)).toBe(true);
    expect(context.percents.has("47")).toBe(false);
  });

  it("문제 문구는 기록용 요약(issueSummary)으로 줄였을 때 '…니다' 또는 '…니다 (값)'이고 생성 문장을 담지 않는다", () => {
    const sentence = "한 달에 30만 원씩 모으시면 2028년 5월에는 반드시 목돈이 생깁니다";
    const broken: ScrollDraftContent = {
      sectionId: "ch2",
      coreAnswer: "",
      blocks: [
        block("paragraph", ["9-9"], ["m99"], sentence),
        block("compare", [], [], "", [{ label: "", text: "" }]),
        block("scene", [], [], "사주에 나와 있듯 2028년 5월에 만난다."),
      ],
      scenes: [],
    };
    const issues = [
      ...checkDraftSection(broken, ch1, context),
      ...checkVoiceSection({ ...broken, blocks: [...broken.blocks, block("apply", [], ["m4"], "하루 25분씩")] }, ch1Draft, ch1, context),
    ];
    expect(issues.length).toBeGreaterThan(10);
    for (const issue of issues) {
      const summary = issueSummary(issue);
      expect(summary).toMatch(/니다(\s*\([^)]{0,20}\))?$/);
      expect(summary).not.toContain(sentence.slice(0, 15));
    }
  });
});
