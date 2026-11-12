import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_NOW } from "@/domain/mujin/now";
import type { MujinPlan, ScrollSectionContent } from "@/domain/mujin/types";
import { MUJIN, MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { addMonths, emptyAnalysis, type ClassifierOutput, type QuestionItem } from "@/domain/reading/question";
import type { TimingAnalysis } from "@/domain/reading/types";
import { ApiError } from "@/server/api";
import { toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeMujinBirth, computeMujinTiming } from "@/server/engine/mujin";
import { MUJIN_FEATURE_IDS } from "@/server/engine/features";
import { analyzeTiming, type TimingRequest } from "@/server/engine/timing";
import { createCallRecorder, type LlmCallRow } from "@/server/llm/call-log";
import type { callStructured, callStructuredStream, LlmCallLog, StructuredRequest } from "@/server/llm/client";
import { buildMujinFollowupRequest, hasMujinFollowupPrompt, MUJIN_FOLLOWUP_PROMPT_1_0_0, type MujinFollowupPromptInput } from "@/server/llm/mujin-followup-prompt";
import { MUJIN_BUNDLE_VERSION, MUJIN_BUNDLES } from "@/server/llm/mujin-prompts";
import { buildFollowupPrompt, characterBlock, CURRENT_FOLLOWUP_PROMPT, FOLLOWUP_SCHEMA_VERSION } from "@/server/llm/prompts";
import { askFollowup } from "@/server/readings/followup";
import { routeWithoutItems } from "@/server/readings/followup-core";
import { loadReadingState } from "@/server/readings/store";
import {
  askScrollFollowup,
  deliveredOf,
  DELIVERED_MAX_CHARS,
  extraTimingRequests,
  followupCheckContext,
  followupMaterial,
  mujinFollowupChecker,
  supabaseFollowupStore,
  type ScrollFollowupContext,
  type ScrollFollowupDeps,
  type ScrollFollowupStore,
} from "@/server/scroll/followup";
import { scrollExtraTimingKey, type AnalysisStore } from "@/server/scroll/store";
import { MUJIN_TIMING_FEATURES, prepareScrollExtraTimingWith } from "@/server/scroll/timing";

/**
 * 무진의 종합 사주 후속 질문. 모델·DB 없이 가짜 호출과 가짜 저장소로 확인한다 (실제 OpenAI 호출 없음).
 * 출생 정보는 모두 가상 값이고, 원국 계획과 기간 재료는 실제 엔진으로 계산한다.
 */

const clients = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => clients.admin,
  createSupabaseServerClient: async () => {
    throw new Error("server client is not used in this test");
  },
}));
// 묘묘 경로(readings/followup.ts)가 족자 경로를 부르는지 보려고 실제 함수를 감싼다. 동작은 실제 함수 그대로다.
vi.mock("@/server/scroll/followup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/scroll/followup")>();
  return { ...actual, askScrollFollowup: vi.fn(actual.askScrollFollowup) };
});

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const known: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };
const birth = toPublicBirthInput(known);
const analyzed = analyzeMujinBirth({ birth, product: MUJIN_OVERVIEW, nickname: "가람", now: EMPTY_NOW });
const plan: MujinPlan = analyzed.plan;
/** 첫 유료 생성 때 고정한 기준일. 후속 질문을 하는 날(TODAY)과 다르다. */
const REFERENCE_DATE = "2026-11-12";
const TODAY = "2027-02-03";
const timing = computeMujinTiming({ birth, referenceDate: REFERENCE_DATE, gender: "female" });

const USER_ID = "11111111-1111-4111-8111-111111111111";
const READING_ID = "22222222-2222-4222-8222-222222222222";
const FOLLOWUP_ID = "33333333-3333-4333-8333-333333333333";

/** 최종문 한 장. 블록에는 서버 안에서만 쓰는 근거 연결(refs)이 붙어 있다. */
function content(sectionId: string, marker: string): ScrollSectionContent {
  return {
    sectionId,
    coreAnswer: `${marker} 핵심 답이에요. **꼭 기억할 결론**이에요.`,
    blocks: [
      { type: "paragraph", questionIds: ["3-1"], refs: ["m9001", "q7"], text: `${marker} 설명 문단이에요.`, items: [] },
      {
        type: "compare",
        questionIds: ["3-3"],
        refs: ["m9002"],
        text: "",
        items: [
          { label: "조직", text: `${marker} 조직 쪽 설명` },
          { label: "자율", text: `${marker} 자율 쪽 설명` },
        ],
      },
      { type: "scene", questionIds: [], refs: ["m9003"], text: `${marker} 가정해 보는 장면이에요.`, items: [] },
    ],
  };
}

const FINALS = new Map<string, ScrollSectionContent>([
  ["basics-structure", content("basics-structure", "기초 표지")],
  ["ch1", content("ch1", "1장 표지")],
  ["ch3", content("ch3", "3장 표지")],
  ["ch5", content("ch5", "5장 표지")],
  ["ch10", content("ch10", "10장 표지")],
  ["closing", content("closing", "정리 표지")],
]);

const CONTEXT: ScrollFollowupContext = {
  productId: MUJIN_OVERVIEW.id,
  personaId: "mujin",
  chart: analyzed.chart,
  birth,
  plan,
  finals: FINALS,
  referenceDate: REFERENCE_DATE,
  initialQuestions: { analysis: emptyAnalysis(REFERENCE_DATE), facts: [{ text: "내년에 창업하고 싶다", domain: "career", kind: "plan" }] },
  lastTurn: null,
};

const USAGE = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, reasoningTokens: 50, cachedInputTokens: 600 };

function callLog(model: string, outcome: LlmCallLog["outcome"]): LlmCallLog {
  const at = new Date(Date.UTC(2027, 1, 3)).toISOString();
  return {
    startedAt: at,
    endedAt: at,
    outcome,
    usage: outcome === "usage" ? USAGE : null,
    requestedModel: model,
    actualModel: outcome === "usage" ? "gpt-test-2027" : null,
    responseId: "resp_test",
    requestId: "req_test",
    errorCode: null,
  };
}

const meta = (model: string) => ({ requestedModel: model, actualModel: "gpt-test-2027", responseId: "resp_test", usage: USAGE, durationMs: 1, calls: 1 });

/** 질문 정리 호출 (가짜). 실제 호출처럼 사용량과 호출 기록을 남긴다. */
function fakeClassifier(output: ClassifierOutput) {
  const requests: StructuredRequest<unknown>[] = [];
  const spy = vi.fn(async (request: StructuredRequest<unknown>) => {
    requests.push(request);
    request.meter?.record({ kind: "usage", usage: USAGE });
    request.onCall?.(callLog(request.model, "usage"));
    return { parsed: request.parser.parse(output), meta: meta(request.model) };
  });
  return { call: spy as unknown as typeof callStructured, requests, spy };
}

