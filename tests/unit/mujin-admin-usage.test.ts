import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatDuration, generationTimings, loadLlmUsage, parseLlmUsage, usageCells, usageStepLabel, type LlmUsageTotals } from "@/server/admin";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 관리자 화면의 무진 생성 사용량. 실제 migration을 적용한 테스트용 Postgres(PGlite)에 호출 기록과 생성 시각을 넣고,
 * 서버 함수(loadLlmUsage)가 관리자만 admin_llm_usage를 부르는지, 화면 값이 캐시 입력을 다시 더하지 않는지 확인한다.
 * 모든 값은 가상이다. LLM은 부르지 않는다.
 */

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => {
    throw new Error("tests pass the client explicitly");
  },
  createSupabaseServerClient: async () => {
    throw new Error("server client is not used in this test");
  },
}));

let db: TestDb;
const CAMPAIGN = "free-trial-2026-11";

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const one = async <T>(sql: string, params: unknown[] = []) => (await svc<{ r: T }>(sql, params))[0]!.r;

async function member(): Promise<string> {
  const id = randomUUID();
  await db.addUser(id);
  return id;
}

const NICKNAME = "가상별명사용량";
const CONCERN = "가상 궁금한 점 원문입니다";
const SECTION_TEXT = "가상 최종문 원문입니다";
const FOLLOWUP_QUESTION = "가상 후속 질문 원문입니다";

const createReading = (user: string) =>
  one<string>(`select create_reading($1, $2, $3, 1000) as r`, [
    user,
    JSON.stringify({
      product_id: "mujin-overview",
      product_version: "1.0.0",
      nickname: NICKNAME,
      birth_input: {},
      place_snapshot: {},
      chart: {},
      preview: {},
      persona_id: "mujin",
      persona_version: "1.0.0",
      ruleset_id: "mujin-overview",
      ruleset_version: "1.0.0",
      engine_meta: {},
      concern: CONCERN,
    }),
    JSON.stringify({ plan: { planVersion: "mujin-plan-1.0.0" }, trace: [] }),
  ]);

const iso = (ms: number) => new Date(ms).toISOString();

function call(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    callKey: randomUUID(),
    readingId: null,
    userId: null,
    followupId: null,
    productId: "mujin-overview",
    tier: "free",
    step: "pass1",
    unitId: "free-basics",
    modelRequested: "gpt-5.6-luna",
    modelActual: "gpt-5.6-luna-2026-11-01",
    promptVersion: "mujin-draft-1.0.0",
    schemaVersion: "mujin-draft-schema-1.0.0",
    personaVersion: null,
    reasoningEffort: "medium",
    providerResponseId: "resp_가상",
    providerRequestId: "req_가상",
    outcome: "usage",
    errorCode: null,
    startedAt: iso(Date.UTC(2031, 0, 1)),
    endedAt: iso(Date.UTC(2031, 0, 1, 0, 0, 5)),
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 600,
    reasoningTokens: 50,
    usageReceived: true,
    ...overrides,
  };
}
const NO_USAGE = { outcome: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, usageReceived: false };
const record = (entry: Record<string, unknown>) => one<boolean>(`select record_llm_call($1) as r`, [JSON.stringify(entry)]);

/**
 * 서버 권한(service_role) 클라이언트 흉내. loadLlmUsage가 쓰는 RPC와 select·in만 PGlite SQL로 옮긴다.
 * PostgREST처럼 시각은 ISO 문자열로 돌려준다.
 */
function serviceClient() {
  const log: string[] = [];
  const toJson = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      log.push(`rpc:${fn}`);
      const keys = Object.keys(args);
      try {
        const rows = await svc<{ r: unknown }>(`select public.${fn}(${keys.map((key, index) => `${key} := $${index + 1}`).join(", ")}) as r`, keys.map((key) => args[key]));
        return { data: rows[0]?.r ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error), code: "P0001" } };
      }
    },
    from: (table: string) => {
      let columns = "*";
      const filters: { column: string; values: readonly unknown[] }[] = [];
      const builder = {
        select(value: string) {
          columns = value;
          return builder;
        },
        in(column: string, values: readonly unknown[]) {
          filters.push({ column, values });
          return builder;
        },
        then<T>(resolve: (value: { data: Record<string, unknown>[] | null; error: { message: string; code: string } | null }) => T, reject?: (reason: unknown) => T) {
          log.push(`select:${table}:${columns}`);
          const where = filters.map((filter, index) => `${filter.column}::text = any($${index + 1}::text[])`).join(" and ");
          return svc<Record<string, unknown>>(`select ${columns} from public.${table}${where ? ` where ${where}` : ""}`, filters.map((filter) => filter.values.map(String)))
            .then(
              (rows) => ({ data: rows.map(toJson), error: null }),
              (error: unknown) => ({ data: null, error: { message: String(error), code: "42501" } }),
            )
            .then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, log };
}

const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);
const ENTITLED_AT = T0 + 120_000;
let admin: string;
let user: string;
let readingId: string;

