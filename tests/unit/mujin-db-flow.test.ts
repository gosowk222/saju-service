import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_NOW } from "@/domain/mujin/now";
import { MUJIN_PLAN_VERSION, type ScrollDraftContent, type ScrollSectionContent, type ScrollTier } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { createCallRecorder, type LlmCallTags } from "@/server/llm/call-log";
import type { LlmCallLog, StreamedResult, StructuredRequest, StructuredResult, callStructured, callStructuredStream } from "@/server/llm/client";
import { MUJIN_BUNDLES, MUJIN_BUNDLE_VERSION, type MujinQuestionOutput } from "@/server/llm/mujin-prompts";
import { searchPlaces } from "@/server/places/search";
import { computeMujinTiming } from "@/server/engine/mujin";
import { createScrollReading } from "@/server/scroll/create";
import { SCROLL_QUESTION_VERSION, prepareScrollQuestionsWith, type ScrollClassifier } from "@/server/scroll/questions";
import { runScrollTier } from "@/server/scroll/runner";
import { SCROLL_QUESTION_KEY, createScrollStore, getReferenceDate, loadFinalSections, loadScrollReading, loadTimingBundle, scrollTimingKey } from "@/server/scroll/store";
import { prepareScrollTimingWith } from "@/server/scroll/timing";
import { createTestDb, type DbRole, type TestDb } from "../support/test-db";

/**
 * 실행기 저장소 래퍼(store.ts, create.ts, questions.ts, timing.ts)가 실제 SQL 함수(20261113120000_mujin_scroll.sql와 기존 함수)와
 * 맞는지 실제 migration을 적용한 PGlite로 확인한다. 클라이언트는 가짜 게이트웨이와 같은 방식으로 RPC·조회를 SQL로 옮긴다.
 * PGlite는 연결이 하나라 동시성 검증이 아니다 (동시 요청은 tests/db/concurrency.test.ts, 실제 Postgres). 입력은 모두 가상 값이다.
 */

/** PostgREST처럼 동작하는 최소 클라이언트 (tests/support/fake-gateway.ts의 RPC·조회 변환과 같다). */
function pgClient(db: TestDb, role: DbRole, userId: string | null): SupabaseClient {
  const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
  const failure = (error: unknown) => ({ message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? "P0001" });
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    const keys = Object.keys(args);
    const params = keys.map((key) => {
      const value = args[key];
      return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
    });
    try {
      const rows = await db.run<{ result: Record<string, unknown> | null }>(
        role,
        userId,
        `select row_to_json(s) as result from (select * from public.${fn}(${keys.map((key, index) => `${key} := $${index + 1}`).join(", ")})) s`,
        params,
      );
      const row = rows[0]?.result ?? null;
      const rowKeys = row ? Object.keys(row) : [];
      return { data: json(row && rowKeys.length === 1 && rowKeys[0] === fn ? row[fn] : row), error: null };
    } catch (error) {
      return { data: null, error: failure(error) };
    }
  };
  const from = (table: string) => {
    let columns = "*";
    let single = false;
    let order = "";
    const clauses: string[] = [];
    const params: unknown[] = [];
    const execute = async () => {
      try {
        const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
        const rows = json(await db.run(role, userId, `select ${columns === "*" ? "t.*" : columns} from public.${table} t${where}${order}`, params));
        if (!single) return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: { message: "more than one row", code: "PGRST116" } };
        return { data: rows[0] ?? null, error: null };
      } catch (error) {
        return { data: null, error: failure(error) };
      }
    };
    const query = {
      select(value = "*") {
        columns = value;
        return query;
      },
      eq(column: string, value: unknown) {
        params.push(String(value));
        clauses.push(`${column}::text = $${params.length}`);
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        order = ` order by ${column} ${options?.ascending === false ? "desc" : "asc"}`;
        return query;
      },
      maybeSingle() {
        single = true;
        return query;
      },
      then<A, B>(resolve: (value: Awaited<ReturnType<typeof execute>>) => A, reject?: (reason: unknown) => B) {
        return execute().then(resolve, reject);
      },
    };
    return query;
  };
  return { rpc, from } as unknown as SupabaseClient;
}