type StreamRequest = StructuredRequest<unknown> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> };
type AnswerInput = {
  readonly questions: readonly { readonly ref: string; readonly summary: string }[];
  readonly chapters: readonly { readonly materials?: readonly { readonly ref: string }[] }[];
  readonly timing: { readonly months: { readonly months: readonly { readonly label: string }[] } } | null;
};

/** 가짜 서버(tests/support/fake-gateway.ts)와 같은 모양의 답. 질문마다 문단 세 개. */
function defaultAnswer(input: AnswerInput) {
  const ref = input.chapters.flatMap((chapter) => chapter.materials ?? [])[0]?.ref;
  const month = input.timing?.months.months[0]?.label;
  return {
    mode: "answer",
    sections: input.questions.map((question) => ({
      questionRef: question.ref,
      angle: "먼저 짚을 점",
      refs: ref ? [ref] : [],
      text: [
        `[테스트 응답] "${question.summary}"에 대한 답이에요.`,
        "[테스트 응답] **두 번째 문단**은 다음 문단이에요.",
        month ? `[테스트 응답] ${month}부터 차례로 살펴봐요.` : "[테스트 응답] 세 번째 문단이에요.",
      ].join("\n\n"),
    })),
    clarifyQuestion: "",
  };
}

/** 후속 답변 스트림 (가짜). 글자를 조금씩 넘기며 onDelta를 부르고, stop이면 멈춘다. */
function fakeStream(answer: (input: AnswerInput) => unknown = defaultAnswer) {
  const requests: StreamRequest[] = [];
  const spy = vi.fn(async (request: StreamRequest) => {
    requests.push(request);
    const text = JSON.stringify(answer(JSON.parse(request.input) as AnswerInput));
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
    request.meter?.record(stopped ? { kind: "unknown" } : { kind: "usage", usage: USAGE });
    request.onCall?.(callLog(request.model, stopped ? "unknown" : "usage"));
    return { parsed: stopped ? null : request.parser.parse(JSON.parse(text)), text: received, stopped, meta: meta(request.model) };
  });
  return { stream: spy as unknown as typeof callStructuredStream, requests, spy };
}

function fakeStore(context: ScrollFollowupContext | null, options: { readonly earlierReactions?: number; readonly begin?: ScrollFollowupStore["begin"] } = {}) {
  const record = {
    begin: 0,
    published: [] as string[],
    completed: [] as Parameters<ScrollFollowupStore["complete"]>[0][],
    failed: [] as Parameters<ScrollFollowupStore["fail"]>[0][],
  };
  const store: ScrollFollowupStore = {
    begin:
      options.begin ??
      (async () => {
        record.begin += 1;
        return { outcome: "started", used: 0, limit: 3, followup: { id: FOLLOWUP_ID, status: "answering", answer: null } };
      }),
    load: async () => context,
    earlierReactions: async () => options.earlierReactions ?? 0,
    publish: async (_id, answer) => {
      record.published.push(answer);
    },
    // 차감은 DB 함수(complete_followup)가 정상 답변(answered)일 때만 한다. 가짜도 같은 규칙으로 쓴 횟수를 돌려준다.
    complete: async (input) => {
      record.completed.push(input);
      return { saved: true, used: input.status === "answered" ? 1 : 0, limit: 3 };
    },
    fail: async (input) => {
      record.failed.push(input);
    },
  };
  return { store, record };
}

const item = (overrides: Partial<ClassifierOutput["items"][number]> = {}): ClassifierOutput["items"][number] => ({
  summary: "지금 회사에서 이직을 언제 준비하면 좋을까요",
  domain: "career",
  intent: "timing",
  options: [],
  period: { kind: "default", start: "", end: "" },
  missingInfo: [],
  ...overrides,
});

const classified = (overrides: Partial<ClassifierOutput> = {}): ClassifierOutput => ({
  items: [item()],
  userFacts: [],
  needsClarification: false,
  reaction: "none",
  ...overrides,
});

/** reading_analyses 대신 쓰는 메모리 저장소 (save_reading_analysis처럼 같은 키는 처음 저장한 값을 돌려준다). */
function memoryAnalyses() {
  const saved = new Map<string, unknown>();
  const store: AnalysisStore = {
    loadAnalysis: async <T,>(readingId: string, cacheKey: string) => (saved.get(`${readingId}/${cacheKey}`) as T | undefined) ?? null,
    saveAnalysis: async <T,>(readingId: string, cacheKey: string, _kind: "question" | "timing", _version: string, payload: T) => {
      const key = `${readingId}/${cacheKey}`;
      if (!saved.has(key)) saved.set(key, structuredClone(payload));
      return { saved: true, payload: saved.get(key) as T };
    },
  };
  return { store, saved };
}

async function ask(
  question: string,
  output: ClassifierOutput,
  options: {
    readonly context?: ScrollFollowupContext | null;
    readonly earlierReactions?: number;
    readonly answer?: (input: AnswerInput) => unknown;
    readonly prepareExtraTiming?: ScrollFollowupDeps["prepareExtraTiming"];
  } = {},
) {
  const { store, record } = fakeStore(options.context === undefined ? CONTEXT : options.context, options);
  const classify = fakeClassifier(output);
  const streamed = fakeStream(options.answer);
  const rows: LlmCallRow[] = [];
  const prepareTiming = vi.fn<ScrollFollowupDeps["prepareTiming"]>(async () => timing);
  const analyses = memoryAnalyses();
  const prepareExtraTiming = vi.fn<ScrollFollowupDeps["prepareExtraTiming"]>(
    options.prepareExtraTiming ?? ((input) => prepareScrollExtraTimingWith({ ...input, store: analyses.store })),
  );
  const response = await askScrollFollowup(
    { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question },
    {
      store,
      recorder: () =>
        createCallRecorder(async (row) => {
          rows.push(row);
        }),
      callStructured: classify.call,
      callStructuredStream: streamed.stream,
      prepareTiming,
      prepareExtraTiming,
      modelId: () => "gpt-test",
      now: () => 1_000_000,
      today: () => TODAY,
    },
  );
  return { response, record, classify, streamed, rows, prepareTiming, prepareExtraTiming };
}

const promptInput = (overrides: Partial<MujinFollowupPromptInput> = {}): MujinFollowupPromptInput => ({
  bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!,
  persona: MUJIN,
  nickname: "가람",
  hourKnown: true,
  coverageNotes: [],
  referenceDate: null,
  today: TODAY,
  questions: [],
  facts: plan.facts,
  nowFacts: plan.nowFacts,
  userContext: [],
  chapters: [],
  overview: [],
  timing: null,
  lastTurn: null,
  reaction: "none",
  ...overrides,
});

