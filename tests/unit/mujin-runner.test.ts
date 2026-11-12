import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_NOW } from "@/domain/mujin/now";
import type { MujinPlan, MujinTimingBundle, ScrollDraftContent, ScrollSectionContent, ScrollTier } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import type { ChartView } from "@/domain/reading/types";
import { toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeMujinBirth, computeMujinTiming } from "@/server/engine/mujin";
import type { LlmCallRow } from "@/server/llm/call-log";
import { LlmError, type LlmCallLog, type StreamedResult, type StructuredRequest, type StructuredResult, type callStructured, type callStructuredStream } from "@/server/llm/client";
import type { MujinQuestionOutput } from "@/server/llm/mujin-prompts";
import { SCROLL_SETTINGS } from "@/server/scroll/config";
import type { ScrollClassifier } from "@/server/scroll/questions";
import { runScrollTier, type RunnerDeps } from "@/server/scroll/runner";
import { buildScrollStateView } from "@/server/scroll/state";
import { isFinalFreeFailure, type ClaimOutcome, type ClaimRequest, type FinalSection, type ScrollReadingRecord, type ScrollStore, type UnitRecord, type UnitWrite } from "@/server/scroll/store";

/**
 * 무진 생성 실행기(runner.ts). DB와 LLM 없이 가짜 저장소(SQL 함수와 같은 규칙)와 가짜 LLM을 넣어 순서와 저장을 확인한다.
 * 저장소 래퍼가 실제 SQL 함수와 맞는지는 mujin-db-flow.test.ts(PGlite)가 확인한다. 출생 입력과 질문은 모두 가상 값이다.
 * 가짜 LLM의 문장은 형식 확인용이며 문장 품질 검증이 아니다 (실제 모델 확인은 LIVE_NOT_RUN).
 */

const USER = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-11-12T03:00:00Z"); // Asia/Seoul 2026-11-12 정오
const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const known: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };

const FREE_IDS = ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"];
const PAID_IDS = ["ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10", "closing"];

let base: ReturnType<typeof analyzeMujinBirth>;
const timingMemo = new Map<string, MujinTimingBundle>();
/** 기간 재료 계산은 엔진만 쓰고 같은 입력이면 같다. 테스트 시간을 줄이려고 기준일마다 한 번만 계산한다. */
const computeTiming = vi.fn((input: Parameters<typeof computeMujinTiming>[0]) => {
  const cached = timingMemo.get(input.referenceDate);
  if (cached) return cached;
  const bundle = computeMujinTiming(input);
  timingMemo.set(input.referenceDate, bundle);
  return bundle;
});

beforeAll(() => {
  base = analyzeMujinBirth({ birth: toPublicBirthInput(known), product: MUJIN_OVERVIEW, nickname: "가람", now: EMPTY_NOW });
});

// ─── 가짜 저장소: 20261113120000_mujin_scroll.sql의 함수와 같은 규칙 ─────────────────────

interface RunRow {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  leaseUntil: number | null;
  modelId: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  reasoningEffort: string | null;
  errorCode: string | null;
  errorRetryable: boolean | null;
  referenceDate: string | null;
}

const newRun = (): RunRow => ({
  status: "queued",
  attempts: 0,
  leaseUntil: null,
  modelId: null,
  promptVersion: null,
  schemaVersion: null,
  reasoningEffort: null,
  errorCode: null,
  errorRetryable: null,
  referenceDate: null,
});

class MemoryStore implements ScrollStore {
  readonly readings = new Map<string, { reading: ScrollReadingRecord; plan: MujinPlan }>();
  readonly entitled = new Set<string>();
  readonly freeRuns = new Map<string, RunRow>();
  /** 무료 단계가 더 다시 시도할 수 없는 실패로 끝난 풀이. */
  readonly finalFreeFailure = new Set<string>();
  readonly jobs = new Map<string, RunRow>();
  readonly units = new Map<string, UnitRecord>();
  readonly finals = new Map<string, FinalSection & { readonly meta: Record<string, unknown> }>();
  readonly analyses = new Map<string, unknown>();
  readonly calls: LlmCallRow[] = [];
  /** 성공한 쓰기와 단계 정리의 기록 (예: draft:ch1@1, final:ch1@1, release:free@1). */
  readonly log: string[] = [];
  completeMeta: Record<string, unknown> | null = null;

  constructor(private readonly clock: () => number) {}

  addReading(concern = "", plan: MujinPlan = base.plan): string {
    const id = randomUUID();
    this.readings.set(id, {
      reading: {
        id,
        user_id: USER,
        product_id: MUJIN_OVERVIEW.id,
        persona_id: "mujin",
        nickname: "가람",
        concern,
        birth_input: base.birth,
        chart: base.chart,
        created_at: new Date(START).toISOString(),
      },
      plan,
    });
    return id;
  }

  /** 이용권 사용·결제처럼 권한과 유료 작업을 한 번에 만든다. */
  entitle(readingId: string): void {
    this.entitled.add(readingId);
    this.jobs.set(readingId, newRun());
  }

  /** 다른 요청이 점유를 이어받았다 (시도 번호가 바뀐다). */
  takeOver(readingId: string, tier: ScrollTier): void {
    const row = (tier === "free" ? this.freeRuns : this.jobs).get(readingId)!;
    row.attempts += 1;
    row.leaseUntil = this.clock() + SCROLL_SETTINGS.leaseSeconds * 1000;
  }

  unit(readingId: string, unitId: string): UnitRecord | undefined {
    return this.units.get(`${readingId}/${unitId}`);
  }

  private writer(readingId: string, tier: ScrollTier, attempt: number): boolean {
    const row = (tier === "free" ? this.freeRuns : this.jobs).get(readingId);
    if (!row || row.status !== "running" || row.attempts !== attempt || row.leaseUntil === null || row.leaseUntil <= this.clock()) return false;
    return tier === "free" || this.entitled.has(readingId);
  }

  private touch(readingId: string, unitId: string, tier: ScrollTier): UnitRecord {
    const key = `${readingId}/${unitId}`;
    const existing = this.units.get(key);
    if (existing) return existing;
    const created: UnitRecord = {
      unitId,
      tier,
      status: "pending",
      draft: null,
      draftAttempts: 0,
      voiceAttempts: 0,
      errorStage: null,
      errorCode: null,
      errorRetryable: null,
      updatedAt: new Date(this.clock()).toISOString(),
    };
    this.units.set(key, created);
    return created;
  }

  private put(readingId: string, unit: UnitRecord): void {
    this.units.set(`${readingId}/${unit.unitId}`, { ...unit, updatedAt: new Date(this.clock()).toISOString() });
  }

  private claim(map: Map<string, RunRow>, request: ClaimRequest, create: boolean): ClaimOutcome {
    let row = map.get(request.readingId);
    if (!row) {
      if (!create) return { claimed: false, reason: "not_entitled" };
      row = newRun();
      map.set(request.readingId, row);
    }
    const now = this.clock();
    if (row.status === "cancelled") return { claimed: false, reason: "not_entitled" };
    if (row.status === "completed") return { claimed: false, reason: "completed" };
    if (row.status === "running" && row.leaseUntil !== null && row.leaseUntil > now) return { claimed: false, reason: "running" };
    if (row.status === "failed" && !request.retry) return { claimed: false, reason: "failed" };
    if (row.attempts >= request.maxAttempts) {
      Object.assign(row, { status: "failed", errorCode: "attempts_exhausted", errorRetryable: false, leaseUntil: null });
      return { claimed: false, reason: "exhausted" };
    }
    Object.assign(row, {
      status: "running",
      attempts: row.attempts + 1,
      leaseUntil: now + request.leaseSeconds * 1000,
      modelId: row.modelId ?? request.model,
      promptVersion: row.promptVersion ?? request.promptVersion,
      schemaVersion: row.schemaVersion ?? request.schemaVersion,
      reasoningEffort: row.reasoningEffort ?? request.reasoningEffort,
      errorCode: null,
      errorRetryable: null,
    });
    return {
      claimed: true,
      run: { attempts: row.attempts, modelId: row.modelId, promptVersion: row.promptVersion, schemaVersion: row.schemaVersion, reasoningEffort: row.reasoningEffort },
    };
  }