let db: TestDb;
const admin = () => pgClient(db, "service_role", null);
const as = (userId: string) => pgClient(db, "authenticated", userId);
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db.run<T>("service_role", null, text, params);
const bundle = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;
const claim = { retry: false, model: "fake-model", promptVersion: MUJIN_BUNDLE_VERSION, schemaVersion: bundle.draftSchema, reasoningEffort: "medium", leaseSeconds: 300 };

async function member(): Promise<string> {
  const id = randomUUID();
  await db.addUser(id);
  return id;
}

const NOW_INPUT = { work: ["job-seeking"], interests: ["ch3"], relationship: "private", family: ["none"] };

const readingInput = (extra: Record<string, unknown> = {}) =>
  ({
    productId: "mujin-overview",
    nickname: "가람",
    gender: "female",
    yymmdd: "980919",
    calendar: "solar",
    isLeapMonth: false,
    geonameId: searchPlaces("서울")[0]!.geonameId,
    birthTime: { status: "branch", branch: "신" },
    situationId: null,
    concern: "",
    now: NOW_INPUT,
    ...extra,
  }) as Parameters<typeof createScrollReading>[1];

const newReading = (user: string, extra: Record<string, unknown> = {}) => createScrollReading(user, readingInput(extra), { admin: admin() });

async function redeem(user: string, readingId: string): Promise<void> {
  await sql(`select grant_free_ticket($1, 'free-trial-2026-11')`, [user]);
  const [row] = await sql<{ r: { outcome: string } }>(`select redeem_free_ticket($1, $2, $3, 'mujin-overview', '1.0.0', 3, '{}'::jsonb) as r`, [user, readingId, randomUUID()]);
  expect(row?.r.outcome).toBe("redeemed");
}

const draftOf = (sectionId: string): ScrollDraftContent => ({ sectionId, coreAnswer: `${sectionId} 초안`, blocks: [], scenes: [] });
const contentOf = (sectionId: string): ScrollSectionContent => ({ sectionId, coreAnswer: `${sectionId} 최종문`, blocks: [] });

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe("풀이 만들기 (createScrollReading → create_reading)", () => {
  it("'지금의 나'를 situation_detail에, 원국 작성 계획을 reading_internals에 저장하고 상황 선택지와 맛보기는 비운다", async () => {
    const user = await member();
    const readingId = await newReading(user, { concern: "가상 질문 원문" });
    const [row] = await sql<Record<string, unknown>>(`select * from public.readings where id = $1`, [readingId]);
    expect(row).toMatchObject({
      user_id: user,
      product_id: "mujin-overview",
      product_version: MUJIN_OVERVIEW.version,
      persona_id: "mujin",
      ruleset_id: "mujin-overview",
      ruleset_version: "1.0.0",
      situation_id: null,
      situation_detail: NOW_INPUT,
      preview: null,
      concern: "가상 질문 원문",
    });
    const [internals] = await sql<{ plan: { planVersion: string; now: unknown } }>(`select plan from public.reading_internals where reading_id = $1`, [readingId]);
    expect(internals?.plan.planVersion).toBe(MUJIN_PLAN_VERSION);
    expect(internals?.plan.now).toEqual(NOW_INPUT);

    const loaded = await loadScrollReading(admin(), readingId, user);
    expect(loaded?.reading).toMatchObject({ id: readingId, product_id: "mujin-overview", concern: "가상 질문 원문" });
    expect(loaded?.plan.planVersion).toBe(MUJIN_PLAN_VERSION);
    expect(await loadScrollReading(admin(), readingId, await member())).toBeNull();
    expect(await loadScrollReading(admin(), "not-a-uuid", user)).toBeNull();
  });

  it("상황 선택지를 보내거나 '지금의 나'가 규칙에 맞지 않으면 거부하고 기록을 만들지 않는다", async () => {
    const user = await member();
    await expect(newReading(user, { situationId: "job-seeker" })).rejects.toMatchObject({ status: 422, code: "invalid_situation" });
    await expect(newReading(user, { now: { work: [], interests: [], relationship: null, family: ["none", "care"] } })).rejects.toMatchObject({ status: 422, code: "invalid_now" });
    await expect(newReading(user, { productId: "first-overview" })).rejects.toMatchObject({ status: 404 });
    expect(await sql(`select 1 from public.readings where user_id = $1`, [user])).toHaveLength(0);
    // now가 없으면 미응답(EMPTY_NOW)으로 저장한다.
    const readingId = await newReading(user, { now: undefined });
    const [row] = await sql<{ situation_detail: unknown }>(`select situation_detail from public.readings where id = $1`, [readingId]);
    expect(row?.situation_detail).toEqual(EMPTY_NOW);
  });
});