describe("무진 후속 질문 지시 (mujin-followup-1.0.0)", () => {
  it("묶음의 후속 지시 이름과 같고, 무진 캐릭터 블록으로 시작하며 묘묘 전용 반말 문구가 없다", () => {
    const bundle = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;
    expect(bundle.followupPrompt).toBe(MUJIN_FOLLOWUP_PROMPT_1_0_0);
    expect(hasMujinFollowupPrompt(bundle.followupPrompt)).toBe(true);
    const request = buildMujinFollowupRequest(promptInput());
    expect(request.instructions.startsWith(characterBlock(MUJIN))).toBe(true);
    expect(request.instructions).toContain("말씨: 존댓말");
    expect(request.instructions).toContain("[명리 해석 지침]");
    // 묘묘 지시(followup-3.1.0)의 반말 전제 문구가 들어가지 않는다.
    expect(request.instructions).not.toMatch(/존댓말[^\n.]*쓰지 않는다/);
    expect(request.instructions).not.toContain("반말로");
    expect(request.instructions).not.toContain("[캐릭터: 묘묘]");
    // 의미 보존과 금지 사항은 Pass 1·Pass 2와 같은 기준이다.
    for (const rule of ["가능성을 확정으로", "가족사", "다른 사람의 속마음", "매매를 지시하지 않는다", "진단, 병명", "날짜는 timing에 있는 달 label"]) {
      expect(request.instructions).toContain(rule);
    }
  });

  it("묘묘 후속 지시는 그대로다 (반말 캐릭터용 문구를 지우지 않았다)", () => {
    const myomyo = buildFollowupPrompt({
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
      previousIssues: [],
    });
    expect(CURRENT_FOLLOWUP_PROMPT).toBe("followup-3.1.0");
    expect(myomyo.instructions.startsWith(characterBlock(MYOMYO))).toBe(true);
    expect(myomyo.instructions).toContain("존댓말, 전문가의 인사말, 보고서 말투를 쓰지 않는다.");
  });

  it("출력 형식은 묘묘 후속 답변과 같은 followup-output-2.2.0이다 (스키마 이름도 같아 화면·가짜 서버가 같은 모양을 받는다)", () => {
    const myomyo = buildFollowupPrompt({
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
      previousIssues: [],
    });
    const mujin = buildMujinFollowupRequest(promptInput());
    expect(mujin.schemaName).toBe(myomyo.schemaName);
    expect(mujin.jsonSchema).toEqual(myomyo.jsonSchema);
    const sample = { mode: "answer", sections: [{ questionRef: "q1", angle: "메모", refs: ["m1"], text: "답" }], clarifyQuestion: "" };
    expect(mujin.parser.parse(sample)).toEqual(myomyo.parser.parse(sample));
    expect(FOLLOWUP_SCHEMA_VERSION).toBe("followup-output-2.2.0");
  });

  it("모르는 지시 버전이면 만들지 않는다", () => {
    const bundle = { ...MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!, followupPrompt: "mujin-followup-9.9.9" };
    expect(() => buildMujinFollowupRequest(promptInput({ bundle }))).toThrow(/prompt_version_unavailable/);
  });

  it("입력에는 작성용 ref만 있고 규칙·결론·근거 ID와 변형·태그 열쇠는 없다", () => {
    const ch3 = plan.sections.find((section) => section.sectionId === "ch3")!;
    expect(ch3.materials.some((material) => material.ruleId || material.evidence)).toBe(true);
    const request = buildMujinFollowupRequest(
      promptInput({ chapters: [{ sectionId: "ch3", title: ch3.title, questions: ch3.questions, materials: ch3.materials, delivered: deliveredOf(FINALS.get("ch3")) }] }),
    );
    const input = JSON.parse(request.input) as { chapters: { materials: { ref: string }[] }[] };
    expect(input.chapters[0]!.materials.map((material) => material.ref)).toEqual(ch3.materials.map((material) => material.ref));
    for (const key of ['"ruleId"', '"ruleVersion"', '"conclusionId"', '"evidence"', '"variant"', '"tags"', '"periodId"']) expect(request.input).not.toContain(key);
    for (const material of ch3.materials) if (material.conclusionId) expect(request.input).not.toContain(material.conclusionId);
  });
});

