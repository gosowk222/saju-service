import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CONCERN_MAX, NICKNAME_MAX } from "@/domain/birth/input";
import { MujinNowSchema } from "@/domain/mujin/now";
import type { MujinPlan, ScrollDraftContent, ScrollSectionContent, ScrollTier } from "@/domain/mujin/types";
import { findPersona } from "@/domain/personas";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { issueSummary } from "@/domain/reading/check";
import { computeMujinTiming } from "@/server/engine/mujin";
import type { StreamedResult, StructuredRequest, StructuredResult, callStructured, callStructuredStream } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { CURRENT_READING_PROMPT, getNarrationSchema, getReadingPrompt, NARRATION_SCHEMA_VERSION, personaVersionFor } from "@/server/llm/prompts";
import { runScrollTier, type RunnerDeps } from "@/server/scroll/runner";
import type { ClaimOutcome, ClaimRequest, FinalSection, ScrollReadingRecord, ScrollStore, UnitRecord, UnitWrite } from "@/server/scroll/store";
import { EVALUATION_CASES, MUJIN_DEFAULT_REFERENCE_DATE, MUJIN_EVALUATION_CASES, casePlan, readArg, readOption } from "../../scripts/llm-cases";
import {
  MODEL_PLACEHOLDER,
  MUJIN_PROMPTS_ROOT,
  MUJIN_QUALITY_ITEMS,
  buildMujinEvaluation,
  closingState,
  contentChars,
  defaultCaseDir,
  loadCaseOutputs,
  loadOutputs,
  outputSources,
  pass1Requests,
  pass2Requests,
  renderMujinComparison,
  requestBody,
  reviewSections,
  writeMujinExport,
  type MujinEvaluation,
  type MujinOutputs,
} from "../../scripts/mujin-llm";
import { createTestDb } from "../support/test-db";

/**
 * 무진 모델 비교 스크립트(scripts/mujin-llm.ts, llm-export·llm-render의 --product=mujin-overview).
 * 사례 → 작성 계획 → 요청 파일, 받은 결과 → 운영 검사 → 초안·최종문 비교표를 모델 없이 확인한다. 묘묘 경로는 바뀌지 않았는지 본다.
 * 사례와 가짜 결과는 모두 가상 값이다. 가짜 결과는 형식 확인용이며 문장 품질 검증이 아니다 (실제 모델 확인은 LIVE_NOT_RUN).
 */

const REFERENCE = MUJIN_DEFAULT_REFERENCE_DATE;
const caseById = (id: string) => {
  const found = MUJIN_EVALUATION_CASES.find((entry) => entry.id === id);
  if (!found) throw new Error(`사례 없음: ${id}`);
  return found;
};

/** 같은 사례·기준일의 계획은 늘 같으므로 한 번만 만든다 (엔진 계산만). */
const evaluations = new Map<string, Promise<MujinEvaluation>>();
function evaluationOf(id: string): Promise<MujinEvaluation> {
  if (!evaluations.has(id)) evaluations.set(id, buildMujinEvaluation(caseById(id), REFERENCE));
  return evaluations.get(id)!;
}

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mujin-llm-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const parse = (input: string) => JSON.parse(input) as Record<string, unknown>;
const unique = <T,>(values: readonly T[]) => [...new Set(values)];
const WRITTEN_IDS = MUJIN_OVERVIEW.scroll.sections.filter((section) => section.kind !== "chart").map((section) => section.id);
const batchOfSection = (sectionId: string) => MUJIN_OVERVIEW.scroll.draftBatches.find((batch) => batch.sectionIds.includes(sectionId))!;

// ─── 가짜 결과 (가상 문장, 형식 확인용) ─────────────────────────────────────

interface DraftRequestInput {
  readonly sections: readonly { readonly sectionId: string; readonly questions: readonly { readonly id: string; readonly refs: readonly string[] }[] }[];
  readonly fixTheseProblemsFromPreviousAttempt?: readonly string[];
}

interface VoiceRequestInput {
  readonly draft: { readonly sectionId: string; readonly coreAnswer: string; readonly blocks: ScrollSectionContent["blocks"] };
  readonly fixTheseProblemsFromPreviousAttempt?: readonly string[];
}

const BAD_CORE = "2031년 5월에 큰일이 생긴다.";
const BAD_TAIL = " 하루 3번 확인한다.";

/** 검사를 통과하는 평범한 초안. 날짜·숫자·원국 글자가 없고 장의 질문마다 블록 하나를 쓴다. bad면 분석하지 않은 날짜를 넣는다. */
function fakeDraft(section: DraftRequestInput["sections"][number], bad = false): ScrollDraftContent {
  return {
    sectionId: section.sectionId,
    coreAnswer: bad ? BAD_CORE : "가상 초안: 이 장의 핵심은 조건을 나눠 차분히 보는 데 있다.",
    blocks: section.questions.map((question) => ({
      type: "paragraph" as const,
      questionIds: [question.id],
      refs: question.refs.slice(0, 1),
      text: "가상 초안: 이 질문은 재료의 뜻을 이어 쉬운 말로 설명한다.",
      items: [],
    })),
    scenes: [`${section.sectionId} 장면 요약`],
  };
}

/** 초안을 그대로 옮긴 최종문. bad면 초안에 없던 숫자를 더한다. */
function fakeFinal(draft: VoiceRequestInput["draft"], bad = false): ScrollSectionContent {
  return {
    sectionId: draft.sectionId,
    coreAnswer: draft.coreAnswer,
    blocks: draft.blocks.map((block, index) => (bad && index === 0 ? { ...block, text: `${block.text}${BAD_TAIL}` } : block)),
  };
}

/** 요청 입력으로 만든 가짜 초안 (장 ID → 초안, 목차 순서). */
function draftsFor(requests: readonly { readonly request: { readonly input: string } }[], bad: readonly string[] = []): Map<string, ScrollDraftContent> {
  const drafts = new Map<string, ScrollDraftContent>();
  for (const { request } of requests) {
    for (const section of (JSON.parse(request.input) as DraftRequestInput).sections) drafts.set(section.sectionId, fakeDraft(section, bad.includes(section.sectionId)));
  }
  return new Map(WRITTEN_IDS.filter((id) => drafts.has(id)).map((id) => [id, drafts.get(id)!] as const));
}

/** 모든 장의 가짜 초안 (마지막 정리 포함): 묶음 요청 → 초안 → 마지막 정리 요청 → 초안. */
function allDrafts(evaluation: MujinEvaluation, bad: readonly string[] = []): Map<string, ScrollDraftContent> {
  const chapters = draftsFor(pass1Requests(evaluation).requests, bad);
  const closing = pass1Requests(evaluation, { drafts: chapters, finals: new Map() }).requests.filter((entry) => entry.batch.id === "paid-closing");
  return new Map([...chapters, ...draftsFor(closing, bad)]);
}

