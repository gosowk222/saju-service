import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCallRecorder, supabaseCallWriter, type LlmCallRow, type LlmCallTags } from "@/server/llm/call-log";
import { callStructured, callStructuredStream, type LlmCallLog } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { completedArrayItems, completedParts } from "@/server/llm/stream-parts";
import { summarizeUsage, UsageMeter, usageRecordOf } from "@/server/llm/usage";

/**
 * 무진 생성에 쓰는 LLM 기반 기능: 스트림의 배열 원소 추출, HTTP 요청 시도마다의 호출 기록(onCall), 호출 기록 저장기, 작업 설정.
 * 호출 경로는 로컬 가짜 서버가 정해 둔 응답으로만 확인한다. 실제 모델은 부르지 않으며 문장 품질과는 무관하다.
 */

// ─── 스트림의 배열 원소 추출 ───────────────────────────────

/** 텍스트의 모든 앞부분에서 예외 없이, 최종 결과의 앞부분만 늘어나며 돌려주는지 확인하고 최종 결과를 돌려준다. */
function itemsOverPrefixes(text: string, key: string): unknown[] {
  const final = completedArrayItems(text, key);
  let previous = 0;
  for (let cut = 0; cut <= text.length; cut += 1) {
    const items = completedArrayItems(text.slice(0, cut), key);
    expect(items.length).toBeGreaterThanOrEqual(previous);
    expect(items).toEqual(final.slice(0, items.length));
    previous = items.length;
  }
  return final;
}

