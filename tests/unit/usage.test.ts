import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { issueSummary } from "@/domain/reading/check";
import { callStructured, callStructuredStream, LlmError } from "@/server/llm/client";
import { summarizeUsage, UsageMeter, type LlmUsage } from "@/server/llm/usage";

/**
 * 토큰 사용량 집계 (src/server/llm/usage.ts, client.ts). 로컬 가짜 서버가 정해 둔 usage를 돌려준다. 실제 모델은 부르지 않는다.
 */

const usage = (input: number | null, output: number | null, cached: number | null, reasoning: number | null = 0): LlmUsage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input !== null && output !== null ? input + output : null,
  reasoningTokens: reasoning,
  cachedInputTokens: cached,
});

describe("사용량 합계 규칙", () => {
  it("cached는 input에 포함되고 total은 input + output이다 (캐시·추론 토큰을 다시 더하지 않는다)", () => {
    const summary = summarizeUsage([{ kind: "usage", usage: usage(1000, 200, 600, 80) }]);
    expect(summary).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, reasoningTokens: 80, totalTokens: 1200, complete: true });
    // 캐시되지 않은 입력 = 1000 - 600 = 400
    expect(summary.inputTokens! - summary.cachedInputTokens!).toBe(400);
  });

  it("캐시 토큰 0은 실제 0으로, 받지 못한 값(null)은 모르는 값으로 둔다", () => {
    expect(summarizeUsage([{ kind: "usage", usage: usage(500, 100, 0) }])).toMatchObject({ cachedInputTokens: 0, complete: true });
    const missing = summarizeUsage([{ kind: "usage", usage: usage(500, 100, null) }]);
    expect(missing).toMatchObject({ inputTokens: 500, outputTokens: 100, totalTokens: 600, cachedInputTokens: null, complete: false });
  });

  it("여러 호출은 받은 값만 더하고, usage를 받지 못한 호출이 있으면 불완전으로 표시한다 (0으로 채우지 않는다)", () => {
    const summary = summarizeUsage([
      { kind: "usage", usage: usage(1000, 200, 600) },
      { kind: "unknown" },
      { kind: "usage", usage: usage(1100, 300, 900) },
    ]);
    expect(summary).toMatchObject({ inputTokens: 2100, outputTokens: 500, cachedInputTokens: 1500, totalTokens: 2600, calls: 3, callsWithUsage: 2, callsWithoutUsage: 1, complete: false });
    expect(summarizeUsage([{ kind: "unknown" }])).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, calls: 1, complete: false });
  });

  it("호출이 없거나 API가 오류로 거절한 호출뿐이면 쓴 토큰은 0이고 합계는 완전하다", () => {
    expect(summarizeUsage([])).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, complete: true });
    expect(summarizeUsage([{ kind: "rejected" }])).toMatchObject({ inputTokens: 0, outputTokens: 0, calls: 1, callsWithoutUsage: 0, complete: true });
  });

  it("하위 집계는 자기 호출만 세고, 같은 기록이 상위(생성 시도 전체)에도 쌓인다", () => {
    const attempt = new UsageMeter();
    const classify = new UsageMeter(attempt);
    const narrate = new UsageMeter(attempt);
    classify.record({ kind: "usage", usage: usage(300, 50, 0) });
    narrate.record({ kind: "usage", usage: usage(1000, 200, 600) });
    narrate.record({ kind: "unknown" });
    expect(classify.summary()).toMatchObject({ inputTokens: 300, calls: 1, complete: true });
    expect(narrate.summary()).toMatchObject({ inputTokens: 1000, calls: 2, complete: false });
    expect(attempt.summary()).toMatchObject({ inputTokens: 1300, outputTokens: 250, cachedInputTokens: 600, calls: 3, callsWithoutUsage: 1, complete: false });
  });
});