function finalsFor(drafts: ReadonlyMap<string, ScrollDraftContent>, bad: readonly string[] = []): Map<string, ScrollSectionContent> {
  return new Map([...drafts].map(([id, draft]) => [id, fakeFinal(draft, bad.includes(id))] as const));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** 내보낸 Pass 1 요청 입력을 읽어 결과 파일(p1-<묶음>.output.json)을 쓴다. 사용자가 플레이그라운드 결과를 저장하는 것과 같은 이름이다. */
function savePass1Outputs(dir: string, batchIds: readonly string[]): void {
  for (const id of batchIds) {
    const input = JSON.parse(readFileSync(path.join(dir, `p1-${id}.input.json`), "utf8")) as DraftRequestInput;
    writeJson(path.join(dir, `p1-${id}.output.json`), { sections: input.sections.map((section) => fakeDraft(section)) });
  }
}

function savePass2Outputs(dir: string, sectionIds: readonly string[]): void {
  for (const id of sectionIds) {
    const input = JSON.parse(readFileSync(path.join(dir, `p2-${id}.input.json`), "utf8")) as VoiceRequestInput;
    writeJson(path.join(dir, `p2-${id}.output.json`), { section: fakeFinal(input.draft) });
  }
}

// ─── 운영 실행기를 가짜 저장소·가짜 LLM으로 돌려 실제로 보내는 요청을 받는다 ─────────────

const USER_ID = "11111111-1111-4111-8111-111111111111";
const READING_ID = "22222222-2222-4222-8222-222222222222";
const START = Date.parse(`${REFERENCE}T12:00:00+09:00`);
const USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 10, cachedInputTokens: 0 };
const META = { requestedModel: "fake", actualModel: "fake", responseId: null, usage: USAGE, durationMs: 1, calls: 1 };

/** 실행기가 끝까지 지나가게 하는 단순한 저장소 (점유는 늘 성공). SQL 함수 규칙 자체는 mujin-runner·mujin-db-flow 테스트가 본다. */
class CaptureStore implements ScrollStore {
  readonly units = new Map<string, UnitRecord>();
  readonly finals = new Map<string, FinalSection>();
  readonly failures: string[] = [];
  private readonly analyses = new Map<string, unknown>();
  private readonly free = { status: "queued", attempts: 0 };
  private paid: { status: string; attempts: number; referenceDate: string | null } | null = null;

  constructor(private readonly record: { readonly reading: ScrollReadingRecord; readonly plan: MujinPlan }) {}

  entitle(): void {
    this.paid = { status: "queued", attempts: 0, referenceDate: null };
  }

  private claim(run: { status: string; attempts: number }, request: ClaimRequest): ClaimOutcome {
    if (run.status === "completed") return { claimed: false, reason: "completed" };
    run.status = "running";
    run.attempts += 1;
    return { claimed: true, run: { attempts: run.attempts, modelId: request.model, promptVersion: request.promptVersion, schemaVersion: request.schemaVersion, reasoningEffort: request.reasoningEffort } };
  }

  async loadReading(readingId: string, userId: string) {
    return readingId === this.record.reading.id && userId === this.record.reading.user_id ? this.record : null;
  }
  async hasEntitlement() {
    return this.paid !== null;
  }
  async freeRunStatus() {
    return { status: this.free.status, finalFailure: false };
  }
  async claimFree(request: ClaimRequest & { readonly dailyLimit: number }) {
    return this.claim(this.free, request);
  }
  async claimPaid(request: ClaimRequest): Promise<ClaimOutcome> {
    return this.paid ? this.claim(this.paid, request) : { claimed: false, reason: "not_entitled" };
  }
  async fixReferenceDate(_readingId: string, date: string) {
    if (!this.paid) return null;
    this.paid.referenceDate ??= date;
    return this.paid.referenceDate;
  }
  async loadAnalysis<T>(_readingId: string, cacheKey: string) {
    return (this.analyses.get(cacheKey) as T | undefined) ?? null;
  }
  async saveAnalysis<T>(_readingId: string, cacheKey: string, _kind: "question" | "timing", _version: string, payload: T) {
    if (!this.analyses.has(cacheKey)) this.analyses.set(cacheKey, structuredClone(payload));
    return { saved: true, payload: this.analyses.get(cacheKey) as T };
  }
  async loadUnits() {
    return [...this.units.values()];
  }
  async loadFinals() {
    return [...this.finals.values()];
  }
  async saveDraft(unit: UnitWrite & { readonly draft: ScrollDraftContent; readonly meta: Record<string, unknown> }) {
    const before = this.units.get(unit.unitId);
    this.units.set(unit.unitId, {
      unitId: unit.unitId,
      tier: unit.tier,
      status: "drafted",
      draft: unit.draft,
      draftAttempts: (before?.draftAttempts ?? 0) + 1,
      voiceAttempts: before?.voiceAttempts ?? 0,
      errorStage: null,
      errorCode: null,
      errorRetryable: null,
      updatedAt: null,
    });
    return true;
  }
  async saveFinal(unit: UnitWrite & { readonly content: ScrollSectionContent; readonly meta: Record<string, unknown> }) {
    const before = this.units.get(unit.unitId)!;
    if (!this.finals.has(unit.unitId)) this.finals.set(unit.unitId, { sectionId: unit.unitId, tier: unit.tier, content: unit.content });
    this.units.set(unit.unitId, { ...before, status: "done", voiceAttempts: before.voiceAttempts + 1 });
    return true;
  }
  async failUnit(unit: UnitWrite & { readonly stage: "draft" | "voice"; readonly code: string; readonly retryable: boolean }) {
    this.failures.push(`unit:${unit.unitId}:${unit.stage}:${unit.code}`);
    return { saved: true, draftAttempts: 1, voiceAttempts: 1 };
  }
  async releaseRun() {
    return true;
  }
  async completeRun(tier: ScrollTier) {
    if (tier === "free") this.free.status = "completed";
    else if (this.paid) this.paid.status = "completed";
    return true;
  }
  async failRun(tier: ScrollTier, _readingId: string, _attempt: number, code: string) {
    this.failures.push(`run:${tier}:${code}`);
    return true;
  }
  async writeCall() {}
}

interface Captured {
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly reasoningEffort: string;
  readonly maxOutputTokens: number;
}

const capture = <T,>(request: StructuredRequest<T>): Captured => ({
  instructions: request.instructions,
  input: request.input,
  schemaName: request.schemaName,
  jsonSchema: request.jsonSchema,
  reasoningEffort: request.reasoningEffort,
  maxOutputTokens: request.maxOutputTokens,
});

/** 무료 단계와 (권한을 준 뒤) 유료 단계를 운영 실행기(runScrollTier)로 끝까지 쓴다. bad에 든 장은 첫 응답만 검사에 걸리게 한다. */
async function runProduction(evaluation: MujinEvaluation, bad: { readonly drafts?: readonly string[]; readonly finals?: readonly string[] } = {}) {
  const { entry, base } = evaluation;
  const store = new CaptureStore({
    reading: {
      id: READING_ID,
      user_id: USER_ID,
      product_id: MUJIN_OVERVIEW.id,
      persona_id: MUJIN_OVERVIEW.personaId,
      nickname: entry.nickname,
      concern: entry.concern,
      birth_input: base.birth,
      chart: base.chart,
      created_at: new Date(START).toISOString(),
    },
    plan: base.plan,
  });
  const streams: Captured[] = [];
  const voices: Captured[] = [];
  const badDrafts = new Set(bad.drafts ?? []);
  const badFinals = new Set(bad.finals ?? []);
  const stream = (async <T,>(request: StructuredRequest<T> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> }): Promise<StreamedResult<T>> => {
    streams.push(capture(request));
    const input = JSON.parse(request.input) as DraftRequestInput;
    const retry = Boolean(input.fixTheseProblemsFromPreviousAttempt?.length);
    const text = JSON.stringify({ sections: input.sections.map((section) => fakeDraft(section, !retry && badDrafts.has(section.sectionId))) });
    await request.onDelta(text, text);
    const parsed = request.parser.safeParse(JSON.parse(text));
    return { parsed: parsed.success ? parsed.data : null, text, stopped: false, meta: META };
  }) as unknown as typeof callStructuredStream;
  const call = (async <T,>(request: StructuredRequest<T>): Promise<StructuredResult<T>> => {
    voices.push(capture(request));
    const input = JSON.parse(request.input) as VoiceRequestInput;
    const retry = Boolean(input.fixTheseProblemsFromPreviousAttempt?.length);
    return { parsed: request.parser.parse({ section: fakeFinal(input.draft, !retry && badFinals.has(input.draft.sectionId)) }), meta: META };
  }) as unknown as typeof callStructured;
  const deps: Partial<RunnerDeps> = {
    store,
    now: () => START,
    callStructured: call,
    callStructuredStream: stream,
    computeTiming: computeMujinTiming,
    classify: async () => {
      if (!entry.classification) throw new Error("궁금한 점이 없으면 질문 정리를 부르지 않는다");
      return entry.classification;
    },
  };
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  try {
    const free = await runScrollTier({ userId: USER_ID, readingId: READING_ID, tier: "free", retry: false, deps });
    store.entitle();
    const paid = await runScrollTier({ userId: USER_ID, readingId: READING_ID, tier: "paid", retry: false, deps });
    return { free, paid, store, streams, voices };
  } finally {
    info.mockRestore();
  }
}