describe("무료 단계 저장 (claim_free_run → save_unit_draft → save_unit_final → complete_free_run)", () => {
  it("점유한 실행자만 초안·최종문을 저장하고, 단계를 마치면 다시 시작하지 않는다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const store = createScrollStore(admin());

    const first = await store.claimFree({ ...claim, userId: user, readingId, maxAttempts: 8, dailyLimit: 10 });
    expect(first).toEqual({
      claimed: true,
      run: { attempts: 1, modelId: "fake-model", promptVersion: "mujin-1.0.0", schemaVersion: bundle.draftSchema, reasoningEffort: "medium" },
    });
    expect(await store.claimFree({ ...claim, userId: user, readingId, maxAttempts: 8, dailyLimit: 10 })).toEqual({ claimed: false, reason: "running" });
    expect(await store.freeRunStatus(readingId)).toBe("running");

    expect(await store.saveDraft({ readingId, tier: "free", attempt: 1, unitId: "ch1", draft: draftOf("ch1"), meta: { batchId: "free-ch1" } })).toBe(true);
    // 시도 번호가 다른 실행(이어받기 전의 늦은 응답)은 저장하지 못한다.
    expect(await store.saveDraft({ readingId, tier: "free", attempt: 2, unitId: "basics-structure", draft: draftOf("basics-structure"), meta: {} })).toBe(false);
    expect(await store.saveFinal({ readingId, tier: "free", attempt: 2, unitId: "ch1", content: contentOf("ch1"), meta: {} })).toBe(false);
    expect(await store.failUnit({ readingId, tier: "free", attempt: 2, unitId: "ch1", stage: "voice", code: "timeout", retryable: true })).toEqual({
      saved: false,
      draftAttempts: 1,
      voiceAttempts: 0,
    });

    const [unit] = await store.loadUnits(readingId);
    expect(unit).toMatchObject({ unitId: "ch1", tier: "free", status: "drafted", draft: draftOf("ch1"), draftAttempts: 1, voiceAttempts: 0, errorStage: null });
    expect(await store.saveFinal({ readingId, tier: "free", attempt: 1, unitId: "ch1", content: contentOf("ch1"), meta: { personaVersion: "1.0.0" } })).toBe(true);
    expect((await store.loadUnits(readingId))[0]).toMatchObject({ status: "done", voiceAttempts: 1 });
    expect(await store.loadFinals(readingId)).toEqual([{ sectionId: "ch1", tier: "free", content: contentOf("ch1") }]);
    // 무료 장은 소유자가 권한 없이 읽는다. 다른 회원은 못 읽는다.
    expect(await loadFinalSections(as(user), readingId)).toEqual([{ sectionId: "ch1", tier: "free", content: contentOf("ch1") }]);
    expect(await loadFinalSections(as(await member()), readingId)).toEqual([]);
    // 초안 표는 브라우저 권한으로 읽을 수 없다.
    await expect(db.run("authenticated", user, `select draft from public.reading_units where reading_id = $1`, [readingId])).rejects.toThrow(/permission denied/);

    expect(await store.completeRun("free", readingId, 2, {})).toBe(false);
    expect(await store.completeRun("free", readingId, 1, {})).toBe(true);
    expect(await store.freeRunStatus(readingId)).toBe("completed");
    expect(await store.claimFree({ ...claim, userId: user, readingId, maxAttempts: 8, dailyLimit: 10 })).toEqual({ claimed: false, reason: "completed" });
  });

  it("반납하면 점유 시간을 기다리지 않고 다음 요청이 이어받고, 실패·재시도·시작 상한·하루 제한은 DB 함수 결과 그대로다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const store = createScrollStore(admin());
    const request = { ...claim, userId: user, readingId, maxAttempts: 3, dailyLimit: 10 };

    expect(await store.claimFree(request)).toMatchObject({ claimed: true, run: { attempts: 1 } });
    expect(await store.releaseRun("free", readingId, 2)).toBe(false);
    expect(await store.releaseRun("free", readingId, 1)).toBe(true);
    expect(await store.freeRunStatus(readingId)).toBe("queued");
    expect(await store.claimFree(request)).toMatchObject({ claimed: true, run: { attempts: 2 } });
    // 반납한 실행의 늦은 저장은 거부된다.
    expect(await store.saveDraft({ readingId, tier: "free", attempt: 1, unitId: "ch1", draft: draftOf("ch1"), meta: {} })).toBe(false);

    expect(await store.failUnit({ readingId, tier: "free", attempt: 2, unitId: "ch1", stage: "draft", code: "validation_failed", retryable: true })).toEqual({
      saved: true,
      draftAttempts: 1,
      voiceAttempts: 0,
    });
    expect((await store.loadUnits(readingId))[0]).toMatchObject({ status: "failed", errorStage: "draft", errorCode: "validation_failed", errorRetryable: true });
    expect(await store.failRun("free", readingId, 2, "units_failed", true, 0)).toBe(true);
    const [run] = await sql<{ status: string; error_code: string; error_retryable: boolean }>(`select * from public.reading_free_runs where reading_id = $1`, [readingId]);
    expect(run).toMatchObject({ status: "failed", error_code: "units_failed", error_retryable: true });
    expect(await store.claimFree(request)).toEqual({ claimed: false, reason: "failed" });
    expect(await store.claimFree({ ...request, retry: true })).toMatchObject({ claimed: true, run: { attempts: 3 } });
    expect(await store.releaseRun("free", readingId, 3)).toBe(true);
    expect(await store.claimFree(request)).toEqual({ claimed: false, reason: "exhausted" });

    // 하루 무료 시작 수: 이미 다른 풀이를 시작했으므로 한도 1이면 새 풀이는 시작하지 못한다.
    const another = await newReading(user);
    expect(await store.claimFree({ ...request, readingId: another, dailyLimit: 1 })).toEqual({ claimed: false, reason: "daily_limited" });
  });
});

