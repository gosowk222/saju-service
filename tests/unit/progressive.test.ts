import { describe, expect, it } from "vitest";
import { MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { emptyAnalysis } from "@/domain/reading/question";
import type { NarrationOutputV2, NarrationPlanV2 } from "@/domain/reading/types";
import { analyzeBirth, toPublicBirthInput } from "@/server/engine/analyze";
import type { callStructuredStream } from "@/server/llm/client";
import { answerFollowupProgressive, narrateReadingProgressive, sentPartsFrom, type NewMessage, type SentParts } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";
import { completedParts, followupParts } from "@/server/llm/stream-parts";

/** 주제가 완성될 때마다 먼저 보여 주는 생성 (reading-2.4.0). 모델 대신 정해 둔 글자를 조금씩 흘려보낸다. */

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const { plan: base, chart } = analyzeBirth({
  birth: toPublicBirthInput({ birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place }),
  product: FIRST_OVERVIEW,
  nickname: "달빛",
  situationId: null,
});
const plan: NarrationPlanV2 = buildNarrationPlan({ base, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
const config = { modelId: "gpt-5.6-luna", promptVersion: CURRENT_READING_PROMPT, schemaVersion: NARRATION_SCHEMA_VERSION, reasoningEffort: "low" };

function topicBubbles(topicId: string, round = 1) {
  const topic = plan.topics.find((item) => item.topicId === topicId)!;
  const ref = topic.statements[0]?.ref ?? plan.base.facts[0]!.ref;
  return [1, 2, 3].map((index) => ({ kind: "explanation" as const, refs: [ref], text: `${round}회차 ${topicId} 주제의 ${index}번째 이야기예요.`, highlight: "" }));
}

function output(overrides: Partial<NarrationOutputV2> = {}, sent: readonly string[] = []): NarrationOutputV2 {
  return {
    opening: sent.length ? "" : "달빛 님, 반가워요. 오늘은 차근차근 같이 볼게요.",
    focus: [],
    topics: plan.topics.map((topic) => ({ topicId: topic.topicId, bubbles: sent.includes(topic.topicId) ? [] : topicBubbles(topic.topicId) })),
    closing: "더 궁금한 건 편하게 물어봐 주세요.",
    ...overrides,
  };
}

/** 정해 둔 출력들을 차례로 흘려보내는 가짜 스트림. onDelta가 멈추라고 하면 거기서 끊는다. */
function fakeStream(outputs: readonly NarrationOutputV2[]) {
  const inputs: Record<string, unknown>[] = [];
  const stream = (async (request: Parameters<typeof callStructuredStream>[0]) => {
    const text = JSON.stringify(outputs[inputs.length]!);
    inputs.push(JSON.parse(request.input) as Record<string, unknown>);
    let received = "";
    let stopped = false;
    for (let index = 0; index < text.length; index += 37) {
      const delta = text.slice(index, index + 37);
      received += delta;
      if ((await request.onDelta(received, delta)) === "stop") {
        stopped = true;
        break;
      }
    }
    return {
      parsed: stopped ? null : JSON.parse(received),
      text: received,
      stopped,
      meta: {
        requestedModel: request.model,
        actualModel: "fake",
        responseId: null,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 0, cachedInputTokens: 0 },
        durationMs: 1,
        calls: 1,
      },
    };
  }) as unknown as typeof callStructuredStream;
  return { stream, inputs };
}

async function run(outputs: readonly NarrationOutputV2[], sent: SentParts = { opening: null, focus: [], topics: [] }) {
  const commits: NewMessage[][] = [];
  const { stream, inputs } = fakeStream(outputs);
  const result = await narrateReadingProgressive({
    plan,
    excluded: [],
    chart,
    persona: MYOMYO,
    config,
    sent,
    commit: async (messages) => {
      commits.push([...messages]);
    },
    stream,
  });
  return { result, commits, inputs };
}

const topicIds = plan.topics.map((topic) => topic.topicId);

describe("스트리밍 풀이에서 완성된 부분 찾기", () => {
  it("닫힌 문자열과 다 받은 주제만 돌려준다", () => {
    const text = JSON.stringify(output());
    const cut = text.indexOf(`"topicId":"${topicIds[2]}"`);
    const parts = completedParts(text.slice(0, cut + 20));
    expect(parts.opening).toBe("달빛 님, 반가워요. 오늘은 차근차근 같이 볼게요.");
    expect(parts.focus).toEqual([]);
    expect((parts.topics as { topicId: string }[]).map((topic) => topic.topicId)).toEqual(topicIds.slice(0, 2));
    expect(parts.closing).toBeUndefined();
    expect(completedParts(text.slice(0, 15)).opening).toBeUndefined();
  });

  it("문장 안의 따옴표와 괄호는 구조로 보지 않는다", () => {
    const tricky = output({ opening: '"안녕" {하세요} [반가워요] \\ 끝' });
    expect(completedParts(JSON.stringify(tricky)).opening).toBe('"안녕" {하세요} [반가워요] \\ 끝');
    expect(completedParts(JSON.stringify(tricky)).topics).toHaveLength(topicIds.length);
  });
});

describe("주제가 완성될 때마다 먼저 보여 주는 생성", () => {
  it("인사와 주제를 완성되는 순서대로 저장하고, 마무리는 완료 저장 때 쓰도록 돌려준다", async () => {
    const { result, commits, inputs } = await run([output()]);
    expect(inputs).toHaveLength(1);
    expect(commits.map((batch) => batch[0]!.topicId)).toEqual([null, ...topicIds]);
    expect(commits[1]!.map((message) => message.text)).toEqual(topicBubbles(topicIds[0]!).map((bubble) => bubble.text));
    expect(result.closing.text).toBe("더 궁금한 건 편하게 물어봐 주세요.");
    expect(result.meta.llmCalls).toBe(1);
  });

  it("검사에 걸린 주제에서 끊고, 보낸 부분은 그대로 둔 채 나머지만 이어 쓰게 한다", async () => {
    const broken = output();
    const bad = { ...broken.topics[2]!, bubbles: broken.topics[2]!.bubbles.map((bubble, index) => (index === 1 ? { ...bubble, refs: ["s999"] } : bubble)) };
    const first = { ...broken, topics: broken.topics.map((topic, index) => (index === 2 ? bad : topic)) };
    const sent = topicIds.slice(0, 2);
    const second = output({ topics: plan.topics.map((topic) => ({ topicId: topic.topicId, bubbles: sent.includes(topic.topicId) ? [] : topicBubbles(topic.topicId, 2) })) }, sent);

    const { result, commits, inputs } = await run([first, second]);
    expect(inputs).toHaveLength(2);
    // 1회차: 인사, 1·2번 주제까지만 보내고 3번 주제에서 끊는다.
    expect(commits.slice(0, 3).map((batch) => batch[0]!.topicId)).toEqual([null, topicIds[0], topicIds[1]]);
    expect(commits.slice(0, 3).flat().some((message) => message.text.startsWith("2회차"))).toBe(false);
    // 2회차: 이미 보낸 부분을 입력에 넣고, 3번 주제부터 이어 쓴다.
    const alreadySent = inputs[1]!.alreadySent as { opening: string; topics: { topicId: string }[] };
    expect(alreadySent.opening).toBe("달빛 님, 반가워요. 오늘은 차근차근 같이 볼게요.");
    expect(alreadySent.topics.map((topic) => topic.topicId)).toEqual(sent);
    expect(String(inputs[1]!.fixTheseProblemsFromPreviousAttempt)).toContain("없는 근거");
    expect(commits.slice(3).map((batch) => batch[0]!.topicId)).toEqual(topicIds.slice(2));
    expect(commits.slice(3).flat().every((message) => message.text.startsWith("2회차"))).toBe(true);
    expect(result.meta.llmCalls).toBe(2);
  });

  it("이전 시도가 보낸 메시지가 있으면 그 뒤부터 이어 쓴다", async () => {
    const stored = [
      { topicId: null, text: "달빛 님, 반가워요." },
      ...topicBubbles(topicIds[0]!).map((bubble, index) => ({ topicId: topicIds[0]!, text: index === 0 ? `**${bubble.text}**` : bubble.text })),
    ];
    const sent = sentPartsFrom(stored, plan.focusSection.id);
    expect(sent.topics[0]!.texts[0]).toBe(topicBubbles(topicIds[0]!)[0]!.text);

    const { commits, inputs } = await run([output({}, [topicIds[0]!])], sent);
    expect((inputs[0]!.alreadySent as { topics: unknown[] }).topics).toHaveLength(1);
    expect(commits.map((batch) => batch[0]!.topicId)).toEqual(topicIds.slice(1));
  });

  it("보낸 말을 다시 쓰면 같은 문장 반복으로 거부한다", async () => {
    const stored = [{ topicId: null, text: "달빛 님, 반가워요." }, ...topicBubbles(topicIds[0]!).map((bubble) => ({ topicId: topicIds[0]!, text: bubble.text }))];
    const repeated = output({ topics: plan.topics.map((topic, index) => ({ topicId: topic.topicId, bubbles: index === 0 ? [] : index === 1 ? topicBubbles(topicIds[0]!) : topicBubbles(topic.topicId) })) }, [topicIds[0]!]);
    await expect(run([repeated, repeated], sentPartsFrom(stored, plan.focusSection.id))).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("질문이 없는데 쓴 답변 영역은 보여 주지 않고 다시 쓰게 하지도 않는다", async () => {
    const extra = output({ focus: [{ kind: "explanation", refs: [plan.base.facts[0]!.ref], text: "묻지 않은 답이에요.", highlight: "" }] });
    const { commits, inputs } = await run([extra]);
    expect(inputs).toHaveLength(1);
    expect(commits.flat().some((message) => message.text === "묻지 않은 답이에요.")).toBe(false);
  });
});

// ─── 후속 답변 (followup-2.5.0 / followup-output-2.1.0) ─────────────────

/** 정해 둔 JSON 문자열들을 차례로 흘려보내는 가짜 스트림. */
function fakeTextStream(texts: readonly string[], size = 23) {
  const inputs: Record<string, unknown>[] = [];
  const stream = (async (request: Parameters<typeof callStructuredStream>[0]) => {
    const text = texts[inputs.length]!;
    inputs.push(JSON.parse(request.input) as Record<string, unknown>);
    let received = "";
    let stopped = false;
    for (let index = 0; index < text.length; index += size) {
      const delta = text.slice(index, index + size);
      received += delta;
      if ((await request.onDelta(received, delta)) === "stop") {
        stopped = true;
        break;
      }
    }
    let parsed: unknown = null;
    if (!stopped) {
      const result = request.parser.safeParse(JSON.parse(received));
      parsed = result.success ? result.data : null;
    }
    return {
      parsed,
      text: received,
      stopped,
      meta: { requestedModel: request.model, actualModel: "fake", responseId: null, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 }, durationMs: 1, calls: 1 },
    };
  }) as unknown as typeof callStructuredStream;
  return { stream, inputs };
}

const followupAnswer = (sections: { questionRef: string; refs: string[]; paragraphs: string[] }[]) =>
  JSON.stringify({ mode: "answer", sections: sections.map(({ questionRef, refs, paragraphs }) => ({ questionRef, refs, text: paragraphs.join("\n\n") })), clarifyQuestion: "" });

describe("스트리밍 후속 답변에서 완성된 문단 찾기", () => {
  it("근거 연결을 먼저 읽고, 쓰는 중인 마지막 문단은 빼고 돌려준다", () => {
    const text = followupAnswer([{ questionRef: "q1", refs: ["s1"], paragraphs: ["첫 문단이야.", "두 번째 \"따옴표\" 문단이야.", "세 번째 문단"] }]);
    const cut = text.indexOf("세 번째") + 3;
    const parts = followupParts(text.slice(0, cut));
    expect(parts.mode).toBe("answer");
    expect(parts.sections[0]).toMatchObject({ questionRef: "q1", refs: ["s1"], paragraphs: ["첫 문단이야.", '두 번째 "따옴표" 문단이야.'], closed: false });
    expect(followupParts(text).sections[0]!.paragraphs).toHaveLength(3);
    // 이스케이프가 끊긴 자리에서도 앞 문단은 읽는다.
    const escape = text.indexOf("\\n\\n") + 1;
    expect(followupParts(text.slice(0, escape)).sections[0]!.paragraphs).toEqual([]);
  });
});

describe("문단이 완성될 때마다 먼저 보여 주는 후속 답변", () => {
  const { chart: followupChart } = analyzeBirth({
    birth: toPublicBirthInput({ birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place }),
    product: FIRST_OVERVIEW,
    nickname: "달빛",
    situationId: null,
  });
  const check = { questionRefs: ["q1", "q2"], knownRefs: new Set(["s1", "s2"]), timing: [], percentSources: [], excluded: [], persona: MYOMYO };
  const args = {
    persona: MYOMYO,
    nickname: "달빛",
    hourKnown: true,
    expression: FIRST_OVERVIEW.expression,
    situation: null,
    facts: [],
    userContext: [],
    questions: [],
    statements: [],
    timing: [],
    delivered: [],
    lastTurn: null,
    chart: followupChart,
    modelId: "gpt-5.6-luna",
    check,
  };

  async function runFollowup(texts: readonly string[]) {
    const published: string[][] = [];
    const { stream, inputs } = fakeTextStream(texts);
    const result = await answerFollowupProgressive({
      ...args,
      publish: async (sections) => {
        published.push(sections.flatMap((section) => section.paragraphs));
      },
      stream,
    });
    return { result, published, inputs };
  }

  it("질문 순서대로 문단을 하나씩 보내고, 마지막에 보낸 그대로 돌려준다", async () => {
    const text = followupAnswer([
      { questionRef: "q1", refs: ["s1"], paragraphs: ["어라~? 그건 이렇게 봐야 해.", "왜냐면 근거가 이쪽이거든."] },
      { questionRef: "q2", refs: ["s2", "q2"], paragraphs: ["두 번째 질문은 간단해."] },
    ]);
    const { result, published, inputs } = await runFollowup([text]);
    expect(inputs).toHaveLength(1);
    expect(published.map((list) => list.length)).toEqual([1, 2, 3]);
    expect(result.output.sections.map((section) => section.text)).toEqual(["어라~? 그건 이렇게 봐야 해.\n\n왜냐면 근거가 이쪽이거든.", "두 번째 질문은 간단해."]);
    expect(result.output.sections[1]!.refs).toEqual(["s2", "q2"]);
  });

  it("없는 근거를 참조하면 문단을 보내기 전에 끊고 다시 쓰게 한다", async () => {
    const bad = followupAnswer([{ questionRef: "q1", refs: ["s99"], paragraphs: ["보이면 안 되는 문단이야."] }, { questionRef: "q2", refs: [], paragraphs: ["두 번째."] }]);
    const good = followupAnswer([{ questionRef: "q1", refs: ["s1"], paragraphs: ["다시 쓴 문단이야."] }, { questionRef: "q2", refs: [], paragraphs: ["두 번째 답."] }]);
    const { result, published, inputs } = await runFollowup([bad, good]);
    expect(inputs).toHaveLength(2);
    expect(published.flat()).not.toContain("보이면 안 되는 문단이야.");
    expect(String(inputs[1]!.fixTheseProblemsFromPreviousAttempt)).toContain("없는 근거");
    expect(result.output.sections[0]!.text).toBe("다시 쓴 문단이야.");
  });

  it("중간 문단이 검사에 걸리면 보낸 문단은 두고 이어서 쓰게 한다", async () => {
    const first = followupAnswer([
      { questionRef: "q1", refs: ["s1"], paragraphs: ["먼저 보낸 문단이야.", "이건 진짜 병신 같은 습관이야.", "안 보일 문단."] },
      { questionRef: "q2", refs: [], paragraphs: ["두 번째."] },
    ]);
    const rest = followupAnswer([
      { questionRef: "q1", refs: ["s1"], paragraphs: ["이어서 쓴 문단이야."] },
      { questionRef: "q2", refs: [], paragraphs: ["두 번째 답이야."] },
    ]);
    const { result, published, inputs } = await runFollowup([first, rest]);
    expect(published[0]).toEqual(["먼저 보낸 문단이야."]);
    expect(published.flat()).not.toContain("안 보일 문단.");
    expect(inputs[1]!.alreadySent).toEqual([{ questionRef: "q1", paragraphs: ["먼저 보낸 문단이야."] }]);
    expect(result.output.sections[0]!.text).toBe("먼저 보낸 문단이야.\n\n이어서 쓴 문단이야.");
  });

  it("되묻기는 끝까지 받은 뒤 한 번에 돌려주고 문단을 보내지 않는다", async () => {
    const text = JSON.stringify({ mode: "clarify", sections: [], clarifyQuestion: "어느 주제 얘기야?" });
    const { result, published } = await runFollowup([text]);
    expect(result.output).toEqual({ mode: "clarify", sections: [], clarifyQuestion: "어느 주제 얘기야?" });
    expect(published).toEqual([]);
  });
});