describe("무진 후속 질문 재료", () => {
  it("이미 보낸 최종문은 상한까지만, 근거 연결과 굵게 표시 없이 넘긴다", () => {
    const delivered = deliveredOf(FINALS.get("ch3"))!;
    expect(delivered.coreAnswer).toBe("3장 표지 핵심 답이에요. 꼭 기억할 결론이에요.");
    expect(delivered.blocks.map((block) => block.type)).toEqual(["paragraph", "compare", "scene"]);
    expect(JSON.stringify(delivered)).not.toMatch(/m900\d|q7|questionIds|refs/);
    const long: ScrollSectionContent = { sectionId: "ch3", coreAnswer: "가".repeat(5000), blocks: [{ type: "paragraph", questionIds: [], refs: [], text: "나".repeat(5000), items: [] }] };
    const clipped = deliveredOf(long)!;
    expect(clipped.coreAnswer.length + clipped.blocks.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThanOrEqual(DELIVERED_MAX_CHARS);
  });

  it("넓은 질문은 장별 핵심 답과 마지막 정리만 쓰고, 분야 질문은 그 장만 쓴다", () => {
    const general = followupMaterial({
      plan,
      product: MUJIN_OVERVIEW,
      items: [{ id: "q1", summary: "전체적으로 어때요", domain: "general", intent: "general", options: [], period: null, missingInfo: [], scope: "in", answerability: "full", timingSupported: false, topicDomain: null }],
      finals: FINALS,
      timing: null,
    });
    expect(general.chapters.map((chapter) => chapter.sectionId)).toEqual(["closing"]);
    expect(general.overview.map((entry) => entry.sectionId)).toEqual(["basics-structure", "ch1", "ch3", "ch5", "ch10"]);
    expect(general.timing).toBeNull();

    const romance = followupMaterial({
      plan,
      product: MUJIN_OVERVIEW,
      items: [{ id: "q1", summary: "연애할 때 제 약점은요", domain: "romance", intent: "explain", options: [], period: null, missingInfo: [], scope: "in", answerability: "full", timingSupported: false, topicDomain: "romance" }],
      finals: FINALS,
      timing,
    });
    expect(romance.sectionIds).toEqual(["ch5"]);
    expect(romance.overview).toEqual([]);
    // 기간과 이어지지 않는 질문에는 기간 자료를 넘기지 않는다.
    expect(romance.timing).toBeNull();
  });

  it("질문이 많아도 질문마다 자기 장을 하나는 받고, 시기 질문은 기간 장과 기간 자료를 먼저 받는다", () => {
    const question = (id: string, domain: "career" | "romance" | "wealth" | "family", intent: "timing" | "explain") => ({
      id,
      summary: `${domain} 질문`,
      domain,
      intent,
      options: [],
      period: null,
      missingInfo: [],
      scope: "in" as const,
      answerability: "full" as const,
      timingSupported: intent === "timing",
      topicDomain: domain,
    });
    const material = followupMaterial({
      plan,
      product: MUJIN_OVERVIEW,
      items: [question("q1", "career", "timing"), question("q2", "romance", "explain"), question("q3", "wealth", "explain"), question("q4", "family", "explain")],
      finals: FINALS,
      timing,
    });
    // 3장(직업)은 상한 때문에 빠지지만 시기 질문은 10장과 기간 자료를 받고, 나머지 질문도 각자 장을 받는다.
    expect(material.sectionIds).toEqual(["ch4", "ch5", "ch7", "ch10"]);
    expect(material.timing).not.toBeNull();
    for (const entry of material.questions) expect(entry.sectionIds.some((id) => material.sectionIds.includes(id))).toBe(true);
  });

  it("고정된 12개월 밖을 물은 기간만 분야마다 따로 계산할 기간으로 고른다 (겹치는 달, 기본 기간, 기간 규칙이 없는 분야, 상품 기간 상한 초과는 고르지 않는다)", () => {
    const window = { startMonth: "2026-11", endMonth: "2027-10" };
    const timingItem = (id: string, domain: QuestionItem["domain"], startMonth: string, endMonth: string, extra: Partial<QuestionItem> = {}): QuestionItem => ({
      id,
      summary: "시기 질문",
      domain,
      intent: "timing",
      options: [],
      period: { kind: "explicit", startMonth, endMonth },
      missingInfo: [],
      scope: "in",
      answerability: "full",
      timingSupported: true,
      topicDomain: domain as QuestionItem["topicDomain"],
      ...extra,
    });
    const requests = (...items: QuestionItem[]): TimingRequest[] => extraTimingRequests({ items, window, product: MUJIN_OVERVIEW });
    const explicit = (domain: string, startMonth: string, endMonth: string) => ({ domain, period: { kind: "explicit", startMonth, endMonth } });

    expect(requests(timingItem("q1", "career", "2028-07", "2028-12"))).toEqual([explicit("career", "2028-07", "2028-12")]);
    // 12개월과 겹치면 밖의 달만, 앞뒤로 모두 밖이면 두 구간으로 나눈다.
    expect(requests(timingItem("q1", "wealth", "2027-06", "2027-12"))).toEqual([explicit("wealth", "2027-11", "2027-12")]);
    expect(requests(timingItem("q1", "romance", "2026-05", "2027-12"))).toEqual([explicit("romance", "2026-05", "2026-10"), explicit("romance", "2027-11", "2027-12")]);
    // 12개월 안이면 고르지 않는다 (이미 있는 재료를 쓴다).
    expect(requests(timingItem("q1", "career", "2027-01", "2027-06"))).toEqual([]);
    // 기간을 말하지 않은 시기 질문(기본 기간)은 고정된 12개월로 답한다.
    expect(requests(timingItem("q1", "career", "2027-02", "2028-01", { period: { kind: "default", startMonth: "2027-02", endMonth: "2028-01" } }))).toEqual([]);
    // 기간 판단 규칙이 없는 분야나 시기 질문이 아니면 고르지 않는다.
    expect(requests(timingItem("q1", "family", "2028-07", "2028-12", { timingSupported: false }))).toEqual([]);
    expect(requests(timingItem("q1", "career", "2028-07", "2028-12", { intent: "explain", timingSupported: false }))).toEqual([]);
    // 상품 기간 상한(maxMonths)보다 긴 기간은 고르지 않는다.
    expect(requests(timingItem("q1", "career", "2028-01", addMonths("2028-01", MUJIN_OVERVIEW.timing.maxMonths)))).toEqual([]);
    // 같은 분야·기간은 한 번만, 투자 시기는 재물 월운으로 본다.
    expect(
      requests(
        timingItem("q1", "career", "2028-07", "2028-12"),
        timingItem("q2", "career", "2028-07", "2028-12"),
        timingItem("q3", "investment", "2028-07", "2028-12", { topicDomain: "wealth" }),
      ),
    ).toEqual([explicit("career", "2028-07", "2028-12"), explicit("wealth", "2028-07", "2028-12")]);
  });

  it("따로 계산하는 기간은 9·10장 기간 재료와 같은 무진 기능을 쓴다 (12개월 안의 같은 달은 같은 판단이 나온다)", async () => {
    expect(MUJIN_TIMING_FEATURES).toEqual({ yearMonths: MUJIN_FEATURE_IDS.yearMonths, decade: MUJIN_FEATURE_IDS.luck });
    const { store } = memoryAnalyses();
    const start = timing.months.window.startMonth;
    const end = addMonths(start, 2);
    const [inside] = await prepareScrollExtraTimingWith({
      store,
      readingId: READING_ID,
      birth,
      referenceDate: REFERENCE_DATE,
      requests: [{ domain: "career", period: { kind: "explicit", startMonth: start, endMonth: end } }],
    });
    const fixed = timing.analyses.find((analysis) => analysis.domain === "career")!;
    const pick = (statements: readonly TimingAnalysis["months"][number][]) =>
      statements.map(({ periodId, label, verdict, statement, markers }) => ({ periodId, label, verdict, statement, markers }));
    const months = (statement: TimingAnalysis["months"][number]) => (statement.startsOn ?? "").slice(0, 7);
    expect(inside!.months.length).toBeGreaterThan(0);
    expect(pick(inside!.months)).toEqual(pick(fixed.months.filter((statement) => months(statement) >= start && months(statement) <= end)));
  });

  it("검사는 기간 자료의 달과 재료의 ref만 허용하고, 없는 날짜·ref·비율은 잡는다", () => {
    const material = followupMaterial({
      plan,
      product: MUJIN_OVERVIEW,
      items: [{ id: "q1", summary: "이직 시기", domain: "career", intent: "timing", options: [], period: null, missingInfo: [], scope: "in", answerability: "full", timingSupported: true, topicDomain: "career" }],
      finals: FINALS,
      timing,
    });
    expect(material.sectionIds).toEqual(["ch3", "ch10"]);
    const context = followupCheckContext({ plan, chart: analyzed.chart, material, userTexts: [], lastTurn: null, excluded: [{ summary: "비트코인을 지금 사도 될까요", domain: "investment" }] });
    const checker = mujinFollowupChecker(context, analyzed.chart);
    const firstMonth = timing.months.months[0]!.label;
    const ref = material.chapters[0]!.materials[0]!.ref;
    expect(checker.section("q1", [ref])).toEqual([]);
    expect(checker.section("q1", ["m99999"])).toEqual(["없는 근거를 참조했습니다 (m99999)."]);
    expect(checker.section("q9", [])).toEqual(["없는 질문에 답했습니다 (q9)."]);
    expect(checker.paragraph(`${firstMonth}부터 준비해 보세요.`)).toEqual([]);
    expect(checker.paragraph("2031년 5월에 움직이세요.").join(" ")).toMatch(/분석하지 않은 기간/);
    expect(checker.paragraph("확률은 87%예요.").length).toBeGreaterThan(0);
    expect(checker.paragraph("지금 매수하세요.").join(" ")).toMatch(/결과를 단정하거나 진단·매매/);
    expect(checker.paragraph("코인 이야기는 하지 않을게요.").join(" ")).toMatch(/범위 밖으로 뺀 주제/);
  });
});

describe("무진 후속 질문 처리 (askScrollFollowup)", () => {
  it("범위 안 기간 질문: 무진 지시에 관련 장 재료와 최종문 일부, 고정된 기준일의 기간 재료를 넣고 한 번 차감한다", async () => {
    const { response, record, classify, streamed, rows, prepareTiming } = await ask(
      "지금 회사에서 언제 이직을 준비하면 좋을까요? 3년째 다니고 있어요.",
      classified({ userFacts: [{ text: "지금 회사에 3년째 다니고 있다", domain: "career" }] }),
    );

    // 질문 정리: 묘묘와 같은 지시, 후속 질문 방식, 질문한 날을 기준으로 기간을 읽는다.
    expect(classify.requests).toHaveLength(1);
    expect(classify.requests[0]!.schemaName).toBe("saju_question_analysis");
    expect(JSON.parse(classify.requests[0]!.input)).toMatchObject({ mode: "followup", referenceDate: TODAY });

    // 기간 재료는 질문한 날이 아니라 첫 유료 생성 때 고정한 기준일로 가져온다.
    expect(prepareTiming).toHaveBeenCalledTimes(1);
    expect(prepareTiming.mock.calls[0]![0]).toMatchObject({ readingId: READING_ID, referenceDate: REFERENCE_DATE, gender: "female" });

    expect(streamed.requests).toHaveLength(1);
    const request = streamed.requests[0]!;
    expect(request.instructions.startsWith(characterBlock(MUJIN))).toBe(true);
    expect(request.instructions).not.toContain("반말로");
    expect(request.schemaName).toBe("saju_followup_v2");
    const input = JSON.parse(request.input) as {
      referenceDate: string;
      today: string;
      questions: { ref: string; sectionIds: string[] }[];
      chapters: { sectionId: string; materials: { ref: string }[]; delivered: { coreAnswer: string } | null }[];
      timing: { months: { window: string; months: { label: string }[] } } | null;
      userContext: { text: string; from: string; kind: string | null }[];
      address: { call: string };
    };
    expect(input.referenceDate).toBe(REFERENCE_DATE);
    expect(input.today).toBe(TODAY);
    expect(input.address.call).toBe("가람 님");
    expect(input.questions).toEqual([expect.objectContaining({ ref: "q1", sectionIds: ["ch3", "ch10"] })]);
    // 질문 분야의 장(3장)과 기간 장(10장)만 보낸다. 다른 장의 최종문은 보내지 않는다.
    expect(input.chapters.map((chapter) => chapter.sectionId)).toEqual(["ch3", "ch10"]);
    const ch3 = plan.sections.find((section) => section.sectionId === "ch3")!;
    expect(input.chapters[0]!.materials.map((material) => material.ref)).toEqual(ch3.materials.map((material) => material.ref));
    expect(input.chapters[0]!.delivered?.coreAnswer).toContain("3장 표지 핵심 답");
    expect(input.chapters[1]!.materials.length).toBeGreaterThan(0);
    expect(input.chapters[1]!.delivered?.coreAnswer).toContain("10장 표지 핵심 답");
    expect(request.input).not.toContain("5장 표지");
    expect(request.input).not.toContain("1장 표지");
    expect(input.timing?.months.window).toBe(timing.months.window.label);
    expect(input.timing?.months.months.map((month) => month.label)).toEqual(timing.months.months.map((month) => month.label));
    // 처음 궁금한 점의 사실은 종류(계획)를 지키고, 이번 메시지의 사실은 이번 말로 넘긴다.
    expect(input.userContext).toEqual([
      { text: "내년에 창업하고 싶다", from: "concern", kind: "plan" },
      { text: "지금 회사에 3년째 다니고 있다", from: "message", kind: null },
    ]);

    // 정상 답변: 한 번 차감(answered), 문단을 먼저 저장해 보여 준다.
    expect(response).toMatchObject({ status: "answered", questionsUsed: 1, questionLimit: 3, replayed: false });
    expect(response.answer).toContain("**두 번째 문단**");
    expect(record.published.length).toBeGreaterThanOrEqual(3);
    expect(record.completed).toHaveLength(1);
    const completed = record.completed[0]!;
    expect(completed).toMatchObject({ followupId: FOLLOWUP_ID, userId: USER_ID, status: "answered", refs: [ch3.materials[0]!.ref] });
    expect(completed.meta).toMatchObject({
      modelId: "gpt-test",
      promptVersion: "mujin-followup-1.0.0",
      schemaVersion: "followup-output-2.2.0",
      personaVersion: MUJIN.version,
      usage: { calls: 2, inputTokens: 2000, cachedInputTokens: 1200, outputTokens: 400, totalTokens: 2400, complete: true },
      analysis: { personaId: "mujin", personaVersion: MUJIN.version, bundle: MUJIN_BUNDLE_VERSION, timingReferenceDate: REFERENCE_DATE, sectionIds: ["ch3", "ch10"], reaction: "none" },
    });
    expect(record.failed).toEqual([]);

    // 호출 단위 기록: 질문 정리와 답변이 각각 한 줄이며 후속 질문 ID와 유료 단계, 버전이 붙는다.
    expect(rows.map((row) => [row.step, row.tier, row.unitId, row.followupId, row.promptVersion, row.schemaVersion, row.personaVersion])).toEqual([
      ["classify", "paid", null, FOLLOWUP_ID, "question-1.3.0", null, null],
      ["followup", "paid", null, FOLLOWUP_ID, "mujin-followup-1.0.0", "followup-output-2.2.0", MUJIN.version],
    ]);
    expect(rows.every((row) => row.readingId === READING_ID && row.userId === USER_ID && row.productId === "mujin-overview")).toBe(true);
    // 호출 기록의 합은 followups.usage의 합계와 같다. 캐시 입력은 입력에 포함된 값이라 다시 더하지 않는다.
    expect(rows.reduce((sum, row) => sum + Number(row.inputTokens), 0)).toBe(2000);
    expect(JSON.stringify(rows)).not.toContain("이직");
  });

  it("고정된 12개월 밖의 기간을 물으면 그 기간만 고정 기준일·무진 기능으로 계산해 저장하고 지시 입력(기간 자료·10장 재료)에 넣으며, 두 번째 질문은 저장된 것을 다시 쓴다", async () => {
    const analyses = memoryAnalyses();
    const compute = vi.fn(analyzeTiming);
    const prepareExtraTiming: ScrollFollowupDeps["prepareExtraTiming"] = (input) => prepareScrollExtraTimingWith({ ...input, store: analyses.store, compute });
    const asked = classified({ items: [item({ summary: "그해 하반기에 이직하면 어떤지", period: { kind: "explicit", start: "2028-07", end: "2028-12" } })] });
    // 따로 살펴본 달을 답에 써도 검사(분석하지 않은 기간)에 걸리지 않는다.
    const answer = (input: AnswerInput) => {
      const base = defaultAnswer(input);
      const month = input.timing?.months.months.find((entry) => entry.label.startsWith("2028년"))?.label;
      return { ...base, sections: base.sections.map((section) => ({ ...section, text: `${section.text}\n\n[테스트 응답] ${month ?? "그 기간"}에는 이렇게 살펴봐요.` })) };
    };

    const first = await ask("그해 하반기에 이직하면 어때요?", asked, { prepareExtraTiming, answer });
    // 질문한 날(TODAY)이 아니라 고정 기준일로, 9·10장 기간 재료와 같은 무진 기능으로 그 기간만 계산했다.
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0]![0]).toMatchObject({
      referenceDate: REFERENCE_DATE,
      requests: [{ domain: "career", period: { kind: "explicit", startMonth: "2028-07", endMonth: "2028-12" } }],
      features: { yearMonths: MUJIN_FEATURE_IDS.yearMonths, decade: MUJIN_FEATURE_IDS.luck },
    });
    const key = scrollExtraTimingKey("career", "2028-07", "2028-12", REFERENCE_DATE);
    expect(key).toBe("mujin-timing-extra:career:2028-07..2028-12@2026-11-12");
    expect(key.length).toBeLessThanOrEqual(120);
    expect([...analyses.saved.keys()]).toEqual([`${READING_ID}/${key}`]);
    const extra = analyses.saved.get(`${READING_ID}/${key}`) as TimingAnalysis;
    expect(extra).toMatchObject({ domain: "career", referenceDate: REFERENCE_DATE, window: { kind: "explicit", startMonth: "2028-07", endMonth: "2028-12" } });
    expect(extra.months.length).toBeGreaterThan(0);

    const input = JSON.parse(first.streamed.requests[0]!.input) as {
      timing: { months: { window: string; months: { label: string; tones: Record<string, string> }[] } } | null;
      chapters: { sectionId: string; materials: { ref: string; kind: string; text: string }[] }[];
    };
    // 기간 자료: 살펴본 기간에 질문한 기간이 들어가고, 계산한 달이 고정된 12개월 뒤에 더해진다 (다른 분야는 자료 없음).
    expect(input.timing!.months.window).toContain(timing.months.window.label);
    expect(input.timing!.months.window).toContain("2028년 7월부터 2028년 12월까지");
    const labels = input.timing!.months.months.map((month) => month.label);
    expect(labels.slice(0, 12)).toEqual(timing.months.months.map((month) => month.label));
    expect(labels.slice(12)).toEqual(extra.months.map((statement) => statement.label));
    for (const month of input.timing!.months.months.slice(12)) expect(month.tones).toMatchObject({ 재물: "no-data", 연애: "no-data", 인간관계: "no-data" });
    // 10장 재료: 따로 살펴본 기간 안내와 표지가 있는 달마다의 기간 판단.
    const ch10 = input.chapters.find((chapter) => chapter.sectionId === "ch10")!;
    const texts = ch10.materials.map((material) => material.text);
    expect(texts.some((text) => text.startsWith("질문하신 기간 2028년 7월부터 2028년 12월까지"))).toBe(true);
    for (const statement of extra.months) {
      expect(ch10.materials.some((material) => material.kind === "period" && material.text.startsWith(statement.label) && material.text.includes(statement.statement))).toBe(true);
      // 규칙·결론 ID는 지시 입력에 넣지 않는다.
      expect(first.streamed.requests[0]!.input).not.toContain(statement.conclusionId);
    }
    expect(new Set(ch10.materials.map((material) => material.ref)).size).toBe(ch10.materials.length);
    // 검사를 통과해(다시 쓰지 않음) 한 번 차감하고, 따로 살펴본 기간을 관리 기록에 남긴다 (질문 문장 없음).
    expect(first.streamed.requests).toHaveLength(1);
    expect(first.response).toMatchObject({ status: "answered", questionsUsed: 1 });
    expect(first.response.answer).toContain(extra.months[0]!.label);
    expect(first.record.completed[0]!.meta).toMatchObject({ analysis: { extraPeriods: ["career:2028-07..2028-12"], timingReferenceDate: REFERENCE_DATE } });

    // 두 번째 질문: 저장된 기간 분석을 다시 쓴다 (계산 없음).
    const second = await ask("그해 하반기 이직을 다시 물어볼게요", asked, { prepareExtraTiming, answer });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.prepareExtraTiming).toHaveBeenCalledTimes(1);
    expect(second.streamed.requests[0]!.input).toContain("2028년 7월부터 2028년 12월까지");
    expect(second.response.status).toBe("answered");
  });

  it("말한 기간이 고정된 12개월 안이거나 기간을 말하지 않았으면 따로 계산하지 않는다", async () => {
    const inside = await ask("내년 봄 이직은요?", classified({ items: [item({ period: { kind: "explicit", start: "2027-03", end: "2027-05" } })] }));
    expect(inside.prepareExtraTiming).not.toHaveBeenCalled();
    expect(inside.streamed.requests[0]!.input).not.toContain("질문하신 기간");
    const unspecified = await ask("언제 이직하면 좋을까요?", classified());
    expect(unspecified.prepareExtraTiming).not.toHaveBeenCalled();
  });

  it("범위 밖 질문은 모델 답변 없이 무진의 고정 문장으로 답하고 차감하지 않는다", async () => {
    const { response, record, streamed, prepareTiming } = await ask(
      "오늘 서울 날씨 알려 줘",
      classified({ items: [item({ summary: "오늘 서울 날씨", domain: "non-saju", intent: "general", period: { kind: "none", start: "", end: "" } })] }),
    );
    expect(response).toMatchObject({ status: "off_topic", answer: MUJIN.lines.outOfScope(MUJIN_OVERVIEW.scope.topicsLabel), questionsUsed: 0 });
    expect(streamed.spy).not.toHaveBeenCalled();
    expect(prepareTiming).not.toHaveBeenCalled();
    expect(record.completed[0]).toMatchObject({ status: "off_topic", refs: [] });
  });

  it("되묻기와 무료 반응은 무진 고정 문장이고 차감하지 않으며, 무료 횟수를 넘긴 반응만 한 번 센다", async () => {
    const vague = await ask("음…", classified({ items: [], needsClarification: true }));
    expect(vague.response).toMatchObject({ status: "clarify", answer: MUJIN.lines.clarify, questionsUsed: 0 });

    const praise = "소름 돋게 맞췄네";
    const first = await ask(praise, classified({ items: [], reaction: "praise" }), { earlierReactions: 0 });
    expect(first.response).toMatchObject({ status: "clarify", answer: `${MUJIN.lines.reaction("praise", praise)}\n\n${MUJIN.lines.reactionFree}`, questionsUsed: 0 });
    const again = await ask(praise, classified({ items: [], reaction: "praise" }), { earlierReactions: MUJIN_OVERVIEW.freeReactions });
    expect(again.response).toMatchObject({ status: "answered", answer: `${MUJIN.lines.reaction("praise", praise)}\n\n${MUJIN.lines.reactionCharged}`, questionsUsed: 1 });
    for (const run of [vague, first, again]) expect(run.streamed.spy).not.toHaveBeenCalled();
    // 같은 규칙을 묘묘와 함께 쓴다 (routeWithoutItems).
    expect(routeWithoutItems(MUJIN_OVERVIEW, MUJIN, { ...emptyAnalysis(TODAY), needsClarification: true }).answer).toBe(MUJIN.lines.clarify);
  });

  it("모델이 되물으면 무진의 차감 안내를 붙이고 차감하지 않는다", async () => {
    const { response } = await ask("그거요", classified({ items: [item({ intent: "explain", domain: "general", summary: "앞에서 말한 것" })] }), {
      answer: () => ({ mode: "clarify", sections: [], clarifyQuestion: "어느 장의 설명을 말씀하시는지 짚어 주시겠어요?" }),
    });
    expect(response).toMatchObject({ status: "clarify", questionsUsed: 0 });
    expect(response.answer).toBe(`어느 장의 설명을 말씀하시는지 짚어 주시겠어요?\n\n${MUJIN.lines.notCharged}`);
  });

  it("범위 안 질문과 범위 밖 질문이 함께 오면 범위 안만 답하고 무진의 일부 제외 안내를 붙인다", async () => {
    const { response, streamed } = await ask(
      "연애할 때 제 약점이랑 비트코인 사도 되는지 알려 주세요",
      classified({
        items: [
          item({ summary: "연애할 때 제 약점", domain: "romance", intent: "explain", period: { kind: "none", start: "", end: "" } }),
          item({ summary: "비트코인을 지금 사도 될까요", domain: "non-saju", intent: "outcome", period: { kind: "none", start: "", end: "" } }),
        ],
      }),
    );
    const input = JSON.parse(streamed.requests[0]!.input) as { questions: { ref: string }[]; chapters: { sectionId: string }[] };
    expect(input.questions.map((question) => question.ref)).toEqual(["q1"]);
    expect(input.chapters.map((chapter) => chapter.sectionId)).toEqual(["ch5"]);
    expect(streamed.requests[0]!.input).not.toContain("비트코인");
    expect(response.status).toBe("answered");
    expect(response.answer.endsWith(MUJIN.lines.partialScope("사주와 관계없는 내용"))).toBe(true);
  });

  it("다른 회원의 풀이는 시작 단계(begin_followup)에서 막히고 모델을 부르지 않는다", async () => {
    const { store } = fakeStore(CONTEXT, {
      begin: async () => {
        throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
      },
    });
    const classify = fakeClassifier(classified());
    const streamed = fakeStream();
    await expect(
      askScrollFollowup(
        { userId: "44444444-4444-4444-8444-444444444444", readingId: READING_ID, clientRequestId: randomUUID(), question: "제 성격은요?" },
        { store, recorder: () => createCallRecorder(async () => undefined), callStructured: classify.call, callStructuredStream: streamed.stream, prepareTiming: async () => timing, modelId: () => "gpt-test", now: () => 0, today: () => TODAY },
      ),
    ).rejects.toMatchObject({ status: 403, code: "not_entitled" });
    expect(classify.spy).not.toHaveBeenCalled();
    expect(streamed.spy).not.toHaveBeenCalled();
  });

  it("시작했어도 소유자의 풀이를 읽지 못하면 모델을 부르지 않고 차감 없이 실패로 정리한다", async () => {
    const { store, record } = fakeStore(null);
    const classify = fakeClassifier(classified());
    await expect(
      askScrollFollowup(
        { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "제 성격은요?" },
        { store, recorder: () => createCallRecorder(async () => undefined), callStructured: classify.call, callStructuredStream: fakeStream().stream, prepareTiming: async () => timing, modelId: () => "gpt-test", now: () => 0, today: () => TODAY },
      ),
    ).rejects.toMatchObject({ status: 502, code: "generation_failed" });
    expect(classify.spy).not.toHaveBeenCalled();
    expect(record.completed).toEqual([]);
    expect(record.failed).toEqual([{ followupId: FOLLOWUP_ID, userId: USER_ID, code: "internal", usage: null }]);
  });

  it("검사에 계속 걸리면 차감 없이 실패로 정리하고 이미 쓴 사용량은 남긴다", async () => {
    const { store, record } = fakeStore(CONTEXT);
    const classify = fakeClassifier(classified({ items: [item({ domain: "romance", intent: "explain", summary: "연애 약점", period: { kind: "none", start: "", end: "" } })] }));
    const streamed = fakeStream((input) => ({
      mode: "answer",
      sections: input.questions.map((question) => ({ questionRef: question.ref, angle: "", refs: [], text: "2031년 5월에 결혼합니다." })),
      clarifyQuestion: "",
    }));
    await expect(
      askScrollFollowup(
        { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "연애 약점은요?" },
        // 다시 쓸 시간이 남았는지는 실제 시계로 본다 (묘묘와 같다).
        { store, recorder: () => createCallRecorder(async () => undefined), callStructured: classify.call, callStructuredStream: streamed.stream, prepareTiming: async () => timing, modelId: () => "gpt-test", now: () => Date.now(), today: () => TODAY },
      ),
    ).rejects.toMatchObject({ status: 502, code: "generation_failed" });
    // 검사 실패 뒤 한 번만 다시 쓴다 (묘묘와 같은 재시도 횟수).
    expect(streamed.spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(streamed.requests[1]!.input)).toHaveProperty("fixTheseProblemsFromPreviousAttempt");
    expect(record.completed).toEqual([]);
    expect(record.published).toEqual([]);
    expect(record.failed).toHaveLength(1);
    expect(record.failed[0]).toMatchObject({ code: "validation_failed", usage: { calls: 3, callsWithoutUsage: 2 } });
  });

  it("같은 요청을 다시 보내면 저장된 답을 그대로 돌려준다 (다시 만들거나 차감하지 않는다)", async () => {
    const { store } = fakeStore(CONTEXT, {
      begin: async () => ({ outcome: "duplicate", used: 1, limit: 3, followup: { id: FOLLOWUP_ID, status: "answered", answer: "저장된 답" } }),
    });
    const classify = fakeClassifier(classified());
    const response = await askScrollFollowup(
      { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "제 성격은요?" },
      { store, recorder: () => createCallRecorder(async () => undefined), callStructured: classify.call, callStructuredStream: fakeStream().stream, prepareTiming: async () => timing, modelId: () => "gpt-test", now: () => 0, today: () => TODAY },
    );
    expect(response).toEqual({ status: "answered", answer: "저장된 답", questionsUsed: 1, questionLimit: 3, replayed: true });
    expect(classify.spy).not.toHaveBeenCalled();
  });
});

