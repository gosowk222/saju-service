import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generationPolicyLabel, loadGenerationUsage, partLabel, usageCells, type GenerationUsageReport } from "@/server/admin";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 관리자 생성 사용량(묘묘·무진 함께). 실제 migration을 적용한 테스트용 Postgres(PGlite)에 세 출처의 기록을 넣고
 * admin_generation_usage가 출처를 고르는 규칙(같은 사용량을 두 번 세지 않기), 상품 필터와 합계, 미확인과 0의 구분을 지키는지 본다.
 *
 * 풀이 A: 이전 1-pass 묘묘. 시도 합계(generation_attempts)와 후속 질문 합계(followups.usage)만 있다 (호출 기록 없음).
 * 풀이 B: 묘묘 2-pass. 호출 기록(질문 정리·Pass 1·Pass 2, 오류 응답 포함)과 같은 수의 시도 기록이 있다 → 호출 기록만 센다.
 * 풀이 C: 묘묘 2-pass인데 호출 기록 일부가 빠진 시도(시도 기록 3회, 호출 기록 2줄) → 그 시도는 시도 합계로 센다. 다음 시도는 진행 중(호출 기록만).
 * 풀이 D: 무진. 호출 기록(사용량을 받지 못한 호출 포함)과, 호출 기록·followups.usage가 둘 다 있는 후속 질문 → 호출 기록만 센다.
 * 풀이 E: 생성을 시작했지만 사용량 기록이 하나도 없는 묘묘 풀이 → 기록 없음(미확인).
 * 풀이 F: 테스트용 세 번째 캐릭터(sunbae)의 상품. SQL과 집계 코드를 고치지 않고 함께 보인다. 실제로 받은 0 토큰은 0으로 남는다.
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
const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const one = async <T>(sql: string, params: unknown[] = []) => (await svc<{ r: T }>(sql, params))[0]!.r;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2031, 5, 1, 0, 0, 0);

async function member(): Promise<string> {
  const id = randomUUID();
  await db.addUser(id);
  return id;
}

/** 풀이 하나와 생성 작업(무료 이용권 사용). productId·personaId는 풀이 기록에 그대로 남는다. */
async function reading(productId: string, personaId: string): Promise<{ id: string; user: string }> {
  const user = await member();
  const id = await one<string>(`select create_reading($1, $2, $3, 1000) as r`, [
    user,
    JSON.stringify({
      product_id: productId,
      product_version: "9.9.9",
      nickname: "가상별명",
      birth_input: {},
      place_snapshot: {},
      chart: {},
      preview: {},
      persona_id: personaId,
      persona_version: "1.0.0",
      ruleset_id: productId,
      ruleset_version: "1.0.0",
      engine_meta: {},
      concern: "가상 궁금한 점 원문",
    }),
    JSON.stringify({ plan: { planVersion: "2.0.0" }, trace: [] }),
  ]);
  await one(`select grant_free_ticket($1, 'free-trial-2026-11') as r`, [user]);
  const redeemed = await one<{ outcome: string }>(`select redeem_free_ticket($1, $2, $3, $4, '9.9.9', 3, '{}'::jsonb) as r`, [user, id, randomUUID(), productId]);
  expect(redeemed.outcome).toBe("redeemed");
  return { id, user };
}

const setJob = (readingId: string, attempts: number, promptVersion: string, status = "completed") =>
  db.pg.query(`update public.generation_jobs set attempts = $2, prompt_version = $3, status = $4, updated_at = $5 where reading_id = $1`, [
    readingId,
    attempts,
    promptVersion,
    status,
    iso(T0 + 1000),
  ]);

const attemptRecord = (readingId: string, attempt: number, outcome: string, usage: Record<string, unknown>) =>
  one<boolean>(`select record_generation_attempt($1, $2, $3, $4) as r`, [
    readingId,
    attempt,
    outcome,
    JSON.stringify({ promptVersion: "가상", modelId: "gpt-5.6-luna", usage, durationMs: 1000 }),
  ]);