describe("유료 단계 저장 (이용권 → claim_generation → … → complete_generation)", () => {
  it("권한 없이는 시작·저장하지 못하고, 이용권을 쓴 뒤에는 쓰고 마치면 작업과 이용권이 함께 완료된다. 기준일은 처음 값을 유지한다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const store = createScrollStore(admin());
    const request = { ...claim, schemaVersion: bundle.voiceSchema, userId: user, readingId, maxAttempts: 20 };

    expect(await store.hasEntitlement(readingId, user)).toBe(false);
    expect(await store.claimPaid(request)).toEqual({ claimed: false, reason: "not_entitled" });
    expect(await store.fixReferenceDate(readingId, "2026-11-12")).toBeNull();

    await redeem(user, readingId);
    expect(await store.hasEntitlement(readingId, user)).toBe(true);
    expect(await store.claimPaid(request)).toMatchObject({ claimed: true, run: { attempts: 1, schemaVersion: bundle.voiceSchema } });
    expect(await store.fixReferenceDate(readingId, "2026-11-12")).toBe("2026-11-12");
    expect(await store.fixReferenceDate(readingId, "2026-11-15")).toBe("2026-11-12");
    expect(await getReferenceDate(admin(), readingId)).toBe("2026-11-12");

    // 반납 뒤 바로 이어받는다 (시도 번호가 1 늘어난다).
    expect(await store.releaseRun("paid", readingId, 1)).toBe(true);
    expect(await store.claimPaid(request)).toMatchObject({ claimed: true, run: { attempts: 2 } });

    expect(await store.saveDraft({ readingId, tier: "paid", attempt: 2, unitId: "ch2", draft: draftOf("ch2"), meta: {} })).toBe(true);
    // 이미 다른 tier로 만든 장은 바꾸지 못한다.
    expect(await store.saveDraft({ readingId, tier: "free", attempt: 2, unitId: "ch2", draft: draftOf("ch2"), meta: {} })).toBe(false);
    expect(await store.saveFinal({ readingId, tier: "paid", attempt: 2, unitId: "ch2", content: contentOf("ch2"), meta: {} })).toBe(true);
    expect(await loadFinalSections(as(user), readingId)).toEqual([{ sectionId: "ch2", tier: "paid", content: contentOf("ch2") }]);

    const meta = { actualModel: "fake-model", usage: { calls: 2 }, durationMs: 12, llmCalls: 2, issueCount: 0, versions: { bundle: "mujin-1.0.0" } };
    expect(await store.completeRun("paid", readingId, 1, meta)).toBe(false);
    expect(await store.completeRun("paid", readingId, 2, meta)).toBe(true);
    const [job] = await sql<{ status: string; llm_calls: number; generation_meta: unknown }>(`select * from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(job).toMatchObject({ status: "completed", llm_calls: 2, generation_meta: { bundle: "mujin-1.0.0" } });
    const [ticket] = await sql<{ status: string }>(`select status from public.free_tickets where user_id = $1`, [user]);
    expect(ticket?.status).toBe("completed");
    expect(await store.claimPaid(request)).toEqual({ claimed: false, reason: "completed" });
  });

  it("유료 실패 기록은 fail_generation으로 남고 다시 시도로 이어받는다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const store = createScrollStore(admin());
    const request = { ...claim, userId: user, readingId, maxAttempts: 20 };
    await redeem(user, readingId);
    expect(await store.claimPaid(request)).toMatchObject({ claimed: true, run: { attempts: 1 } });
    expect(await store.failRun("paid", readingId, 1, "units_failed", true, 3)).toBe(true);
    const [job] = await sql<{ status: string; error_code: string; llm_calls: number }>(`select * from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(job).toMatchObject({ status: "failed", error_code: "units_failed", llm_calls: 3 });
    expect(await store.claimPaid(request)).toEqual({ claimed: false, reason: "failed" });
    expect(await store.claimPaid({ ...request, retry: true })).toMatchObject({ claimed: true, run: { attempts: 2 } });
  });
});