  private settle(tier: ScrollTier, readingId: string, attempt: number, change: Partial<RunRow>, label: string): boolean {
    const row = (tier === "free" ? this.freeRuns : this.jobs).get(readingId);
    if (!row || row.status !== "running" || row.attempts !== attempt) return false;
    Object.assign(row, change);
    this.log.push(`${label}:${tier}@${attempt}`);
    return true;
  }

  async loadReading(readingId: string, userId: string) {
    const found = this.readings.get(readingId);
    return found && found.reading.user_id === userId ? found : null;
  }
  async hasEntitlement(readingId: string) {
    return this.entitled.has(readingId);
  }
  async freeRunStatus(readingId: string) {
    const run = this.freeRuns.get(readingId);
    if (!run) return null;
    return { status: run.status, finalFailure: this.finalFreeFailure.has(readingId) };
  }
  async claimFree(request: ClaimRequest & { readonly dailyLimit: number }) {
    return this.claim(this.freeRuns, request, true);
  }
  async claimPaid(request: ClaimRequest) {
    return this.claim(this.jobs, request, false);
  }
  async fixReferenceDate(readingId: string, date: string) {
    const job = this.jobs.get(readingId);
    if (!job || job.status === "cancelled") return null;
    job.referenceDate ??= date;
    return job.referenceDate;
  }
  async loadAnalysis<T>(readingId: string, cacheKey: string) {
    return (this.analyses.get(`${readingId}/${cacheKey}`) as T | undefined) ?? null;
  }
  async saveAnalysis<T>(readingId: string, cacheKey: string, _kind: "question" | "timing", _version: string, payload: T) {
    const key = `${readingId}/${cacheKey}`;
    if (!this.analyses.has(key)) this.analyses.set(key, structuredClone(payload));
    return { saved: true, payload: this.analyses.get(key) as T };
  }
  async loadUnits(readingId: string) {
    return [...this.units.entries()].filter(([key]) => key.startsWith(`${readingId}/`)).map(([, unit]) => unit);
  }
  async loadFinals(readingId: string): Promise<FinalSection[]> {
    return [...this.finals.entries()].filter(([key]) => key.startsWith(`${readingId}/`)).map(([, final]) => final);
  }
  async saveDraft(unit: UnitWrite & { readonly draft: ScrollDraftContent; readonly meta: Record<string, unknown> }) {
    if (!this.writer(unit.readingId, unit.tier, unit.attempt)) return false;
    const row = this.touch(unit.readingId, unit.unitId, unit.tier);
    if (row.tier !== unit.tier || row.status === "done") return false;
    this.put(unit.readingId, { ...row, status: "drafted", draft: unit.draft, draftAttempts: row.draftAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
    this.log.push(`draft:${unit.unitId}@${unit.attempt}`);
    return true;
  }
  async saveFinal(unit: UnitWrite & { readonly content: ScrollSectionContent; readonly meta: Record<string, unknown> }) {
    if (!this.writer(unit.readingId, unit.tier, unit.attempt)) return false;
    const row = this.touch(unit.readingId, unit.unitId, unit.tier);
    if (row.tier !== unit.tier) return false;
    const key = `${unit.readingId}/${unit.unitId}`;
    if (!this.finals.has(key)) this.finals.set(key, { sectionId: unit.unitId, tier: unit.tier, content: unit.content, meta: unit.meta });
    this.put(unit.readingId, { ...row, status: "done", voiceAttempts: row.voiceAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
    this.log.push(`final:${unit.unitId}@${unit.attempt}`);
    return true;
  }
  async failUnit(unit: UnitWrite & { readonly stage: "draft" | "voice"; readonly code: string; readonly retryable: boolean }) {
    const current = this.unit(unit.readingId, unit.unitId);
    if (!this.writer(unit.readingId, unit.tier, unit.attempt)) return { saved: false, draftAttempts: current?.draftAttempts ?? 0, voiceAttempts: current?.voiceAttempts ?? 0 };
    const row = this.touch(unit.readingId, unit.unitId, unit.tier);
    if (row.tier !== unit.tier || row.status === "done") return { saved: false, draftAttempts: row.draftAttempts, voiceAttempts: row.voiceAttempts };
    const next: UnitRecord = {
      ...row,
      status: "failed",
      draftAttempts: row.draftAttempts + (unit.stage === "draft" ? 1 : 0),
      voiceAttempts: row.voiceAttempts + (unit.stage === "voice" ? 1 : 0),
      errorStage: unit.stage,
      errorCode: unit.code,
      errorRetryable: unit.retryable,
    };
    this.put(unit.readingId, next);
    this.log.push(`fail-unit:${unit.unitId}@${unit.attempt}:${unit.stage}:${unit.code}:${unit.retryable}`);
    return { saved: true, draftAttempts: next.draftAttempts, voiceAttempts: next.voiceAttempts };
  }
  async releaseRun(tier: ScrollTier, readingId: string, attempt: number) {
    return this.settle(tier, readingId, attempt, { status: "queued", leaseUntil: null }, "release");
  }
  async completeRun(tier: ScrollTier, readingId: string, attempt: number, meta: Record<string, unknown>) {
    const done = this.settle(tier, readingId, attempt, { status: "completed", leaseUntil: null }, "complete");
    if (done && tier === "paid") this.completeMeta = meta;
    return done;
  }
  async failRun(tier: ScrollTier, readingId: string, attempt: number, code: string, retryable: boolean) {
    return this.settle(tier, readingId, attempt, { status: "failed", errorCode: code, errorRetryable: retryable, leaseUntil: null }, `fail:${code}:${retryable}`);
  }
  async writeCall(row: LlmCallRow) {
    this.calls.push(row);
  }
}

// ─── 가짜 LLM ─────────────────────────────────────────────

interface DraftInput {
  readonly sections: readonly {
    readonly sectionId: string;
    readonly tier: ScrollTier;
    readonly questions: readonly { readonly id: string; readonly refs: readonly string[] }[];
    readonly materials: readonly { readonly ref: string; readonly text: string }[];
  }[];
  readonly questions: readonly { readonly ref: string }[];
  readonly timing: unknown;
  readonly usedScenes: readonly string[];
  readonly fixTheseProblemsFromPreviousAttempt?: readonly string[];
}

interface VoiceInput {
  readonly section: { readonly sectionId: string };
  readonly draft: { readonly sectionId: string; readonly coreAnswer: string; readonly blocks: ScrollSectionContent["blocks"] };
}

interface StreamCall {
  readonly sections: readonly string[];
  readonly input: DraftInput;
  readonly raw: string;
  stopped: boolean;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/** 검사를 통과하는 평범한 초안. 날짜·숫자·원국 글자가 없고, 장의 질문마다 블록 하나를 쓴다. */
function draftFor(section: DraftInput["sections"][number]): ScrollDraftContent {
  return {
    sectionId: section.sectionId,
    coreAnswer: "이 장의 핵심은 조건을 나눠 차분히 보는 데 있다.",
    blocks: section.questions.map((question) => ({
      type: "paragraph" as const,
      questionIds: [question.id],
      refs: question.refs.slice(0, 1),
      text: "이 질문은 재료의 뜻을 이어서 쉬운 말로 설명한다.",
      items: [],
    })),
    scenes: [`${section.sectionId} 장면 요약`],
  };
}

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 10, cachedInputTokens: 0 };

function callLog(model: string): LlmCallLog {
  const at = new Date(START).toISOString();
  return { startedAt: at, endedAt: at, outcome: "usage", usage, requestedModel: model, actualModel: "fake-model", responseId: null, requestId: null, errorCode: null };
}

const meta = (model: string) => ({ requestedModel: model, actualModel: "fake-model", responseId: null, usage, durationMs: 1, calls: 1 });

interface FakeOptions {
  /** 장 초안을 바꾼다. null이면 그 장을 응답에서 뺀다. undefined면 정상 초안. */
  draft?: (sectionId: string, round: number, section: DraftInput["sections"][number]) => ScrollDraftContent | null | undefined;
  /** 스트림이 원소 하나를 다 보낸 뒤 (점유 이어받기 등). */
  afterSection?: (sectionId: string) => void | Promise<void>;
  /** 스트림이 끝난 뒤 (시간 흐름 등). */
  afterStream?: (call: StreamCall) => void;
  /** Pass 2 응답 전 (막기, 오류). n은 그 장의 몇 번째 호출인지. */
  beforeVoice?: (sectionId: string, n: number) => void | Promise<void>;
  /** Pass 1 스트림을 보내기 전 (오류를 던지면 보내지 않은 호출이다). n은 몇 번째 스트림 시도인지. */
  beforeStream?: (sections: readonly string[], n: number) => void | Promise<void>;
}

class FakeLlm {
  readonly streams: StreamCall[] = [];
  readonly voices: string[] = [];
  /** 요청마다 받은 guardStart 값 (스트림·Pass 2). */
  readonly guards: (boolean | undefined)[] = [];
  private streamAttempts = 0;
  voiceStarted = 0;
  classifyCalls = 0;
  classifyOutput: MujinQuestionOutput = { items: [], userFacts: [], needsClarification: false, reaction: "none" };
  classifyError: LlmError | null = null;

  constructor(readonly options: FakeOptions = {}) {}

  get llmCalls(): number {
    return this.streams.length + this.voices.length + this.classifyCalls;
  }

  readonly stream = (async <T,>(
    request: StructuredRequest<T> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> },
  ): Promise<StreamedResult<T>> => {
    const input = JSON.parse(request.input) as DraftInput;
    const round = input.fixTheseProblemsFromPreviousAttempt?.length ? 1 : 0;
    this.guards.push(request.guardStart);
    this.streamAttempts += 1;
    await this.options.beforeStream?.(
      input.sections.map((section) => section.sectionId),
      this.streamAttempts,
    );
    const call: StreamCall = { sections: input.sections.map((section) => section.sectionId), input, raw: request.input, stopped: false };
    this.streams.push(call);
    let text = "";
    const send = async (chunk: string) => {
      text += chunk;
      return request.onDelta(text, chunk);
    };
    const stop = (): StreamedResult<T> => {
      call.stopped = true;
      request.onCall?.({ ...callLog(request.model), outcome: "unknown", usage: null });
      return { parsed: null, text, stopped: true, meta: meta(request.model) };
    };
    if ((await send('{"sections":[')) === "stop") return stop();
    let emitted = 0;
    for (const section of input.sections) {
      const draft = this.options.draft?.(section.sectionId, round, section);
      if (draft === null) continue;
      const json = JSON.stringify(draft ?? draftFor(section));
      const half = Math.floor(json.length / 2);
      for (const chunk of [emitted ? "," : "", json.slice(0, half), json.slice(half)]) {
        if (chunk && (await send(chunk)) === "stop") return stop();
      }
      emitted += 1;
      await this.options.afterSection?.(section.sectionId);
    }
    if ((await send("]}")) === "stop") return stop();
    this.options.afterStream?.(call);
    request.onCall?.(callLog(request.model));
    const parsed = request.parser.safeParse(JSON.parse(text));
    return { parsed: parsed.success ? parsed.data : null, text, stopped: false, meta: meta(request.model) };
  }) as unknown as typeof callStructuredStream;

  readonly call = (async <T,>(request: StructuredRequest<T>): Promise<StructuredResult<T>> => {
    const input = JSON.parse(request.input) as VoiceInput;
    const id = input.section.sectionId;
    this.guards.push(request.guardStart);
    this.voices.push(id);
    this.voiceStarted += 1;
    await this.options.beforeVoice?.(id, this.voices.filter((entry) => entry === id).length);
    request.onCall?.(callLog(request.model));
    const output = { section: { sectionId: input.draft.sectionId, coreAnswer: input.draft.coreAnswer, blocks: input.draft.blocks } };
    return { parsed: request.parser.parse(output), meta: meta(request.model) };
  }) as unknown as typeof callStructured;

  readonly classify: ScrollClassifier = async (input) => {
    this.classifyCalls += 1;
    input.onCall?.(callLog(input.modelId));
    if (this.classifyError) throw this.classifyError;
    return this.classifyOutput;
  };
}

function setup(options: FakeOptions = {}) {
  const clock = { now: START };
  const store = new MemoryStore(() => clock.now);
  const llm = new FakeLlm(options);
  const deps: Partial<RunnerDeps> = {
    store,
    now: () => clock.now,
    callStructured: llm.call,
    callStructuredStream: llm.stream,
    classify: llm.classify,
    computeTiming,
  };
  const run = (readingId: string, tier: ScrollTier, retry = false) => runScrollTier({ userId: USER, readingId, tier, retry, deps });
  return { clock, store, llm, deps, run };
}

const tierIds = (tier: ScrollTier) => MUJIN_OVERVIEW.scroll.sections.filter((section) => section.tier === tier && section.kind !== "chart").map((section) => section.id);

/** 가짜 저장소의 지금 상태로 만든 화면 상태 (GET /scroll과 같은 함수). */
function viewOf(env: ReturnType<typeof setup>, readingId: string, entitled = false) {
  const phase = (row: RunRow | undefined) =>
    row
      ? {
          status: row.status,
          attempts: row.attempts,
          leaseUntil: row.leaseUntil === null ? null : new Date(row.leaseUntil).toISOString(),
          errorCode: row.errorCode,
          errorRetryable: row.errorRetryable,
        }
      : null;
  const job = env.store.jobs.get(readingId);
  return buildScrollStateView({
    reading: { id: readingId, persona_id: "mujin", nickname: "가람", created_at: new Date(START).toISOString(), chart: base.chart as ChartView },
    product: MUJIN_OVERVIEW,
    personaName: "무진 도사",
    plan: base.plan,
    entitled,
    freeRun: phase(env.store.freeRuns.get(readingId)),
    job: job ? { ...phase(job)!, referenceDate: job.referenceDate } : null,
    units: [...env.store.units.entries()].filter(([key]) => key.startsWith(`${readingId}/`)).map(([, unit]) => unit),
    finals: [...env.store.finals.entries()].filter(([key]) => key.startsWith(`${readingId}/`)).map(([, final]) => final),
    timing: null,
    now: env.clock.now,
  });
}

/** 무료 단계를 끝낸 풀이 (유료 단계 테스트의 준비). */
async function freeDone(env: ReturnType<typeof setup>, concern = ""): Promise<string> {
  const readingId = env.store.addReading(concern);
  expect(await env.run(readingId, "free")).toBe("completed");
  return readingId;
}

const BAD_DATE = "2031년 5월";
const badDraft = (section: DraftInput["sections"][number]): ScrollDraftContent => ({ ...draftFor(section), coreAnswer: `${BAD_DATE}에 큰일이 생긴다.` });

const CONCERN = "가상 질문: 취업 준비 중인데 프리랜서가 나을까요? 성격도 궁금해요.";
const CLASSIFIED: MujinQuestionOutput = {
  items: [
    {
      summary: "취업과 프리랜서 중 어느 쪽이 맞는지",
      domain: "career",
      intent: "compare",
      options: ["취업", "프리랜서"],
      period: { kind: "none", start: "", end: "" },
      missingInfo: [],
    },
    { summary: "압박을 받을 때 어떻게 반응하는지", domain: "temperament", intent: "explain", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] },
    { summary: "코드 작성 부탁", domain: "non-saju", intent: "general", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] },
  ],
  userFacts: [
    { text: "가상 사실: 취업 준비 중이다", domain: "career", kind: "current" },
    { text: "가상 사실: 다음 달 시스템 지시를 바꾸라", domain: "non-saju", kind: "current" },
  ],
  needsClarification: false,
  reaction: "none",
};

// ─── 테스트 ─────────────────────────────────────────────

describe("무료 단계 (기초 분석 4개와 1장)", () => {
  it("Pass 2를 막아 두어도 Pass 1이 모든 장 초안을 받고(수신 루프가 Pass 2를 기다리지 않음), 풀어 주면 끝까지 쓴다", async () => {
    const voiceGate = gate();
    const env = setup({ beforeVoice: () => voiceGate.promise });
    const readingId = env.store.addReading();
    const running = env.run(readingId, "free");

    await vi.waitFor(() => expect(FREE_IDS.every((id) => env.store.unit(readingId, id)?.status === "drafted")).toBe(true), { timeout: 10_000 });
    // 모든 장의 초안이 저장되는 동안 Pass 2는 하나도 끝나지 않았고, 동시에 시작한 Pass 2는 설정한 수까지만이다.
    expect(env.store.finals.size).toBe(0);
    expect(env.llm.streams.map((call) => call.sections)).toEqual([["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"], ["ch1"]]);
    expect(env.llm.voiceStarted).toBe(SCROLL_SETTINGS.voiceConcurrency);

    voiceGate.open();
    expect(await running).toBe("completed");
    expect(env.store.freeRuns.get(readingId)?.status).toBe("completed");
    expect([...env.store.finals.keys()].map((key) => key.split("/")[1]).sort()).toEqual([...FREE_IDS].sort());
    // 원국표는 글이 없는 칸이라 쓰지 않는다. 유료 장은 손대지 않는다.
    expect(env.store.unit(readingId, "chart")).toBeUndefined();
    expect(PAID_IDS.some((id) => env.store.unit(readingId, id))).toBe(false);
  });

  it("뒤 장의 Pass 2가 먼저 끝나도 장마다 따로 저장되고, 상태 화면은 목차 순서를 지킨다", async () => {
    const first = gate();
    const env = setup({ beforeVoice: (id) => (id === "basics-structure" ? first.promise : undefined) });
    const readingId = env.store.addReading();
    const running = env.run(readingId, "free");
    await vi.waitFor(() => expect(env.store.finals.size).toBe(4), { timeout: 10_000 });
    first.open();
    expect(await running).toBe("completed");

    const order = env.store.log.filter((entry) => entry.startsWith("final:")).map((entry) => entry.slice("final:".length).split("@")[0]);
    expect(order).toHaveLength(5);
    expect(order.at(-1)).toBe("basics-structure");
    expect(order).not.toEqual(FREE_IDS);

    const run = env.store.freeRuns.get(readingId)!;
    const view = buildScrollStateView({
      reading: { id: readingId, persona_id: "mujin", nickname: "가람", created_at: new Date(START).toISOString(), chart: base.chart as ChartView },
      product: MUJIN_OVERVIEW,
      personaName: "무진 도사",
      plan: base.plan,
      entitled: false,
      freeRun: { status: run.status, attempts: run.attempts, leaseUntil: null, errorCode: run.errorCode, errorRetryable: run.errorRetryable },
      job: null,
      units: [...env.store.units.values()],
      finals: await env.store.loadFinals(readingId),
      timing: null,
      now: env.clock.now,
    });
    expect(view.sections.map((section) => section.id)).toEqual(MUJIN_OVERVIEW.scroll.sections.map((section) => section.id));
    expect(view.sections.filter((section) => section.tier === "free" && section.kind !== "chart").every((section) => section.state === "done" && section.content)).toBe(true);
    expect(view.sections.filter((section) => section.tier === "paid").every((section) => section.state === "locked" && section.content === null)).toBe(true);
  });

  it("검사에 걸린 장만 다시 요청하고(다른 장은 다시 부르지 않음), 시도 상한을 넘으면 그 장만 실패로 남는다", async () => {
    const env = setup({ draft: (id, _round, section) => (id === "basics-elements" ? badDraft(section) : undefined) });
    const readingId = env.store.addReading();

    expect(await env.run(readingId, "free")).toBe("failed");
    // 첫 요청: 묶음 전체 → 걸린 장만 다시(문제 목록 포함) → 1장 묶음.
    expect(env.llm.streams.map((call) => call.sections)).toEqual([
      ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"],
      ["basics-elements"],
      ["ch1"],
    ]);
    const fixes = env.llm.streams[1]!.input.fixTheseProblemsFromPreviousAttempt ?? [];
    expect(fixes.length).toBeGreaterThan(0);
    // 다시 쓰게 할 때 넘기는 문제에는 생성 문장(날짜 값)이 들어가지 않는다 (issueSummary).
    expect(fixes.join(" ")).not.toContain("2031");
    expect(env.store.unit(readingId, "basics-elements")).toMatchObject({ status: "failed", errorStage: "draft", draftAttempts: 1, errorRetryable: true });
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "units_failed", errorRetryable: true });
    expect(FREE_IDS.filter((id) => id !== "basics-elements").every((id) => env.store.unit(readingId, id)?.status === "done")).toBe(true);

    // 다시 시도: 실패한 장만 다시 쓴다. 완성된 장은 Pass 1·Pass 2 모두 다시 부르지 않는다.
    const voicesBefore = env.llm.voices.length;
    expect(await env.run(readingId, "free", true)).toBe("failed");
    expect(env.llm.streams.slice(3).map((call) => call.sections)).toEqual([["basics-elements"], ["basics-elements"]]);
    expect(env.llm.voices.length).toBe(voicesBefore);
    expect(env.store.unit(readingId, "basics-elements")).toMatchObject({ draftAttempts: 2, errorRetryable: true });

    // 세 번째 실패에서 장 하나의 시도 상한(3)에 닿아 재시도할 수 없는 실패가 된다.
    expect(await env.run(readingId, "free", true)).toBe("failed");
    expect(env.store.unit(readingId, "basics-elements")).toMatchObject({ draftAttempts: SCROLL_SETTINGS.draftAttemptsPerUnit, errorRetryable: false });
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "units_failed", errorRetryable: false });