const usageOf = (calls: number, input: number | null, output: number | null, cached: number | null, complete = true) => ({
  calls,
  callsWithUsage: complete ? calls : 0,
  callsWithoutUsage: complete ? 0 : calls,
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cached,
  reasoningTokens: 0,
  complete,
});

function call(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    callKey: randomUUID(),
    followupId: null,
    productId: "first-overview",
    tier: "paid",
    step: "pass2",
    unitId: "temperament",
    modelRequested: "gpt-5.6-luna",
    modelActual: "gpt-5.6-luna-2031",
    promptVersion: "messenger-voice-1.0.0",
    schemaVersion: "messenger-voice-schema-1.0.0",
    personaVersion: "2.1.0",
    reasoningEffort: "medium",
    providerResponseId: "resp_가상",
    providerRequestId: "req_가상",
    outcome: "usage",
    errorCode: null,
    startedAt: iso(T0),
    endedAt: iso(T0 + 5000),
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 600,
    reasoningTokens: 0,
    usageReceived: true,
    attempt: 1,
    personaId: "myomyo",
    policyVersion: "myomyo-2pass-1.0.0",
    ...overrides,
  };
}
const NO_USAGE = { outcome: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, usageReceived: false };
const record = (entry: Record<string, unknown>) => one<boolean>(`select record_llm_call($1) as r`, [JSON.stringify(entry)]);

/** 서버 권한 클라이언트 흉내 (rpc만). */
function serviceClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      try {
        const rows = await svc<{ r: unknown }>(`select public.${fn}(${keys.map((key, index) => `${key} := $${index + 1}`).join(", ")}) as r`, keys.map((key) => args[key]));
        return { data: rows[0]?.r ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error), code: "P0001" } };
      }
    },
  } as unknown as SupabaseClient;
}

let admin: string;
const ids: Record<"A" | "B" | "C" | "D" | "E" | "F", string> = { A: "", B: "", C: "", D: "", E: "", F: "" };
let report: GenerationUsageReport;