describe("분석 저장과 호출 기록", () => {
  it("기간 재료는 고정된 기준일 키로 한 번 계산해 저장하고 다시 계산하지 않는다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const store = createScrollStore(admin());
    const loaded = (await store.loadReading(readingId, user))!;
    const compute = vi.fn(computeMujinTiming);
    const input = { store, compute, readingId, birth: loaded.reading.birth_input, referenceDate: "2026-11-12", gender: loaded.plan.gender };

    const first = await prepareScrollTimingWith(input);
    expect(compute).toHaveBeenCalledTimes(1);
    const second = await prepareScrollTimingWith(input);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(await loadTimingBundle(admin(), readingId, "2026-11-12")).toEqual(first);
    expect(await loadTimingBundle(admin(), readingId, "2026-11-13")).toBeNull();
    const [row] = await sql<{ kind: string; cache_key: string }>(`select kind, cache_key from public.reading_analyses where reading_id = $1`, [readingId]);
    expect(row).toEqual({ kind: "timing", cache_key: scrollTimingKey("2026-11-12") });
  });

  it("질문 정리는 한 번만 부르고 정리된 문장만 저장한다 (원문 없음). 다시 쓸 때는 호출하지 않는다", async () => {
    const user = await member();
    const readingId = await newReading(user, { concern: "가상 질문 원문: 이직해도 될까요?" });
    const store = createScrollStore(admin());
    const output: MujinQuestionOutput = {
      items: [{ summary: "이직 시기", domain: "career", intent: "timing", options: [], period: { kind: "default", start: "", end: "" }, missingInfo: [] }],
      userFacts: [{ text: "회사에 다니고 있다", domain: "career", kind: "current" }],
      needsClarification: false,
      reaction: "none",
    };
    const classify = vi.fn<ScrollClassifier>(async () => output);
    const recorder = createCallRecorder(store.writeCall);
    const prepare = () =>
      prepareScrollQuestionsWith({
        store,
        classify,
        readingId,
        userId: user,
        product: MUJIN_OVERVIEW,
        concern: "가상 질문 원문: 이직해도 될까요?",
        modelId: "fake-model",
        deadlineAt: Date.now() + 60_000,
        recorder,
        tier: "free",
        bundle,
      });
    const first = await prepare();
    expect(first.fresh).toBe(true);
    expect(first.questions).toEqual([
      { ref: "q1", summary: "이직 시기", domain: "career", topicDomain: "career", intent: "timing", answerability: "full", missingInfo: [], timingSupported: true },
    ]);
    expect(first.concernFacts).toEqual([{ text: "회사에 다니고 있다", domain: "career", kind: "current" }]);
    const second = await prepare();
    expect(second.fresh).toBe(false);
    expect(second.questions).toEqual(first.questions);
    expect(classify).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ kind: string; version: string; payload: unknown }>(`select kind, version, payload from public.reading_analyses where reading_id = $1 and cache_key = $2`, [
      readingId,
      SCROLL_QUESTION_KEY,
    ]);
    expect(row).toMatchObject({ kind: "question", version: SCROLL_QUESTION_VERSION });
    expect(JSON.stringify(row?.payload)).not.toContain("가상 질문 원문");
  });

  it("호출 기록은 record_llm_call로 한 줄씩 남고 태그·토큰을 그대로 담는다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const recorder = createCallRecorder(createScrollStore(admin()).writeCall);
    const tags: LlmCallTags = {
      readingId,
      userId: user,
      productId: "mujin-overview",
      tier: "free",
      step: "pass1",
      unitId: "free-basics",
      promptVersion: bundle.draftPrompt,
      schemaVersion: bundle.draftSchema,
      personaVersion: null,
      reasoningEffort: "medium",
    };
    const log: LlmCallLog = {
      startedAt: "2026-11-12T03:00:00.000Z",
      endedAt: "2026-11-12T03:00:05.000Z",
      outcome: "usage",
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, reasoningTokens: 10, cachedInputTokens: 20 },
      requestedModel: "fake-model",
      actualModel: "fake-model-1",
      responseId: "resp_1",
      requestId: "req_1",
      errorCode: null,
    };
    recorder.forCall(tags)(log);
    recorder.forCall(tags)({ ...log, outcome: "unknown", usage: null, errorCode: "timeout" });
    await recorder.flush();
    expect(recorder.failures()).toBe(0);
    const rows = await sql<Record<string, unknown>>(`select * from public.llm_calls where reading_id = $1 order by id`, [readingId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tier: "free", step: "pass1", unit_id: "free-basics", prompt_version: "mujin-draft-1.0.0", input_tokens: 100, cached_input_tokens: 20, usage_received: true });
    expect(rows[1]).toMatchObject({ outcome: "unknown", input_tokens: null, usage_received: false, error_code: "timeout" });
  });
});

