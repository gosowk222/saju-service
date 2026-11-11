import { describe, expect, it } from "vitest";
import { MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkNarrationV2 } from "@/domain/reading/check";
import { splitEmphasis } from "@/domain/reading/emphasis";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { writingMaterial } from "@/domain/reading/material";
import { buildQuestionAnalysis, emptyAnalysis } from "@/domain/reading/question";
import type { InterpretationStatement, NarrationOutputV2 } from "@/domain/reading/types";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { toStoredMessages } from "@/server/llm/narrate";
import {
  buildFollowupPrompt,
  buildReadingExperiment,
  CURRENT_READING_PROMPT,
  DEFAULT_EXPERIMENT,
  experimentPlan,
  getNarrationSchema,
  getReadingPrompt,
  NARRATION_SCHEMA_VERSION,
} from "@/server/llm/prompts";

/**
 * 묘묘 2.0.0 / reading-3.0.0의 코드 경로 확인. 가짜 입력과 정해 둔 문장으로 확인하며, 실제 모델의 문장 품질과는 무관하다
 * (실제 모델 확인은 LIVE_NOT_RUN, 사용자가 docs/personas/myomyo-evaluation.md의 순서로 직접 확인한다).
 */

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const birthOf = (input: Partial<AnalyzeInput> = {}) =>
  toPublicBirthInput({ birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place, ...input });
const analyze = (situationId: string | null, nickname = "달빛", input: Partial<AnalyzeInput> = {}) => analyzeBirth({ birth: birthOf(input), product: FIRST_OVERVIEW, nickname, situationId });
const promptFor = (plan: ReturnType<typeof buildNarrationPlan>, previousIssues: string[] = []) => getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues });

const question = (summary: string, domain: "career" | "romance" | "wealth", intent: "timing" | "compare" | "apply" | "explain", options: string[] = []) => ({
  summary,
  domain,
  intent,
  options,
  period: intent === "timing" ? { kind: "default" as const, start: "", end: "" } : { kind: "none" as const, start: "", end: "" },
  missingInfo: [],
});

describe("여섯 상황 모두 같은 캐릭터 지시와, 상황과 감정을 구분할 자료를 받는다", () => {
  const situations = FIRST_OVERVIEW.situation.options.map((option) => option.id);

  it("학생, 직장인, 취업 준비, 자영업·프리랜서, 가사·육아, 쉬는 중이 모두 있다", () => {
    expect(situations).toEqual(["student", "employee", "job-seeking", "self-employed", "homemaker", "resting"]);
  });

  it.each(situations)("%s: 같은 캐릭터 블록과 지시를 받고, 고른 상황은 출처가 situation인 일반 맥락으로만 들어간다", (situationId) => {
    const { plan: base } = analyze(situationId);
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
    const { instructions, input } = promptFor(plan);
    const reference = promptFor(buildNarrationPlan({ base: analyze(null).plan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] })).instructions;
    // 상황에 따라 지시가 달라지지 않는다 (상황 때문에 캐릭터를 끄거나 바꾸는 분기가 없다).
    expect(instructions).toBe(reference);
    expect(instructions).toContain("context에 적힌 걱정거리는 그 상황에서 흔한 주제일 뿐 이 사용자가 말한 감정이 아니다");
    const parsed = JSON.parse(input) as { situation: { label: string; context: string }; userContext: { from: string; text: string }[]; topics: { topicId: string }[] };
    const option = FIRST_OVERVIEW.situation.options.find((item) => item.id === situationId)!;
    expect(parsed.situation).toEqual({ label: option.label, context: option.context });
    expect(parsed.userContext).toEqual([{ ref: "u1", text: `사용자가 고른 현재 상황: ${option.label}`, from: "situation" }]);
    expect(parsed.topics).toHaveLength(9);
  });

  it("상황 맥락에 '불안'이 있어도 사용자가 말한 감정으로 넘기지 않고, 궁금한 점에 직접 적은 지친 마음만 출처 concern으로 넘긴다", () => {
    const jobSeeking = FIRST_OVERVIEW.situation.options.find((option) => option.id === "job-seeking")!;
    expect(jobSeeking.context).toContain("불안");
    const { plan: base } = analyze("job-seeking");
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-11", {
      items: [question("언제쯤 취업할 수 있을지", "career", "timing")],
      userFacts: [{ text: "요즘 면접에서 계속 떨어져 많이 지쳐 있다고 말함", domain: "temperament" }],
      needsClarification: false,
    });
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis, timing: [] });
    const parsed = JSON.parse(promptFor(plan).input) as { userContext: { from: string; text: string }[] };
    expect(parsed.userContext.map((item) => item.from)).toEqual(["situation", "concern"]);
    expect(parsed.userContext[0]!.text).not.toContain("불안");
    expect(parsed.userContext[1]!.text).toContain("지쳐");
  });
});

