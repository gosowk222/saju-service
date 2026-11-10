import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findPersona } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { buildQuestionAnalysis } from "@/domain/reading/question";
import { analyzeBirth, toPublicBirthInput } from "@/server/engine/analyze";
import { callStructured, LlmError } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { narrateReading, toStoredMessages } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, isPlanV2Prompt, PROMPTS_FOR_PLAN } from "@/server/llm/prompts";
import { INITIAL_QUESTION_KEY, prepareNarration } from "@/server/readings/analysis";
import { answerAnalyzedFollowup, routeWithoutItems } from "@/server/readings/followup-core";
import { internalReason } from "@/server/log";

/**
 * 생성 경로를 실제 모델 없이 확인한다. 로컬 서버가 고정된 테스트 응답을 돌려주므로
 * 호출 횟수, 재사용, 재시도 한도, 응답 조립만 확인하며 문장 품질과는 무관하다.
 */
let server: Server;
const requests: { schema: string; input: Record<string, unknown> }[] = [];
let mode: { narration: "valid" | "invalid" | "invalid-once"; status?: number } = { narration: "valid" };

type Input = Record<string, unknown> & {
  questions: { ref: string; timingId: string | null }[];
  timing: { id: string; months: { ref: string }[] }[];
  topics: { topicId: string; statements: { ref: string }[] }[];
};

function narration(input: Input, valid: boolean) {
  const focus = input.questions.flatMap((question) => {
    const plan = input.timing.find((entry) => entry.id === question.timingId);
    return [
      { kind: "explanation", refs: [question.ref, ...(plan?.months[0] ? [plan.months[0].ref] : [input.topics[0]!.statements[0]!.ref])], text: `[테스트] ${question.ref} 핵심 답` },
      { kind: "explanation", refs: [question.ref, input.topics[0]!.statements[0]!.ref], text: `[테스트] ${question.ref} 이유` },
    ];
  });
  return {
    opening: "[테스트] 안녕하세요",
    focus: valid ? focus : focus.slice(0, 1),
    topics: input.topics.map((topic) => ({
      topicId: topic.topicId,
      bubbles: [0, 1, 2, 3].map((index) => ({
        kind: "explanation",
        refs: [topic.statements[index % topic.statements.length]!.ref],
        text: `[테스트] ${topic.topicId} ${index}`,
      })),
    })),
    closing: "[테스트] 끝",
  };
}

function respond(schema: string, input: Record<string, unknown>) {
  if (schema === "saju_question_analysis") {
    return {
      items: [
        { summary: "언제 취업할 수 있을지", domain: "career", intent: "timing", options: [], period: { kind: "default", start: "", end: "" }, missingInfo: [] },
        { summary: "이번 시험에 합격할지", domain: "study", intent: "outcome", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] },
      ],
      userFacts: [],
      needsClarification: false,
    };
  }
  if (schema === "saju_narration_v2") {
    const valid = mode.narration === "valid" || (mode.narration === "invalid-once" && requests.filter((item) => item.schema === schema).length > 1);
    return narration(input as Input, valid);
  }
  if (schema === "saju_followup_v2") {
    const questions = (input as Input).questions;
    return { mode: "answer", clarifyQuestion: "", sections: questions.map((question) => ({ questionRef: question.ref, text: `[테스트] ${question.ref}의 답`, refs: [] })) };
  }
  return { a: "b" };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { input: string; text: { format: { name: string } } };
      const schema = body.text.format.name;
      const input = schema === "t" ? {} : (JSON.parse(body.input) as Record<string, unknown>);
      requests.push({ schema, input });
      if (mode.status) {
        res.writeHead(mode.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "x" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp",
          object: "response",
          status: "completed",
          model: "gpt-5.6-luna",
          output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(respond(schema, input)), annotations: [] }] }],
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } },
        }),
      );
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
  mode = { narration: "valid" };
});

/** reading_analyses만 흉내 내는 메모리 저장소. 같은 키는 처음 값을 유지한다. */
function fakeAdmin() {
  const store = new Map<string, unknown>();
  const admin = {
    from: () => {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return query;
        },
        maybeSingle: async () => {
          const key = `${filters.reading_id}|${filters.cache_key}`;
          return { data: store.has(key) ? { payload: store.get(key) } : null, error: null };
        },
      };
      return query;
    },
    rpc: async (_name: string, args: { p_reading_id: string; p_cache_key: string; p_payload: unknown }) => {
      const key = `${args.p_reading_id}|${args.p_cache_key}`;
      if (!store.has(key)) store.set(key, JSON.parse(JSON.stringify(args.p_payload)));
      return { data: store.get(key), error: null };
    },
  };
  return { admin: admin as unknown as SupabaseClient, store };
}