// ─── 실행기 + 실제 SQL 함수 ─────────────────────

function draftFromInput(section: { sectionId: string; questions: { id: string; refs: string[] }[] }): ScrollDraftContent {
  return {
    sectionId: section.sectionId,
    coreAnswer: "이 장의 핵심은 조건을 나눠 차분히 보는 데 있다.",
    blocks: section.questions.map((question) => ({ type: "paragraph" as const, questionIds: [question.id], refs: question.refs.slice(0, 1), text: "이 질문을 쉬운 말로 설명한다.", items: [] })),
    scenes: [],
  };
}

const meta = (model: string) => ({
  requestedModel: model,
  actualModel: "fake-model",
  responseId: null,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 0, cachedInputTokens: 0 },
  durationMs: 1,
  calls: 1,
});
const callLog = (model: string): LlmCallLog => ({
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  outcome: "usage",
  usage: meta(model).usage,
  requestedModel: model,
  actualModel: "fake-model",
  responseId: null,
  requestId: null,
  errorCode: null,
});

/** 장 원소를 하나씩 보내는 가짜 스트림과 초안을 그대로 돌려주는 가짜 Pass 2 (형식 확인용, 문장 품질 검증이 아니다). */
const fakeStream = (async <T,>(request: StructuredRequest<T> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> }): Promise<StreamedResult<T>> => {
  const input = JSON.parse(request.input) as { sections: { sectionId: string; questions: { id: string; refs: string[] }[] }[] };
  let text = '{"sections":[';
  await request.onDelta(text, text);
  for (const [index, section] of input.sections.entries()) {
    const chunk = `${index ? "," : ""}${JSON.stringify(draftFromInput(section))}`;
    text += chunk;
    if ((await request.onDelta(text, chunk)) === "stop") return { parsed: null, text, stopped: true, meta: meta(request.model) };
  }
  text += "]}";
  await request.onDelta(text, "]}");
  request.onCall?.(callLog(request.model));
  const parsed = request.parser.safeParse(JSON.parse(text));
  return { parsed: parsed.success ? parsed.data : null, text, stopped: false, meta: meta(request.model) };
}) as unknown as typeof callStructuredStream;