describe("스트림 JSON에서 최상위 배열의 닫힌 원소만 찾기 (completedArrayItems)", () => {
  const doc = {
    sections: [
      { sectionId: "ch2", coreAnswer: "첫 장의 핵심 답", blocks: [] },
      { sectionId: "ch3", coreAnswer: "둘째 장", blocks: [{ type: "paragraph", text: "본문" }] },
    ],
  };

  it("원소가 닫힐 때마다 순서대로 돌려주고, 닫히지 않은 마지막 원소는 넣지 않는다", () => {
    const text = JSON.stringify(doc);
    const second = text.indexOf('{"sectionId":"ch3"');
    expect(completedArrayItems(text.slice(0, second - 1), "sections")).toEqual([doc.sections[0]]);
    expect(completedArrayItems(text.slice(0, second + 20), "sections")).toEqual([doc.sections[0]]);
    // 둘째 원소의 마지막 }가 오기 전까지는 첫 원소만.
    expect(completedArrayItems(text.slice(0, text.length - 3), "sections")).toEqual([doc.sections[0]]);
    expect(completedArrayItems(text.slice(0, text.length - 2), "sections")).toEqual(doc.sections);
    expect(itemsOverPrefixes(text, "sections")).toEqual(doc.sections);
    expect(completedArrayItems("", "sections")).toEqual([]);
    expect(completedArrayItems('{"sections":[]}', "sections")).toEqual([]);
  });

  it("문자열 안의 ] } \" \\ 와 이스케이프를 원소 경계로 읽지 않는다", () => {
    const tricky = { sections: [{ text: 'a ] b } c " d \\ e \\" f [ { , :' }, '문자열 원소 ] } " \\', { text: "\\" }, "끝\\"] };
    expect(itemsOverPrefixes(JSON.stringify(tricky), "sections")).toEqual(tricky.sections);
    // ]는 ], "는 ", }는 }이다.
    const escaped = '{"sections":["\\u005d\\u0022", {"a":"\\u007d\\\\"}, "\\"]"]}';
    expect(itemsOverPrefixes(escaped, "sections")).toEqual([']"', { a: "}\\" }, '"]']);
  });

  it("중첩 배열·객체와 문자열·숫자·true·false·null 원소를 모두 돌려준다", () => {
    const mixed = { sections: [[1, [2, [3]]], { a: { b: [{ c: "]" }] } }, "s", 12.5, -3, 0, true, false, null, [], {}] };
    expect(itemsOverPrefixes(JSON.stringify(mixed), "sections")).toEqual(mixed.sections);
    // 숫자·true·false·null은 뒤에 쉼표나 ]가 와야 끝난 것으로 본다.
    expect(completedArrayItems('{"sections":[1,2,3', "sections")).toEqual([1, 2]);
    expect(completedArrayItems('{"sections":[1,2,3 ', "sections")).toEqual([1, 2]);
    expect(completedArrayItems('{"sections":[1,2,3]', "sections")).toEqual([1, 2, 3]);
    expect(completedArrayItems('{"sections":[tru', "sections")).toEqual([]);
    expect(completedArrayItems('{"sections":[true', "sections")).toEqual([]);
    expect(completedArrayItems('{"sections":[true,', "sections")).toEqual([true]);
  });

  it("공백·줄바꿈·탭이 섞여 있어도 같은 원소를 돌려준다", () => {
    const pretty = JSON.stringify(doc, null, 2);
    expect(itemsOverPrefixes(pretty, "sections")).toEqual(doc.sections);
    const windows = pretty.replace(/\n/g, "\r\n\t");
    expect(itemsOverPrefixes(windows, "sections")).toEqual(doc.sections);
    expect(completedArrayItems('{ "sections" :\n [ 1 ,\t"두 번째" ,\r\n { "a" : [ ] } ] }', "sections")).toEqual([1, "두 번째", { a: [] }]);
  });

  it("다른 키가 먼저 나와도 최상위 객체의 그 키만 본다", () => {
    const text = JSON.stringify({
      intro: 'sections: ["가짜"]',
      meta: { sections: ["다른 값 안의 같은 이름"] },
      list: [{ sections: [9] }],
      count: 3,
      flag: false,
      sections: [{ id: "a" }],
      after: ["뒤"],
    });
    expect(itemsOverPrefixes(text, "sections")).toEqual([{ id: "a" }]);
    expect(completedArrayItems(text, "list")).toEqual([{ sections: [9] }]);
    expect(completedArrayItems(text, "after")).toEqual(["뒤"]);
    // 배열이 아닌 값(객체·문자열·숫자)은 원소가 없다.
    expect(completedArrayItems(text, "meta")).toEqual([]);
    expect(completedArrayItems(text, "intro")).toEqual([]);
    expect(completedArrayItems(text, "count")).toEqual([]);
    expect(completedArrayItems(text, "없는 키")).toEqual([]);
  });

  it("원소 안에 같은 이름의 배열 키가 있어도 최상위 원소만 돌려준다", () => {
    const nested = { sections: [{ sections: [{ id: "안쪽" }], id: "바깥 1" }, { id: "바깥 2", sections: ["x", ["y"]] }] };
    expect(itemsOverPrefixes(JSON.stringify(nested), "sections")).toEqual(nested.sections);
    // 첫 원소가 닫히기 전에는 안쪽 배열의 원소를 내보내지 않는다.
    const text = JSON.stringify(nested);
    expect(completedArrayItems(text.slice(0, text.indexOf('"id":"바깥 1"')), "sections")).toEqual([]);
  });

  it("최상위가 객체가 아니면 키로 읽지 않는다", () => {
    expect(completedArrayItems('["sections",[1,2]]', "sections")).toEqual([]);
    expect(completedArrayItems('[{"sections":[1,2]}]', "sections")).toEqual([]);
    // 최상위 배열 안에 키처럼 보이는 글자가 와도(형식 오류) 키로 읽지 않는다.
    expect(completedArrayItems('["sections":[1,2]]', "sections")).toEqual([]);
    expect(completedArrayItems('"sections"', "sections")).toEqual([]);
  });

  it("깨진 앞부분과 형식이 아닌 텍스트에서도 예외를 던지지 않는다", () => {
    const broken = [
      "{",
      '{"',
      '{"sec',
      '{"sections"',
      '{"sections":',
      '{"sections":[',
      '{"sections":[{"a":"\\',
      '{"sections":["\\u00',
      '{"sections":[{"a":"x"}, "\\',
      ']]}}""',
      'sections":[{"a":1}]',
      '{"sections":[1,,2]}',
      '{"sections":[{"a":1]}',
      '{"sections":[1}',
      '{"sections":[{]}',
      "}}}{{{[[[",
      "null",
      "\\",
      '"',
    ];
    for (const text of broken) {
      expect(() => completedArrayItems(text, "sections")).not.toThrow();
      expect(Array.isArray(completedArrayItems(text, "sections"))).toBe(true);
    }
    expect(completedArrayItems('{"sections":[{"a":"\\', "sections")).toEqual([]);
    expect(completedArrayItems('{"sections":["\\u00', "sections")).toEqual([]);
    expect(completedArrayItems('{"sections":[{"a":"x"}, "\\', "sections")).toEqual([{ a: "x" }]);
    // 닫는 괄호가 맞지 않는 원소는 해석되지 않으므로 넣지 않는다.
    expect(completedArrayItems('{"sections":[{"a":1]}', "sections")).toEqual([]);
    // 앞뒤에 다른 글자가 붙어 있어도 객체 안의 원소는 읽는다.
    expect(completedArrayItems('```json\n{"sections":[1]}\n```', "sections")).toEqual([1]);
  });

  it("기존 풀이 스캐너(completedParts)의 주제 원소와 모든 앞부분에서 같은 결과를 낸다", () => {
    const narration = {
      opening: "안녕 ] }",
      focusAngle: "메모",
      focus: [{ kind: "explanation", refs: ["s1"], text: '답 ] } "', highlight: "" }],
      topics: [
        { topicId: "work", angle: "먼저 짚을 것", bubbles: [{ kind: "explanation", refs: ["s1", "f2"], text: "일 [이야기]", highlight: "일" }] },
        { topicId: "money", angle: "", bubbles: [] },
        { topicId: "love", angle: "\\", bubbles: [{ kind: "creative-scene", refs: [], text: "장면 {괄호}", highlight: "" }] },
      ],
      closing: "끝",
    };
    const text = JSON.stringify(narration);
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(completedArrayItems(text.slice(0, cut), "topics")).toEqual(completedParts(text.slice(0, cut)).topics);
    }
    expect(completedArrayItems(text, "topics")).toEqual(narration.topics);
  });
});

// ─── 호출 기록 공통 값 ───────────────────────────────