describe("질문 없음, 구체적 질문, 복합 질문", () => {
  const { plan: base } = analyze("employee");

  it("질문이 없으면 답변 영역 없이 아홉 주제를 상품 순서대로, 고른 상황의 주제를 조금 더 깊게 둔다", () => {
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
    const input = JSON.parse(promptFor(plan).input) as { questions: unknown[]; topics: { topicId: string; weight: string }[] };
    expect(input.questions).toEqual([]);
    expect(input.topics.map((topic) => topic.topicId)).toEqual(FIRST_OVERVIEW.topics.map((topic) => topic.id));
    expect(input.topics.filter((topic) => topic.weight === "lead").map((topic) => topic.topicId)).toEqual(["work", "people"]);
  });

  it("구체적 질문은 그 주제를 맨 앞의 중심(focus)으로 옮기고 질문 ref를 넘긴다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-11", { items: [question("좋아하는 사람에게 먼저 다가가도 될지", "romance", "apply")], userFacts: [], needsClarification: false });
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis, timing: [] });
    const input = JSON.parse(promptFor(plan).input) as { questions: { ref: string; topicId: string }[]; topics: { topicId: string; weight: string }[] };
    expect(input.questions.map((item) => [item.ref, item.topicId])).toEqual([["q1", "romance"]]);
    expect(input.topics[0]).toMatchObject({ topicId: "romance", weight: "focus" });
  });

  it("복합 질문은 질문마다 나눠 넘기고, 질문 주제들을 앞에 둔다", () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-11", {
      items: [question("언제 이직할 수 있을지", "career", "timing"), question("이직과 창업 중 무엇이 맞는지", "career", "compare", ["이직", "창업"]), question("돈이 왜 안 모이는지", "wealth", "explain")],
      userFacts: [],
      needsClarification: false,
    });
    const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis, timing: [] });
    const input = JSON.parse(promptFor(plan).input) as { questions: { ref: string }[]; topics: { topicId: string; weight: string }[] };
    expect(input.questions.map((item) => item.ref)).toEqual(["q1", "q2", "q3"]);
    expect(input.topics.slice(0, 2).map((topic) => [topic.topicId, topic.weight])).toEqual([
      ["work", "focus"],
      ["money", "focus"],
    ]);
  });
});

describe("서로 반대되는 판단을 가진 사주도 같은 캐릭터 지시를 받는다", () => {
  // 1998-09-19: 생각을 밖으로 꺼내야 정리되는 표현형. 1985-07-30: 충분히 이해한 뒤 움직이는 준비형.
  const fast = analyze(null, "달빛", { birthTime: { status: "unknown" } });
  const slow = analyze(null, "바람", { birthDate: "1985-07-30", gender: "male", birthTime: { status: "unknown" } });
  const planOf = (result: typeof fast) => buildNarrationPlan({ base: result.plan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });

  it("판단은 입력에만 있고, 지시는 판단과 상관없이 같다", () => {
    const a = promptFor(planOf(fast));
    const b = promptFor(planOf(slow));
    const lead = (input: string) => (JSON.parse(input) as { topics: { readings: { meaning: string }[] }[] }).topics[0]!.readings[0]!.meaning;
    expect(lead(a.input)).toContain("밖으로 꺼내야");
    expect(lead(b.input)).toContain("충분히 이해하고 받아들인 다음에");
    expect(a.instructions).toBe(b.instructions);
    // 지시에는 특정 판단이나 주제에 묶인 문장이 없다.
    for (const text of [lead(a.input), lead(b.input)]) expect(a.instructions).not.toContain(text.slice(0, 15));
  });
});