const isRetry = (captured: Captured) => Boolean((parse(captured.input).fixTheseProblemsFromPreviousAttempt as unknown[] | undefined)?.length);
const firstSectionOf = (captured: Captured) => (parse(captured.input).sections as { sectionId: string }[])[0]!.sectionId;
const voiceSectionOf = (captured: Captured) => (parse(captured.input).draft as { sectionId: string }).sectionId;

// ─── 테스트 ─────────────────────────────────────────────

describe("무진 평가 사례 (scripts/llm-cases.ts, 단일 원천)", () => {
  it("명세 07 4절 대표 평가 입력 8개를 사례 9개로 둔다 (3번은 같은 상황·질문의 두 사주)", () => {
    expect(MUJIN_EVALUATION_CASES.map((entry) => entry.number)).toEqual(["1", "2", "3a", "3b", "4", "5", "6", "7", "8"]);
    expect(new Set(MUJIN_EVALUATION_CASES.map((entry) => entry.id)).size).toBe(MUJIN_EVALUATION_CASES.length);
    for (const entry of MUJIN_EVALUATION_CASES) {
      // 운영 입력 검증과 같은 형식이다 (지금의 나, 별명·궁금한 점 길이).
      expect(MujinNowSchema.parse(entry.now)).toEqual(entry.now);
      expect(entry.nickname.length).toBeLessThanOrEqual(NICKNAME_MAX);
      expect(entry.concern.length).toBeLessThanOrEqual(CONCERN_MAX);
      // 궁금한 점이 비면 질문 정리를 하지 않으므로 고정 분류 결과도 없다. 있으면 범위 안 질문이 하나 이상이다.
      expect(entry.classification === null).toBe(entry.concern === "");
      if (entry.classification) expect(entry.classification.items.length).toBeGreaterThan(0);
    }
    const [prepare, act] = [caseById("prepare-first"), caseById("act-first")];
    expect([prepare.now, prepare.concern, prepare.classification]).toEqual([act.now, act.concern, act.classification]);
    expect(prepare.birth).not.toEqual(act.birth);
    expect(MUJIN_EVALUATION_CASES.filter((entry) => entry.birth.birthTime.status === "unknown").map((entry) => entry.id)).toEqual(["prepare-first", "act-first", "hour-unknown"]);
  });

  it("평가 문서 2절의 표가 코드의 사례와 같다 (사례 ID, 별명, 출생일, 궁금한 점)", () => {
    const doc = readFileSync(path.resolve(process.cwd(), "docs/personas/mujin-evaluation.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 2."), doc.indexOf("## 3."));
    expect(section).toContain("scripts/llm-cases.ts");
    for (const entry of MUJIN_EVALUATION_CASES) {
      expect(section).toContain(`\`${entry.id}\``);
      expect(section).toContain(entry.nickname);
      expect(section).toContain(entry.birth.birthDate);
      if (entry.concern) expect(section).toContain(entry.concern);
    }
  });

  it("readOption은 --name=value와 --name value를 읽고, 묘묘가 쓰는 readArg는 그대로 --name=value만 읽는다", () => {
    const argv = ["node", "script", "--product", "mujin-overview", "--case=a=b", "--draft", "--voice=x"];
    expect(readOption("product", argv)).toBe("mujin-overview");
    expect(readOption("case", argv)).toBe("a=b");
    expect(readOption("draft", argv)).toBeUndefined();
    expect(readOption("voice", argv)).toBe("x");
    expect(readOption("missing", argv)).toBeUndefined();
    const saved = process.argv;
    process.argv = argv;
    try {
      expect(readArg("case")).toBe("a=b");
      expect(readArg("product")).toBeUndefined();
    } finally {
      process.argv = saved;
    }
  });
});

describe("사례 → 작성 계획 (운영 함수, 모델 호출 없음)", () => {
  it("무료 단계는 기초 분석 4개와 1장, 유료 단계는 2~10장이다. 9·10장은 유료 단계의 기간 재료로만 만든다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    expect([...evaluation.stages.free.sections.keys()]).toEqual(["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"]);
    expect([...evaluation.stages.paid.sections.keys()]).toEqual(["ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10"]);
    expect(evaluation.stages.free.timing).toBeNull();
    expect(evaluation.stages.paid.timing).toEqual({ luck: evaluation.timing.luck, months: evaluation.timing.months });
    expect(evaluation.timing.referenceDate).toBe(REFERENCE);
    expect(evaluation.persona.id).toBe("mujin");
    expect(evaluation.persona.version).toBe(evaluation.bundle.personaVersion);
  });

  it("질문 정리는 고정 가상 값을 운영 코드로 판정하고, 무료 단계 입력에는 무료 장에 이어진 질문만 넣는다", async () => {
    const work = await evaluationOf("side-job-money");
    expect(work.prepared.questions.map((question) => [question.ref, question.domain])).toEqual([
      ["q1", "career"],
      ["q2", "wealth"],
    ]);
    expect(work.prepared.concernFacts).toEqual([{ text: "회사에 다니면서 외주 일을 하고 있다", domain: "career", kind: "current" }]);
    // 일·돈 질문은 3·4장(유료)에서 답하므로 결제 전 1장 입력에는 없다.
    expect(work.stages.free.questionMaterials).toEqual([]);
    expect(work.stages.paid.questionMaterials.map((question) => [question.ref, question.sectionIds])).toEqual([
      ["q1", ["ch3"]],
      ["q2", ["ch4"]],
    ]);

    const loss = await evaluationOf("heavy-loss");
    expect(loss.stages.free.questionMaterials.map((question) => [question.ref, question.sectionIds, question.answerability])).toEqual([["q1", ["ch1"], "limited"]]);
    expect(loss.prepared.concernFacts.map((fact) => fact.kind)).toEqual(["past", "current"]);

    const blank = await evaluationOf("blank");
    expect([blank.prepared.questions, blank.prepared.concernFacts, blank.prepared.analysis.items]).toEqual([[], [], []]);
  });

  it("같은 사례·기준일이면 같은 계획이고, 기준일을 바꾸면 10장 기간이 바뀐다. 실제 날짜가 아니면 거부한다", async () => {
    const entry = caseById("side-job-money");
    const again = await buildMujinEvaluation(entry, REFERENCE);
    const first = await evaluationOf("side-job-money");
    expect(JSON.stringify(again.stages)).toBe(JSON.stringify(first.stages));
    const later = await buildMujinEvaluation(entry, "2027-03-02");
    expect(later.timing.months.months[0]!.label).not.toBe(first.timing.months.months[0]!.label);
    await expect(buildMujinEvaluation(entry, "2026-02-30")).rejects.toThrow("YYYY-MM-DD");
  });
});