describe("검사 문제 기록에는 생성 문장과 질문 원문을 남기지 않는다", () => {
  it("문제의 종류와 위치만 남긴다", () => {
    expect(issueSummary("work: 없는 근거를 참조했습니다 (s999).")).toBe("work: 없는 근거를 참조했습니다 (s999)");
    expect(issueSummary("work: 말풍선이 너무 깁니다 (312자). 나눠서 써 주세요.")).toBe("work: 말풍선이 너무 깁니다 (312자)");
    expect(issueSummary("근거 없는 금액이 있습니다: 월급 300만 원이면 충분해")).toBe("근거 없는 금액이 있습니다");
    expect(issueSummary("질문(q1)에 대한 답이 없습니다: 언제쯤 취업할 수 있을지")).toBe("질문(q1)에 대한 답이 없습니다");
    expect(issueSummary("같은 문장이 반복되었습니다: 너 또 미뤘지?")).toBe("같은 문장이 반복되었습니다");
  });
});

// ─── 실제 호출 경로 (가짜 서버) ───────────────────────────────

type Planned =
  | { readonly kind: "json"; readonly text: string; readonly usage?: Record<string, unknown> | null; readonly status?: "completed" | "incomplete" }
  | { readonly kind: "error"; readonly status: number }
  | { readonly kind: "sse"; readonly text: string; readonly usage?: Record<string, unknown> | null };

let server: Server;
const planned: Planned[] = [];
let received = 0;

const apiUsage = (input: number, output: number, cached?: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
  output_tokens_details: { reasoning_tokens: 10 },
});

function responseBody(text: string, status: "completed" | "incomplete", usageBody: Record<string, unknown> | null | undefined) {
  return {
    id: "resp",
    object: "response",
    status,
    model: "fake-model",
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    ...(usageBody === null ? {} : { usage: usageBody ?? apiUsage(100, 50, 0) }),
  };
}

function sendSse(res: ServerResponse, text: string, usageBody: Record<string, unknown> | null | undefined) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let sequence = 0;
  const write = (event: Record<string, unknown>) => res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  write({ type: "response.created", response: { ...responseBody("", "completed", usageBody), status: "in_progress", output: [] } });
  for (let index = 0; index < text.length; index += 4) {
    write({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: text.slice(index, index + 4), logprobs: [] });
  }
  write({ type: "response.completed", response: responseBody(text, "completed", usageBody) });
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      const next = planned.shift() ?? { kind: "json", text: JSON.stringify({ a: "b" }) };
      if (next.kind === "error") {
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "x" } }));
      } else if (next.kind === "sse") {
        sendSse(res, next.text, next.usage);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody(next.text, next.status ?? "completed", next.usage)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
});

afterAll(() => {
  server.close();
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  planned.length = 0;
  received = 0;
});

const request = (meter: UsageMeter) => ({
  model: "fake-model",
  instructions: "지시",
  input: "{}",
  schemaName: "t",
  jsonSchema: { type: "object" },
  parser: z.object({ a: z.string() }),
  maxOutputTokens: 100,
  reasoningEffort: "low",
  timeoutMs: 5_000,
  // 일시 오류를 다시 시도하지 않게 시간 한도를 짧게 둔다.
  deadlineAt: Date.now() + 1_000,
  meter,
});

