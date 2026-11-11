import { describe, expect, it } from "vitest";
import { MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkNarrationV2 } from "@/domain/reading/check";
import { splitEmphasis } from "@/domain/reading/emphasis";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { buildQuestionAnalysis, emptyAnalysis } from "@/domain/reading/question";
import type { NarrationOutputV2 } from "@/domain/reading/types";
import { analyzeBirth, toPublicBirthInput } from "@/server/engine/analyze";
import { toStoredMessages } from "@/server/llm/narrate";
import { buildFollowupPrompt, CURRENT_READING_PROMPT, getNarrationSchema, getReadingPrompt, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";

/**
 * 묘묘 1.1.0 / reading-2.6.0의 코드 경로 확인. 가짜 입력과 정해 둔 문장으로 확인하며, 실제 모델의 문장 품질과는 무관하다
 * (실제 모델 확인은 LIVE_NOT_RUN, 사용자가 docs/personas/myomyo-evaluation.md의 순서로 직접 확인한다).
 */

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const birth = toPublicBirthInput({ birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place });
const analyze = (situationId: string | null, nickname = "달빛") => analyzeBirth({ birth, product: FIRST_OVERVIEW, nickname, situationId });

describe("여섯 상황 모두 같은 캐릭터 지시와, 상황과 감정을 구분할 자료를 받는다", () => {
  const situations = FIRST_OVERVIEW.situation.options.map((option) => option.id);

  it("학생, 직장인, 취업 준비, 자영업·프리랜서, 가사·육아, 쉬는 중이 모두 있다", () => {
    expect(situations).toEqual(["student", "employee", "job-seeking", "self-employed", "homemaker", "resting"]);
  });

  it.each(situations)("%s: 캐릭터 설정이 맨 앞에 오고, 고른 상황은 출처가 situation인 일반 맥락으로 들어간다", (situationId) => {
    const { plan: base } = analyze(situationId);
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
    const { instructions, input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });
    const parsed = JSON.parse(input) as { situation: { label: string; context: string }; userContext: { from: string; text: string }[]; topics: { topicId: string }[] };
    const option = FIRST_OVERVIEW.situation.options.find((item) => item.id === situationId)!;
    expect(instructions.startsWith("[캐릭터]")).toBe(true);
    expect(instructions).toContain("context에 적힌 걱정거리(예: 생활비와 불안 관리)는 그 상황에서 흔한 주제일 뿐 이 사용자가 말한 감정이 아니다");
    expect(parsed.situation).toEqual({ label: option.label, context: option.context });
    // 궁금한 점이 없으면 사용자가 말한 감정은 없다. 고른 상황만 출처 situation으로 들어간다.
    expect(parsed.userContext).toEqual([{ ref: "u1", text: `사용자가 고른 현재 상황: ${option.label}`, from: "situation" }]);
    // 아홉 주제가 모두 있다.
    expect(parsed.topics).toHaveLength(9);
  });

  it("상황 맥락에 '불안'이 있어도 사용자가 말한 감정으로 넘기지 않고, 궁금한 점에 직접 적은 지친 마음만 출처 concern으로 넘긴다", () => {
    const jobSeeking = FIRST_OVERVIEW.situation.options.find((option) => option.id === "job-seeking")!;
    expect(jobSeeking.context).toContain("불안");
    const { plan: base } = analyze("job-seeking");
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-11", {
      items: [{ summary: "언제쯤 취업할 수 있을지", domain: "career", intent: "timing", options: [], period: { kind: "default", start: "", end: "" }, missingInfo: [] }],
      userFacts: [{ text: "요즘 면접에서 계속 떨어져 많이 지쳐 있다고 말함", domain: "temperament" }],
      needsClarification: false,
    });
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis, timing: [] });
    const { input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });
    const parsed = JSON.parse(input) as { userContext: { from: string; text: string }[] };
    expect(parsed.userContext.map((item) => item.from)).toEqual(["situation", "concern"]);
    expect(parsed.userContext[0]!.text).not.toContain("불안");
    expect(parsed.userContext[1]!.text).toContain("지쳐");
  });
});

describe("작성 재료의 중복 덜어 내기 (reading-2.7.0, followup-2.7.0)", () => {
  const { plan: base } = analyze("job-seeking");
  const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
  type InputStatement = { ref: string; text: string; weakness: unknown; action: unknown; basis: string[]; caveats: string[]; lore?: string[] };
  const input = JSON.parse(getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] }).input) as {
    commonCaveats: string[];
    topics: { topicId: string; statements: InputStatement[] }[];
  };
  const original = plan.topics.flatMap((topic) => topic.statements);
  const given = input.topics.flatMap((topic) => topic.statements);

  it("같은 명리 근거와 이유는 한 번만 넣는다 (원래는 여러 해석에 반복된다)", () => {
    const originalLore = original.flatMap((statement) => statement.lore ?? []);
    expect(originalLore.length).toBeGreaterThan(new Set(originalLore).size);
    const givenLore = given.flatMap((statement) => statement.lore ?? []);
    expect(givenLore.length).toBe(new Set(givenLore).size);
    const givenBasis = given.flatMap((statement) => statement.basis);
    expect(givenBasis.length).toBe(new Set(givenBasis).size);
  });

  it("뜻은 그대로다: 모든 근거·이유·주의사항이 어딘가에 한 번은 들어가고, 판단·약점·행동 제안은 바뀌지 않는다", () => {
    expect(new Set(given.flatMap((statement) => statement.lore ?? []))).toEqual(new Set(original.flatMap((statement) => statement.lore ?? [])));
    expect(new Set(given.flatMap((statement) => statement.basis))).toEqual(new Set(original.flatMap((statement) => statement.basis ?? [])));
    for (const statement of original) {
      const item = given.find((entry) => entry.ref === statement.ref)!;
      expect([item.text, item.weakness, item.action]).toEqual([statement.text, statement.weakness ?? null, statement.action ?? null]);
      for (const caveat of statement.caveats) expect([...input.commonCaveats, ...item.caveats]).toContain(caveat);
    }
    expect(given).toHaveLength(original.length);
  });

  it("후속 답변 입력도 같은 방식으로 덜어 낸다", () => {
    const statements = plan.topics.flatMap((topic) => topic.statements);
    const prompt = buildFollowupPrompt({ persona: MYOMYO, nickname: "달빛", hourKnown: true, expression: FIRST_OVERVIEW.expression, situation: null, facts: [], userContext: [], questions: [], statements, timing: [], delivered: [], lastTurn: null, previousIssues: [] });
    const parsed = JSON.parse(prompt.input) as { commonCaveats: string[]; statements: InputStatement[] };
    const lore = parsed.statements.flatMap((statement) => statement.lore ?? []);
    expect(lore.length).toBe(new Set(lore).size);
    expect(parsed.commonCaveats.length).toBeGreaterThan(0);
    expect(parsed.statements).toHaveLength(statements.length);
  });
});