describe("Pass 1 묶음별 요청 (지시·입력·출력 형식)", () => {
  it("묶음마다 요청 하나다. 마지막 정리는 유료 장 초안이 모두 있어야 만든다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const fresh = pass1Requests(evaluation);
    expect(fresh.requests.map((entry) => entry.batch.id)).toEqual(["free-basics", "free-ch1", "paid-work", "paid-money-love", "paid-people-life", "paid-flow"]);
    expect(fresh.closing).toEqual({ plan: null, missing: ["ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10"] });

    const drafts = draftsFor(fresh.requests);
    const ready = pass1Requests(evaluation, { drafts, finals: new Map() });
    expect(ready.requests.map((entry) => entry.batch.id).at(-1)).toBe("paid-closing");
    // 마지막 정리는 질문마다 소질문 하나 (질문 ref)이고, 장 초안의 핵심 답을 재료로 모은다.
    expect(ready.closing.plan!.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
    const closingInput = parse(ready.requests.at(-1)!.request.input);
    expect(JSON.stringify(closingInput.sections)).toContain(drafts.get("ch3")!.coreAnswer);
    expect(closingInput.timing).toBeNull();

    const blank = await evaluationOf("blank");
    expect(closingState(blank, { drafts: draftsFor(pass1Requests(blank).requests), finals: new Map() }).plan!.questions.map((question) => question.id)).toEqual(["closing-core"]);
  });

  it("Pass 1 지시에는 [캐릭터]가 없고 묶음과 관계없이 같다. 출력 형식은 mujin_draft(strict)다", async () => {
    const { requests } = pass1Requests(await evaluationOf("side-job-money"));
    for (const { request } of requests) {
      expect(request.instructions).not.toContain("[캐릭터");
      expect(request.instructions).toBe(requests[0]!.request.instructions);
      expect(request.schemaName).toBe("mujin_draft");
    }
  });

  it("입력에 내부 ID(규칙·결론·근거 ID, 규칙 버전, 의미 태그, 월운·대운 ID)와 그 칸 이름이 없다", async () => {
    for (const id of ["side-job-money", "hour-unknown"]) {
      const evaluation = await evaluationOf(id);
      const hidden = new Set<string>();
      const walk = (value: unknown, key = ""): void => {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string" && ["tags", "supporting", "counter", "contextual", "supportingEvidenceIds", "counterEvidenceIds", "contextualEvidenceIds"].includes(key)) hidden.add(item);
            else walk(item);
          }
        } else if (value && typeof value === "object") {
          for (const [name, child] of Object.entries(value)) {
            if (typeof child === "string" && ["ruleId", "ruleVersion", "conclusionId", "periodId"].includes(name)) hidden.add(child);
            walk(child, name);
          }
        }
      };
      walk([evaluation.base.plan, [...evaluation.stages.free.sections.values()], [...evaluation.stages.paid.sections.values()], evaluation.timing]);
      expect(hidden.size).toBeGreaterThan(20);
      const drafts = allDrafts(evaluation);
      const inputs = [
        ...pass1Requests(evaluation, { drafts, finals: new Map() }).requests.map((entry) => entry.request.input),
        ...pass2Requests(evaluation, { drafts, finals: new Map() }).map((entry) => entry.request.input),
      ];
      for (const input of inputs) {
        for (const value of hidden) expect(input).not.toContain(value);
        for (const key of ["ruleId", "ruleVersion", "conclusionId", "evidence", "variant", "tags", "periodId"]) expect(input).not.toContain(`"${key}":`);
      }
    }
  });

  it("9·10장 묶음에만 기간 재료(직전·현재·다음 대운, 기준일이 속한 절기 월부터 12개월)를 넣는다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const { requests } = pass1Requests(evaluation);
    for (const { batch, request } of requests) {
      const input = parse(request.input);
      expect(input.timing === null).toBe(batch.id !== "paid-flow");
      expect(input.tables === null).toBe(batch.id !== "free-basics");
    }
    const flow = parse(requests.find((entry) => entry.batch.id === "paid-flow")!.request.input) as {
      timing: { luck: { status: string; current: { label: string } | null }; months: { months: { label: string }[]; window: string } };
      sections: { sectionId: string; questions: { id: string; status: string }[] }[];
    };
    expect(flow.sections.map((section) => section.sectionId)).toEqual(["ch9", "ch10"]);
    expect(flow.timing.luck.status).toBe("available");
    expect(flow.timing.luck.current?.label).toBe(evaluation.timing.luck.current!.label);
    expect(flow.timing.months.months.map((month) => month.label)).toEqual(evaluation.timing.months.months.map((month) => month.label));
    expect(flow.timing.months.months).toHaveLength(12);
    expect(flow.timing.months.months[0]!.label).toBe("2026년 11월");

    // 태어난 시각을 모르면 대운을 고르지 않는다 (9-1~9-3 자료 없음, 이유는 입력에 쉬운 말로).
    const unknown = parse(pass1Requests(await evaluationOf("hour-unknown")).requests.find((entry) => entry.batch.id === "paid-flow")!.request.input) as typeof flow & {
      timing: { luck: { reasonNote: string | null; previous: unknown; next: unknown } };
    };
    expect(unknown.timing.luck).toMatchObject({ status: "unavailable", reasonNote: "태어난 시각을 몰라 대운을 계산하지 않았다.", previous: null, current: null, next: null });
    expect(unknown.sections[0]!.questions.slice(0, 3).map((question) => question.status)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(unknown.timing.months.months).toHaveLength(12);
  });

  it("무료 묶음 입력에는 유료 장과 유료 장에서 답할 질문이 없고, 무료 장에 이어진 질문만 있다", async () => {
    const work = pass1Requests(await evaluationOf("side-job-money")).requests;
    for (const { batch, request } of work.filter((entry) => entry.batch.tier === "free")) {
      const input = parse(request.input) as { sections: { sectionId: string; tier: string }[]; questions: unknown[] };
      expect(input.sections.every((section) => section.tier === "free" && batch.sectionIds.includes(section.sectionId))).toBe(true);
      expect(input.questions).toEqual([]);
    }
    const loss = pass1Requests(await evaluationOf("heavy-loss")).requests.find((entry) => entry.batch.id === "free-ch1")!;
    expect((parse(loss.request.input).questions as { ref: string }[]).map((question) => question.ref)).toEqual(["q1"]);
  });

  it("usedScenes에는 받은 초안 가운데 앞 묶음 장의 장면 요약을 목차 순서로 넣고, 없는 초안은 상태로 알린다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const basics = draftsFor(pass1Requests(evaluation).requests.filter((entry) => entry.batch.id === "free-basics"));
    const { requests } = pass1Requests(evaluation, { drafts: basics, finals: new Map() });
    const ch1 = requests.find((entry) => entry.batch.id === "free-ch1")!;
    expect(parse(ch1.request.input).usedScenes).toEqual(["basics-structure 장면 요약", "basics-elements 장면 요약", "basics-stages 장면 요약", "basics-ten-gods 장면 요약"]);
    expect(ch1.scenes).toEqual({ given: ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"], missing: [] });
    const work = requests.find((entry) => entry.batch.id === "paid-work")!;
    expect(work.scenes.missing).toEqual(["ch1"]);
    expect(parse(requests[0]!.request.input).usedScenes).toEqual([]);
  });
});