const TAGS: LlmCallTags = {
  readingId: "r-1",
  userId: "u-1",
  productId: "mujin-overview",
  tier: "paid",
  step: "pass2",
  unitId: "ch3",
  promptVersion: "mujin-voice-1.0.0",
  schemaVersion: "mujin-voice-output-1.0.0",
  personaVersion: "1.0.0",
  reasoningEffort: "medium",
};

/** record_llm_call(p_call jsonb)이 읽는 키 이름. */
const ROW_KEYS = [
  "callKey",
  "readingId",
  "userId",
  "followupId",
  "productId",
  "tier",
  "step",
  "unitId",
  "modelRequested",
  "modelActual",
  "promptVersion",
  "schemaVersion",
  "personaVersion",
  "reasoningEffort",
  "providerResponseId",
  "providerRequestId",
  "outcome",
  "errorCode",
  "startedAt",
  "endedAt",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "usageReceived",
];

const callLog = (extra: Partial<LlmCallLog> = {}): LlmCallLog => ({
  startedAt: "2026-11-12T10:00:00.000Z",
  endedAt: "2026-11-12T10:00:01.500Z",
  outcome: "usage",
  usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, reasoningTokens: 50, cachedInputTokens: 400 },
  requestedModel: "gpt-5.6-luna",
  actualModel: "gpt-5.6-luna-2026",
  responseId: "resp_1",
  requestId: "req_1",
  errorCode: null,
  ...extra,
});

// ─── 호출 기록 (가짜 서버) ───────────────────────────────

type Planned =
  | {
      readonly kind: "json";
      readonly text: string;
      readonly usage?: Record<string, unknown> | null;
      readonly status?: "completed" | "incomplete";
      readonly id?: string;
    }
  | {
      readonly kind: "sse";
      readonly text: string;
      readonly usage?: Record<string, unknown> | null;
      readonly id?: string;
      /** completed(기본): 완료 이벤트, incomplete: 출력 한도 미완료 이벤트, cut: 끝 이벤트 없이 연결을 닫는다. */
      readonly end?: "completed" | "incomplete" | "cut";
    }
  | { readonly kind: "error"; readonly status: number }
  /** 요청을 읽은 뒤 응답 없이 연결을 끊는다. */
  | { readonly kind: "drop" }
  /** 응답하지 않는다 (시간 초과 확인용). */
  | { readonly kind: "hang" };

const ACTUAL_MODEL = "fake-model-2026";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let server: Server;
const planned: Planned[] = [];
const hanging: ServerResponse[] = [];
let received = 0;

const apiUsage = (input: number, output: number, cached?: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
  output_tokens_details: { reasoning_tokens: 10 },
});

function responseBody(text: string, status: string, usageBody: Record<string, unknown> | null | undefined, id: string) {
  return {
    id,
    object: "response",
    status,
    model: ACTUAL_MODEL,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    ...(usageBody === null ? {} : { usage: usageBody ?? apiUsage(100, 50, 0) }),
  };
}