const fakeVoice = (async <T,>(request: StructuredRequest<T>): Promise<StructuredResult<T>> => {
  const input = JSON.parse(request.input) as { draft: ScrollSectionContent };
  request.onCall?.(callLog(request.model));
  return { parsed: request.parser.parse({ section: input.draft }), meta: meta(request.model) };
}) as unknown as typeof callStructured;

describe("실행기와 실제 SQL 함수", () => {
  it("무료 단계 → 이용권 → 유료 단계를 실제 저장 함수로 끝까지 쓰고, 이용권과 호출 기록이 맞게 남는다", async () => {
    const user = await member();
    const readingId = await newReading(user);
    const deps = { store: createScrollStore(admin()), callStructured: fakeVoice, callStructuredStream: fakeStream, classify: vi.fn<ScrollClassifier>() };
    const run = (tier: ScrollTier) => runScrollTier({ userId: user, readingId, tier, retry: false, deps });

    expect(await run("paid")).toBe("locked");
    expect(await run("free")).toBe("completed");
    expect(await run("paid")).toBe("locked");
    await redeem(user, readingId);
    expect(await run("paid")).toBe("completed");
    expect(await run("paid")).toBe("completed");

    const units = await sql<{ unit_id: string; tier: string; status: string }>(`select unit_id, tier, status from public.reading_units where reading_id = $1 order by unit_id`, [readingId]);
    const expected = MUJIN_OVERVIEW.scroll.sections.filter((section) => section.kind !== "chart");
    expect(units).toHaveLength(expected.length);
    for (const section of expected) expect(units.find((unit) => unit.unit_id === section.id)).toMatchObject({ tier: section.tier, status: "done" });
    expect(await sql(`select 1 from public.reading_sections where reading_id = $1`, [readingId])).toHaveLength(expected.length);

    const [free] = await sql<{ status: string }>(`select status from public.reading_free_runs where reading_id = $1`, [readingId]);
    const [job] = await sql<{ status: string; reference_date: string; prompt_version: string; schema_version: string }>(
      `select status, reference_date::text, prompt_version, schema_version from public.generation_jobs where reading_id = $1`,
      [readingId],
    );
    expect(free?.status).toBe("completed");
    expect(job).toMatchObject({ status: "completed", prompt_version: "mujin-1.0.0", schema_version: bundle.voiceSchema });
    expect(job?.reference_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [ticket] = await sql<{ status: string }>(`select status from public.free_tickets where user_id = $1`, [user]);
    expect(ticket?.status).toBe("completed");

    const calls = await sql<{ tier: string; step: string; unit_id: string }>(`select tier, step, unit_id from public.llm_calls where reading_id = $1`, [readingId]);
    expect(calls.filter((call) => call.step === "pass2")).toHaveLength(expected.length);
    expect(calls.filter((call) => call.tier === "free" && call.step === "pass1").map((call) => call.unit_id).sort()).toEqual(["free-basics", "free-ch1"]);
    expect(deps.classify).not.toHaveBeenCalled();
  });
});
