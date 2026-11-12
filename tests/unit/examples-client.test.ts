import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 문답 예시가 실제 모델 클라이언트(src/server/llm/client.ts)가 OpenAI SDK에 넘기는 요청 인자까지 가는지 확인한다.
 * OpenAI SDK를 가짜로 바꿔 responses.create가 받은 인자를 기록한다. 네트워크 요청과 실제 OpenAI 호출은 없다.
 */

const sdk = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], reply: "{}" }));

vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
  }
  class FakeOpenAI {
    static APIError = APIError;
    static APIConnectionError = class extends APIError {};
    static APIConnectionTimeoutError = class extends APIError {};
    static APIUserAbortError = class extends APIError {};
    responses = {
      create: (body: Record<string, unknown>) => {
        sdk.calls.push(body);
        const response = {
          id: "resp_test",
          model: "fake-model",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: sdk.reply }] }],
          output_text: sdk.reply,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          _request_id: "req_test",
        };
        if (!body.stream) return Promise.resolve(response);
        async function* events() {
          yield { type: "response.created", response };
          yield { type: "response.output_text.delta", delta: sdk.reply };
          yield { type: "response.completed", response };
        }
        return { withResponse: async () => ({ data: events(), request_id: "req_test" }) };
      },
    };
  }
  return { default: FakeOpenAI };
});

vi.mock("@/server/llm/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/llm/config")>()),
  // 실제 키와 실제 호출 차단을 거치지 않는다 (SDK가 가짜라 요청이 나가지 않는다).
  liveCallBlockReason: () => null,
  requireApiKey: () => "test-key",
}));

const { callStructured, callStructuredStream } = await import("@/server/llm/client");
const { MYOMYO, MUJIN } = await import("@/domain/personas");
const { FIRST_OVERVIEW } = await import("@/domain/products/first-overview");
const { buildFollowupPrompt, getNarrationSchema, getReadingPrompt, NARRATION_SCHEMA_VERSION } = await import("@/server/llm/prompts");
const { buildVoiceRequest, requestFields, MUJIN_BUNDLES, MUJIN_BUNDLE_VERSION } = await import("@/server/llm/mujin-prompts");
const { casePlan, EVALUATION_CASES } = await import("../../scripts/llm-cases");

const BLOCK = "[캐릭터 문답 예시:";

beforeEach(() => {
  sdk.calls.length = 0;
});

describe("모델 클라이언트가 보내는 요청 인자", () => {
  it("묘묘 최초 풀이(스트림): 지시(instructions)에 예시 블록과 고른 ID가 있고, 입력(input)은 작성 재료 그대로다", async () => {
    const { plan } = casePlan(EVALUATION_CASES.find((entry) => entry.id === "job-seeking")!, "2026-11-12");
    const prompt = getReadingPrompt("reading-3.2.0")({ plan, persona: MYOMYO, previousIssues: [], exampleSeed: "33333333-3333-4333-8333-333333333333" });
    const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);
    await callStructuredStream({
      model: "fake-model",
      instructions: prompt.instructions,
      input: prompt.input,
      schemaName: schema.name,
      jsonSchema: schema.jsonSchema,
      parser: schema.parser,
      maxOutputTokens: 1000,
      reasoningEffort: "medium",
      onDelta: async () => "continue",
    });
    expect(sdk.calls).toHaveLength(1);
    const body = sdk.calls[0]!;
    // SDK로 넘어간 본문을 JSON으로 바꿔도(실제로 보내는 형태) 예시가 남는다.
    const sent = JSON.parse(JSON.stringify(body)) as { instructions: string; input: string; stream: boolean; text: { format: { name: string } } };
    expect(sent.stream).toBe(true);
    expect(sent.instructions).toBe(prompt.instructions);
    expect(sent.instructions).toContain(`${BLOCK} 묘묘]`);
    for (const id of prompt.examples!.ids) expect(sent.instructions).toContain(`id="${id}"`);
    expect(sent.input).toBe(prompt.input);
    expect(sent.input).not.toContain(BLOCK);
    expect(sent.text.format.name).toBe("saju_narration_v2");
  });

  it("묘묘 후속 답변(한 번에 받기): 예시 블록이 지시에 있고, 예시 없는 3.1.0과 입력·출력 형식이 같다", async () => {
    sdk.reply = JSON.stringify({ mode: "answer", sections: [], clarifyQuestion: "" });
    const args = {
      persona: MYOMYO,
      nickname: "하나",
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
      reaction: "praise" as const,
      previousIssues: [],
      exampleSeed: "44444444-4444-4444-8444-444444444444",
    };
    for (const promptVersion of ["followup-3.2.0", "followup-3.1.0"]) {
      const prompt = buildFollowupPrompt({ ...args, promptVersion });
      await callStructured({ ...prompt, model: "fake-model", maxOutputTokens: 500, reasoningEffort: "low" });
    }
    const [current, before] = sdk.calls.map((body) => JSON.parse(JSON.stringify(body)) as { instructions: string; input: string; text: unknown });
    expect(current!.instructions).toContain(`${BLOCK} 묘묘]`);
    expect(before!.instructions).not.toContain(BLOCK);
    expect(current!.instructions.startsWith(before!.instructions)).toBe(true);
    expect(current!.input).toBe(before!.input);
    expect(current!.text).toEqual(before!.text);
    // 예시 기록(examples)은 요청 본문에 들어가지 않는다 (지시 안의 블록으로만 간다).
    expect(Object.keys(sdk.calls[0]!)).not.toContain("examples");
  });

  it("무진 Pass 2: 지시에 재작성 예시가 있고 예시 기록은 요청 인자에 섞이지 않는다", async () => {
    sdk.reply = JSON.stringify({ section: { sectionId: "ch3", coreAnswer: "핵심", blocks: [] } });
    const built = buildVoiceRequest({
      bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!,
      persona: MUJIN,
      nickname: "가람",
      section: { sectionId: "ch3", title: "직업과 사회생활", questions: [], targetChars: { min: 900, max: 1500 } },
      draft: { sectionId: "ch3", coreAnswer: "핵심", blocks: [{ type: "paragraph", questionIds: [], refs: [], text: "초안", items: [] }], scenes: [] },
      userFacts: [],
      hourKnown: true,
      exampleSeed: "55555555-5555-4555-8555-555555555555",
    });
    await callStructured({ ...requestFields(built), model: "fake-model", maxOutputTokens: 500, reasoningEffort: "low" });
    const body = sdk.calls[0]!;
    expect(Object.keys(body)).not.toContain("examples");
    const sent = JSON.parse(JSON.stringify(body)) as { instructions: string; input: string };
    expect(sent.instructions).toContain(`${BLOCK} 무진 도사]`);
    expect(sent.instructions).toContain('<rewrite-example id="mujin-rw-09" source="mujin-09">');
    for (const id of built.examples!.ids) expect(sent.instructions).toContain(`id="${id}"`);
    expect(sent.input).toBe(built.input);
    expect(sent.input).not.toContain("mujin-");
  });
});