describe("Pass 2 장별 요청", () => {
  it("초안이 있는 장마다 [캐릭터: 무진 도사]로 시작하는 지시를 쓰고, 입력에 '님' 호칭·장 정보·초안(장면 요약 제외)·사용자 사실을 넣는다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const drafts = allDrafts(evaluation);
    const requests = pass2Requests(evaluation, { drafts, finals: new Map() });
    expect(requests.map((entry) => entry.sectionId)).toEqual(WRITTEN_IDS);
    for (const { request } of requests) {
      expect(request.instructions.startsWith("[캐릭터: 무진 도사]")).toBe(true);
      expect(request.instructions.split("[캐릭터: 무진 도사]").length - 1).toBe(1);
      expect(request.schemaName).toBe("mujin_voice");
    }
    const ch3 = requests.find((entry) => entry.sectionId === "ch3")!;
    const input = parse(ch3.request.input) as {
      address: { call: string };
      section: { sectionId: string; questions: { id: string }[]; targetChars: unknown };
      draft: Record<string, unknown>;
      userFacts: { text: string; source: string | null; factKind: string | null }[];
    };
    expect(input.address.call).toBe("모래 님");
    expect(input.section.questions.map((question) => question.id)).toEqual(["3-1", "3-2", "3-3", "3-4"]);
    expect(input.section.targetChars).toEqual(evaluation.stages.paid.sections.get("ch3")!.targetChars);
    expect(Object.keys(input.draft)).toEqual(["sectionId", "coreAnswer", "blocks"]);
    expect(input.userFacts.map((fact) => fact.text)).toContain("회사에 다니면서 외주 일을 하고 있다");
    expect(input.userFacts.every((fact) => !("ref" in fact))).toBe(true);
    // 초안이 없는 장은 Pass 2 요청이 없다.
    expect(pass2Requests(evaluation, { drafts: new Map([["ch1", drafts.get("ch1")!]]), finals: new Map() }).map((entry) => entry.sectionId)).toEqual(["ch1"]);
  });
});

describe("운영 실행기(runScrollTier)와 같은 요청·같은 검사", () => {
  it.each(["side-job-money", "heavy-loss", "hour-unknown"])("%s: Pass 1 묶음 요청과 Pass 2 장 요청이 운영 실행기가 실제로 보내는 것과 글자까지 같다", async (id) => {
    // Pass 2 문답 예시는 운영처럼 풀이 ID를 순서 값으로 고른다. 같은 값을 주면 지시(예시 블록 포함)까지 글자가 같다.
    const evaluation: MujinEvaluation = { ...(await evaluationOf(id)), exampleSeed: READING_ID };
    const production = await runProduction(evaluation);
    expect({ free: production.free, paid: production.paid, failures: production.store.failures }).toEqual({ free: "completed", paid: "completed", failures: [] });

    // 실행기가 저장한 초안·최종문으로 같은 요청을 만든다 (앞 묶음 장면 요약이 같아진다).
    const outputs: MujinOutputs = {
      drafts: new Map(WRITTEN_IDS.map((section) => [section, production.store.units.get(section)!.draft!] as const)),
      finals: new Map(WRITTEN_IDS.map((section) => [section, production.store.finals.get(section)!.content] as const)),
    };
    const mine = pass1Requests(evaluation, outputs).requests;
    const sent = production.streams.filter((captured) => !isRetry(captured));
    expect(sent.map((captured) => batchOfSection(firstSectionOf(captured)).id)).toEqual(mine.map((entry) => entry.batch.id));
    sent.forEach((captured, index) => {
      const { request } = mine[index]!;
      expect(request.instructions).toBe(captured.instructions);
      expect(request.input).toBe(captured.input);
      expect([request.schemaName, request.jsonSchema]).toEqual([captured.schemaName, captured.jsonSchema]);
      const body = requestBody(request, LLM_SETTINGS.tasks.draft);
      expect([(body.reasoning as { effort: string }).effort, body.max_output_tokens]).toEqual([captured.reasoningEffort, captured.maxOutputTokens]);
    });

    const voices = new Map<string, Captured>();
    for (const captured of production.voices) if (!voices.has(voiceSectionOf(captured))) voices.set(voiceSectionOf(captured), captured);
    const mineVoices = pass2Requests(evaluation, outputs);
    expect(mineVoices.map((entry) => entry.sectionId).sort()).toEqual([...voices.keys()].sort());
    for (const { sectionId, request } of mineVoices) {
      const captured = voices.get(sectionId)!;
      expect(request.instructions).toBe(captured.instructions);
      expect(request.input).toBe(captured.input);
      const body = requestBody(request, LLM_SETTINGS.tasks.voice);
      expect([(body.reasoning as { effort: string }).effort, body.max_output_tokens]).toEqual([captured.reasoningEffort, captured.maxOutputTokens]);
    }
  });

  it("비교표의 검사 결과가 운영 실행기가 다시 쓰게 할 때 넘기는 문제 목록과 같다 (무료 1장·유료 3장 초안, 유료 4장 최종문)", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const production = await runProduction(evaluation, { drafts: ["ch1", "ch3"], finals: ["ch4"] });
    expect({ free: production.free, paid: production.paid }).toEqual({ free: "completed", paid: "completed" });
    const drafts = new Map(WRITTEN_IDS.map((section) => [section, production.store.units.get(section)!.draft!] as const));
    const finals = new Map(WRITTEN_IDS.map((section) => [section, production.store.finals.get(section)!.content] as const));

    for (const id of ["ch1", "ch3"]) {
      const retried = production.streams.filter(isRetry).find((captured) => firstSectionOf(captured) === id)!;
      const sentBad = production.streams.find((captured) => !isRetry(captured) && (parse(captured.input) as unknown as DraftRequestInput).sections.some((section) => section.sectionId === id))!;
      const badSection = (parse(sentBad.input) as unknown as DraftRequestInput).sections.find((section) => section.sectionId === id)!;
      const review = reviewSections(evaluation, { drafts: new Map([...drafts, [id, fakeDraft(badSection, true)]]), finals }).find((entry) => entry.spec.id === id)!;
      expect(review.draftIssues!.length).toBeGreaterThan(0);
      expect(unique(review.draftIssues!.map(issueSummary)).slice(0, 15)).toEqual(parse(retried.input).fixTheseProblemsFromPreviousAttempt);
    }

    const retriedVoice = production.voices.filter(isRetry).find((captured) => voiceSectionOf(captured) === "ch4")!;
    const review = reviewSections(evaluation, { drafts, finals: new Map([...finals, ["ch4", fakeFinal(drafts.get("ch4")!, true)]]) }).find((entry) => entry.spec.id === "ch4")!;
    expect(review.finalIssues).toContain("ch4 블록 1: 초안에 없던 숫자를 썼습니다 (3).");
    expect(unique(review.finalIssues!.map(issueSummary)).slice(0, 15)).toEqual(parse(retriedVoice.input).fixTheseProblemsFromPreviousAttempt);
    // 통과한 장은 문제가 없다.
    expect(reviewSections(evaluation, { drafts, finals }).every((entry) => entry.draftIssues?.length === 0 && entry.finalIssues?.length === 0)).toBe(true);
  });
});