/** 서버 권한 클라이언트 흉내. 필요한 조회(eq·in·order·limit·maybeSingle)와 RPC만 지원한다. */
function fakeClient(tables: Record<string, Record<string, unknown>[]>, rpcs: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }> = {}) {
  const calls: string[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let counted = false;
    let head = false;
    const result = () => ({ data: head ? null : rows, error: null, count: counted ? rows.length : null });
    const builder = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        calls.push(`select:${table}`);
        counted = Boolean(options?.count);
        head = Boolean(options?.head);
        return builder;
      },
      eq(column: string, value: unknown) {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: readonly unknown[]) {
        rows = rows.filter((row) => values.includes(row[column]));
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        const direction = options?.ascending === false ? -1 : 1;
        rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -direction : String(a[column]) > String(b[column]) ? direction : 0));
        return builder;
      },
      limit(count: number) {
        rows = rows.slice(0, count);
        return builder;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: <T>(resolve: (value: ReturnType<typeof result>) => T, reject?: (reason: unknown) => T) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push(`rpc:${fn}`);
    const handler = rpcs[fn];
    return handler ? { data: null, error: null, ...handler(args) } : { data: null, error: { message: `unexpected rpc ${fn}` } };
  };
  return { client: { from, rpc }, calls };
}

describe("후속 질문 진입점의 상품 분기 (src/server/readings/followup.ts)", () => {
  const exhausted = () => ({ data: { outcome: "exhausted", used: 3, limit: 3 } });

  it("족자 상품 풀이는 무진 경로로 보낸다 (기존 횟수 정책과 DB 함수를 그대로 쓴다)", async () => {
    const { client, calls } = fakeClient({ readings: [{ id: READING_ID, user_id: USER_ID, product_id: "mujin-overview" }] }, { begin_followup: exhausted });
    clients.admin = client;
    vi.mocked(askScrollFollowup).mockClear();
    const input = { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "제 성격은요?" };
    await expect(askFollowup(input)).rejects.toMatchObject({ status: 409, code: "exhausted" });
    expect(askScrollFollowup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(askScrollFollowup).mock.calls[0]![0]).toEqual(input);
    expect(calls).toEqual(["select:readings", "rpc:begin_followup"]);
  });

  it("묘묘 풀이는 무진 경로를 부르지 않고 기존 경로 그대로 간다", async () => {
    const { client, calls } = fakeClient({ readings: [{ id: READING_ID, user_id: USER_ID, product_id: "first-overview" }] }, { begin_followup: exhausted });
    clients.admin = client;
    vi.mocked(askScrollFollowup).mockClear();
    await expect(askFollowup({ userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "연애운은요?" })).rejects.toMatchObject({
      status: 409,
      code: "exhausted",
    });
    expect(askScrollFollowup).not.toHaveBeenCalled();
    expect(calls).toEqual(["select:readings", "rpc:begin_followup"]);
  });

  it("다른 회원의 풀이는 분기 없이 기존 경로의 권한 확인(begin_followup)에서 막힌다", async () => {
    const { client } = fakeClient(
      { readings: [{ id: READING_ID, user_id: USER_ID, product_id: "mujin-overview" }] },
      { begin_followup: () => ({ error: { message: "not_entitled" } }) },
    );
    clients.admin = client;
    vi.mocked(askScrollFollowup).mockClear();
    await expect(askFollowup({ userId: "55555555-5555-4555-8555-555555555555", readingId: READING_ID, clientRequestId: randomUUID(), question: "제 성격은요?" })).rejects.toMatchObject({
      status: 403,
      code: "not_entitled",
    });
    expect(askScrollFollowup).not.toHaveBeenCalled();
  });

  it("무진 저장소의 시작 단계는 묘묘와 같은 오류 코드로 바꾼다", async () => {
    const store = (message: string) => supabaseFollowupStore(fakeClient({}, { begin_followup: () => ({ error: { message } }) }).client as never);
    const input = { userId: USER_ID, readingId: READING_ID, clientRequestId: randomUUID(), question: "질문" };
    await expect(store("not_entitled").begin(input)).rejects.toMatchObject({ status: 403, code: "not_entitled" });
    await expect(store("not_ready").begin(input)).rejects.toMatchObject({ status: 409, code: "not_ready" });
    await expect(store("boom").begin(input)).rejects.toMatchObject({ status: 500, code: "begin_failed" });
  });
});