const birth = toPublicBirthInput({
  birthDate: "1998-09-19",
  calendar: "solar",
  isLeapMonth: false,
  gender: "female",
  birthTime: { status: "branch", branch: "신" },
  birthPlace: { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" },
});
const base = analyzeBirth({ birth, product: FIRST_OVERVIEW, nickname: "가람", situationId: "job-seeking" });
const persona = findPersona("yeoul")!;
// 새 작업이 실제로 고정하는 값(계획 2.0.0의 현재 프롬프트와 출력 형식)으로 확인한다.
const config = { modelId: "gpt-5.6-luna", promptVersion: PROMPTS_FOR_PLAN["2.0.0"]!.prompt, schemaVersion: PROMPTS_FOR_PLAN["2.0.0"]!.schema, reasoningEffort: "low" };

describe("최초 풀이 준비", () => {
  it("궁금한 점이 비어 있으면 분류 LLM을 부르지 않는다", async () => {
    const { admin, store } = fakeAdmin();
    const prepared = await prepareNarration({ admin, readingId: "r1", base: base.plan, product: FIRST_OVERVIEW, birth, concern: "  ", modelId: "gpt-5.6-luna", deadlineAt: Date.now() + 60_000 });
    expect(requests).toHaveLength(0);
    expect(prepared.analysis.source).toBe("empty");
    expect(prepared.plan.questions).toEqual([]);
    expect(store.has(`r1|${INITIAL_QUESTION_KEY}`)).toBe(true);
  });

  it("분류와 기간 계산은 한 번만 하고, 재시도에서는 저장된 값을 다시 쓴다", async () => {
    const { admin } = fakeAdmin();
    const args = { admin, readingId: "r2", base: base.plan, product: FIRST_OVERVIEW, birth, concern: "언제 취업할까요? 이번 시험에 합격할까요?", modelId: "gpt-5.6-luna", deadlineAt: Date.now() + 60_000 };
    const first = await prepareNarration(args);
    expect(requests.map((item) => item.schema)).toEqual(["saju_question_analysis"]);
    expect(first.versions.timingComputed).toBe(1);
    expect(first.plan.questions.map((question) => question.summary)).toEqual(["언제 취업할 수 있을지"]);
    expect(first.excluded).toEqual([{ summary: "이번 시험에 합격할지", domain: "study" }]);
    // 분류 원문은 생성 입력으로 넘어가지 않는다.
    expect(JSON.stringify(first.plan)).not.toContain("이번 시험에 합격할지");

    requests.length = 0;
    const second = await prepareNarration(args);
    expect(requests).toHaveLength(0);
    expect(second.versions.timingComputed).toBe(0);
    expect(second.plan.timing[0]!.windowLabel).toBe(first.plan.timing[0]!.windowLabel);
  });
});

/** migration이 적용되지 않은 데이터베이스처럼 reading_analyses 조회·저장이 모두 실패한다. */
function brokenAdmin() {
  const failure = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.reading_analyses'" } };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => failure };
  return { from: () => query, rpc: async () => failure } as unknown as SupabaseClient;
}

describe("분석 저장소 장애", () => {
  it("저장소를 쓸 수 없어도 풀이 준비를 멈추지 않고, 저장 없이 분류와 기간 계산을 진행한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prepared = await prepareNarration({
      admin: brokenAdmin(),
      readingId: "r-broken",
      base: base.plan,
      product: FIRST_OVERVIEW,
      birth,
      concern: "호감 가는 사람이 있는데 곁을 쉽게 내주지 않아요. 언제 취업할까요?",
      modelId: "gpt-5.6-luna",
      deadlineAt: Date.now() + 60_000,
    });
    expect(requests.map((item) => item.schema)).toEqual(["saju_question_analysis"]);
    expect(prepared.plan.questions.length).toBeGreaterThan(0);
    expect(prepared.versions.timingComputed).toBe(1);
    // 오류 코드만 남기고 질문 원문이나 저장소 메시지는 남기지 않는다.
    expect(warn).toHaveBeenCalledWith("[analysis] cache unavailable", { op: "load", code: "PGRST205" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("호감");
    warn.mockRestore();
  });

  it("내부 예외의 원인은 앱의 고정 코드만 그대로 남기고 그 밖의 메시지는 예외 이름만 남긴다", () => {
    expect(internalReason(new Error("analysis_load_failed"))).toBe("analysis_load_failed");
    expect(internalReason(new TypeError("Cannot read birthDate 1998-09-19"))).toBe("TypeError");
    expect(internalReason("x")).toBe("string");
  });
});

describe("생성 경로 선택", () => {
  it("계획 2.0.0용 프롬프트는 버전이 올라가도 새 경로를 쓰고, 1.0.0 프롬프트만 이전 경로를 쓴다", () => {
    // reading-2.1.0을 추가했을 때 이름 비교 때문에 이전 경로로 빠져 생성이 모두 실패한 적이 있다.
    expect(isPlanV2Prompt(CURRENT_READING_PROMPT)).toBe(true);
    expect(isPlanV2Prompt(PROMPTS_FOR_PLAN["2.0.0"]!.prompt)).toBe(true);
    expect(isPlanV2Prompt("reading-2.0.0")).toBe(true);
    expect(isPlanV2Prompt(PROMPTS_FOR_PLAN["1.0.0"]!.prompt)).toBe(false);
    expect(isPlanV2Prompt("reading-9.9.9")).toBe(false);
  });
});