function sendSse(
  res: ServerResponse,
  requestId: string,
  text: string,
  usageBody: Record<string, unknown> | null | undefined,
  id: string,
  end: "completed" | "incomplete" | "cut",
) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": requestId });
  let sequence = 0;
  const write = (event: Record<string, unknown>) => res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  write({ type: "response.created", response: { ...responseBody("", "in_progress", null, id), output: [] } });
  for (let index = 0; index < text.length; index += 4) {
    write({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: text.slice(index, index + 4), logprobs: [] });
  }
  if (end === "completed") write({ type: "response.completed", response: responseBody(text, "completed", usageBody, id) });
  if (end === "incomplete") write({ type: "response.incomplete", response: responseBody(text, "incomplete", usageBody, id) });
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      const requestId = `req-${received}`;
      const next = planned.shift() ?? { kind: "json", text: JSON.stringify({ a: "b" }) };
      if (next.kind === "drop") {
        req.socket.destroy();
      } else if (next.kind === "hang") {
        hanging.push(res);
      } else if (next.kind === "error") {
        res.writeHead(next.status, { "content-type": "application/json", "x-request-id": requestId });
        res.end(JSON.stringify({ error: { message: "x" } }));
      } else if (next.kind === "sse") {
        sendSse(res, requestId, next.text, next.usage, next.id ?? `resp-${received}`, next.end ?? "completed");
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-request-id": requestId });
        res.end(JSON.stringify(responseBody(next.text, next.status ?? "completed", next.usage, next.id ?? `resp-${received}`)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
});

afterAll(() => {
  for (const res of hanging.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  planned.length = 0;
  received = 0;
  for (const res of hanging.splice(0)) res.destroy();
});

/** 입력에는 출생정보처럼 보이는 값을 넣어 두고, 호출 기록에 원문이 들어가지 않는지 확인한다. */
const SECRET_INPUT = JSON.stringify({ birth: "1998-09-19 신시", concern: "비밀 질문" });

const request = () => ({
  model: "fake-model",
  instructions: "비밀 지시",
  input: SECRET_INPUT,
  schemaName: "t",
  jsonSchema: { type: "object" },
  parser: z.object({ a: z.string() }),
  maxOutputTokens: 100,
  reasoningEffort: "low",
  timeoutMs: 5_000,
});

function collect() {
  const logs: LlmCallLog[] = [];
  return { logs, onCall: (log: LlmCallLog) => void logs.push(log) };
}

describe("HTTP 요청 시도마다 호출 기록을 한 번 넘긴다 (onCall)", () => {
  it("비스트림 성공 1회: usage 기록 1건 (입력·출력·캐시 토큰, 응답 ID, 요청 ID, 시각)", async () => {
    planned.push({ kind: "json", text: JSON.stringify({ a: "생성된 비밀 문장" }), usage: apiUsage(1000, 200, 600), id: "resp_ok" });
    const { logs, onCall } = collect();
    const meter = new UsageMeter();
    const before = Date.now();
    const result = await callStructured({ ...request(), meter, onCall });
    expect(result.parsed).toEqual({ a: "생성된 비밀 문장" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      outcome: "usage",
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, reasoningTokens: 10, totalTokens: 1200 },
      requestedModel: "fake-model",
      actualModel: ACTUAL_MODEL,
      responseId: "resp_ok",
      requestId: "req-1",
      errorCode: null,
    });
    expect(logs[0]!.startedAt).toMatch(ISO);
    expect(logs[0]!.endedAt).toMatch(ISO);
    expect(Date.parse(logs[0]!.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(logs[0]!.endedAt)).toBeGreaterThanOrEqual(Date.parse(logs[0]!.startedAt));
    // meter와 같은 기준으로 센다.
    expect(summarizeUsage(logs.map(usageRecordOf))).toEqual(meter.summary());
    // 지시·입력·생성 문장은 기록에 없다.
    const serialized = JSON.stringify(logs);
    for (const secret of ["비밀 지시", "1998-09-19", "비밀 질문", "생성된 비밀 문장"]) expect(serialized).not.toContain(secret);
  });

  it("일시 오류 뒤 다시 시도해 성공하면 기록 2건: 첫째는 rejected (오류 코드와 요청 ID), 둘째는 usage", async () => {
    planned.push({ kind: "error", status: 503 }, { kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(300, 30, 0) });
    const { logs, onCall } = collect();
    const meter = new UsageMeter();
    const result = await callStructured({ ...request(), meter, onCall });
    expect(result.meta.calls).toBe(2);
    expect(logs.map((log) => [log.outcome, log.errorCode])).toEqual([
      ["rejected", "server_error"],
      ["usage", null],
    ]);
    expect(logs[0]).toMatchObject({ usage: null, requestId: "req-1", responseId: null, actualModel: null, requestedModel: "fake-model" });
    expect(logs[1]).toMatchObject({ requestId: "req-2", usage: { inputTokens: 300, outputTokens: 30, cachedInputTokens: 0 } });
    // 재시도 대기 시간은 앞 기록에 넣지 않는다.
    expect(Date.parse(logs[1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(logs[0]!.endedAt) + 400);
    expect(summarizeUsage(logs.map(usageRecordOf))).toEqual(meter.summary());
    expect(meter.summary()).toMatchObject({ calls: 2, callsWithoutUsage: 0, inputTokens: 300, complete: true });
  });

  it("연결이 끊긴 요청은 unknown (connection)으로 남고, 다시 시도한 요청은 따로 남는다", async () => {
    planned.push({ kind: "drop" }, { kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(400, 40, 100) });
    const { logs, onCall } = collect();
    const meter = new UsageMeter();
    await callStructured({ ...request(), meter, onCall });
    expect(logs.map((log) => [log.outcome, log.errorCode, log.usage === null])).toEqual([
      ["unknown", "connection", true],
      ["usage", null, false],
    ]);
    expect(summarizeUsage(logs.map(usageRecordOf))).toEqual(meter.summary());
    expect(meter.summary()).toMatchObject({ calls: 2, callsWithoutUsage: 1, complete: false });
  });

  it("4xx 오류 응답은 rejected 1건이고 다시 시도하지 않는다", async () => {
    planned.push({ kind: "error", status: 400 });
    const { logs, onCall } = collect();
    await expect(callStructured({ ...request(), onCall })).rejects.toMatchObject({ code: "bad_request" });
    expect(received).toBe(1);
    expect(logs).toEqual([expect.objectContaining({ outcome: "rejected", usage: null, errorCode: "bad_request", requestId: "req-1" })]);
  });

  it("응답 형식 오류: usage는 그대로 남기고 errorCode는 invalid_output (JSON 아님, 형식 불일치)", async () => {
    planned.push(
      { kind: "json", text: "형식이 아닌 글", usage: apiUsage(800, 40, 0), id: "resp_bad" },
      { kind: "json", text: JSON.stringify({ wrong: 1 }), usage: apiUsage(500, 20, 5) },
    );
    const { logs, onCall } = collect();
    await expect(callStructured({ ...request(), onCall })).rejects.toMatchObject({ code: "invalid_output" });
    await expect(callStructured({ ...request(), onCall })).rejects.toMatchObject({ code: "invalid_output" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ outcome: "usage", usage: { inputTokens: 800, outputTokens: 40, cachedInputTokens: 0 }, responseId: "resp_bad", errorCode: "invalid_output" });
    expect(logs[1]).toMatchObject({ outcome: "usage", usage: { inputTokens: 500, outputTokens: 20, cachedInputTokens: 5 }, errorCode: "invalid_output" });
  });

  it("미완료 응답과 usage가 없는 응답을 구분한다 (받지 못한 usage는 null, 0으로 채우지 않는다)", async () => {
    planned.push(
      { kind: "json", text: "{", status: "incomplete", usage: apiUsage(900, 100, 300) },
      { kind: "json", text: JSON.stringify({ a: "b" }), usage: null },
    );
    const { logs, onCall } = collect();
    await expect(callStructured({ ...request(), onCall })).rejects.toMatchObject({ code: "incomplete" });
    await callStructured({ ...request(), onCall });
    expect(logs[0]).toMatchObject({ outcome: "usage", usage: { inputTokens: 900, outputTokens: 100, cachedInputTokens: 300 }, errorCode: "incomplete" });
    expect(logs[1]).toMatchObject({ outcome: "unknown", usage: null, errorCode: null, responseId: "resp-2" });
  });

  it("응답이 없어 시간이 초과된 요청은 unknown (timeout)", async () => {
    planned.push({ kind: "hang" });
    const { logs, onCall } = collect();
    await expect(callStructured({ ...request(), timeoutMs: 300, deadlineAt: Date.now() + 100, onCall })).rejects.toMatchObject({ code: "timeout" });
    expect(logs).toEqual([expect.objectContaining({ outcome: "unknown", usage: null, errorCode: "timeout" })]);
  });

  it("스트림을 끝까지 받으면 usage 1건 (요청 ID는 응답 헤더, 응답 ID는 응답 이벤트에서)", async () => {
    const text = JSON.stringify({ a: "스트리밍 응답이 조금씩 들어온다" });
    planned.push({ kind: "sse", text, usage: apiUsage(1200, 300, 1000), id: "resp_stream" });
    const { logs, onCall } = collect();
    const meter = new UsageMeter();
    const result = await callStructuredStream({ ...request(), meter, onCall, onDelta: async () => "continue" });
    expect(result.parsed).toEqual(JSON.parse(text));
    expect(logs).toEqual([
      expect.objectContaining({
        outcome: "usage",
        usage: expect.objectContaining({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000 }),
        responseId: "resp_stream",
        requestId: "req-1",
        actualModel: ACTUAL_MODEL,
        errorCode: null,
      }),
    ]);
    expect(summarizeUsage(logs.map(usageRecordOf))).toEqual(meter.summary());
  });

  it("스트림에서 onDelta가 stop을 돌려주면 unknown 1건 (usage 없음, 시작 이벤트의 응답 ID는 남는다)", async () => {
    planned.push({ kind: "sse", text: JSON.stringify({ a: "끝까지 받지 않을 스트림 응답" }), usage: apiUsage(1200, 300, 1000), id: "resp_cut" });
    const { logs, onCall } = collect();
    const meter = new UsageMeter();
    const result = await callStructuredStream({ ...request(), meter, onCall, onDelta: async (sofar) => (sofar.length > 8 ? "stop" : "continue") });
    expect(result.stopped).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: "unknown", usage: null, errorCode: null, responseId: "resp_cut", requestId: "req-1", actualModel: ACTUAL_MODEL });
    expect(summarizeUsage(logs.map(usageRecordOf))).toEqual(meter.summary());
  });

  it("스트림을 끝까지 받았지만 형식이 맞지 않으면 usage와 invalid_output을 남기고 결과는 지금처럼 parsed: null이다", async () => {
    planned.push({ kind: "sse", text: JSON.stringify({ wrong: 1 }), usage: apiUsage(600, 30, 0) });
    const { logs, onCall } = collect();
    const result = await callStructuredStream({ ...request(), onCall, onDelta: async () => "continue" });
    expect(result.parsed).toBeNull();
    expect(result.stopped).toBe(false);
    expect(logs).toEqual([expect.objectContaining({ outcome: "usage", errorCode: "invalid_output", usage: expect.objectContaining({ inputTokens: 600 }) })]);
  });

  it("스트림이 출력 한도로 미완료되면 usage와 incomplete, 끝 이벤트 없이 끊기면 unknown과 incomplete를 남긴다 (다시 시도하지 않는다)", async () => {
    planned.push({ kind: "sse", text: '{"a":"출력 한도에 걸린', usage: apiUsage(1500, 16_000, 200), end: "incomplete" });
    const first = collect();
    await expect(callStructuredStream({ ...request(), onCall: first.onCall, onDelta: async () => "continue" })).rejects.toMatchObject({ code: "incomplete" });
    expect(first.logs).toEqual([
      expect.objectContaining({
        outcome: "usage",
        errorCode: "incomplete",
        usage: expect.objectContaining({ inputTokens: 1500, outputTokens: 16_000, cachedInputTokens: 200 }),
      }),
    ]);

    planned.push({ kind: "sse", text: '{"a":"중간에 끊긴', end: "cut" });
    const second = collect();
    const meter = new UsageMeter();
    await expect(callStructuredStream({ ...request(), meter, onCall: second.onCall, onDelta: async () => "continue" })).rejects.toMatchObject({ code: "incomplete" });
    expect(second.logs).toEqual([expect.objectContaining({ outcome: "unknown", usage: null, errorCode: "incomplete", responseId: "resp-2", requestId: "req-2" })]);
    expect(summarizeUsage(second.logs.map(usageRecordOf))).toEqual(meter.summary());
    expect(received).toBe(2);
  });

  it("스트림: 글자를 받기 전 일시 오류는 다시 시도하고 기록이 2건, 콜백에서 난 오류는 unknown 1건", async () => {
    planned.push({ kind: "error", status: 503 }, { kind: "sse", text: JSON.stringify({ a: "두 번째" }), usage: apiUsage(200, 20, 0) });
    const first = collect();
    const result = await callStructuredStream({ ...request(), onCall: first.onCall, onDelta: async () => "continue" });
    expect(result.meta.calls).toBe(2);
    expect(first.logs.map((log) => [log.outcome, log.errorCode, log.requestId])).toEqual([
      ["rejected", "server_error", "req-1"],
      ["usage", null, "req-2"],
    ]);

    planned.push({ kind: "sse", text: JSON.stringify({ a: "콜백 오류" }), usage: apiUsage(200, 20, 0) });
    const second = collect();
    class Handover extends Error {}
    await expect(
      callStructuredStream({ ...request(), onCall: second.onCall, onDelta: async () => Promise.reject(new Handover("넘김")) }),
    ).rejects.toBeInstanceOf(Handover);
    expect(second.logs).toEqual([expect.objectContaining({ outcome: "unknown", usage: null, errorCode: null })]);
  });

  it("스트림: 응답이 오지 않아 시간이 초과되면 unknown (timeout) 1건", async () => {
    planned.push({ kind: "hang" });
    const { logs, onCall } = collect();
    await expect(
      callStructuredStream({ ...request(), timeoutMs: 300, deadlineAt: Date.now() + 100, onCall, onDelta: async () => "continue" }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(logs).toEqual([expect.objectContaining({ outcome: "unknown", usage: null, errorCode: "timeout" })]);
  });

  it("onCall 안의 예외(동기·비동기)는 결과·재시도·meter 기록을 바꾸지 않는다", async () => {
    planned.push({ kind: "error", status: 503 }, { kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(100, 10, 0) });
    const meter = new UsageMeter();
    let seen = 0;
    const result = await callStructured({
      ...request(),
      meter,
      onCall: () => {
        seen += 1;
        throw new Error("기록 실패");
      },
    });
    expect(result.parsed).toEqual({ a: "b" });
    expect(result.meta.calls).toBe(2);
    expect(seen).toBe(2);
    expect(meter.summary()).toMatchObject({ calls: 2, inputTokens: 100, complete: true });

    planned.push({ kind: "sse", text: JSON.stringify({ a: "비동기" }), usage: apiUsage(100, 10, 0) });
    const rejecting = async () => {
      throw new Error("비동기 기록 실패");
    };
    const streamed = await callStructuredStream({ ...request(), onCall: rejecting, onDelta: async () => "continue" });
    expect(streamed.parsed).toEqual({ a: "비동기" });
    // 처리되지 않은 거부가 있으면 테스트 실행기가 실패로 알린다.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("onCall이 없으면 결과·재시도·meter 기록이 onCall이 있을 때와 같다", async () => {
    const run = async (onCall?: (log: LlmCallLog) => void) => {
      planned.push({ kind: "error", status: 503 }, { kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(700, 70, 100) });
      const meter = new UsageMeter();
      const result = await callStructured({ ...request(), meter, ...(onCall ? { onCall } : {}) });
      const requests = received;
      received = 0;
      return { parsed: result.parsed, calls: result.meta.calls, usage: result.meta.usage, responseId: result.meta.responseId, summary: meter.summary(), requests };
    };
    const plain = await run();
    const logged = collect();
    expect(await run(logged.onCall)).toEqual(plain);
    expect(logged.logs).toHaveLength(2);
  });

  it("요청을 보내지 못한 설정 오류에는 onCall을 부르지 않는다", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { logs, onCall } = collect();
      await expect(callStructured({ ...request(), onCall })).rejects.toMatchObject({ code: "model_not_configured" });
      expect(logs).toHaveLength(0);
      expect(received).toBe(0);
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });

  it("기록기의 forCall을 onCall로 넘기면 요청 시도마다 한 행이 서로 다른 키로 남는다", async () => {
    planned.push({ kind: "error", status: 503 }, { kind: "json", text: JSON.stringify({ a: "b" }), usage: apiUsage(900, 90, 300), id: "resp_rec" });
    const rows: LlmCallRow[] = [];
    const recorder = createCallRecorder(async (row) => void rows.push(row));
    await callStructured({ ...request(), onCall: recorder.forCall({ ...TAGS, step: "classify", tier: null, unitId: null }) });
    await recorder.flush();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.outcome, row.errorCode, row.usageReceived])).toEqual([
      ["rejected", "server_error", false],
      ["usage", null, true],
    ]);
    expect(new Set(rows.map((row) => row.callKey)).size).toBe(2);
    expect(rows[0]).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, providerRequestId: "req-1", providerResponseId: null });
    expect(rows[1]).toMatchObject({
      inputTokens: 900,
      outputTokens: 90,
      cachedInputTokens: 300,
      reasoningTokens: 10,
      providerResponseId: "resp_rec",
      providerRequestId: "req-2",
      modelRequested: "fake-model",
      modelActual: ACTUAL_MODEL,
      step: "classify",
      tier: null,
      unitId: null,
    });
    expect(String(rows[0]!.callKey)).toMatch(/^r-1:classify:-:[0-9a-f-]{36}$/);
    // JSON으로 그대로 보낼 수 있고, 지시·입력 원문이 없다.
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
    for (const secret of ["비밀 지시", "1998-09-19", "비밀 질문"]) expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

// ─── 호출 기록 저장기 ───────────────────────────────

function capture() {
  const rows: LlmCallRow[] = [];
  return { rows, recorder: createCallRecorder(async (row) => void rows.push(row)) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("호출 기록 저장기 (createCallRecorder)", () => {
  it("행의 키는 record_llm_call(p_call)이 읽는 이름 그대로이고 태그와 기록을 옮긴다", async () => {
    const { rows, recorder } = capture();
    recorder.forCall({ ...TAGS, followupId: "f-1" })(callLog());
    await recorder.flush();
    expect(Object.keys(rows[0]!).sort()).toEqual([...ROW_KEYS].sort());
    expect(rows[0]).toMatchObject({
      readingId: "r-1",
      userId: "u-1",
      followupId: "f-1",
      productId: "mujin-overview",
      tier: "paid",
      step: "pass2",
      unitId: "ch3",
      modelRequested: "gpt-5.6-luna",
      modelActual: "gpt-5.6-luna-2026",
      promptVersion: "mujin-voice-1.0.0",
      schemaVersion: "mujin-voice-output-1.0.0",
      personaVersion: "1.0.0",
      reasoningEffort: "medium",
      providerResponseId: "resp_1",
      providerRequestId: "req_1",
      outcome: "usage",
      errorCode: null,
      startedAt: "2026-11-12T10:00:00.000Z",
      endedAt: "2026-11-12T10:00:01.500Z",
      usageReceived: true,
    });
    // followupId를 주지 않으면 null이다.
    recorder.forCall(TAGS)(callLog());
    await recorder.flush();
    expect(rows[1]!.followupId).toBeNull();
  });

  it("재시도가 이전 기록을 덮지 않게 같은 태그라도 호출마다 새 키를 만든다", async () => {
    const { rows, recorder } = capture();
    const onCall = recorder.forCall(TAGS);
    onCall(callLog());
    onCall(callLog({ outcome: "rejected", usage: null, errorCode: "server_error" }));
    recorder.forCall({ ...TAGS, readingId: null, unitId: null, step: "followup" })(callLog());
    await recorder.flush();
    const keys = rows.map((row) => String(row.callKey));
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^r-1:pass2:ch3:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(keys[1]).toMatch(/^r-1:pass2:ch3:/);
    expect(keys[2]).toMatch(/^-:followup:-:/);
  });

  it("토큰은 받은 그대로 옮긴다: 0은 0, 받지 못한 값은 null, 캐시 토큰은 입력 토큰에 더하지 않는다", async () => {
    const { rows, recorder } = capture();
    const onCall = recorder.forCall(TAGS);
    onCall(callLog({ usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, reasoningTokens: null, cachedInputTokens: 0 } }));
    onCall(callLog({ usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, reasoningTokens: 50, cachedInputTokens: 400 } }));
    onCall(callLog({ outcome: "unknown", usage: null, responseId: "resp_cut", errorCode: null }));
    onCall(callLog({ outcome: "rejected", usage: null, responseId: null, actualModel: null, errorCode: "bad_request" }));
    await recorder.flush();
    const tokens = rows.map((row) => [row.inputTokens, row.outputTokens, row.cachedInputTokens, row.reasoningTokens, row.usageReceived]);
    expect(tokens).toEqual([
      [1000, 0, 0, null, true],
      [1000, 200, 400, 50, true],
      [null, null, null, null, false],
      [null, null, null, null, false],
    ]);
    expect(rows[2]).toMatchObject({ outcome: "unknown", providerResponseId: "resp_cut" });
    expect(rows[3]).toMatchObject({ outcome: "rejected", errorCode: "bad_request", modelActual: null });
  });

  it("저장은 기다리지 않고 바로 시작하고, flush는 도중에 새로 시작한 저장까지 모두 기다린다", async () => {
    const started: LlmCallRow[] = [];
    const finished: LlmCallRow[] = [];
    const gates: (() => void)[] = [];
    const recorder = createCallRecorder(
      (row) =>
        new Promise<void>((resolve) => {
          started.push(row);
          gates.push(() => {
            finished.push(row);
            resolve();
          });
        }),
    );
    const onCall = recorder.forCall(TAGS);
    onCall(callLog());
    onCall(callLog({ outcome: "unknown", usage: null }));
    expect(started).toHaveLength(2);

    let flushed = false;
    const flushing = recorder.flush().then(() => {
      flushed = true;
    });
    gates[0]!();
    await tick();
    expect(flushed).toBe(false);
    onCall(callLog());
    gates[1]!();
    await tick();
    expect(flushed).toBe(false);
    gates[2]!();
    await flushing;
    expect(flushed).toBe(true);
    expect(finished).toHaveLength(3);
    expect(recorder.failures()).toBe(0);
    // 기다릴 것이 없으면 바로 끝난다.
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("저장 실패는 예외를 던지지 않고 횟수만 세며, 로그에는 오류 코드만 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rejecting = createCallRecorder(async () => {
        throw Object.assign(new Error("relation llm_calls does not exist (1998-09-19)"), { code: "42P01" });
      });
      const throwing = createCallRecorder(() => {
        throw new TypeError("동기 실패 1998-09-19 비밀 질문");
      });
      expect(() => rejecting.forCall(TAGS)(callLog())).not.toThrow();
      expect(() => throwing.forCall(TAGS)(callLog())).not.toThrow();
      await expect(rejecting.flush()).resolves.toBeUndefined();
      await expect(throwing.flush()).resolves.toBeUndefined();
      expect(rejecting.failures()).toBe(1);
      expect(throwing.failures()).toBe(1);
      expect(warn).toHaveBeenCalledWith("[llm-call] not recorded", { code: "42P01" });
      expect(warn).toHaveBeenCalledWith("[llm-call] not recorded", { code: "TypeError" });
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of ["1998-09-19", "비밀 질문", "r-1", "u-1", "resp_1"]) expect(logged).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  it("supabaseCallWriter는 record_llm_call을 p_call 하나로 부르고, 오류 응답은 실패로 센다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const calls: [string, Record<string, unknown>][] = [];
      const admin = {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push([fn, args]);
          return { error: null };
        },
      };
      const recorder = createCallRecorder(supabaseCallWriter(admin));
      recorder.forCall(TAGS)(callLog());
      await recorder.flush();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("record_llm_call");
      expect(Object.keys(calls[0]![1])).toEqual(["p_call"]);
      expect(Object.keys(calls[0]![1].p_call as LlmCallRow).sort()).toEqual([...ROW_KEYS].sort());
      expect(recorder.failures()).toBe(0);

      // 함수가 없거나 거부되면 supabase-js는 예외 대신 { error }를 돌려준다.
      const missing = { rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function", details: "r-1", hint: null } }) };
      const failing = createCallRecorder(supabaseCallWriter(missing));
      expect(() => failing.forCall(TAGS)(callLog())).not.toThrow();
      await expect(failing.flush()).resolves.toBeUndefined();
      expect(failing.failures()).toBe(1);
      expect(warn).toHaveBeenCalledWith("[llm-call] not recorded", { code: "PGRST202" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("r-1");
    } finally {
      warn.mockRestore();
    }
  });

  it("관리자 클라이언트(SupabaseClient)를 그대로 넘길 수 있다 (타입 확인)", () => {
    const writerFor = (admin: SupabaseClient) => supabaseCallWriter(admin);
    expect(typeof writerFor).toBe("function");
  });

  it("호출 기록을 UsageMeter와 같은 기록 종류로 바꾼다", () => {
    expect(usageRecordOf(callLog())).toEqual({ kind: "usage", usage: callLog().usage });
    expect(usageRecordOf(callLog({ outcome: "unknown", usage: null }))).toEqual({ kind: "unknown" });
    expect(usageRecordOf(callLog({ outcome: "rejected", usage: null }))).toEqual({ kind: "rejected" });
    // usage 종류인데 값이 없으면(있을 수 없는 경우) 모르는 호출로 센다.
    expect(usageRecordOf(callLog({ outcome: "usage", usage: null }))).toEqual({ kind: "unknown" });
  });
});

// ─── 작업 설정 ───────────────────────────────

describe("무진 작업 설정", () => {
  it("Pass 1·2는 최초 풀이(reading)와 같은 추론 설정을 쓰고, 기존 작업 설정은 그대로다", () => {
    expect(LLM_SETTINGS.tasks.mujinDraft).toEqual({ maxOutputTokens: 16_000, reasoningEffort: "medium", timeoutMs: 170_000 });
    expect(LLM_SETTINGS.tasks.mujinVoice).toEqual({ maxOutputTokens: 8_000, reasoningEffort: "medium", timeoutMs: 90_000 });
    // reading 값이 바뀌면 여기서 알 수 있다. 무진 값도 바꿀지는 사용자 확인을 받는다.
    expect(LLM_SETTINGS.tasks.mujinDraft.reasoningEffort).toBe(LLM_SETTINGS.tasks.reading.reasoningEffort);
    expect(LLM_SETTINGS.tasks.mujinVoice.reasoningEffort).toBe(LLM_SETTINGS.tasks.reading.reasoningEffort);
    expect(LLM_SETTINGS.tasks.reading).toEqual({ maxOutputTokens: 24_000, reasoningEffort: "medium", timeoutMs: 200_000 });
    expect(LLM_SETTINGS.tasks.classify).toEqual({ maxOutputTokens: 2_000, reasoningEffort: "low", timeoutMs: 30_000 });
    expect(LLM_SETTINGS.tasks.followup).toEqual({ maxOutputTokens: 6_000, reasoningEffort: "low", timeoutMs: 90_000 });
    expect(Object.keys(LLM_SETTINGS.tasks).sort()).toEqual(["classify", "followup", "mujinDraft", "mujinVoice", "reading"]);
  });
});