describe("출력 형식 narration-2.2.0 (화면에 나가지 않는 메모 칸)", () => {
  it("메모 칸을 말풍선보다 먼저 쓰게 하고, 해석할 때는 버린다", () => {
    const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);
    const json = schema.jsonSchema as { properties: Record<string, { items?: { properties: Record<string, unknown>; required: string[] } }> };
    expect(Object.keys(json.properties)).toEqual(["opening", "focusAngle", "focus", "topics", "closing"]);
    expect(Object.keys(json.properties.topics!.items!.properties)).toEqual(["topicId", "angle", "bubbles"]);
    expect(json.properties.topics!.items!.required).toContain("angle");
    const parsed = schema.parser.parse({
      opening: "안녕",
      focusAngle: "큰돈 바라면서 정산 얘기는 피함",
      focus: [],
      topics: [{ topicId: "money", angle: "보수 얘기만 나오면 조용해짐", bubbles: [{ kind: "explanation", refs: ["s1"], text: "보수 얘기만 나오면 왜 얌전해져?", highlight: "" }] }],
      closing: "끝",
    }) as unknown as Record<string, unknown> & { topics: Record<string, unknown>[] };
    expect(parsed).not.toHaveProperty("focusAngle");
    expect(parsed.topics[0]).not.toHaveProperty("angle");
    expect(parsed.topics[0]!.bubbles).toHaveLength(1);
  });
});

describe("캐릭터 표현이 근거 확인과 저장을 깨지 않는다", () => {
  const { plan: base, chart } = analyze("job-seeking");
  const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });

  /** 주제마다 다른 말투 문장(정해 둔 문장)과 올바른 근거. 문장 품질 확인이 아니라 검사·저장 경로 확인용이다. */
  const lines = [
    "어라~? 일 얘기할 땐 신나더니 조건 얘기만 나오면 조용해지지?",
    "흥, 그건 인정. 하나 붙잡으면 끝까지 가는 건 네 무기야.",
    "으이구. 그걸 남 좋은 일에만 쓰면 아깝잖아.",
    "그러니까 이번 주에 네 몫부터 적어. 답답해서 하는 말이거든?",
  ];
  const output: NarrationOutputV2 = {
    opening: "달빛아, 왔네. 칭찬만 들으러 왔으면 좀 아쉬울걸? 😏",
    focus: [],
    topics: plan.topics.map((topic, index) => ({
      topicId: topic.topicId,
      bubbles: lines.map((line, bubble) => ({
        kind: "explanation" as const,
        refs: [topic.statements[bubble % Math.max(1, topic.statements.length)]?.ref ?? plan.base.facts[0]!.ref],
        // 같은 문장 반복 검사에 걸리지 않게 주제마다 다른 꼬리를 붙인다. 말버릇은 앞의 한 주제에만 넣는다.
        text: `${index === 0 ? line : line.replace(/^(어라~\? |흥, 그건 인정\. |으이구\. )/, "")} (${topic.title})`,
        highlight: bubble === 3 ? "이번 주에 네 몫부터 적어" : "",
      })),
    })),
    closing: "더 궁금하면 물어봐. 바보야, 아까 그 얘기도 좋고. ♡",
  };

  it("놀림·말버릇·이모티콘이 있어도 근거와 계산값이 맞으면 검사를 통과한다", () => {
    expect(checkNarrationV2(output, plan, chart, [], MYOMYO)).toEqual([]);
  });

  it("저장할 문장은 강조 표시만 더하고 말투를 바꾸거나 순화하지 않는다", () => {
    const stored = toStoredMessages(output, plan.focusSection.id);
    expect(stored[0]!.text).toBe(output.opening);
    expect(stored.at(-1)!.text).toBe(output.closing);
    const first = stored.filter((message) => message.topicId === plan.topics[0]!.topicId);
    expect(first.map((message) => message.text.replace(/\*\*/g, ""))).toEqual(output.topics[0]!.bubbles.map((bubble) => bubble.text));
    expect(first.map((message) => message.refs)).toEqual(output.topics[0]!.bubbles.map((bubble) => bubble.refs));
    // 화면(RichText)은 강조 구절만 나눠 그리고 글자는 그대로 둔다.
    for (const message of stored) expect(splitEmphasis(message.text).map((run) => run.text).join("")).toBe(message.text.replace(/\*\*/g, ""));
  });
});