describe("결과 읽기", () => {
  it("모델 JSON, 응답 전체(output_text), BOM 붙은 파일을 읽고, 요청하지 않은 장·형식이 틀린 장·같은 장의 두 번째 결과는 버린다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const dir = tempDir();
    const drafts = allDrafts(evaluation);
    const basics = ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods"].map((id) => drafts.get(id)!);
    const response = (value: unknown) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
    writeFileSync(path.join(dir, "p1-free-basics.output.json"), `﻿${JSON.stringify(response({ sections: [...basics, drafts.get("ch5")!, { sectionId: "basics-elements" }] }))}`);
    writeJson(path.join(dir, "p1-free-ch1.output.json"), { sections: [drafts.get("ch1")!, drafts.get("basics-structure")!] });
    writeJson(path.join(dir, "p2-ch1.output.json"), { output_text: JSON.stringify({ section: fakeFinal(drafts.get("ch1")!) }) });
    writeJson(path.join(dir, "p2-ch2.output.json"), { section: fakeFinal(drafts.get("ch1")!) });
    writeFileSync(path.join(dir, "p2-ch3.output.json"), "{ 깨진 JSON");
    writeJson(path.join(dir, "notes.json"), { sections: [] });

    const loaded = loadCaseOutputs(evaluation, { dir });
    expect([...loaded.drafts.keys()]).toEqual(["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"]);
    expect([...loaded.finals.keys()]).toEqual(["ch1", "ch2"]);
    expect(loaded.problems).toEqual([
      "p1-free-basics.output.json 5번째 장 (ch5): 이 묶음(free-basics)에서 요청하지 않은 장이라 읽지 않았습니다.",
      "p1-free-basics.output.json 6번째 장 (basics-elements): 출력 형식이 맞지 않아 읽지 않았습니다.",
      "p1-free-ch1.output.json 2번째 장 (basics-structure): 이 묶음(free-ch1)에서 요청하지 않은 장이라 읽지 않았습니다.",
      "p2-ch3.output.json: JSON으로 읽지 못했습니다.",
    ]);
    // 파일 이름의 장(ch2)에 묶어 검사가 다른 장의 글을 잡는다.
    expect(reviewSections(evaluation, loaded).find((entry) => entry.spec.id === "ch2")!.finalIssues).toBeNull();
    const withDraft = reviewSections(evaluation, { drafts: new Map([["ch2", drafts.get("ch2")!]]), finals: loaded.finals }).find((entry) => entry.spec.id === "ch2")!;
    expect(withDraft.finalIssues).toContain("ch2: 장 ID가 계획과 다릅니다 (ch1).");

    // --draft로 준 파일은 이름 규칙과 관계없이 장 ID로 읽는다. 같은 장이 두 번 오면 앞의 것을 쓴다.
    const loose = path.join(dir, "내 결과.json");
    writeJson(loose, { sections: [drafts.get("ch9")!, drafts.get("ch9")!] });
    expect(outputSources([loose], 1)).toEqual([{ file: loose, pass: 1, unit: null }]);
    const explicit = loadOutputs(evaluation, outputSources([loose], 1));
    expect([...explicit.drafts.keys()]).toEqual(["ch9"]);
    expect(explicit.problems).toEqual(["내 결과.json 2번째 장 (ch9): 같은 장의 초안을 이미 읽어 앞의 것을 씁니다."]);
    expect(() => outputSources([path.join(dir, "없는 파일.json")], 1)).toThrow("결과 경로가 없습니다");
  });
});

describe("내보내기 파일 (llm:export)", () => {
  it("사례 폴더에 묶음별 Pass 1 요청 파일 4종과 질문 정리 참고 요청, 안내 파일을 쓴다. 요청 본문은 운영 호출과 같은 모양이다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const dir = tempDir();
    const result = writeMujinExport(evaluation, loadCaseOutputs(evaluation, { dir }), dir);
    const batches = ["free-basics", "free-ch1", "paid-work", "paid-money-love", "paid-people-life", "paid-flow"];
    expect(result.ready).toEqual(batches.map((id) => `p1-${id}`));
    const expected = ["00-guide.md", ...["p0-question", ...batches.map((id) => `p1-${id}`)].flatMap((stem) => ["input.json", "instructions.txt", "request.json", "schema.json"].map((kind) => `${stem}.${kind}`))];
    expect(readdirSync(dir).sort()).toEqual(expected.sort());

    const work = pass1Requests(evaluation).requests.find((entry) => entry.batch.id === "paid-work")!.request;
    const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
    expect(read("p1-paid-work.instructions.txt")).toBe(work.instructions);
    // 입력은 운영이 보내는 문자열 그대로다.
    expect(read("p1-paid-work.input.json")).toBe(work.input);
    expect(JSON.parse(read("p1-paid-work.schema.json"))).toEqual({ name: "mujin_draft", strict: true, schema: work.jsonSchema });
    expect(JSON.parse(read("p1-paid-work.request.json"))).toEqual({
      model: MODEL_PLACEHOLDER,
      instructions: work.instructions,
      input: work.input,
      store: false,
      max_output_tokens: LLM_SETTINGS.tasks.draft.maxOutputTokens,
      reasoning: { effort: LLM_SETTINGS.tasks.draft.reasoningEffort },
      text: { format: { type: "json_schema", name: "mujin_draft", schema: work.jsonSchema, strict: true } },
    });
    expect(JSON.parse(read("p0-question.request.json"))).toMatchObject({ max_output_tokens: LLM_SETTINGS.tasks.classify.maxOutputTokens, text: { format: { name: "mujin_question_analysis" } } });

    const guide = read("00-guide.md");
    expect(guide).toContain("**질문 정리 결과는 실제 모델의 출력이 아니라 이 사례에 고정한 가상 값이다**");
    expect(guide).toContain(`기준일은 ${REFERENCE}로 고정했다`);
    expect(guide).toContain("모델을 부르지 않고 만든 파일이다. API 키와 OPENAI 환경 변수를 읽지 않는다.");
    expect(guide).toContain("| q2 | 외주로 번 돈을 어떻게 관리하면 좋을지 | 재물 (wealth) | 적용 (apply) | 범위 안 | 4장 재물과 돈 관리, 마지막 정리 |");
    expect(guide).toContain("docs/personas/mujin-evaluation.md 1절(명세 07 4절)의 항목 1~9");

    // 궁금한 점이 없는 사례는 질문 정리 요청을 쓰지 않는다.
    const blank = await evaluationOf("blank");
    const blankDir = tempDir();
    writeMujinExport(blank, loadCaseOutputs(blank, { dir: blankDir }), blankDir);
    expect(readdirSync(blankDir).some((name) => name.startsWith("p0-"))).toBe(false);
  });

  it("저장한 결과가 있는 요청은 다시 쓰지 않고, 초안으로 장별 Pass 2 요청과 마지막 정리 요청을 이어서 쓴다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const dir = tempDir();
    writeMujinExport(evaluation, loadCaseOutputs(evaluation, { dir }), dir);
    const chapters = ["free-basics", "free-ch1", "paid-work", "paid-money-love", "paid-people-life", "paid-flow"];
    savePass1Outputs(dir, chapters);
    // 결과를 만든 요청 파일은 그대로 남아야 한다 (사용자가 실제로 실행한 요청).
    writeFileSync(path.join(dir, "p1-free-basics.input.json"), "실행한 요청");

    const second = writeMujinExport(evaluation, loadCaseOutputs(evaluation, { dir }), dir);
    expect(readFileSync(path.join(dir, "p1-free-basics.input.json"), "utf8")).toBe("실행한 요청");
    expect(second.ready).toEqual(["p1-paid-closing", ...WRITTEN_IDS.filter((id) => id !== "closing").map((id) => `p2-${id}`)]);
    const closingRequest = pass1Requests(evaluation, loadCaseOutputs(evaluation, { dir })).requests.find((entry) => entry.batch.id === "paid-closing")!;
    expect(readFileSync(path.join(dir, "p1-paid-closing.input.json"), "utf8")).toBe(closingRequest.request.input);

    savePass1Outputs(dir, ["paid-closing"]);
    savePass2Outputs(dir, ["ch1"]);
    writeFileSync(path.join(dir, "p2-ch1.input.json"), "실행한 요청");
    const third = writeMujinExport(evaluation, loadCaseOutputs(evaluation, { dir }), dir);
    expect(third.ready).toEqual(WRITTEN_IDS.filter((id) => id !== "ch1").map((id) => `p2-${id}`));
    expect(readFileSync(path.join(dir, "p2-ch1.input.json"), "utf8")).toBe("실행한 요청");
    const guide = readFileSync(path.join(dir, "00-guide.md"), "utf8");
    expect(guide).toContain("| 1 | Pass 1 (무료) | `free-basics`: 원국 분석, 오행 분석, 12운성 분석, 십성 분석 | p1-free-basics.* | p1-free-basics.output.json | 결과 있음 |");
    expect(guide).toContain("- 1장 성향과 내면: 문제 없음");
  });

  it("기본 사례 폴더는 git에 올리지 않는 docs/model-comparison/prompts/ 아래다", async () => {
    const evaluation = await evaluationOf("blank");
    expect(defaultCaseDir(evaluation.entry, REFERENCE)).toBe(path.resolve(MUJIN_PROMPTS_ROOT, `${REFERENCE}_blank`));
    expect(MUJIN_PROMPTS_ROOT.startsWith("docs/model-comparison/prompts/")).toBe(true);
    expect(readFileSync(path.resolve(process.cwd(), ".gitignore"), "utf8")).toContain("/docs/model-comparison/prompts/");
  });
});