beforeAll(async () => {
  db = await createTestDb();
  admin = await member();
  user = await member();
  await db.pg.query(`select public.set_user_role($1, 'admin')`, [admin]);

  readingId = await createReading(user);
  expect((await one<{ outcome: string }>(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN])).outcome).toBe("granted");
  expect((await one<{ outcome: string }>(`select redeem_free_ticket($1, $2, $3, 'mujin-overview', '1.0.0', 3, '{}'::jsonb) as r`, [user, readingId, randomUUID()])).outcome).toBe(
    "redeemed",
  );

  // 생성 시각: 무료 단계 시작·완료, 칸 최종문 저장, 구매 권한, 유료 단계 완료.
  const content = JSON.stringify({ sectionId: "x", coreAnswer: SECTION_TEXT, blocks: [] });
  await db.pg.query(`insert into public.reading_free_runs (reading_id, user_id, status, attempts, started_at, completed_at) values ($1, $2, 'completed', 1, $3, $4)`, [
    readingId,
    user,
    iso(T0),
    iso(T0 + 61_000),
  ]);
  await db.pg.query(
    `insert into public.reading_sections (reading_id, section_id, user_id, tier, content, created_at)
     values ($1, 'basics-structure', $2, 'free', $3, $4), ($1, 'ch1', $2, 'free', $3, $5), ($1, 'ch2', $2, 'paid', $3, $6), ($1, 'ch3', $2, 'paid', $3, $7)`,
    [readingId, user, content, iso(T0 + 12_500), iso(T0 + 40_000), iso(ENTITLED_AT + 30_000), iso(ENTITLED_AT + 45_000)],
  );
  await db.pg.query(`update public.entitlements set created_at = $2 where reading_id = $1`, [readingId, iso(ENTITLED_AT)]);
  await db.pg.query(`update public.generation_jobs set status = 'completed', started_at = $2, completed_at = $3 where reading_id = $1`, [
    readingId,
    iso(ENTITLED_AT + 1_000),
    iso(ENTITLED_AT + 200_000),
  ]);
  const begun = await one<{ outcome: string; followup: { id: string } }>(`select begin_followup($1, $2, $3, $4, 180, 6) as r`, [user, readingId, randomUUID(), FOLLOWUP_QUESTION]);
  expect(begun.outcome).toBe("started");

  // 호출 기록: 무료 질문 정리·Pass 1, 유료 Pass 2(사용량 모름), 후속 질문의 질문 정리·답변.
  const base = { readingId, userId: user };
  await record(call({ ...base, step: "classify", unitId: null, promptVersion: "mujin-question-1.0.0", inputTokens: 300, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 10 }));
  await record(call({ ...base }));
  await record(call({ ...base, tier: "paid", step: "pass2", unitId: "ch2", promptVersion: "mujin-voice-1.0.0", ...NO_USAGE }));
  await record(
    call({ ...base, tier: "paid", step: "classify", unitId: null, followupId: begun.followup.id, promptVersion: "question-1.3.0", inputTokens: 500, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 0 }),
  );
  await record(
    call({ ...base, tier: "paid", step: "followup", unitId: null, followupId: begun.followup.id, promptVersion: "mujin-followup-1.0.0", personaVersion: "1.0.0", inputTokens: 2000, outputTokens: 400, cachedInputTokens: 1500, reasoningTokens: 100 }),
  );
});

afterAll(async () => {
  await db.close();
});