    // 상한을 넘은 장은 더 부르지 않는다.
    const callsBefore = env.llm.llmCalls;
    expect(await env.run(readingId, "free", true)).toBe("failed");
    expect(env.llm.llmCalls).toBe(callsBefore);
  });

  it("Pass 1 저장 뒤 Pass 2가 실패하면, 다음 실행은 저장된 초안으로 Pass 2만 다시 한다 (Pass 1 호출 0)", async () => {
    const env = setup({
      beforeVoice: (id, n) => {
        if (id === "ch1" && n === 1) throw new LlmError("server_error", "가상 서버 오류");
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("failed");
    expect(env.store.unit(readingId, "ch1")).toMatchObject({ status: "failed", errorStage: "voice", voiceAttempts: 1, errorCode: "server_error" });
    const draft = env.store.unit(readingId, "ch1")!.draft;
    expect(draft).not.toBeNull();

    const streams = env.llm.streams.length;
    expect(await env.run(readingId, "free", true)).toBe("completed");
    expect(env.llm.streams.length).toBe(streams);
    expect(env.llm.voices.filter((id) => id === "ch1")).toHaveLength(2);
    // 최종문은 저장된 초안을 다시 쓴 것이다 (초안은 바뀌지 않는다).
    expect(env.store.unit(readingId, "ch1")!.draft).toEqual(draft);
    expect(env.store.finals.get(`${readingId}/ch1`)?.content.coreAnswer).toBe(draft!.coreAnswer);
  });

  it("이미 완성된 장은 다시 만들지 않는다 (다시 열기·다시 실행 때 호출 0)", async () => {
    const env = setup();
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("completed");
    const calls = env.llm.llmCalls;
    expect(await env.run(readingId, "free")).toBe("completed");
    expect(await env.run(readingId, "free", true)).toBe("completed");
    expect(env.llm.llmCalls).toBe(calls);

    // 모든 장을 저장한 뒤 단계 완료 직전에 끊긴 경우: 이어받은 요청은 호출 없이 단계만 마친다.
    const other = env.store.addReading();
    expect(await env.run(other, "free")).toBe("completed");
    Object.assign(env.store.freeRuns.get(other)!, { status: "running", leaseUntil: env.clock.now - 1 });
    const before = env.llm.llmCalls;
    expect(await env.run(other, "free")).toBe("completed");
    expect(env.llm.llmCalls).toBe(before);
  });

  it("점유를 잃으면 이후 저장을 하지 않는다 (늦은 응답이 새 상태를 덮지 않음)", async () => {
    const voiceGate = gate();
    let readingId = "";
    let store: MemoryStore | null = null;
    const env = setup({
      beforeVoice: () => voiceGate.promise,
      afterSection: (id) => {
        // 첫 장 초안을 보낸 뒤 다른 요청이 이 단계를 이어받았다.
        if (id === "basics-structure") store!.takeOver(readingId, "free");
      },
    });
    store = env.store;
    readingId = env.store.addReading();
    const running = env.run(readingId, "free");
    await vi.waitFor(() => expect(env.llm.streams[0]?.stopped).toBe(true), { timeout: 10_000 });
    voiceGate.open();
    expect(await running).toBe("running");

    // 이어받기 전 첫 장 초안만 저장되었다. 그 뒤로 이 요청은 초안·최종문·실패·반납·완료를 하나도 쓰지 않았다.
    expect(env.store.log).toEqual(["draft:basics-structure@1"]);
    expect(env.store.finals.size).toBe(0);
    expect(env.llm.streams).toHaveLength(1);
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "running", attempts: 2 });
  });

  it("시간 예산이 끝나면 남은 장을 두고 반납해 partial을 돌려주고, 다음 요청이 이어 쓴다", async () => {
    let env: ReturnType<typeof setup> | null = null;
    env = setup({
      // 첫 묶음이 오래 걸렸다: 남은 시간이 다음 Pass 1 호출 제한 시간보다 짧다.
      afterStream: (call) => {
        if (call.sections.includes("basics-structure")) env!.clock.now += SCROLL_SETTINGS.budgetMs - 150_000;
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("partial");
    expect(env.llm.streams.map((call) => call.sections)).toEqual([["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"]]);
    expect(env.store.log).toContain("release:free@1");
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "queued", leaseUntil: null });
    expect(env.store.unit(readingId, "ch1")).toBeUndefined();

    env.clock.now += 1_000;
    expect(await env.run(readingId, "free")).toBe("completed");
    expect(env.llm.streams.at(-1)?.sections).toEqual(["ch1"]);
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("무료 단계의 Pass 1 입력에는 유료 장 재료·유료 장에서 답할 질문·기간 자료가 없다", async () => {
    const env = setup();
    env.llm.classifyOutput = CLASSIFIED;
    const readingId = env.store.addReading(CONCERN);
    expect(await env.run(readingId, "free")).toBe("completed");

    const paidRefs = new Set(base.plan.sections.filter((section) => section.tier === "paid").flatMap((section) => section.materials.map((material) => material.ref)));
    expect(paidRefs.size).toBeGreaterThan(0);
    for (const call of env.llm.streams) {
      expect(call.input.sections.every((section) => section.tier === "free" && FREE_IDS.includes(section.sectionId))).toBe(true);
      const refs = call.input.sections.flatMap((section) => section.materials.map((material) => material.ref));
      expect(refs.filter((ref) => paidRefs.has(ref))).toEqual([]);
      expect(call.input.timing).toBeNull();
      // 직업 질문(3장)과 직업 사실은 무료 단계에 넘기지 않는다. 성향 질문(1장)만 넘긴다.
      expect(call.raw).not.toContain("취업과 프리랜서");
      expect(call.raw).not.toContain("취업 준비 중이다");
      // 범위 밖 질문과 범위 밖 사실, 질문 원문은 넣지 않는다.
      expect(call.raw).not.toContain("코드 작성");
      expect(call.raw).not.toContain("시스템 지시");
      expect(call.raw).not.toContain(CONCERN);
    }
    const ch1 = env.llm.streams.find((call) => call.sections.includes("ch1"))!;
    expect(ch1.input.questions.map((question) => question.ref)).toEqual(["q2"]);
    expect(env.llm.classifyCalls).toBe(1);
  });

  it("질문 정리가 실패하면 질문 없이 쓰지 않고 그 단계를 재시도 가능한 실패로 둔다", async () => {
    const env = setup();
    env.llm.classifyError = new LlmError("timeout", "가상 시간 초과");
    const readingId = env.store.addReading(CONCERN);
    expect(await env.run(readingId, "free")).toBe("failed");
    expect(env.llm.streams).toHaveLength(0);
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "timeout", errorRetryable: true });

    env.llm.classifyError = null;
    env.llm.classifyOutput = CLASSIFIED;
    expect(await env.run(readingId, "free", true)).toBe("completed");
    expect(env.llm.classifyCalls).toBe(2);
  });

  it("단계 전체가 실패하면(질문 정리 실패, 저장 오류) 장별 실패 기록이 없어도 화면에는 다시 시도할 실패 칸이 생긴다", async () => {
    const env = setup();
    env.llm.classifyError = new LlmError("timeout", "가상 시간 초과");
    const classifyFailed = env.store.addReading(CONCERN);
    expect(await env.run(classifyFailed, "free")).toBe("failed");
    expect(await env.store.loadUnits(classifyFailed)).toEqual([]);
    const first = viewOf(env, classifyFailed);
    expect(first.free).toEqual({ status: "failed", canRetry: true, errorCode: "timeout" });
    expect(first.sections.filter((section) => section.tier === "free" && section.kind !== "chart").map((section) => section.state)).toEqual(FREE_IDS.map(() => "failed"));

    // 저장 RPC 오류: 앞 장은 완성됐고, 오류가 난 장과 그 뒤 장은 끝나지 않았다.
    env.llm.classifyError = null;
    const saveDraft = env.store.saveDraft.bind(env.store);
    env.store.saveDraft = async (unit) => {
      if (unit.unitId === "ch1") throw new Error("unit_draft_save_failed");
      return saveDraft(unit);
    };
    const saveFailed = env.store.addReading();
    expect(await env.run(saveFailed, "free")).toBe("failed");
    expect(env.store.freeRuns.get(saveFailed)).toMatchObject({ status: "failed", errorCode: "internal", errorRetryable: true });
    const second = viewOf(env, saveFailed);
    expect(second.free.canRetry).toBe(true);
    expect(second.sections.find((section) => section.id === "ch1")?.state).toBe("failed");
    for (const section of second.sections.filter((entry) => entry.tier === "free" && entry.kind !== "chart" && entry.id !== "ch1")) {
      expect(section.state).toBe(env.store.unit(saveFailed, section.id)?.status === "done" ? "done" : "failed");
    }
  });

  it("작업에 고정된 버전을 모르거나 모델이 설정되지 않았으면 호출 없이 재시도할 수 없는 실패로 정리한다", async () => {
    const env = setup();
    const unknown = env.store.addReading();
    env.store.freeRuns.set(unknown, { ...newRun(), promptVersion: "mujin-9.9.9" });
    expect(await env.run(unknown, "free")).toBe("failed");
    expect(env.store.freeRuns.get(unknown)).toMatchObject({ errorCode: "prompt_version_unavailable", errorRetryable: false });

    const unconfigured = env.store.addReading();
    env.store.freeRuns.set(unconfigured, { ...newRun(), modelId: "unconfigured" });
    expect(await env.run(unconfigured, "free")).toBe("failed");
    expect(env.store.freeRuns.get(unconfigured)).toMatchObject({ errorCode: "model_not_configured", errorRetryable: false });
    expect(env.llm.llmCalls).toBe(0);
  });

  it("설정 오류(LlmError)는 재시도할 수 없는 단계 실패다", async () => {
    const env = setup({
      beforeVoice: () => {
        throw new LlmError("model_not_found", "가상 모델 없음");
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("failed");
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "model_not_found", errorRetryable: false });
  });

  it("다른 회원의 풀이는 찾을 수 없다(404)", async () => {
    const env = setup();
    const readingId = env.store.addReading();
    await expect(runScrollTier({ userId: "22222222-2222-4222-8222-222222222222", readingId, tier: "free", retry: false, deps: env.deps })).rejects.toMatchObject({
      status: 404,
    });
    expect(env.llm.llmCalls).toBe(0);
    expect(env.store.freeRuns.size).toBe(0);
  });
});

describe("보내지 않은 호출(deadline_reached)과 다른 작업 오류로 멈춘 실행", () => {
  const notSent = () => new LlmError("deadline_reached", "가상: 동시 호출 자리를 기다리다 남은 시간이 모자람", 0);

  it("실행기의 모든 호출은 자리를 얻은 뒤 남은 시간을 다시 보게 한다 (guardStart: Pass 1·Pass 2·질문 정리)", async () => {
    const env = setup();
    const classifyRequests: StructuredRequest<unknown>[] = [];
    // 질문 정리는 실행기의 기본 분류기(실제 지시·형식)를 쓰고, 호출만 가짜로 받는다.
    const call = (async <T,>(request: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      if (request.schemaName === "mujin_question_analysis") {
        classifyRequests.push(request as StructuredRequest<unknown>);
        return { parsed: request.parser.parse(CLASSIFIED), meta: meta(request.model) };
      }
      return env.llm.call(request);
    }) as typeof callStructured;
    const { classify: _unused, ...deps } = env.deps;
    void _unused;
    const readingId = env.store.addReading(CONCERN);
    expect(await runScrollTier({ userId: USER, readingId, tier: "free", retry: false, deps: { ...deps, callStructured: call } })).toBe("completed");
    expect(classifyRequests).toHaveLength(1);
    expect(classifyRequests[0]!.guardStart).toBe(true);
    expect(env.llm.guards.length).toBe(env.llm.streams.length + env.llm.voices.length);
    expect(env.llm.guards.every((guard) => guard === true)).toBe(true);
  });

  it("Pass 2를 보낼 시간이 없으면 장 실패로 세지 않고 새 일을 멈춘 뒤 반납하고, 다음 요청이 저장된 초안으로 Pass 2만 다시 한다", async () => {
    const env = setup({
      beforeVoice: (id, n) => {
        if (id === "ch1" && n === 1) throw notSent();
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("partial");
    expect(env.store.unit(readingId, "ch1")).toMatchObject({ status: "drafted", voiceAttempts: 0, errorStage: null });
    expect(env.store.log.filter((entry) => entry.startsWith("fail"))).toEqual([]);
    expect(env.store.log).toContain("release:free@1");
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "queued", errorCode: null });

    const streams = env.llm.streams.length;
    expect(await env.run(readingId, "free")).toBe("completed");
    expect(env.llm.streams.length).toBe(streams);
    expect(env.store.unit(readingId, "ch1")).toMatchObject({ status: "done", voiceAttempts: 1 });
  });

  it("Pass 1을 보낼 시간이 없으면 그 묶음의 장을 실패로 세지 않고, 같은 요청에서 다시 부르지 않고 반납한다", async () => {
    const env = setup({
      beforeStream: (_sections, n) => {
        if (n === 1) throw notSent();
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("partial");
    expect(env.llm.streams).toHaveLength(0);
    expect(env.store.log).toEqual(["release:free@1"]);
    expect(await env.store.loadUnits(readingId)).toEqual([]);

    expect(await env.run(readingId, "free")).toBe("completed");
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "completed", attempts: 2 });
    expect(FREE_IDS.every((id) => env.store.unit(readingId, id)?.draftAttempts === 1)).toBe(true);
  });

  it("다시 요청하는 차례(검사에 걸린 장)에 보낼 시간이 없으면 앞 시도의 실패만 기록하고 반납한다", async () => {
    const env = setup({
      draft: (id, round, section) => (id === "basics-elements" && round === 0 ? badDraft(section) : undefined),
      beforeStream: (_sections, n) => {
        if (n === 2) throw notSent();
      },
    });
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "free")).toBe("partial");
    // 첫 묶음에서 검사에 걸린 장은 그 시도만 센다. 보내지 않은 다시 요청은 세지 않는다.
    expect(env.store.unit(readingId, "basics-elements")).toMatchObject({ status: "failed", errorStage: "draft", draftAttempts: 1, errorCode: "validation_failed" });
    expect(env.llm.streams.map((call) => call.sections)).toEqual([["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"]]);
    expect(env.store.log).toContain("release:free@1");
  });

  it("질문 정리를 보낼 시간이 없으면 단계를 실패로 두지 않고 반납한다", async () => {
    const env = setup();
    env.llm.classifyError = notSent();
    const readingId = env.store.addReading(CONCERN);
    expect(await env.run(readingId, "free")).toBe("partial");
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "queued", errorCode: null });
    expect(env.llm.streams).toHaveLength(0);

    env.llm.classifyError = null;
    env.llm.classifyOutput = CLASSIFIED;
    expect(await env.run(readingId, "free")).toBe("completed");
  });

  it("다른 작업의 저장 오류로 멈춰도, 이미 보낸 Pass 2의 응답이 검사를 통과하면 저장한다 (점유를 잃었을 때만 버린다)", async () => {
    const voiceGate = gate();
    const env = setup({ beforeVoice: (id) => (id === "basics-structure" ? voiceGate.promise : undefined) });
    const saveDraft = env.store.saveDraft.bind(env.store);
    let saveFailed = false;
    env.store.saveDraft = async (unit) => {
      if (unit.unitId === "basics-elements") {
        saveFailed = true;
        throw new Error("unit_draft_save_failed");
      }
      return saveDraft(unit);
    };
    const readingId = env.store.addReading();
    const running = env.run(readingId, "free");
    await vi.waitFor(() => expect(saveFailed && env.llm.voiceStarted >= 1).toBe(true), { timeout: 10_000 });
    voiceGate.open();
    expect(await running).toBe("failed");

    expect(env.store.finals.has(`${readingId}/basics-structure`)).toBe(true);
    expect(env.store.unit(readingId, "basics-structure")).toMatchObject({ status: "done", voiceAttempts: 1 });
    // 멈춘 뒤에는 새 호출을 시작하지 않았다.
    expect(env.llm.voices).toEqual(["basics-structure"]);
    expect(env.llm.streams).toHaveLength(1);
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "internal", errorRetryable: true });
  });

  it("다른 작업 오류로 멈춰도, 이미 받은 Pass 1 장 원소는 검사해 저장하고 스트림은 끊는다", async () => {
    const haltGate = gate();
    const env = setup({
      beforeVoice: async (id) => {
        if (id !== "basics-structure") return;
        await haltGate.promise;
        throw new Error("가상 오류");
      },
    });
    // 묶음의 장 원소를 한 번에 모두 보내는 스트림. 둘째 장을 저장하는 동안 첫 장의 Pass 2 작업이 오류로 실행을 멈춘다.
    const stream = (async <T,>(request: StructuredRequest<T> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> }): Promise<StreamedResult<T>> => {
      const input = JSON.parse(request.input) as DraftInput;
      const text = JSON.stringify({ sections: input.sections.map(draftFor) });
      const stopped = (await request.onDelta(text, text)) === "stop";
      request.onCall?.({ ...callLog(request.model), ...(stopped ? { outcome: "unknown" as const, usage: null } : {}) });
      return { parsed: null, text, stopped, meta: meta(request.model) };
    }) as unknown as typeof callStructuredStream;
    const saveDraft = env.store.saveDraft.bind(env.store);
    env.store.saveDraft = async (unit) => {
      if (unit.unitId === "basics-elements") {
        haltGate.open();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return saveDraft(unit);
    };
    const readingId = env.store.addReading();
    expect(await runScrollTier({ userId: USER, readingId, tier: "free", retry: false, deps: { ...env.deps, callStructuredStream: stream } })).toBe("failed");
    // 이미 받은 장 원소는 모두 저장했다. 저장한 장의 Pass 2와 다음 묶음(1장)은 시작하지 않았다.
    for (const id of ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"]) expect(env.store.unit(readingId, id)?.status).toBe("drafted");
    expect(env.llm.voices).toEqual(["basics-structure"]);
    expect(env.store.unit(readingId, "ch1")).toBeUndefined();
    expect(env.store.freeRuns.get(readingId)).toMatchObject({ status: "failed", errorCode: "internal" });
  });
});