describe("비교표 (llm:render)", () => {
  it("장마다 초안과 최종문을 나란히 놓고, 운영 검사 문제와 글자 수·편집 목표(실패 기준 아님)를 적는다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const drafts = allDrafts(evaluation, ["ch3"]);
    const finals = finalsFor(drafts, ["ch4"]);
    const report = renderMujinComparison(evaluation, { drafts, finals, files: [], problems: [] });

    expect(report).toContain("**질문 정리 결과는 실제 모델의 출력이 아니라 이 사례에 고정한 가상 값이다**");
    expect(report).toContain("| 칸 | 초안 (Pass 1) | 최종문 (Pass 2) |");
    expect(report).toContain("실패 기준이 아니다");
    // 같은 줄에 초안 블록과 최종문 블록이 나란히 있다.
    const ch4Row = report.split("\n").find((line) => line.startsWith("| 블록 1 |") && line.includes(BAD_TAIL.trim()))!;
    expect(ch4Row).toContain("[설명 · 질문 4-1]<br>가상 초안: 이 질문은 재료의 뜻을 이어 쉬운 말로 설명한다. | [설명 · 질문 4-1]<br>가상 초안: 이 질문은 재료의 뜻을 이어 쉬운 말로 설명한다. 하루 3번 확인한다. |");
    expect(report).toContain(`| 핵심 답 | ${BAD_CORE} | ${BAD_CORE} |`);
    // 검사 문제는 장마다 초안·최종문으로 나눠 적는다.
    const ch3 = report.slice(report.indexOf("## 3장 직업과 사회생활"), report.indexOf("## 4장 재물과 돈 관리"));
    expect(ch3).toMatch(/- 초안: \d+건\n {2}- ch3 핵심 답: /);
    const ch4 = report.slice(report.indexOf("## 4장 재물과 돈 관리"), report.indexOf("## 5장"));
    expect(ch4).toContain("- 초안: 문제 없음\n- 최종문: 1건\n  - ch4 블록 1: 초안에 없던 숫자를 썼습니다 (3).");
    // 한눈에 보기: 편집 목표와 글자 수 (강조 표시 제외, 공백 포함).
    const target = evaluation.stages.paid.sections.get("ch4")!.targetChars;
    expect(report).toContain(
      `| 4장 재물과 돈 관리 | 유료 | ${target.min.toLocaleString("ko-KR")}~${target.max.toLocaleString("ko-KR")}자 | ${contentChars(drafts.get("ch4")!)}자 | ${contentChars(finals.get("ch4")!)}자 | 0건 | 1건 |`,
    );
    for (const item of MUJIN_QUALITY_ITEMS) expect(report).toContain(`| ${item} |`);
    expect(MUJIN_QUALITY_ITEMS).toHaveLength(9);
  });

  it("결과가 없는 장, 초안 없이 최종문만 있는 장, 마지막 정리 계획이 없을 때를 구분해 적는다", async () => {
    const evaluation = await evaluationOf("side-job-money");
    const drafts = allDrafts(evaluation);
    const report = renderMujinComparison(evaluation, { drafts: new Map([["ch1", drafts.get("ch1")!]]), finals: new Map([["ch2", fakeFinal(drafts.get("ch2")!)]]), files: [], problems: [] });
    const ch2 = report.slice(report.indexOf("## 2장"), report.indexOf("## 3장"));
    expect(ch2).toContain("- 초안: 결과 없음\n- 최종문: 검사하지 않음 (Pass 2 검사는 그 장의 초안이 있어야 한다)");
    expect(report.slice(report.indexOf("## 3장"), report.indexOf("## 4장"))).toContain("아직 이 장의 결과가 없다.");
    expect(report.slice(report.indexOf("## 마지막 정리"))).toContain("마지막 정리 계획이 없다 (유료 장 초안이 모두 있어야 만든다). 검사하지 않았다.");
    // 강조 표시(**)는 빼고 공백은 센다: '핵심 답' 4 + '가 나' 3 + 'A' 1 + 'bc' 2.
    expect(contentChars({ sectionId: "x", coreAnswer: "**핵심** 답", blocks: [{ type: "compare", questionIds: [], refs: [], text: "가 나", items: [{ label: "A", text: "bc" }] }] })).toBe(4 + 3 + 1 + 2);
  });
});