describe("작성 재료 3.0.0: 종류를 나누고, 뜻·조건·반대 근거를 잃지 않는다", () => {
  const { plan: base } = analyze("job-seeking");
  const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
  const original = plan.topics.flatMap((topic) => topic.statements);
  const material = writingMaterial(plan.topics.map((topic) => topic.statements));
  const readings = material.groups.flatMap((group) => group.readings);
  const actions = material.groups.flatMap((group) => group.actions);

  it("해석마다 판단의 뜻, 확실성, 약점(무엇이·언제·잃는 것), 비교 기준이 그대로다", () => {
    expect(readings.map((reading) => reading.ref)).toEqual(original.map((statement) => statement.ref));
    for (const statement of original) {
      const reading = readings.find((item) => item.ref === statement.ref)!;
      expect(reading.meaning).toBe(statement.text);
      expect(reading.status).toBe(statement.status);
      expect(reading.risk).toEqual(statement.weakness ? { pattern: statement.weakness.what, when: statement.weakness.when, cost: statement.weakness.cost } : undefined);
      expect(reading.compare).toEqual(statement.compare);
      expect(reading.strength).toBe(statement.upside);
    }
  });

  it("반대 근거와 한계는 해석의 limits나 commonLimits에 모두 남는다", () => {
    for (const statement of original) {
      const reading = readings.find((item) => item.ref === statement.ref)!;
      if (statement.counterNote) expect(reading.limits).toContain(statement.counterNote);
      for (const caveat of statement.caveats) expect([...material.commonLimits, ...(reading.limits ?? [])]).toContain(caveat);
    }
  });

  it("같은 근거(이유·원국 근거)는 처음 한 번만 넣되 모두 남는다. 비교 해석의 이유는 비교 기준에 남는다", () => {
    const why = readings.flatMap((reading) => reading.why ?? []);
    const chart = readings.flatMap((reading) => reading.chart ?? []);
    expect(why.length).toBe(new Set(why).size);
    expect(chart.length).toBe(new Set(chart).size);
    expect(new Set(chart)).toEqual(new Set(original.flatMap((statement) => statement.lore ?? [])));
    const fromCompare = new Set(original.flatMap((statement) => statement.compare?.criteria.map((item) => `${item.name}: ${item.reason}`) ?? []));
    const basis = new Set(original.flatMap((statement) => statement.basis ?? []).filter((item) => !fromCompare.has(item)));
    expect(new Set(why)).toEqual(basis);
  });

  it("서비스가 제안하는 행동은 해석과 따로, 딸린 해석(for)과 함께 그 주제에 둔다", () => {
    for (const statement of original) {
      for (const text of [statement.weakness?.change, statement.action].filter((item): item is string => Boolean(item))) {
        const action = actions.find((item) => item.text === text)!;
        expect(action).toBeDefined();
        const topicIndex = plan.topics.findIndex((topic) => topic.statements.includes(statement));
        expect(material.groups[topicIndex]!.actions).toContainEqual(action);
      }
    }
    expect(actions.find((action) => action.text === original.find((statement) => statement.weakness)!.weakness!.change)!.kind).toBe("fix");
    expect(actions.length).toBe(new Set(actions.map((action) => action.text)).size);
  });

  it("같은 문장의 행동이 여러 주제에 있으면 처음 나온 주제에만 둔다 (숫자와 주기는 바꾸지 않는다)", () => {
    const statement = (ref: string, change: string): InterpretationStatement => ({
      ref,
      kind: "service-interpretation",
      text: `${ref} 판단`,
      status: "candidate",
      caveats: [],
      conclusionId: ref,
      ruleId: "r",
      ruleVersion: "1",
      weakness: { what: "w", when: "w", cost: "w", change },
    });
    const result = writingMaterial([[statement("s1", "불편한 건 사흘 안에 한 번은 말하기")], [statement("s2", "불편한 건 사흘 안에 한 번은 말하기"), statement("s3", "석 달에 한 번은 새 방식 시도하기")]]);
    expect(result.groups[0]!.actions.map((action) => action.text)).toEqual(["불편한 건 사흘 안에 한 번은 말하기"]);
    expect(result.groups[1]!.actions.map((action) => [action.for, action.text])).toEqual([["s3", "석 달에 한 번은 새 방식 시도하기"]]);
    // 행동을 뺀 해석의 약점과 판단은 그대로 남는다.
    expect(result.groups[1]!.readings.map((reading) => reading.ref)).toEqual(["s2", "s3"]);
  });

  it("최초 풀이와 후속 답변이 같은 재료를 받는다", () => {
    const statements = plan.topics.find((topic) => topic.topicId === "work")!.statements;
    const followup = JSON.parse(buildFollowupPrompt({ persona: MYOMYO, nickname: "달빛", hourKnown: true, expression: FIRST_OVERVIEW.expression, situation: null, facts: [], userContext: [], questions: [], statements, timing: [], delivered: [], lastTurn: null, previousIssues: [] }).input);
    const alone = writingMaterial([statements]);
    expect(followup.readings).toEqual(alone.groups[0]!.readings);
    expect(followup.actions).toEqual(alone.groups[0]!.actions);
    expect(followup.commonLimits).toEqual(alone.commonLimits);
  });
});