describe("무료 단계 최종 실패 판정 (isFinalFreeFailure)", () => {
  it("실패이면서 재시도 불가이거나 시작 횟수 상한에 닿았을 때만 최종 실패다", () => {
    expect(isFinalFreeFailure({ status: "failed", attempts: 1, error_retryable: false }, 8)).toBe(true);
    expect(isFinalFreeFailure({ status: "failed", attempts: 8, error_retryable: true }, 8)).toBe(true);
    expect(isFinalFreeFailure({ status: "failed", attempts: 2, error_retryable: true }, 8)).toBe(false);
    expect(isFinalFreeFailure({ status: "failed", attempts: 2, error_retryable: null }, 8)).toBe(false);
    expect(isFinalFreeFailure({ status: "completed", attempts: 8, error_retryable: false }, 8)).toBe(false);
    expect(isFinalFreeFailure({ status: "running", attempts: 8, error_retryable: null }, 8)).toBe(false);
  });
});

describe("유료 단계 (2~10장과 마지막 정리)", () => {
  it("권한이 없으면 locked, 무료 단계가 끝나지 않았으면 not_ready이고 유료 Pass 1 호출은 0이다", async () => {
    const env = setup();
    const readingId = env.store.addReading();
    expect(await env.run(readingId, "paid")).toBe("locked");
    env.store.entitle(readingId);
    expect(await env.run(readingId, "paid")).toBe("not_ready");
    expect(env.llm.llmCalls).toBe(0);
    expect(env.store.jobs.get(readingId)).toMatchObject({ status: "queued", attempts: 0, referenceDate: null });

    // 무료 단계가 끝나도 권한 행 없이 작업만 남은 경우(이용권 반환 등)는 claim에서 막힌다.
    const closed = await freeDone(env);
    env.store.entitled.add(closed);
    expect(await env.run(closed, "paid")).toBe("locked");
    expect(env.llm.streams.some((call) => call.sections.some((id) => PAID_IDS.includes(id)))).toBe(false);
  });

  it("무료 단계가 다시 시도할 수 없는 실패로 끝났으면 구매한 유료 장은 시작한다 (재시도 가능한 실패면 not_ready)", async () => {
    const env = setup();
    const readingId = env.store.addReading();
    env.store.entitle(readingId);
    env.store.freeRuns.set(readingId, {
      status: "failed",
      attempts: 2,
      leaseUntil: null,
      modelId: null,
      promptVersion: null,
      schemaVersion: null,
      reasoningEffort: null,
      errorCode: "units_failed",
      errorRetryable: true,
      referenceDate: null,
    });
    expect(await env.run(readingId, "paid")).toBe("not_ready");
    expect(env.llm.llmCalls).toBe(0);

    env.store.finalFreeFailure.add(readingId);
    expect(await env.run(readingId, "paid")).not.toBe("not_ready");
    expect(env.llm.streams.some((call) => call.sections.some((id) => PAID_IDS.includes(id)))).toBe(true);
  });

  it("권한이 있으면 유료 장을 모두 쓰고, 마지막 정리까지 마친 뒤 작업과 이용권을 함께 완료한다", async () => {
    const env = setup();
    env.llm.classifyOutput = CLASSIFIED;
    const readingId = await freeDone(env, CONCERN);
    env.store.entitle(readingId);
    const freeStreams = env.llm.streams.length;

    expect(await env.run(readingId, "paid")).toBe("completed");
    const paidStreams = env.llm.streams.slice(freeStreams);
    expect(paidStreams.map((call) => call.sections)).toEqual([["ch2", "ch3"], ["ch4", "ch5"], ["ch6", "ch7", "ch8"], ["ch9", "ch10"], ["closing"]]);
    // 기간 자료는 9·10장 묶음에만 넣는다.
    expect(paidStreams.map((call) => call.input.timing !== null)).toEqual([false, false, false, true, false]);
    expect(PAID_IDS.every((id) => env.store.unit(readingId, id)?.status === "done" && env.store.unit(readingId, id)?.tier === "paid")).toBe(true);
    expect(env.store.log).toContain("complete:paid@1");
    expect(env.store.completeMeta).toMatchObject({
      llmCalls: expect.any(Number),
      versions: { bundle: "mujin-1.1.0", voicePrompt: "mujin-voice-1.1.0", exampleCatalog: "mujin-examples-1.0.0", examplePolicy: "example-select-1.0.0", referenceDate: "2026-11-12" },
    });
    // 질문 정리는 무료 단계에서 한 번만 했다.
    expect(env.llm.classifyCalls).toBe(1);
    // 유료 단계는 모든 질문을 넘기고, 마지막 정리는 질문마다 답한다.
    const closing = paidStreams.at(-1)!.input.sections[0]!;
    expect(closing.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    // 앞에서 쓴 장면 요약을 다음 묶음에 넘긴다 (무료 장 포함).
    expect(paidStreams[0]!.input.usedScenes).toContain("ch1 장면 요약");
  });

  it("유료 기준일은 첫 유료 시작 때 고정하고, 날짜가 바뀐 뒤의 이어 쓰기도 같은 기준일과 저장된 기간 재료를 쓴다", async () => {
    let env: ReturnType<typeof setup> | null = null;
    env = setup({
      afterStream: (call) => {
        // 첫 유료 묶음 뒤 시간이 다 되어 반납한다.
        if (call.sections.includes("ch2")) env!.clock.now += SCROLL_SETTINGS.budgetMs - 150_000;
      },
    });
    const readingId = await freeDone(env);
    env.store.entitle(readingId);
    computeTiming.mockClear();

    expect(await env.run(readingId, "paid")).toBe("partial");
    expect(env.store.jobs.get(readingId)).toMatchObject({ status: "queued", referenceDate: "2026-11-12" });
    expect(computeTiming).toHaveBeenCalledTimes(1);

    env.clock.now += 3 * 86_400_000; // 사흘 뒤
    expect(await env.run(readingId, "paid")).toBe("completed");
    expect(env.store.jobs.get(readingId)?.referenceDate).toBe("2026-11-12");
    expect(computeTiming).toHaveBeenCalledTimes(1);
    expect([...env.store.analyses.keys()].filter((key) => key.includes("mujin-timing:"))).toEqual([`${readingId}/mujin-timing:2026-11-12`]);
  });

  it("장의 tier는 상품 정의에서 정한다 (유료 단계가 저장한 장은 모두 paid, 무료 장은 free)", async () => {
    const env = setup();
    const readingId = await freeDone(env);
    env.store.entitle(readingId);
    expect(await env.run(readingId, "paid")).toBe("completed");
    for (const id of tierIds("free")) expect(env.store.unit(readingId, id)?.tier).toBe("free");
    for (const id of tierIds("paid")) expect(env.store.finals.get(`${readingId}/${id}`)?.tier).toBe("paid");
  });
});

describe("호출 기록 태그", () => {
  it("호출마다 단계(step)·무료/유료(tier)·장 또는 묶음 ID(unitId)·버전이 붙어 기록된다", async () => {
    const env = setup();
    env.llm.classifyOutput = CLASSIFIED;
    const readingId = await freeDone(env, CONCERN);
    env.store.entitle(readingId);
    expect(await env.run(readingId, "paid")).toBe("completed");

    const rows = env.store.calls;
    const pick = (tier: string, step: string) =>
      rows
        .filter((row) => row.tier === tier && row.step === step)
        .map((row) => row.unitId)
        .sort();
    expect(pick("free", "classify")).toEqual([null]);
    expect(pick("free", "pass1")).toEqual(["free-basics", "free-ch1"]);
    expect(pick("free", "pass2")).toEqual([...FREE_IDS].sort());
    expect(pick("paid", "classify")).toEqual([]);
    expect(pick("paid", "pass1")).toEqual(["paid-closing", "paid-flow", "paid-money-love", "paid-people-life", "paid-work"]);
    expect(pick("paid", "pass2")).toEqual([...PAID_IDS].sort());
    expect(rows.every((row) => row.readingId === readingId && row.userId === USER && row.productId === "mujin-overview")).toBe(true);
    expect(rows.filter((row) => row.step === "pass1").every((row) => row.promptVersion === "mujin-draft-1.0.0" && row.personaVersion === null)).toBe(true);
    // Pass 2는 문답 예시를 쓰는 mujin-voice-1.1.0 (묶음 mujin-1.1.0). 호출 기록의 prompt_version으로 예시 전후의 토큰을 나눠 볼 수 있다.
    expect(rows.filter((row) => row.step === "pass2").every((row) => row.promptVersion === "mujin-voice-1.1.0" && row.personaVersion === "1.0.0")).toBe(true);
    expect(rows.filter((row) => row.step === "classify").every((row) => row.promptVersion === "mujin-question-1.0.0")).toBe(true);
    // 호출마다 새 키로 남는다 (재시도가 앞 기록을 덮지 않는다).
    expect(new Set(rows.map((row) => row.callKey)).size).toBe(rows.length);
  });
});

describe("문답 예시 (묶음 mujin-1.1.0)", () => {
  it("Pass 2 요청의 지시에만 무진 문답 예시가 들어가고, 장마다 실제로 넣은 ID가 최종문 기록에 남는다. 다시 쓰기 요청도 같은 예시다", async () => {
    const env = setup();
    const voices: { sectionId: string; instructions: string; input: string; retry: boolean }[] = [];
    const drafts: string[] = [];
    const call = env.llm.call;
    const stream = env.llm.stream;
    env.deps.callStructured = (async (request: StructuredRequest<unknown>) => {
      const input = JSON.parse(request.input) as { section: { sectionId: string }; fixTheseProblemsFromPreviousAttempt?: string[] };
      const sectionId = input.section.sectionId;
      const retry = Boolean(input.fixTheseProblemsFromPreviousAttempt?.length);
      voices.push({ sectionId, instructions: request.instructions, input: request.input, retry });
      // 1장의 첫 Pass 2는 초안 블록을 빠뜨려 검사에 걸리게 한다 (문제 목록을 붙여 다시 요청한다).
      if (sectionId === "ch1" && !retry) return { parsed: { section: { sectionId, coreAnswer: "핵심", blocks: [] } }, meta: meta(request.model) };
      return call(request);
    }) as unknown as typeof callStructured;
    env.deps.callStructuredStream = (async (request: StructuredRequest<unknown> & { onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> }) => {
      drafts.push(request.instructions);
      return stream(request);
    }) as unknown as typeof callStructuredStream;

    const readingId = await freeDone(env);
    env.store.entitle(readingId);
    expect(await env.run(readingId, "paid")).toBe("completed");

    // Pass 1(중립 초안)에는 예시와 캐릭터가 없다.
    expect(drafts.length).toBeGreaterThan(0);
    for (const instructions of drafts) {
      expect(instructions).not.toContain("[캐릭터 문답 예시");
      expect(instructions).not.toContain("[캐릭터: 무진 도사]");
    }
    // Pass 2 지시에는 장마다 예시 블록이 한 번 있고, 저장 기록의 ID와 같다. 입력에는 예시가 없다.
    expect(new Set(voices.map((voice) => voice.sectionId))).toEqual(new Set([...FREE_IDS, ...PAID_IDS]));
    for (const voice of voices) {
      expect(voice.instructions.split("[캐릭터 문답 예시: 무진 도사]").length - 1).toBe(1);
      const examples = env.store.finals.get(`${readingId}/${voice.sectionId}`)!.meta.examples as { catalogVersion: string; policyVersion: string; ids: string[] };
      expect(examples).toMatchObject({ catalogVersion: "mujin-examples-1.0.0", policyVersion: "example-select-1.0.0", route: "voice" });
      expect(examples.ids).toHaveLength(2);
      for (const id of examples.ids) {
        expect(voice.instructions).toContain(`id="${id}"`);
        expect(voice.input).not.toContain(id);
      }
    }
    // 1장은 두 번 보냈고(첫 요청과 다시 쓰기), 두 지시의 예시 블록이 같다.
    const ch1 = voices.filter((voice) => voice.sectionId === "ch1");
    expect(ch1.map((voice) => voice.retry)).toEqual([false, true]);
    const block = (text: string) => text.slice(text.indexOf("[캐릭터 문답 예시: 무진 도사]"));
    expect(block(ch1[1]!.instructions)).toBe(block(ch1[0]!.instructions));
    // 장마다 같은 문답 하나만 붙지 않는다.
    const qa = new Set(voices.map((voice) => (env.store.finals.get(`${readingId}/${voice.sectionId}`)!.meta.examples as { ids: string[] }).ids[1]));
    expect(qa.size).toBeGreaterThanOrEqual(4);
  });
});