describe("무진 생성 사용량 (관리자 화면 서버 함수)", () => {
  it("관리자가 아니면 404이고 사용량 함수를 부르지 않는다", async () => {
    const { client, log } = serviceClient();
    await expect(loadLlmUsage(user, 20, client)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(log).toEqual(["rpc:get_reading_access"]);
  });

  it("브라우저 권한은 사용량 함수와 호출 기록을 쓸 수 없다 (서버 역할만)", async () => {
    for (const role of ["authenticated", "anon"] as const) {
      const who = role === "authenticated" ? admin : null;
      await expect(db.run(role, who, `select public.admin_llm_usage(20)`)).rejects.toThrow(/permission denied/);
      await expect(db.run(role, who, `select * from public.llm_calls`)).rejects.toThrow(/permission denied/);
      await expect(db.run(role, who, `select * from public.llm_call_usage`)).rejects.toThrow(/permission denied/);
    }
  });

  it("관리자는 풀이별·단계별 호출과 토큰을 보고, 합계는 입력 + 출력이라 캐시 입력을 다시 더하지 않는다", async () => {
    const { client, log } = serviceClient();
    const report = await loadLlmUsage(admin, 20, client);
    expect(log.slice(0, 2)).toEqual(["rpc:get_reading_access", "rpc:admin_llm_usage"]);
    expect(report.limit).toBe(20);
    const reading = report.readings.find((entry) => entry.readingId === readingId)!;
    expect(reading).toMatchObject({ productId: "mujin-overview", productVersion: "1.0.0", personaId: "mujin", personaVersion: "1.0.0" });
    expect(reading.steps.map(usageStepLabel)).toEqual(["무료 · 질문 정리", "무료 · 초안 (Pass 1)", "유료 · 질문 정리", "유료 · 무진 문장 (Pass 2)", "유료 · 후속 질문"]);

    const pass1 = reading.steps.find((step) => step.tier === "free" && step.step === "pass1")!;
    expect(usageCells(pass1)).toEqual({
      calls: "1",
      callsWithUsage: "1",
      inputTokens: "1,000",
      cachedInputTokens: "600",
      outputTokens: "200",
      totalTokens: "1,200",
      usageComplete: "예",
    });
    // 사용량을 받지 못한 호출은 0이 아니라 모름이고, 그 단계와 풀이 합계는 불완전으로 보인다.
    const pass2 = reading.steps.find((step) => step.step === "pass2")!;
    expect(usageCells(pass2)).toMatchObject({ calls: "1", callsWithUsage: "0", inputTokens: "모름", totalTokens: "모름", usageComplete: "아니요" });

    // 풀이 합계: 입력 3,800 = 300 + 1,000 + 500 + 2,000, 출력 670, 캐시 입력 2,200(입력에 포함).
    // 합계는 입력 + 출력 = 4,470이다. 캐시를 다시 더한 6,670이 아니다.
    expect(reading.total).toMatchObject({ calls: 5, callsWithUsage: 4, callsWithoutUsage: 1, inputTokens: 3800, cachedInputTokens: 2200, outputTokens: 670, totalTokens: 4470, usageComplete: false });
    expect(usageCells(reading.total)).toMatchObject({ inputTokens: "3,800", cachedInputTokens: "2,200", outputTokens: "670", totalTokens: "4,470", usageComplete: "아니요" });
    expect(usageCells(reading.total).totalTokens).not.toBe((3800 + 670 + 2200).toLocaleString("ko-KR"));

    // 후속 질문 단계는 followups.usage와 따로, 호출 단위로 보인다.
    expect(reading.steps.find((step) => step.step === "followup")).toMatchObject({ calls: 1, inputTokens: 2000, cachedInputTokens: 1500, promptVersions: ["mujin-followup-1.0.0"] });
  });

  it("생성 시간은 DB에 저장된 시각으로만 계산한다 (무료 첫 칸, 무료 완료, 권한 뒤 첫 유료 장, 권한 뒤 전체 완료)", async () => {
    const { client, log } = serviceClient();
    const report = await loadLlmUsage(admin, 20, client);
    const reading = report.readings.find((entry) => entry.readingId === readingId)!;
    expect(reading.timings).toEqual({ freeFirstMs: 12_500, freeDoneMs: 61_000, paidFirstMs: 30_000, paidDoneMs: 200_000 });
    expect(reading.timings).not.toHaveProperty("displayedMs");
    expect(formatDuration(reading.timings.freeFirstMs)).toBe("12.5초");
    expect(formatDuration(reading.timings.paidDoneMs)).toBe("3분 20초");
    // 시각 계산에는 본문(content)을 읽지 않는다.
    expect(log.filter((entry) => entry.startsWith("select:"))).toEqual([
      "select:reading_free_runs:reading_id, started_at, completed_at",
      "select:reading_sections:reading_id, tier, created_at",
      "select:entitlements:reading_id, created_at",
      "select:generation_jobs:reading_id, status, started_at, completed_at",
    ]);
  });

  it("화면 값에는 별명, 궁금한 점·후속 질문 원문, 생성 문장이 없다", async () => {
    const { client } = serviceClient();
    const text = JSON.stringify(await loadLlmUsage(admin, 20, client));
    for (const secret of [NICKNAME, CONCERN, SECTION_TEXT, FOLLOWUP_QUESTION]) expect(text).not.toContain(secret);
  });
});

describe("사용량 화면 값 (순수 함수)", () => {
  const totals = (overrides: Partial<LlmUsageTotals> = {}): LlmUsageTotals => ({
    calls: 2,
    callsWithUsage: 2,
    callsWithoutUsage: 0,
    inputTokens: 1000,
    cachedInputTokens: 600,
    uncachedInputTokens: 400,
    outputTokens: 200,
    reasoningTokens: 50,
    totalTokens: 1200,
    usageComplete: true,
    startedAt: null,
    endedAt: null,
    ...overrides,
  });

  it("합계 칸은 입력 + 출력으로 다시 계산하며 캐시·추론 토큰을 더하지 않고, 모름과 0을 구분한다", () => {
    // 저장된 합계가 잘못 들어와도 화면은 입력 + 출력을 쓴다.
    expect(usageCells(totals({ totalTokens: 1800 })).totalTokens).toBe("1,200");
    expect(usageCells(totals({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }))).toMatchObject({ inputTokens: "0", totalTokens: "0" });
    expect(usageCells(totals({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, usageComplete: false }))).toMatchObject({
      inputTokens: "모름",
      cachedInputTokens: "모름",
      totalTokens: "모름",
      usageComplete: "아니요",
    });
  });

  it("DB 결과를 읽을 때 문자열 숫자와 모르는 단계를 다룬다", () => {
    const report = parseLlmUsage({
      limit: "20",
      readings: [
        { readingId: "r1", userId: "u1", steps: [{ tier: "paid", step: "pass2", calls: "3", inputTokens: "10", outputTokens: null }, { tier: "free", step: "unknown-step", calls: 1 }], total: { calls: 3 } },
        { userId: "u2" },
      ],
      total: { calls: 3 },
    });
    expect(report.limit).toBe(20);
    expect(report.readings).toHaveLength(1);
    expect(report.readings[0]!.steps).toEqual([expect.objectContaining({ tier: "paid", step: "pass2", calls: 3, inputTokens: 10, outputTokens: null })]);
    // 화면에 회원 ID는 옮기지 않는다.
    expect(JSON.stringify(report)).not.toContain("u1");
  });

  it("시각이 없거나 순서가 맞지 않으면 그 칸은 기록 없음이다", () => {
    const timings = generationTimings(
      {
        freeRuns: [{ reading_id: "r1", started_at: "2031-01-01T00:00:10Z", completed_at: null }],
        sections: [{ reading_id: "r1", tier: "free", created_at: "2031-01-01T00:00:05Z" }],
        entitlements: [],
        jobs: [{ reading_id: "r1", status: "running", started_at: "2031-01-01T00:01:00Z", completed_at: null }],
      },
      "r1",
    );
    expect(timings).toEqual({ freeFirstMs: null, freeDoneMs: null, paidFirstMs: null, paidDoneMs: null });
    expect(formatDuration(null)).toBe("기록 없음");
    expect(formatDuration(59_949)).toBe("59.9초");
    expect(formatDuration(119_600)).toBe("2분");
  });
});

describe("운영 문서의 무진 사용량 SQL", () => {
  it("docs/LLM_OPERATIONS.md '무진 호출 단위 사용량' 절의 SQL 7개가 실제 스키마에서 실행된다", async () => {
    const doc = readFileSync(path.resolve(process.cwd(), "docs/LLM_OPERATIONS.md"), "utf8");
    const start = doc.indexOf("## 무진 호출 단위 사용량");
    expect(start).toBeGreaterThan(doc.indexOf("## 공식 문서 확인 결과"));
    const rest = doc.slice(start + 3);
    const next = rest.indexOf("\n## ");
    const section = next >= 0 ? rest.slice(0, next) : rest;
    const statements = [...section.matchAll(/```sql\r?\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.split(/;\s*(?:\r?\n|$)/))
      .map((sql) => sql.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements).toHaveLength(7);
    const results: Record<string, unknown>[][] = [];
    for (const sql of statements) results.push(await svc(sql.replaceAll("'<풀이 ID>'", `'${readingId}'`)));
    // 6) Pass 2 호출의 프롬프트 버전별 평균 토큰, 7) 장마다 넣은 문답 예시. 실행되고 칸 이름이 문서와 같은지만 본다.
    expect(results[5]!.every((row) => "prompt_version" in row && "avg_input" in row && "avg_cached" in row)).toBe(true);
    expect(results[6]!.every((row) => "section_id" in row && "examples" in row)).toBe(true);

    const pass1 = results[0]!.find((row) => row.tier === "free" && row.step === "pass1")!;
    expect(Number(pass1.total_tokens)).toBe(1200);
    expect(Number(pass1.uncached_input_tokens)).toBe(400);
    expect(results[1]).toHaveLength(5);
    expect(results[2]).toHaveLength(1);
    expect(Number(results[2]![0]!.calls)).toBe(2);
    expect(results[3]).toHaveLength(1);
    expect((results[4]![0] as { admin_llm_usage: { readings: unknown[] } }).admin_llm_usage.readings.length).toBeGreaterThan(0);
  });
});
