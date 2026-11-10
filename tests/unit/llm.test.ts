import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { callStructured, callStructuredStream, LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, LlmConfigError, liveCallBlockReason, resolveModelId } from "@/server/llm/config";

/** 고정된 테스트 응답을 돌려주는 로컬 서버. 실제 모델 품질과는 무관하다. */
let server: Server;
let handler: (body: Record<string, unknown>) => { status: number; json?: unknown; sse?: readonly Record<string, unknown>[] };
const requests: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const { status, json, sse } = handler(body);
      if (sse) {
        res.writeHead(status, { "content-type": "text/event-stream" });
        sse.forEach((event, index) => res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`));
        res.end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
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
  requests.length = 0;
});

function okResponse(text: string, model = "gpt-5.6-luna") {
  return {
    status: 200,
    json: {
      id: "resp_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } },
    },
  };
}

const request = (model = "gpt-5.6-luna") => ({
  model,
  instructions: "지시",
  input: "입력",
  schemaName: "t",
  jsonSchema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } },
  parser: z.object({ a: z.string() }),
  maxOutputTokens: 500,
  reasoningEffort: LLM_SETTINGS.reasoningEffort,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return (error as LlmError).code;
  }
}

describe("모델 설정", () => {
  it("개발 기본값은 gpt-5.6-luna다", () => {
    expect(resolveModelId({ NODE_ENV: "development" })).toBe("gpt-5.6-luna");
    expect(resolveModelId({ NODE_ENV: "test", OPENAI_MODEL: "  " })).toBe("gpt-5.6-luna");
  });

  it("OPENAI_MODEL을 그대로 따른다", () => {
    expect(resolveModelId({ NODE_ENV: "development", OPENAI_MODEL: "gpt-6-luna" })).toBe("gpt-6-luna");
    expect(resolveModelId({ NODE_ENV: "production", OPENAI_MODEL: "gpt-5.6-luna" })).toBe("gpt-5.6-luna");
  });

  it("production이라는 이유로 모델을 바꾸지 않고, 값이 없으면 설정 오류로 처리한다", () => {
    expect(() => resolveModelId({ NODE_ENV: "production" })).toThrow(LlmConfigError);
  });
});

describe("요청 형식", () => {
  it("설정한 모델과 지원 옵션만 보낸다", async () => {
    handler = () => okResponse('{"a":"b"}', "gpt-6-luna");
    const result = await callStructured(request(resolveModelId({ NODE_ENV: "development", OPENAI_MODEL: "gpt-6-luna" })));
    expect(result.parsed).toEqual({ a: "b" });
    const body = requests[0]!;
    expect(body.model).toBe("gpt-6-luna");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body.max_output_tokens).toBe(500);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
    expect((body.text as { format: Record<string, unknown> }).format).toMatchObject({ type: "json_schema", name: "t", strict: true });
  });

  it("요청 모델과 응답의 실제 모델, 토큰 사용량을 돌려준다", async () => {
    handler = () => okResponse('{"a":"b"}', "gpt-5.6-luna-2026-01");
    const { meta } = await callStructured(request());
    expect(meta.requestedModel).toBe("gpt-5.6-luna");
    expect(meta.actualModel).toBe("gpt-5.6-luna-2026-01");
    expect(meta.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
    expect(meta.calls).toBe(1);
  });
});

describe("오류 구분", () => {
  it.each([
    [401, { error: { message: "x" } }, "auth_failed"],
    [403, { error: { message: "x" } }, "permission_denied"],
    [404, { error: { message: "x" } }, "model_not_found"],
    [400, { error: { message: "x", code: "model_not_found" } }, "model_not_found"],
    [400, { error: { message: "x" } }, "bad_request"],
    [429, { error: { message: "x", code: "insufficient_quota" } }, "quota_exceeded"],
  ])("HTTP %s", async (status, json, expected) => {
    handler = () => ({ status, json });
    expect(await codeOf(callStructured(request()))).toBe(expected);
    expect(requests).toHaveLength(1);
  });

  it("사용량 제한은 정해진 횟수까지만 재시도한다", async () => {
    handler = () => ({ status: 429, json: { error: { message: "x" } } });
    expect(await codeOf(callStructured(request()))).toBe("rate_limited");
    expect(requests).toHaveLength(LLM_SETTINGS.transportRetries + 1);
  });

  it("다른 모델로 몰래 바꾸지 않는다", async () => {
    handler = () => ({ status: 404, json: { error: { message: "x" } } });
    await codeOf(callStructured(request("gpt-6-luna")));
    expect(requests.map((body) => body.model)).toEqual(["gpt-6-luna"]);
  });

  it("완료되지 않은 응답을 구분한다", async () => {
    handler = () => ({
      status: 200,
      json: { id: "r", object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, model: "m", output: [] },
    });
    expect(await codeOf(callStructured(request()))).toBe("incomplete");
  });

  it("빈 응답, 거절, 형식 오류를 구분한다", async () => {
    handler = () => ({ status: 200, json: { id: "r", object: "response", status: "completed", model: "m", output: [] } });
    expect(await codeOf(callStructured(request()))).toBe("empty_response");

    handler = () => ({
      status: 200,
      json: {
        id: "r",
        object: "response",
        status: "completed",
        model: "m",
        output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }],
      },
    });
    expect(await codeOf(callStructured(request()))).toBe("refused");

    handler = () => okResponse("not json");
    expect(await codeOf(callStructured(request()))).toBe("invalid_output");

    handler = () => okResponse('{"wrong":1}');
    expect(await codeOf(callStructured(request()))).toBe("invalid_output");
  });

  it("키가 없으면 호출하지 않고 설정 오류로 처리한다", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    handler = () => okResponse('{"a":"b"}');
    expect(await codeOf(callStructured(request()))).toBe("model_not_configured");
    expect(requests).toHaveLength(0);
    process.env.OPENAI_API_KEY = saved;
  });
});

describe("실제 API 호출 제한", () => {
  it("Next 서버 밖에서는 실제 OpenAI 주소로 호출하지 않고, 가짜 서버 주소일 때만 호출한다", () => {
    expect(liveCallBlockReason({}, undefined)).toContain("개발 서버");
    expect(liveCallBlockReason({ OPENAI_BASE_URL: "https://api.openai.com/v1" }, undefined)).toContain("개발 서버");
    expect(liveCallBlockReason({ OPENAI_BASE_URL: "http://127.0.0.1:4010/v1" }, undefined)).toBeNull();
    // 직접 연 개발 서버나 배포 서버(Next)는 실제 호출을 할 수 있다.
    expect(liveCallBlockReason({}, "nodejs")).toBeNull();
  });

  it("Claude Code가 띄운 프로세스는 Next 서버라도 실제 OpenAI를 부르지 않는다", () => {
    expect(liveCallBlockReason({ CLAUDECODE: "1" }, "nodejs")).toContain("Claude Code");
    expect(liveCallBlockReason({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, "nodejs")).toContain("Claude Code");
    expect(liveCallBlockReason({ CLAUDECODE: "1", OPENAI_BASE_URL: "https://api.openai.com/v1" }, "nodejs")).toContain(
      "Claude Code",
    );
    // 가짜 서버(브라우저 테스트)는 그대로 쓸 수 있다.
    expect(liveCallBlockReason({ CLAUDECODE: "1", OPENAI_BASE_URL: "http://127.0.0.1:54399/openai/v1" }, "nodejs")).toBeNull();
  });

  it("막힌 호출은 요청을 보내지 않고 설정 오류로 끝난다", async () => {
    const base = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const error = await callStructured({
        model: "gpt-5.6-luna",
        instructions: "x",
        input: "x",
        schemaName: "s",
        jsonSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
        parser: z.object({}),
        maxOutputTokens: 10,
        reasoningEffort: "low",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe("live_call_blocked");
      expect((error as LlmError).isConfigurationError).toBe(true);
      expect(requests).toHaveLength(0);
    } finally {
      process.env.OPENAI_BASE_URL = base;
    }
  });
});

describe("스트리밍 호출 (주제별로 먼저 보여 주는 생성)", () => {
  const events = (text: string, pieces = 4) => {
    const size = Math.ceil(text.length / pieces);
    const deltas = Array.from({ length: pieces }, (_, index) => text.slice(index * size, (index + 1) * size)).filter(Boolean);
    const completed = okResponse(text).json as Record<string, unknown>;
    return [
      ...deltas.map((delta) => ({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta, logprobs: [] })),
      { type: "response.completed", response: completed },
    ];
  };

  it("글자가 들어올 때마다 알리고, 끝까지 받으면 형식을 확인한 결과와 사용량을 돌려준다", async () => {
    handler = () => ({ status: 200, sse: events('{"a":"스트리밍 응답"}') });
    const seen: string[] = [];
    const result = await callStructuredStream({
      ...request(),
      onDelta: async (text) => {
        seen.push(text);
        return "continue";
      },
    });
    expect(requests[0]!.stream).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe('{"a":"스트리밍 응답"}');
    expect(result.stopped).toBe(false);
    expect(result.parsed).toEqual({ a: "스트리밍 응답" });
    expect(result.meta.usage.outputTokens).toBe(5);
    expect(result.meta.calls).toBe(1);
  });

  it("멈추라고 하면 거기서 끊고 결과 없이 돌려주며, 다시 호출하지 않는다", async () => {
    handler = () => ({ status: 200, sse: events('{"a":"끝까지 받지 않을 응답"}', 6) });
    const result = await callStructuredStream({ ...request(), onDelta: async () => "stop" });
    expect(result.stopped).toBe(true);
    expect(result.parsed).toBeNull();
    expect(result.meta.usage.outputTokens).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("글자를 받기 전의 일시 오류만 다시 시도하고, 콜백에서 난 오류는 그대로 돌려준다", async () => {
    let count = 0;
    handler = () => (count++ === 0 ? { status: 503, json: { error: { message: "busy" } } } : { status: 200, sse: events('{"a":"두 번째"}') });
    const result = await callStructuredStream({ ...request(), onDelta: async () => "continue" });
    expect(result.parsed).toEqual({ a: "두 번째" });
    expect(result.meta.calls).toBe(2);

    handler = () => ({ status: 200, sse: events('{"a":"콜백 오류"}') });
    class Handover extends Error {}
    await expect(callStructuredStream({ ...request(), onDelta: async () => Promise.reject(new Handover("넘김")) })).rejects.toBeInstanceOf(Handover);
  });
});