describe("호출마다 API가 돌려준 usage를 그대로 기록한다", () => {
  it("정상 응답: 입력·출력·캐시·추론 토큰을 받은 그대로 남긴다", async () => {
    planned.push({ kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(1000, 200, 600) });
    const meter = new UsageMeter();
    const result = await callStructured(request(meter));
    expect(result.meta.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, totalTokens: 1200 });
    expect(meter.summary()).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, reasoningTokens: 10, totalTokens: 1200, calls: 1, complete: true });
  });

  it("usage를 받은 뒤 형식 검증에 실패해도 받은 usage는 남는다", async () => {
    planned.push({ kind: "json", text: "형식이 아닌 글", usage: apiUsage(800, 40, 0) });
    const meter = new UsageMeter();
    await expect(callStructured(request(meter))).rejects.toMatchObject({ code: "invalid_output" });
    expect(meter.summary()).toMatchObject({ inputTokens: 800, outputTokens: 40, calls: 1, complete: true });
  });

  it("응답이 완료되지 않았어도(출력 한도) 그 응답의 usage를 남긴다", async () => {
    planned.push({ kind: "json", text: "{", status: "incomplete", usage: apiUsage(900, 24_000, 300) });
    const meter = new UsageMeter();
    await expect(callStructured(request(meter))).rejects.toMatchObject({ code: "incomplete" });
    expect(meter.summary()).toMatchObject({ inputTokens: 900, outputTokens: 24_000, cachedInputTokens: 300, complete: true });
  });

  it("응답에 usage가 없으면 0이 아니라 모르는 값으로 남긴다", async () => {
    planned.push({ kind: "json", text: JSON.stringify({ a: "b" }), usage: null });
    const meter = new UsageMeter();
    const result = await callStructured(request(meter));
    expect(result.meta.usage.inputTokens).toBeNull();
    expect(meter.summary()).toMatchObject({ inputTokens: null, outputTokens: null, calls: 1, callsWithoutUsage: 1, complete: false });
  });

  it("캐시 토큰 칸이 없으면 캐시는 모르는 값이고 합계는 불완전하다", async () => {
    planned.push({ kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(700, 70) });
    const meter = new UsageMeter();
    await callStructured(request(meter));
    expect(meter.summary()).toMatchObject({ inputTokens: 700, outputTokens: 70, cachedInputTokens: null, complete: false });
  });

  it("API가 오류로 거절한 호출은 호출 수에 넣고, 쓴 토큰이 없는 호출로 센다", async () => {
    planned.push({ kind: "error", status: 400 });
    const meter = new UsageMeter();
    await expect(callStructured(request(meter))).rejects.toBeInstanceOf(LlmError);
    expect(meter.summary()).toMatchObject({ calls: 1, callsWithoutUsage: 0, inputTokens: 0, complete: true });
  });

  it("스트리밍을 끝까지 받으면 마지막 응답의 usage를, 중간에 끊으면 모르는 값을 남긴다", async () => {
    const text = JSON.stringify({ a: "스트리밍 응답이 조금씩 들어온다" });
    planned.push({ kind: "sse", text, usage: apiUsage(1200, 300, 1000) });
    const whole = new UsageMeter();
    const done = await callStructuredStream({ ...request(whole), onDelta: async () => "continue" });
    expect(done.stopped).toBe(false);
    expect(whole.summary()).toMatchObject({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000, totalTokens: 1500, complete: true });

    planned.push({ kind: "sse", text, usage: apiUsage(1200, 300, 1000) });
    const stopped = new UsageMeter();
    const cut = await callStructuredStream({ ...request(stopped), onDelta: async (sofar) => (sofar.length > 8 ? "stop" : "continue") });
    expect(cut.stopped).toBe(true);
    expect(stopped.summary()).toMatchObject({ calls: 1, callsWithoutUsage: 1, inputTokens: null, complete: false });
  });

  it("검사에 실패해 다시 부른 호출도 따로 더한다 (마지막 성공 호출만 세지 않는다)", async () => {
    planned.push({ kind: "json", text: JSON.stringify({ a: "첫 시도" }), usage: apiUsage(1000, 200, 0) });
    planned.push({ kind: "json", text: JSON.stringify({ a: "다시 쓴 것" }), usage: apiUsage(1100, 210, 900) });
    const meter = new UsageMeter();
    await callStructured(request(meter));
    await callStructured(request(meter));
    expect(received).toBe(2);
    expect(meter.summary()).toMatchObject({ inputTokens: 2100, outputTokens: 410, cachedInputTokens: 900, totalTokens: 2510, calls: 2, complete: true });
  });
});