beforeAll(async () => {
  db = await createTestDb();
  admin = await member();
  await db.pg.query(`select public.set_user_role($1, 'admin')`, [admin]);

  // A: 이전 1-pass 묘묘 (시도 합계 2개, 후속 질문 합계 1개).
  const a = await reading("first-overview", "myomyo");
  ids.A = a.id;
  await setJob(a.id, 2, "reading-3.2.0");
  expect(await attemptRecord(a.id, 1, "failed", usageOf(1, 1000, 200, 600))).toBe(true);
  expect(await attemptRecord(a.id, 2, "completed", usageOf(2, 3000, 900, 1200))).toBe(true);
  const followupA = await one<{ followup: { id: string } }>(`select begin_followup($1, $2, $3, '가상 후속 질문', 180, 6) as r`, [a.user, a.id, randomUUID()]);
  await db.pg.query(`update public.followups set status = 'answered', usage = $2, answered_at = $3 where id = $1`, [
    followupA.followup.id,
    JSON.stringify(usageOf(2, 800, 100, 300)),
    iso(T0 + 2000),
  ]);

  // B: 묘묘 2-pass. 시도 기록의 호출 수(4)와 호출 기록 수(4)가 같다. 같은 호출을 두 번 보내도 한 줄만 남는다.
  const b = await reading("first-overview", "myomyo");
  ids.B = b.id;
  await setJob(b.id, 1, "myomyo-2pass-1.0.0");
  const base = { readingId: b.id, userId: b.user };
  const pass1 = call({ ...base, step: "pass1", unitId: "b1", promptVersion: "messenger-draft-1.0.0", personaVersion: null, inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 1000 });
  expect(await record(call({ ...base, step: "classify", unitId: null, promptVersion: "question-1.3.0", personaVersion: null, inputTokens: 300, outputTokens: 40, cachedInputTokens: 0 }))).toBe(true);
  expect(await record(pass1)).toBe(true);
  expect(await record(pass1)).toBe(false);
  expect(await record(call({ ...base, inputTokens: 1500, outputTokens: 600, cachedInputTokens: 1200 }))).toBe(true);
  expect(await record(call({ ...base, unitId: "strengths", outcome: "rejected", errorCode: "rate_limited", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, usageReceived: false }))).toBe(true);
  expect(await attemptRecord(b.id, 1, "completed", usageOf(4, 6800, 2640, 2200))).toBe(true);

  // C: 묘묘 2-pass, 시도 1은 호출 기록 일부가 빠짐(3회 중 2줄) → 시도 합계. 시도 2는 진행 중(호출 기록만).
  const c = await reading("first-overview", "myomyo");
  ids.C = c.id;
  await setJob(c.id, 2, "myomyo-2pass-1.0.0", "running");
  await record(call({ readingId: c.id, userId: c.user, inputTokens: 400, outputTokens: 40, cachedInputTokens: 0 }));
  await record(call({ readingId: c.id, userId: c.user, unitId: "strengths", inputTokens: 500, outputTokens: 50, cachedInputTokens: 0 }));
  expect(await attemptRecord(c.id, 1, "released", usageOf(3, 1000, 100, 0))).toBe(true);
  await record(call({ readingId: c.id, userId: c.user, attempt: 2, step: "pass1", unitId: "b3", inputTokens: 700, outputTokens: 70, cachedInputTokens: 0 }));

  // D: 무진. 이전 호출 기록(시도 번호 없음), 사용량을 받지 못한 Pass 2, 호출 기록과 followups.usage가 둘 다 있는 후속 질문.
  const d = await reading("mujin-overview", "mujin");
  ids.D = d.id;
  await setJob(d.id, 1, "mujin-1.1.0");
  const mujin = { readingId: d.id, userId: d.user, productId: "mujin-overview", attempt: null, personaId: null, policyVersion: null };
  await record(call({ ...mujin, tier: "free", step: "pass1", unitId: "free-basics", inputTokens: 2000, outputTokens: 800, cachedInputTokens: 0 }));
  await record(call({ ...mujin, step: "pass2", unitId: "ch2", ...NO_USAGE }));
  const followupD = await one<{ followup: { id: string } }>(`select begin_followup($1, $2, $3, '가상 무진 후속', 180, 6) as r`, [d.user, d.id, randomUUID()]);
  await record(call({ ...mujin, step: "classify", unitId: null, followupId: followupD.followup.id, inputTokens: 500, outputTokens: 30, cachedInputTokens: 100 }));
  await record(call({ ...mujin, step: "followup", unitId: null, followupId: followupD.followup.id, inputTokens: 2000, outputTokens: 400, cachedInputTokens: 1500 }));
  await db.pg.query(`update public.followups set status = 'answered', usage = $2, answered_at = $3 where id = $1`, [
    followupD.followup.id,
    JSON.stringify(usageOf(2, 2500, 430, 1600)),
    iso(T0 + 3000),
  ]);

  // E: 생성을 시작했지만 사용량 기록이 하나도 없는 이전 묘묘 풀이.
  const e = await reading("first-overview", "myomyo");
  ids.E = e.id;
  await setJob(e.id, 1, "reading-3.1.0");

  // F: 테스트용 세 번째 캐릭터의 상품. 실제로 받은 0 토큰.
  const f = await reading("test-product", "sunbae");
  ids.F = f.id;
  await record(call({ readingId: f.id, userId: f.user, productId: "test-product", personaId: "sunbae", policyVersion: "sunbae-2pass-test", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }));

  report = await loadGenerationUsage(admin, { limit: 20, product: null }, serviceClient());
});

afterAll(async () => {
  await db.close();
});

const readingOf = (key: keyof typeof ids) => report.readings.find((entry) => entry.readingId === ids[key])!;