describe("실제 모델 비교 조건 (llm:compare, 사용자가 직접 실행)", () => {
  const { plan: base } = analyze("job-seeking");
  const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-11", { items: [question("취업과 창업 중 무엇이 맞는지", "career", "compare", ["취업", "창업"])], userFacts: [], needsClarification: false });
  const plan = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis, timing: [] });
  const args = { plan, persona: MYOMYO, previousIssues: [] };

  it("기본 조건은 운영 지시와 같다", () => {
    expect(buildReadingExperiment(args, DEFAULT_EXPERIMENT)).toEqual(promptFor(plan));
  });

  it("한 조건씩만 바뀐다: 상담 문장 묶음, 짧은 성격 설정과 판단만, 첫 주제만", () => {
    const now = promptFor(plan);
    const consult = buildReadingExperiment(args, { ...DEFAULT_EXPERIMENT, material: "consult" });
    expect(consult.instructions).toContain("topics[].statements: 서비스가 채택한 해석. text 핵심 판단");
    expect(consult.instructions.replace(/\[재료\][\s\S]*?\n- 서비스가 제안하는/, "")).toBe(now.instructions.replace(/\[재료\][\s\S]*?\n- 서비스가 제안하는/, ""));
    const consultInput = JSON.parse(consult.input) as { commonCaveats: string[]; topics: { statements: { text: string; weakness: unknown }[] }[] };
    expect(consultInput.commonCaveats.length).toBeGreaterThan(0);
    expect(consultInput.topics[0]!.statements[0]!.text).toBe(plan.topics[0]!.statements[0]!.text);

    const minimal = buildReadingExperiment(args, { ...DEFAULT_EXPERIMENT, rules: "minimal" });
    expect(minimal.instructions.startsWith(now.instructions.slice(0, now.instructions.indexOf("[작업]")))).toBe(true);
    expect(minimal.instructions).not.toContain("[지킬 것]");
    const minimalInput = JSON.parse(minimal.input) as { topics: { judgments: { ref: string; judgment: string }[] }[] };
    expect(Object.keys(minimalInput.topics[0]!.judgments[0]!).sort()).toEqual(["judgment", "ref", "status"]);

    const first = buildReadingExperiment(args, { ...DEFAULT_EXPERIMENT, topics: "first" });
    expect(first.instructions).toBe(now.instructions);
    const firstInput = JSON.parse(first.input) as { questions: unknown[]; topics: { topicId: string }[] };
    expect(firstInput.topics.map((topic) => topic.topicId)).toEqual([plan.topics[0]!.topicId]);
    expect(firstInput.questions).toHaveLength(1);
    expect(experimentPlan(plan, { ...DEFAULT_EXPERIMENT, topics: "first" }).topics).toHaveLength(1);
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
      focusAngle: "결론: 조직 쪽 조건이 더 맞음",
      focus: [],
      topics: [{ topicId: "money", angle: "중심 판단과 걸리는 상황", bubbles: [{ kind: "explanation", refs: ["s1"], text: "보수 얘기는 미루지 마.", highlight: "" }] }],
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
    "일 얘기할 땐 신나더니 조건 얘기만 나오면 조용해지지? 다 보여.",
    "하나 붙잡으면 끝까지 가는 건… 뭐, 인정. 그거 네 무기야.",
    "근데 그걸 남 좋은 일에만 쓰면 아깝잖아. 바보같이.",
    "그러니까 이번 주에 네 몫부터 적어. 답답해서 하는 말이거든?",
  ];
  const output: NarrationOutputV2 = {
    opening: "달빛아, 왔네. 칭찬만 들으러 왔으면 좀 아쉬울걸? 😏",
    focus: [],
    topics: plan.topics.map((topic) => ({
      topicId: topic.topicId,
      bubbles: lines.map((line, bubble) => ({
        kind: "explanation" as const,
        refs: [topic.statements[bubble % Math.max(1, topic.statements.length)]?.ref ?? plan.base.facts[0]!.ref],
        // 같은 문장 반복 검사에 걸리지 않게 주제마다 다른 꼬리를 붙인다.
        text: `${line} (${topic.title})`,
        highlight: bubble === 3 ? "이번 주에 네 몫부터 적어" : "",
      })),
    })),
    closing: "더 궁금하면 물어봐. 허접하게 묻지만 말고. ♡",
  };

  it("놀림·얄미운 말·이모티콘이 있어도 근거와 계산값이 맞으면 검사를 통과한다", () => {
    expect(checkNarrationV2(output, plan, chart, [])).toEqual([]);
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
