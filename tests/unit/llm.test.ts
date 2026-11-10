import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { callStructured, LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, LlmConfigError, resolveModelId } from "@/server/llm/config";

/** 고정된 테스트 응답을 돌려주는 로컬 서버. 실제 모델 품질과는 무관하다. */
let server: Server;
let handler: (body: Record<string, unknown>) => { status: number; json: unknown };
const requests: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const { status, json } = handler(body);
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