describe("관리자 생성 사용량 (묘묘·무진 함께)", () => {
  it("이전 1-pass 묘묘: 시도 합계와 후속 질문 합계를 '기존 단일 생성'으로 보이고, 단계로 거짓 분류하지 않는다", () => {
    const entry = readingOf("A");
    expect(entry.productId).toBe("first-overview");
    expect(entry.personaId).toBe("myomyo");
    expect(entry.parts.map((part) => `${part.scope}/${part.step}/${part.source}`)).toEqual(["initial/attempt/attempt", "followup/followup/followup-summary"]);
    expect(entry.parts[0]).toMatchObject({ calls: 3, inputTokens: 4000, cachedInputTokens: 1800, outputTokens: 1100, callsWithUsage: null });
    expect(entry.total).toMatchObject({ calls: 5, inputTokens: 4800, outputTokens: 1200, totalTokens: 6000, usageComplete: true });
    expect(generationPolicyLabel(entry.job?.promptVersion ?? null)).toBe("기존 단일 생성 (1-pass)");
    expect(partLabel(entry.parts[0]!)).toContain("기존 단일 생성");
    expect(entry.attemptOutcomes).toEqual({ failed: 1, completed: 1 });
  });

  it("묘묘 2-pass: 호출 기록과 시도 기록이 같으면 호출 기록만 세고(두 번 세지 않음), 같은 호출 두 번은 한 줄이다", () => {
    const entry = readingOf("B");
    expect(entry.parts.map((part) => `${part.tier}/${part.step}/${part.source}`)).toEqual(["paid/classify/calls", "paid/pass1/calls", "paid/pass2/calls"]);
    const pass2 = entry.parts.find((part) => part.step === "pass2")!;
    expect(pass2).toMatchObject({ calls: 2, callsWithUsage: 1, callsRejected: 1, inputTokens: 1500 });
    // 캐시 입력은 입력에 포함된 값이라 합계(입력 + 출력)에 다시 더하지 않는다.
    expect(entry.total).toMatchObject({ calls: 4, inputTokens: 6800, cachedInputTokens: 2200, outputTokens: 2640, totalTokens: 9440, usageComplete: true });
    expect(generationPolicyLabel(entry.job?.promptVersion ?? null)).toBe("2-pass (myomyo-2pass-1.0.0)");
    expect(partLabel(pass2)).toBe("최초 풀이 · 유료 · 캐릭터 문장 (Pass 2)");
  });

  it("호출 기록이 일부 빠진 시도는 시도 합계로 세고 그 시도의 호출 기록은 빼며, 진행 중인 시도는 호출 기록으로 센다", () => {
    const entry = readingOf("C");
    expect(entry.parts.map((part) => `${part.step}/${part.source}`)).toEqual(["pass1/calls", "attempt/attempt-partial"]);
    expect(entry.total).toMatchObject({ calls: 4, inputTokens: 1700, outputTokens: 170 });
    expect(entry.missingAttempts).toBe(0);
    expect(entry.attemptOutcomes).toEqual({ released: 1 });
  });

  it("무진: 후속 질문은 호출 기록만 세고(followups.usage를 다시 더하지 않음), 사용량을 받지 못한 호출이 있으면 미확인이다", () => {
    const entry = readingOf("D");
    expect(entry.parts.map((part) => `${part.scope}/${part.tier}/${part.step}`)).toEqual(["initial/free/pass1", "initial/paid/pass2", "followup/paid/classify", "followup/paid/followup"]);
    const pass2 = entry.parts.find((part) => part.step === "pass2")!;
    expect(pass2).toMatchObject({ calls: 1, callsWithoutUsage: 1, inputTokens: null, outputTokens: null, usageComplete: false });
    expect(entry.total).toMatchObject({ calls: 4, inputTokens: 4500, outputTokens: 1230, usageComplete: false });
    expect(usageCells(pass2).inputTokens).toBe("모름");
  });

  it("생성을 시작했지만 기록이 없는 풀이는 '기록 없음'이고 0으로 채우지 않는다", () => {
    const entry = readingOf("E");
    expect(entry.parts).toEqual([]);
    expect(entry.total).toMatchObject({ calls: 0, inputTokens: null, outputTokens: null, totalTokens: null, usageComplete: false });
    expect(usageCells(entry.total).totalTokens).toBe("모름");
  });

  it("세 번째 캐릭터의 상품도 집계 코드를 고치지 않고 보이며, 실제로 받은 0은 0이다", () => {
    const entry = readingOf("F");
    expect([entry.productId, entry.personaId]).toEqual(["test-product", "sunbae"]);
    expect(entry.parts[0]).toMatchObject({ policyVersions: ["sunbae-2pass-test"], inputTokens: 0, outputTokens: 0 });
    expect(entry.total).toMatchObject({ inputTokens: 0, totalTokens: 0, usageComplete: true });
    expect(usageCells(entry.total).totalTokens).toBe("0");
  });

  it("상품별 합계와 전체 합계는 같은 풀이 범위를 쓰고, 풀이 합계를 다시 더한 값과 같다", () => {
    const sum = (values: readonly (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
    expect(report.total.readings).toBe(report.readings.length);
    expect(report.total.calls).toBe(sum(report.readings.map((entry) => entry.total.calls)));
    expect(report.total.inputTokens).toBe(sum(report.readings.map((entry) => entry.total.inputTokens)));
    expect(sum(report.products.map((product) => product.total.inputTokens))).toBe(report.total.inputTokens);
    expect(sum(report.products.map((product) => product.total.readings))).toBe(report.total.readings);
    expect(report.products.map((product) => product.productId).sort()).toEqual(["first-overview", "mujin-overview", "test-product"]);
    // 미확인이 섞였으므로 전체 합계도 완전하지 않다.
    expect(report.total.usageComplete).toBe(false);
  });

  it("상품 필터: 고른 상품의 풀이만 나오고 합계도 그 풀이만 더한다", async () => {
    const mujinOnly = await loadGenerationUsage(admin, { limit: 20, product: "mujin-overview" }, serviceClient());
    expect(mujinOnly.readings.map((entry) => entry.readingId)).toEqual([ids.D]);
    expect(mujinOnly.total).toMatchObject({ readings: 1, calls: 4, inputTokens: 4500 });
    const myomyo = await loadGenerationUsage(admin, { limit: 20, product: "first-overview" }, serviceClient());
    expect(new Set(myomyo.readings.map((entry) => entry.readingId))).toEqual(new Set([ids.A, ids.B, ids.C, ids.E]));
  });

  it("관리자가 아니면 읽지 못한다 (DB에서 역할을 다시 확인한다)", async () => {
    const user = await member();
    await expect(loadGenerationUsage(user, { limit: 20, product: null }, serviceClient())).rejects.toMatchObject({ status: 404 });
  });

  it("docs/LLM_OPERATIONS.md 묘묘 2-pass·상품 통합 사용량 절의 SQL 5개가 실제 스키마에서 실행된다", async () => {
    const doc = readFileSync(path.resolve(process.cwd(), "docs/LLM_OPERATIONS.md"), "utf8").replace(/\r\n/g, "\n");
    const start = doc.indexOf("## 묘묘 2-pass와 상품 통합 생성 사용량");
    expect(start).toBeGreaterThan(0);
    const rest = doc.slice(start + 3);
    const next = rest.indexOf("\n## ");
    const section = next >= 0 ? rest.slice(0, next) : rest;
    const statements = [...section.matchAll(/```sql\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.split(/;\s*(?:\n|$)/))
      .map((sql) => sql.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements).toHaveLength(5);
    const results: Record<string, unknown>[][] = [];
    for (const sql of statements) results.push(await svc(sql.replaceAll("'<풀이 ID>'", `'${ids.B}'`)));
    expect(results[1]).toHaveLength(4);
    expect(results[2]).toEqual([{ attempt: 1, outcome: "completed", attempt_calls: 4, logged_calls: 4 }]);
    expect(results[3]!.some((row) => row.prompt_version === "가상")).toBe(true);
  });
});