describe("최초 풀이 생성", () => {
  async function plan() {
    const { admin } = fakeAdmin();
    return prepareNarration({ admin, readingId: "r3", base: base.plan, product: FIRST_OVERVIEW, birth, concern: "언제 취업할까요?", modelId: "gpt-5.6-luna", deadlineAt: Date.now() + 60_000 });
  }

  it("말풍선마다 호출하지 않고 한 번에 받으며, 질문 답변 영역을 저장 순서 앞에 둔다", async () => {
    const prepared = await plan();
    requests.length = 0;
    const { output, meta } = await narrateReading({ narration: { version: "2.0.0", plan: prepared.plan, excluded: prepared.excluded }, chart: base.chart, persona, config });
    expect(meta.llmCalls).toBe(1);
    const messages = toStoredMessages(output, "focus");
    expect(messages[0]!.topicId).toBeNull();
    expect(messages[1]!.topicId).toBe("focus");
    expect(messages.at(-1)!.topicId).toBeNull();
  });

  it("검사에 실패하면 문제를 알려 주고 한 번만 다시 생성한다", async () => {
    const prepared = await plan();
    requests.length = 0;
    mode = { narration: "invalid-once" };
    const { meta } = await narrateReading({ narration: { version: "2.0.0", plan: prepared.plan, excluded: prepared.excluded }, chart: base.chart, persona, config });
    expect(meta.llmCalls).toBe(2);
    const retry = requests.at(-1)!.input as { fixTheseProblemsFromPreviousAttempt?: string[] };
    expect(retry.fixTheseProblemsFromPreviousAttempt?.join()).toContain("궁금한 점에 대한 답");
  });

  it("계속 실패하면 설정한 횟수에서 멈춘다", async () => {
    const prepared = await plan();
    requests.length = 0;
    mode = { narration: "invalid" };
    await expect(
      narrateReading({ narration: { version: "2.0.0", plan: prepared.plan, excluded: prepared.excluded }, chart: base.chart, persona, config }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(requests).toHaveLength(LLM_SETTINGS.validationRetries + 1);
  });
});

describe("호출 시간 한도", () => {
  it("남은 시간이 부족하면 일시 오류도 다시 시도하지 않는다", async () => {
    mode = { narration: "valid", status: 429 };
    const request = {
      model: "gpt-5.6-luna",
      instructions: "지시",
      input: "{}",
      schemaName: "t",
      jsonSchema: { type: "object" },
      parser: z.object({ a: z.string() }),
      maxOutputTokens: 100,
      reasoningEffort: "low",
      timeoutMs: 1_000,
      deadlineAt: Date.now() + 500,
    };
    await expect(callStructured(request)).rejects.toBeInstanceOf(LlmError);
    expect(requests).toHaveLength(1);
  });
});

describe("후속 질문 답변 조립", () => {
  it("여러 소질문에 각각 답하고, 범위 밖 부분은 짧게 안내한다", async () => {
    const analysis = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-10", {
      items: [
        { summary: "언제 취업할 수 있을지", domain: "career", intent: "timing", options: [], period: { kind: "default", start: "", end: "" }, missingInfo: [] },
        { summary: "취업과 창업 중 무엇이 맞는지", domain: "career", intent: "compare", options: ["취업", "창업"], period: { kind: "none", start: "", end: "" }, missingInfo: [] },
        { summary: "이번 시험에 붙을지", domain: "study", intent: "outcome", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] },
      ],
      userFacts: [],
      needsClarification: false,
    });
    const result = await answerAnalyzedFollowup({ plan: base.plan, product: FIRST_OVERVIEW, persona, chart: base.chart, analysis, initialAnalysis: null, timing: [], messages: [], lastTurn: null, modelId: "gpt-5.6-luna" });
    expect(result.status).toBe("answered");
    expect(result.answer.indexOf("q1의 답")).toBeLessThan(result.answer.indexOf("q2의 답"));
    expect(result.answer).toContain("시험·학업 결과 이야기는 이 풀이에서 다루지 않아");
    const sent = requests.find((item) => item.schema === "saju_followup_v2")!.input as Input;
    expect(JSON.stringify(sent)).not.toContain("시험에 붙을지");
  });

  it("범위 안 질문이 없으면 답변을 만들지 않고 범위 안내나 되묻기로 끝낸다", () => {
    const outside = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-10", {
      items: [{ summary: "정렬 코드 작성", domain: "non-saju", intent: "general", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] }],
      userFacts: [],
      needsClarification: false,
    });
    expect(routeWithoutItems(FIRST_OVERVIEW, outside)).toEqual({ status: "off_topic", answer: FIRST_OVERVIEW.scope.outOfScopeReply });
    const vague = buildQuestionAnalysis(FIRST_OVERVIEW, "2026-11-10", { items: [], userFacts: [], needsClarification: true });
    expect(routeWithoutItems(FIRST_OVERVIEW, vague).status).toBe("clarify");
  });
});