describe("무진 풀이의 후속 질문 상태 (GET /api/readings/{id}/state)", () => {
  it("무진 풀이도 질문 기록과 쓴 횟수, 질문 한도가 기존 형식으로 온다 (실패한 질문은 빠진다)", async () => {
    const { client } = fakeClient({
      entitlements: [{ reading_id: READING_ID, source: "free_ticket", question_limit: MUJIN_OVERVIEW.followupLimit }],
      generation_jobs: [{ reading_id: READING_ID, status: "completed", attempts: 3, lease_until: null, error_code: null }],
      reading_messages: [],
      followups: [
        { id: "f1", reading_id: READING_ID, client_request_id: "c1", question: "제 성격은요?", answer: "답 1", status: "answered", created_at: "2027-02-03T01:00:00Z" },
        { id: "f2", reading_id: READING_ID, client_request_id: "c2", question: "날씨는요?", answer: "범위 밖", status: "off_topic", created_at: "2027-02-03T01:01:00Z" },
        { id: "f3", reading_id: READING_ID, client_request_id: "c3", question: "실패", answer: null, status: "failed", created_at: "2027-02-03T01:02:00Z" },
      ],
      question_usage: [{ id: 1, reading_id: READING_ID }],
    });
    const state = await loadReadingState(client as never, READING_ID);
    expect(state).toMatchObject({ status: "completed", messages: [], questionsUsed: 1, questionLimit: 3 });
    expect(state!.followups.map((followup) => [followup.id, followup.status])).toEqual([
      ["f1", "answered"],
      ["f2", "off_topic"],
    ]);
  });

  it("구매 권한이 없으면 상태를 주지 않는다 (라우트는 403)", async () => {
    const { client } = fakeClient({ entitlements: [], generation_jobs: [] });
    expect(await loadReadingState(client as never, READING_ID)).toBeNull();
  });
});