describe("문서의 조회 SQL (docs/personas/mujin-evaluation.md 3절)", () => {
  it("앱에서 만든 풀이의 초안·최종문·질문 정리를 꺼내는 SQL이 실제 스키마에서 실행된다", async () => {
    const doc = readFileSync(path.resolve(process.cwd(), "docs/personas/mujin-evaluation.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 3."), doc.indexOf("## 4."));
    const statements = [...section.matchAll(/```sql\r?\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.split(/;\s*(?:\r?\n|$)/))
      .map((sql) => sql.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    const db = await createTestDb();
    try {
      for (const sql of statements) expect(await db.run("service_role", null, sql.replaceAll("'<풀이 ID>'", `'${READING_ID}'`))).toEqual([]);
    } finally {
      await db.pg.close();
    }
  }, 90_000);
});

describe("명령 (CLI): 모델을 부르지 않는 스크립트", () => {
  // 스크립트가 OPENAI 변수 없이 도는지 보려고 자식 프로세스에는 OPENAI_로 시작하는 변수를 넘기지 않는다.
  const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("OPENAI"))) as NodeJS.ProcessEnv;
  const runScript = (script: "llm-export" | "llm-render", args: readonly string[]) =>
    spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", `scripts/${script}.ts`, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: scrubbed,
      timeout: 120_000,
    });

  it("--product=mujin-overview: 내보내기가 사례 폴더에 요청 파일을 쓰고, 읽기가 저장한 결과로 comparison.md를 만든다", () => {
    const dir = tempDir();
    const exported = runScript("llm-export", ["--product", "mujin-overview", "--case=hour-unknown", `--dir=${dir}`]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stdout).toContain("모델 호출 없음, 질문 정리는 고정 가상 값");
    expect(existsSync(path.join(dir, "00-guide.md"))).toBe(true);
    expect(existsSync(path.join(dir, "p1-paid-flow.request.json"))).toBe(true);

    savePass1Outputs(dir, ["free-basics"]);
    const rendered = runScript("llm-render", ["--product=mujin-overview", "--case=hour-unknown", `--dir=${dir}`]);
    expect(rendered.status, rendered.stderr).toBe(0);
    const report = readFileSync(path.join(dir, "comparison.md"), "utf8");
    expect(report).toContain("# 무진 초안·최종문 비교: hour-unknown (사례 6, 기준일 2026-11-12)");
    expect(report).toContain("| 원국 분석 | 무료 |");

    const usage = runScript("llm-render", ["--product=mujin-overview", "--case=없는-사례"]);
    expect(usage.stdout).toContain("사용법: npm run llm:render '--' --product=mujin-overview --case=<blank|side-job-money|");
    const unknown = runScript("llm-export", ["--product=other", "--case=job-seeking"]);
    expect(unknown.stdout.trim()).toBe("알 수 없는 상품: other (--product=first-overview|mujin-overview)");
  }, 240_000);

  it("--product를 주지 않으면 묘묘 내보내기가 그대로다 (파일 이름·지시·입력·형식·요청 본문, 예시 보고서)", () => {
    const dir = tempDir();
    const result = runScript("llm-export", ["--case=job-seeking", "--date=2026-11-12", `--out=${dir}`]);
    expect(result.status, result.stderr).toBe(0);
    const stem = "2026-11-12_job-seeking_reading-3.2.0";
    expect(readdirSync(dir).sort()).toEqual([`${stem}.examples.md`, `${stem}.input.json`, `${stem}.instructions.txt`, `${stem}.request.json`, `${stem}.schema.json`]);
    const entry = EVALUATION_CASES.find((item) => item.id === "job-seeking")!;
    const { plan } = casePlan(entry, "2026-11-12");
    const persona = findPersona("myomyo", personaVersionFor(CURRENT_READING_PROMPT))!;
    // 내보내기는 사례 ID를 예시 순서 값으로 쓴다 (운영은 풀이 ID).
    const { instructions, input, examples } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona, previousIssues: [], exampleSeed: "llm-export:job-seeking" });
    const report = readFileSync(path.join(dir, `${stem}.examples.md`), "utf8");
    for (const id of examples!.ids) expect(report).toContain(`| ${id} |`);
    expect(report).toContain("--prompt=reading-3.1.0");
    const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);
    const read = (suffix: string) => readFileSync(path.join(dir, `${stem}${suffix}`), "utf8");
    expect(read(".instructions.txt")).toBe(instructions);
    expect(read(".input.json")).toBe(JSON.stringify(JSON.parse(input), null, 2));
    expect(read(".schema.json")).toBe(JSON.stringify({ name: schema.name, strict: true, schema: schema.jsonSchema }, null, 2));
    expect(read(".request.json")).toBe(
      JSON.stringify(
        {
          model: "<OPENAI_MODEL과 같은 모델>",
          instructions,
          input,
          reasoning: { effort: LLM_SETTINGS.tasks.reading.reasoningEffort },
          max_output_tokens: LLM_SETTINGS.tasks.reading.maxOutputTokens,
          text: { format: { type: "json_schema", name: schema.name, strict: true, schema: schema.jsonSchema } },
        },
        null,
        2,
      ),
    );
    expect(Object.keys(JSON.parse(result.stdout.trim()) as object)).toEqual([
      "case",
      "note",
      "prompt",
      "personaVersion",
      "referenceDate",
      "instructionsChars",
      "inputChars",
      "topics",
      "questions",
      "examples",
      "files",
    ]);
    expect((JSON.parse(result.stdout.trim()) as { examples: string[] }).examples).toEqual(examples!.ids);

    // 예시 없는 비교용 지시(reading-3.1.0)는 같은 입력이고, 지시는 예시 블록 앞까지 글자가 같다.
    const baseline = runScript("llm-export", ["--case=job-seeking", "--date=2026-11-12", `--out=${dir}`, "--prompt=reading-3.1.0"]);
    expect(baseline.status, baseline.stderr).toBe(0);
    const before = "2026-11-12_job-seeking_reading-3.1.0";
    expect(existsSync(path.join(dir, `${before}.examples.md`))).toBe(false);
    const baseInstructions = readFileSync(path.join(dir, `${before}.instructions.txt`), "utf8");
    expect(instructions.startsWith(`${baseInstructions}\n\n[캐릭터 문답 예시: 묘묘]`)).toBe(true);
    expect(readFileSync(path.join(dir, `${before}.input.json`), "utf8")).toBe(read(".input.json"));
  }, 120_000);

  it("--product를 주지 않은 묘묘 읽기의 사용법 안내가 그대로다", () => {
    const result = runScript("llm-render", ["--case=job-seeking"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`사용법: --case=${EVALUATION_CASES.map((item) => item.id).join("|")} --date=<기준일> --file=<결과 JSON> [--prompt=<버전>]\n`);
  }, 120_000);
});

describe("모델을 부르지 않고 OPENAI 환경 변수를 읽지 않는다", () => {
  it("모듈을 새로 불러와 내보내기·결과 읽기·비교표를 끝까지 해도 OPENAI_ 변수와 네트워크를 쓰지 않는다", async () => {
    const original = process.env;
    const touched = new Set<string>();
    let enumerated = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("네트워크 호출 금지");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = tempDir();
    process.env = new Proxy(original, {
      get(target, key, receiver) {
        if (typeof key === "string") touched.add(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        if (typeof key === "string") touched.add(key);
        return Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string") touched.add(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        enumerated = true;
        return Reflect.ownKeys(target);
      },
    });
    try {
      vi.resetModules();
      const mujin = await import("../../scripts/mujin-llm");
      const argv = ["node", "llm-export", "--product=mujin-overview", "--case=family-time", `--dir=${dir}`];
      await mujin.exportMujinCli(argv);
      savePass1Outputs(dir, ["free-basics", "free-ch1", "paid-work", "paid-money-love", "paid-people-life", "paid-flow"]);
      await mujin.exportMujinCli(argv);
      savePass2Outputs(dir, ["ch1", "ch7", "ch8"]);
      await mujin.renderMujinCli(["node", "llm-render", "--product=mujin-overview", "--case=family-time", `--dir=${dir}`]);
    } finally {
      process.env = original;
      fetchSpy.mockRestore();
      log.mockRestore();
    }
    expect(readFileSync(path.join(dir, "comparison.md"), "utf8")).toContain("# 무진 초안·최종문 비교: family-time");
    expect([...touched].filter((key) => key.toUpperCase().startsWith("OPENAI"))).toEqual([]);
    expect(enumerated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);
});
