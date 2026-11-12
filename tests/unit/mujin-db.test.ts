import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MujinNowSchema, NOW_VERSION, nowStatus } from "@/domain/mujin/now";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 무진의 종합 사주 저장 구조(20261113120000 migration)를 실제 migration을 적용한 테스트용 Postgres(PGlite)로 확인한다.
 * 무료 단계 점유, 장 단위 초안·최종문 저장, 브라우저 권한(RLS), 무료 이용권, 기준일·반납, 호출 단위 사용량, 기간 재료 저장.
 * PGlite는 연결이 하나라 진짜 병렬 실행이 아니다. 동시 요청은 tests/db/concurrency.test.ts(실제 Postgres)가 확인한다.
 * 모든 입력은 가상 값이다.
 */
let db: TestDb;
const CAMPAIGN = "free-trial-2026-11";

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const asUser = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  db.run<T>("authenticated", user, sql, params);
const one = async <T>(sql: string, params: unknown[] = []) => (await svc<{ r: T }>(sql, params))[0]!.r;
const count = async (sql: string, params: unknown[] = []) => (await svc<{ n: number }>(sql, params))[0]!.n;
/** 합계(bigint·numeric)는 드라이버에 따라 문자열로 올 수 있어 숫자로 맞춘다. null은 그대로 둔다. */
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

async function member(): Promise<string> {
  const id = randomUUID();
  await db.addUser(id);
  return id;
}

const MUJIN_READING = {
  product_id: "mujin-overview",
  product_version: "1.0.0",
  nickname: "가상별명",
  birth_input: {},
  place_snapshot: {},
  chart: {},
  preview: {},
  persona_id: "mujin",
  persona_version: "1.0.0",
  ruleset_id: "mujin-overview",
  ruleset_version: "1.0.0",
  engine_meta: {},
  concern: "가상 질문 원문입니다",
};

const MYOMYO_READING = {
  product_id: "first-overview",
  product_version: "3.2.1",
  nickname: "달빛",
  birth_input: { birthDate: "2001-01-01" },
  place_snapshot: { latitudeDeg: 37.5 },
  situation_id: "job-seeker",
  concern: "가상 질문",
  chart: { pillars: [] },
  preview: { bubbles: ["가상 맛보기"] },
  persona_id: "myomyo",
  persona_version: "2.1.0",
  ruleset_id: "first-overview",
  ruleset_version: "3.1.0",
  engine_meta: { fingerprint: "가상" },
};

const INTERNALS = JSON.stringify({ plan: { planVersion: "mujin-plan-1.0.0" }, trace: [] });
const META = JSON.stringify({ actualModel: "m", usage: {}, durationMs: 1, llmCalls: 1, issueCount: 0 });

const createReading = (user: string, reading: Record<string, unknown> = MUJIN_READING, hourlyLimit = 1000) =>
  one<string>(`select create_reading($1, $2, $3, $4) as r`, [user, JSON.stringify(reading), INTERNALS, hourlyLimit]);

interface FreeRun {
  readonly status: string;
  readonly attempts: number;
  readonly model_id: string | null;
  readonly prompt_version: string | null;
  readonly schema_version: string | null;
  readonly reasoning_effort: string | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
  readonly started_at: string | null;
  readonly lease_until: string | null;
}

interface FreeClaim {
  readonly claimed: boolean;
  readonly reason: string;
  readonly run: FreeRun | null;
}

const claimFree = (user: string, readingId: string, options: { retry?: boolean; model?: string; maxAttempts?: number; dailyLimit?: number } = {}) =>
  one<FreeClaim>(`select claim_free_run($1, $2, $3, $4, 'mujin-pass1-1.0.0', 'mujin-draft-1.0.0', 'medium', 300, $5, $6) as r`, [
    user,
    readingId,
    options.retry ?? false,
    options.model ?? "gpt-5.6-luna",
    options.maxAttempts ?? 3,
    options.dailyLimit ?? 100,
  ]);
const releaseFree = (readingId: string, attempt: number) => one<boolean>(`select release_free_run($1, $2) as r`, [readingId, attempt]);
const completeFree = (readingId: string, attempt: number) => one<boolean>(`select complete_free_run($1, $2) as r`, [readingId, attempt]);
const failFree = (readingId: string, attempt: number, code = "timeout", retryable = true) =>
  one<boolean>(`select fail_free_run($1, $2, $3, $4) as r`, [readingId, attempt, code, retryable]);
const expireFree = (readingId: string) =>
  svc(`update public.reading_free_runs set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);

const grant = (user: string) => one<{ outcome: string; ticket?: { id: string } }>(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN]);
const redeem = (user: string, readingId: string, productId = "mujin-overview", productVersion = "1.0.0") =>
  one<{ outcome: string; readingId?: string }>(`select redeem_free_ticket($1, $2, $3, $4, $5, 3, '{}'::jsonb) as r`, [
    user,
    readingId,
    randomUUID(),
    productId,
    productVersion,
  ]);
const restore = (ticketId: string) => one<{ outcome: string }>(`select restore_free_ticket($1, '가상 반환 사유') as r`, [ticketId]);
/** 무진 유료 단계는 반납·이어받기가 잦아 시도 상한을 크게 준다. */
const claimPaid = (user: string, readingId: string, retry = false, maxAttempts = 50) =>
  one<{ claimed: boolean; reason: string; job: { attempts: number; status: string; model_id: string | null } }>(
    `select claim_generation($1, $2, $3, 'gpt-5.6-luna', 'mujin-pass1-1.0.0', 'mujin-draft-1.0.0', 'medium', 300, $4) as r`,
    [user, readingId, retry, maxAttempts],
  );
const releasePaid = (readingId: string, attempt: number) => one<boolean>(`select release_generation($1, $2) as r`, [readingId, attempt]);
const completePaid = (readingId: string, attempt: number) =>
  one<boolean>(`select complete_generation($1, $2, '[]'::jsonb, $3) as r`, [readingId, attempt, META]);
const fixDate = (readingId: string, date: string) => one<string | null>(`select fix_reference_date($1, $2)::text as r`, [readingId, date]);

const draftOf = (sectionId: string, coreAnswer = "가상 초안") => ({ sectionId, coreAnswer, blocks: [], scenes: [] });
const contentOf = (sectionId: string, coreAnswer = "가상 완성문") => ({ sectionId, coreAnswer, blocks: [] });

const saveDraft = (readingId: string, tier: string, attempt: number, unitId: string, draft: object = draftOf(unitId)) =>
  one<boolean>(`select save_unit_draft($1, $2, $3, $4, $5, $6) as r`, [
    readingId,
    tier,
    attempt,
    unitId,
    JSON.stringify(draft),
    JSON.stringify({ promptVersion: "mujin-pass1-1.0.0" }),
  ]);
const saveFinal = (readingId: string, tier: string, attempt: number, unitId: string, content: object = contentOf(unitId)) =>
  one<boolean>(`select save_unit_final($1, $2, $3, $4, $5, $6) as r`, [
    readingId,
    tier,
    attempt,
    unitId,
    JSON.stringify(content),
    JSON.stringify({ promptVersion: "mujin-pass2-1.0.0" }),
  ]);
const failUnit = (readingId: string, tier: string, attempt: number, unitId: string, stage: string, code = "validation_failed", retryable = true) =>
  one<{ saved: boolean; draftAttempts: number; voiceAttempts: number }>(`select fail_unit($1, $2, $3, $4, $5, $6, $7) as r`, [
    readingId,
    tier,
    attempt,
    unitId,
    stage,
    code,
    retryable,
  ]);

interface UnitRow {
  readonly status: string;
  readonly tier: string;
  readonly draft: unknown;
  readonly draft_meta: unknown;
  readonly draft_attempts: number;
  readonly voice_attempts: number;
  readonly error_stage: string | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
}

const unitOf = async (readingId: string, unitId: string) =>
  (
    await svc<UnitRow>(
      `select status, tier, draft, draft_meta, draft_attempts, voice_attempts, error_stage, error_code, error_retryable
       from public.reading_units where reading_id = $1 and unit_id = $2`,
      [readingId, unitId],
    )
  )[0];
const sectionOf = async (readingId: string, sectionId: string) =>
  (
    await svc<{ tier: string; content: unknown; meta: unknown }>(
      `select tier, content, meta from public.reading_sections where reading_id = $1 and section_id = $2`,
      [readingId, sectionId],
    )
  )[0];

let callSecond = 0;
/** 호출 기록 하나 (가상 값). 기본은 무료 Pass 1 호출이 사용량을 모두 받은 경우다. 시각은 2026-11-12 오전부터 1초씩 늘린다. */
function call(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  callSecond += 1;
  const at = (offset: number) => new Date(Date.UTC(2026, 10, 12, 1, 0, 0) + (callSecond * 2 + offset) * 1000).toISOString();
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
    promptVersion: "mujin-pass1-1.0.0",
    schemaVersion: "mujin-draft-1.0.0",
    personaVersion: "1.0.0",
    reasoningEffort: "medium",
    providerResponseId: "resp_가상",
    providerRequestId: "req_가상",
    outcome: "usage",
    errorCode: null,
    startedAt: at(0),
    endedAt: at(1),
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 600,
    reasoningTokens: 50,
    usageReceived: true,
    ...overrides,
  };
}
const NO_USAGE = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, usageReceived: false };
const record = (entry: Record<string, unknown>) => one<boolean>(`select record_llm_call($1) as r`, [JSON.stringify(entry)]);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe("풀이 기록: 무진 '지금의 나' (create_reading 교체)", () => {
  it("묘묘 풀이는 교체 전 함수와 같은 행을 만들고 situation_detail은 비워 둔다", async () => {
    // 교체 전 함수(20261109120000)를 다른 이름으로 다시 만들어 같은 입력의 결과를 비교한다.
    const first = readFileSync(path.resolve(process.cwd(), "supabase/migrations/20261109120000_first_product_mvp.sql"), "utf8");
    const original = first.match(/create function public\.create_reading\(p_user_id[\s\S]*?\r?\n\$\$;/)?.[0];
    expect(original).toBeTruthy();
    await db.pg.exec(original!.replace("public.create_reading(", "public.create_reading_before_mujin("));

    const user = await member();
    const before = await one<string>(`select create_reading_before_mujin($1, $2, $3, 1000) as r`, [user, JSON.stringify(MYOMYO_READING), INTERNALS]);
    const after = await createReading(user, MYOMYO_READING);
    const rowOf = async (id: string) =>
      (
        await svc<{ reading: Record<string, unknown>; internals: Record<string, unknown> }>(
          `select to_jsonb(r) - 'id' - 'created_at' as reading, to_jsonb(i) - 'reading_id' - 'created_at' as internals
           from public.readings r join public.reading_internals i on i.reading_id = r.id where r.id = $1`,
          [id],
        )
      )[0]!;
    const [old, next] = [await rowOf(before), await rowOf(after)];
    expect(next).toEqual(old);
    expect(next.reading.situation_detail).toBeNull();
    expect(next.reading).toMatchObject({ product_id: "first-overview", situation_id: "job-seeker", concern: "가상 질문", persona_id: "myomyo" });
    expect(next.internals).toEqual({ plan: { planVersion: "mujin-plan-1.0.0" }, trace: [] });
  });

  it("무진 풀이는 '지금의 나'를 situation_detail에 저장하고, JSON null은 SQL null로 저장한다", async () => {
    const user = await member();
    const now = MujinNowSchema.parse({ work: ["job-seeking", "freelancer"], interests: ["ch3", "ch4"], relationship: "private", family: ["care", "money"] });
    const detail = { version: NOW_VERSION, now, status: nowStatus(now) };
    const withDetail = await createReading(user, { ...MUJIN_READING, situation_detail: detail });
    const withNull = await createReading(user, { ...MUJIN_READING, situation_detail: null });
    const withoutKey = await createReading(user, MUJIN_READING);
    const rows = await svc<{ id: string; situation_detail: unknown; sql_null: boolean }>(
      `select id, situation_detail, situation_detail is null as sql_null from public.readings where id = any($1::uuid[])`,
      [[withDetail, withNull, withoutKey]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(withDetail)).toMatchObject({ situation_detail: detail, sql_null: false });
    expect(byId.get(withNull)).toMatchObject({ situation_detail: null, sql_null: true });
    expect(byId.get(withoutKey)).toMatchObject({ situation_detail: null, sql_null: true });
    // 소유자는 자기 입력을 읽을 수 있다 (readings 표 읽기 권한 그대로).
    const mine = await asUser<{ situation_detail: unknown }>(user, `select situation_detail from public.readings where id = $1`, [withDetail]);
    expect(mine).toEqual([{ situation_detail: detail }]);
  });

  it("situation_detail은 객체이고 8KB 미만일 때만 저장한다", async () => {
    const user = await member();
    await expect(createReading(user, { ...MUJIN_READING, situation_detail: ["work"] })).rejects.toThrow(/readings_situation_detail_shape/);
    await expect(createReading(user, { ...MUJIN_READING, situation_detail: "학생" })).rejects.toThrow(/readings_situation_detail_shape/);
    const large = { notes: Array.from({ length: 800 }, (_, index) => `가상 메모 ${index} ${(index * 7919) % 104729}`) };
    await expect(createReading(user, { ...MUJIN_READING, situation_detail: large })).rejects.toThrow(/readings_situation_detail_shape/);
    expect(await count(`select count(*)::int as n from public.readings where user_id = $1`, [user])).toBe(0);
  });

  it("시간당 생성 수 제한은 그대로다", async () => {
    const user = await member();
    await createReading(user, MUJIN_READING, 1);
    await expect(createReading(user, MYOMYO_READING, 1)).rejects.toThrow(/rate_limited/);
  });
});

describe("무료 단계 점유 (reading_free_runs)", () => {
  it("처음 시작하면 실행 중이 되어 생성 설정을 고정하고, 점유 중 두 번째 요청은 running이다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const first = await claimFree(user, readingId);
    expect(first).toMatchObject({
      claimed: true,
      reason: "claimed",
      run: {
        status: "running",
        attempts: 1,
        model_id: "gpt-5.6-luna",
        prompt_version: "mujin-pass1-1.0.0",
        schema_version: "mujin-draft-1.0.0",
        reasoning_effort: "medium",
        error_code: null,
      },
    });
    expect(first.run!.started_at).not.toBeNull();
    expect(first.run!.lease_until).not.toBeNull();
    expect(await claimFree(user, readingId)).toMatchObject({ claimed: false, reason: "running", run: { attempts: 1 } });
    // 무료 단계는 생성 작업(generation_jobs)을 만들지 않는다.
    expect(await count(`select count(*)::int as n from public.generation_jobs where reading_id = $1`, [readingId])).toBe(0);
  });

  it("반납하면 다음 요청이 바로 이어받아 시도 번호가 2가 되고, 처음 고정한 설정을 유지한다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    expect(await releaseFree(readingId, run!.attempts)).toBe(true);
    expect(await releaseFree(readingId, run!.attempts)).toBe(false);
    const [row] = await svc<{ status: string; lease_until: string | null }>(`select status, lease_until from public.reading_free_runs where reading_id = $1`, [readingId]);
    expect(row).toEqual({ status: "queued", lease_until: null });
    expect(await claimFree(user, readingId, { model: "gpt-6-luna" })).toMatchObject({
      claimed: true,
      run: { status: "running", attempts: 2, model_id: "gpt-5.6-luna" },
    });
  });

  it("점유 시간이 지나면 다음 요청이 이어받는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    await claimFree(user, readingId);
    await expireFree(readingId);
    expect(await claimFree(user, readingId)).toMatchObject({ claimed: true, reason: "claimed", run: { attempts: 2 } });
  });

  it("완료한 무료 단계는 다시 시작하지 않는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    expect(await completeFree(readingId, run!.attempts)).toBe(true);
    expect(await completeFree(readingId, run!.attempts)).toBe(false);
    expect(await claimFree(user, readingId, { retry: true })).toMatchObject({ claimed: false, reason: "completed", run: { status: "completed" } });
    const [row] = await svc<{ lease_until: string | null; done: boolean }>(
      `select lease_until, completed_at is not null as done from public.reading_free_runs where reading_id = $1`,
      [readingId],
    );
    expect(row).toEqual({ lease_until: null, done: true });
  });

  it("실패하면 다시 시도할 때만 시작하고, 시도 상한을 다 쓰면 exhausted로 닫는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId, { maxAttempts: 2 });
    expect(await failFree(readingId, run!.attempts, "timeout", true)).toBe(true);
    expect(await claimFree(user, readingId, { maxAttempts: 2 })).toMatchObject({
      claimed: false,
      reason: "failed",
      run: { status: "failed", error_code: "timeout", error_retryable: true },
    });
    const retry = await claimFree(user, readingId, { retry: true, maxAttempts: 2 });
    expect(retry).toMatchObject({ claimed: true, run: { attempts: 2, error_code: null, error_retryable: null } });
    await failFree(readingId, retry.run!.attempts);
    const exhausted = await claimFree(user, readingId, { retry: true, maxAttempts: 2 });
    expect(exhausted).toMatchObject({
      claimed: false,
      reason: "exhausted",
      run: { status: "failed", attempts: 2, error_code: "attempts_exhausted", error_retryable: false, lease_until: null },
    });
    expect((await claimFree(user, readingId, { retry: true, maxAttempts: 2 })).reason).toBe("exhausted");
  });

  it("이전 시도 번호로는 반납·완료·실패를 기록하지 않는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    await claimFree(user, readingId);
    await expireFree(readingId);
    const { run } = await claimFree(user, readingId);
    expect(run!.attempts).toBe(2);
    expect(await releaseFree(readingId, 1)).toBe(false);
    expect(await completeFree(readingId, 1)).toBe(false);
    expect(await failFree(readingId, 1)).toBe(false);
    const [row] = await svc<{ status: string; attempts: number }>(`select status, attempts from public.reading_free_runs where reading_id = $1`, [readingId]);
    expect(row).toEqual({ status: "running", attempts: 2 });
  });

  it("회원당 하루 무료 시작 수를 넘으면 새 풀이는 daily_limited이고, 이미 시작한 풀이는 계속 이어 쓴다", async () => {
    const user = await member();
    const [a, b, c] = [await createReading(user), await createReading(user), await createReading(user)];
    expect((await claimFree(user, a, { dailyLimit: 2 })).reason).toBe("claimed");
    expect((await claimFree(user, b, { dailyLimit: 2 })).reason).toBe("claimed");
    expect(await claimFree(user, c, { dailyLimit: 2 })).toEqual({ claimed: false, reason: "daily_limited", run: null });
    expect(await count(`select count(*)::int as n from public.reading_free_runs where reading_id = $1`, [c])).toBe(0);

    // 이미 시작한 풀이는 제한과 관계없이 이어 쓴다.
    await releaseFree(a, 1);
    expect(await claimFree(user, a, { dailyLimit: 2 })).toMatchObject({ claimed: true, run: { attempts: 2 } });

    // 24시간이 지난 시작은 세지 않는다.
    await svc(`update public.reading_free_runs set started_at = now() - interval '25 hours' where reading_id = $1`, [b]);
    expect((await claimFree(user, c, { dailyLimit: 2 })).reason).toBe("claimed");

    // 다른 회원의 시작 수와 섞이지 않는다.
    const other = await member();
    expect((await claimFree(other, await createReading(other), { dailyLimit: 1 })).reason).toBe("claimed");
  });

  it("다른 회원의 풀이나 없는 풀이는 시작할 수 없다 (not_found)", async () => {
    const owner = await member();
    const other = await member();
    const readingId = await createReading(owner);
    await expect(claimFree(other, readingId)).rejects.toThrow(/not_found/);
    await expect(claimFree(owner, randomUUID())).rejects.toThrow(/not_found/);
    expect(await count(`select count(*)::int as n from public.reading_free_runs where reading_id = $1`, [readingId])).toBe(0);
  });
});

describe("장 단위 저장 (reading_units, reading_sections)", () => {
  async function freeRunning() {
    const user = await member();
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    return { user, readingId, attempt: run!.attempts };
  }

  it("무료 단계를 점유한 실행자는 초안을 저장한 뒤 최종문을 저장하고 장을 끝낸다", async () => {
    const { user, readingId, attempt } = await freeRunning();
    expect(await saveDraft(readingId, "free", attempt, "ch1")).toBe(true);
    expect(await unitOf(readingId, "ch1")).toMatchObject({
      status: "drafted",
      tier: "free",
      draft: draftOf("ch1"),
      draft_meta: { promptVersion: "mujin-pass1-1.0.0" },
      draft_attempts: 1,
      voice_attempts: 0,
    });
    expect(await saveFinal(readingId, "free", attempt, "ch1")).toBe(true);
    expect(await unitOf(readingId, "ch1")).toMatchObject({ status: "done", draft: draftOf("ch1"), draft_attempts: 1, voice_attempts: 1 });
    expect(await sectionOf(readingId, "ch1")).toEqual({ tier: "free", content: contentOf("ch1"), meta: { promptVersion: "mujin-pass2-1.0.0" } });
    const [owners] = await svc<{ section: string; unit: string }>(
      `select s.user_id as section, u.user_id as unit from public.reading_sections s
       join public.reading_units u on u.reading_id = s.reading_id and u.unit_id = s.section_id where s.reading_id = $1`,
      [readingId],
    );
    expect(owners).toEqual({ section: user, unit: user });
  });

  it("점유하지 않았거나, 점유 시간이 지났거나, 이전 시도 번호이면 false이고 아무것도 저장하지 않는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const units = () => count(`select count(*)::int as n from public.reading_units where reading_id = $1`, [readingId]);
    const sections = () => count(`select count(*)::int as n from public.reading_sections where reading_id = $1`, [readingId]);

    // 무료 단계를 시작하기 전
    expect(await saveDraft(readingId, "free", 1, "ch1")).toBe(false);
    expect(await saveFinal(readingId, "free", 1, "ch1")).toBe(false);
    expect(await failUnit(readingId, "free", 1, "ch1", "draft")).toEqual({ saved: false, draftAttempts: 0, voiceAttempts: 0 });
    expect([await units(), await sections()]).toEqual([0, 0]);

    // 점유 시간이 지남
    const { run } = await claimFree(user, readingId);
    await expireFree(readingId);
    expect(await saveDraft(readingId, "free", run!.attempts, "ch1")).toBe(false);

    // 다른 요청이 이어받음: 이전 시도 번호는 저장하지 못하고 새 시도 번호만 저장한다.
    const { run: next } = await claimFree(user, readingId);
    expect(next!.attempts).toBe(2);
    expect(await saveDraft(readingId, "free", 1, "ch1")).toBe(false);
    expect(await saveFinal(readingId, "free", 1, "ch1")).toBe(false);
    expect([await units(), await sections()]).toEqual([0, 0]);
    expect(await saveDraft(readingId, "free", 2, "ch1")).toBe(true);

    // 반납·완료 뒤에는 저장하지 못한다.
    expect(await releaseFree(readingId, 2)).toBe(true);
    expect(await saveFinal(readingId, "free", 2, "ch1")).toBe(false);
    expect(await failUnit(readingId, "free", 2, "ch1", "voice")).toEqual({ saved: false, draftAttempts: 1, voiceAttempts: 0 });
    const { run: third } = await claimFree(user, readingId);
    expect(await completeFree(readingId, third!.attempts)).toBe(true);
    expect(await saveFinal(readingId, "free", third!.attempts, "ch1")).toBe(false);
    expect([await units(), await sections()]).toEqual([1, 0]);
    expect(await unitOf(readingId, "ch1")).toMatchObject({ status: "drafted", draft_attempts: 1, voice_attempts: 0 });
  });

  it("최종문은 덮어쓰지 않고, 끝난 장의 초안과 상태도 바꾸지 않는다", async () => {
    const { readingId, attempt } = await freeRunning();
    await saveDraft(readingId, "free", attempt, "basics-structure");
    expect(await saveFinal(readingId, "free", attempt, "basics-structure", contentOf("basics-structure", "처음 완성문"))).toBe(true);
    // 같은 장을 다시 보내도(재전송) 처음 문장이 남는다.
    expect(await saveFinal(readingId, "free", attempt, "basics-structure", contentOf("basics-structure", "두 번째 완성문"))).toBe(true);
    expect((await sectionOf(readingId, "basics-structure"))!.content).toEqual(contentOf("basics-structure", "처음 완성문"));
    expect(await saveDraft(readingId, "free", attempt, "basics-structure", draftOf("basics-structure", "새 초안"))).toBe(false);
    expect(await failUnit(readingId, "free", attempt, "basics-structure", "voice")).toMatchObject({ saved: false });
    expect(await unitOf(readingId, "basics-structure")).toMatchObject({ status: "done", draft: draftOf("basics-structure"), error_stage: null });
    expect(await count(`select count(*)::int as n from public.reading_sections where reading_id = $1`, [readingId])).toBe(1);
  });

  it("실패 기록은 단계별 시도 수를 늘리고 초안을 남기며, 다시 저장하면 오류를 비운다", async () => {
    const { readingId, attempt } = await freeRunning();
    await saveDraft(readingId, "free", attempt, "ch1");
    expect(await failUnit(readingId, "free", attempt, "ch1", "voice", "validation_failed", true)).toEqual({ saved: true, draftAttempts: 1, voiceAttempts: 1 });
    expect(await unitOf(readingId, "ch1")).toMatchObject({
      status: "failed",
      error_stage: "voice",
      error_code: "validation_failed",
      error_retryable: true,
      draft: draftOf("ch1"),
    });
    expect(await failUnit(readingId, "free", attempt, "ch1", "voice")).toEqual({ saved: true, draftAttempts: 1, voiceAttempts: 2 });

    // 행이 없던 장의 Pass 1 실패도 기록한다.
    expect(await failUnit(readingId, "free", attempt, "basics-elements", "draft", "invalid_output", false)).toEqual({
      saved: true,
      draftAttempts: 1,
      voiceAttempts: 0,
    });
    expect(await unitOf(readingId, "basics-elements")).toMatchObject({ status: "failed", draft: null, error_stage: "draft", error_retryable: false });

    // Pass 1을 다시 해서 초안을 저장하면 오류를 비운다.
    expect(await saveDraft(readingId, "free", attempt, "basics-elements")).toBe(true);
    expect(await unitOf(readingId, "basics-elements")).toMatchObject({
      status: "drafted",
      draft_attempts: 2,
      error_stage: null,
      error_code: null,
      error_retryable: null,
    });

    // Pass 2만 다시 해서 최종문을 저장한다 (초안과 Pass 1 시도 수는 그대로).
    expect(await saveFinal(readingId, "free", attempt, "ch1")).toBe(true);
    expect(await unitOf(readingId, "ch1")).toMatchObject({ status: "done", draft: draftOf("ch1"), draft_attempts: 1, voice_attempts: 3, error_stage: null });

    // 정해진 단계 이름만 받는다.
    await expect(failUnit(readingId, "free", attempt, "ch1", "render")).rejects.toThrow(/invalid_input/);
    await expect(saveDraft(readingId, "gift", attempt, "ch1")).rejects.toThrow(/invalid_input/);
  });

  it("초안이 없는 초안 저장과 64KB 이상의 초안·최종문은 거부한다", async () => {
    const { readingId, attempt } = await freeRunning();
    await expect(one(`select save_unit_draft($1, 'free', $2, 'ch1', null, '{}'::jsonb) as r`, [readingId, attempt])).rejects.toThrow(
      /reading_units_drafted_has_draft/,
    );
    const big = { blocks: Array.from({ length: 3000 }, (_, index) => `가상 문단 ${index} ${(index * 7919) % 104729}`) };
    await expect(saveDraft(readingId, "free", attempt, "ch1", big)).rejects.toThrow(/reading_units_draft_size/);
    await expect(saveFinal(readingId, "free", attempt, "ch1", big)).rejects.toThrow(/reading_sections_content_size/);
    expect(await count(`select count(*)::int as n from public.reading_units where reading_id = $1`, [readingId])).toBe(0);
  });

  it("유료 장은 구매 권한과 유료 생성 작업 점유가 모두 있어야 저장한다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    // 무료 단계 점유로는 유료 장을 저장하지 못한다 (권한 전 유료 초안 금지).
    expect(await saveDraft(readingId, "paid", run!.attempts, "ch2")).toBe(false);
    expect(await saveFinal(readingId, "paid", run!.attempts, "ch2")).toBe(false);
    expect(await unitOf(readingId, "ch2")).toBeUndefined();
    expect(await completeFree(readingId, run!.attempts)).toBe(true);

    expect((await redeem(user, readingId)).outcome).toBe("redeemed");
    // 권한은 있지만 아직 유료 생성을 시작하지 않았다.
    expect(await saveDraft(readingId, "paid", 1, "ch2")).toBe(false);

    const { job } = await claimPaid(user, readingId);
    expect(job.attempts).toBe(1);
    expect(await saveDraft(readingId, "paid", job.attempts, "ch2")).toBe(true);
    expect(await saveFinal(readingId, "paid", job.attempts, "ch2")).toBe(true);
    expect(await sectionOf(readingId, "ch2")).toMatchObject({ tier: "paid", content: contentOf("ch2") });
    // 유료 점유로 무료 장을 저장하지 못한다 (무료 단계는 따로 점유한다. 지금은 완료됨).
    expect(await saveDraft(readingId, "free", job.attempts, "basics-structure")).toBe(false);

    // 작업은 실행 중이지만 구매 권한 행이 없으면 저장하지 않는다.
    await db.pg.query(`delete from public.entitlements where reading_id = $1`, [readingId]);
    expect(await saveDraft(readingId, "paid", job.attempts, "ch3")).toBe(false);
    expect(await failUnit(readingId, "paid", job.attempts, "ch3", "draft")).toMatchObject({ saved: false });
    expect(await unitOf(readingId, "ch3")).toBeUndefined();
  });

  it("최종문은 서버 역할도 표에 직접 쓰지 못하고 save_unit_final로만 저장한다", async () => {
    const { user, readingId } = await freeRunning();
    for (const sql of [
      `insert into public.reading_sections (reading_id, section_id, user_id, tier, content) values ('${readingId}', 'ch1', '${user}', 'free', '{}')`,
      `update public.reading_sections set tier = 'free'`,
      `delete from public.reading_sections`,
    ]) {
      await expect(svc(sql), sql).rejects.toThrow(/permission denied/);
    }
    expect(await svc(`select 1 from public.reading_sections where reading_id = $1`, [readingId])).toEqual([]);
  });

  it("같은 장을 다른 단계(tier)로는 저장하지 않는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    expect(await saveDraft(readingId, "free", run!.attempts, "ch1")).toBe(true);
    await redeem(user, readingId);
    const { job } = await claimPaid(user, readingId);
    expect(await saveDraft(readingId, "paid", job.attempts, "ch1")).toBe(false);
    expect(await saveFinal(readingId, "paid", job.attempts, "ch1")).toBe(false);
    expect(await failUnit(readingId, "paid", job.attempts, "ch1", "voice")).toMatchObject({ saved: false });
    expect(await unitOf(readingId, "ch1")).toMatchObject({ tier: "free", status: "drafted", voice_attempts: 0 });
    expect(await sectionOf(readingId, "ch1")).toBeUndefined();
  });
});

describe("브라우저 권한 (RLS)", () => {
  it("소유자는 무료 최종문을 구매 없이 읽고, 유료 최종문은 구매 권한이 있을 때만 읽으며, 다른 회원은 읽지 못한다", async () => {
    const owner = await member();
    const other = await member();
    const { ticket } = await grant(owner);
    const readingId = await createReading(owner);
    const { run } = await claimFree(owner, readingId);
    await saveDraft(readingId, "free", run!.attempts, "ch1");
    await saveFinal(readingId, "free", run!.attempts, "ch1");
    // 유료 최종문이 이미 있는 상황. 구매 권한 없이는 함수로 만들 수 없으므로 관리자 연결로 넣는다.
    await db.pg.query(`insert into public.reading_sections (reading_id, section_id, user_id, tier, content) values ($1, 'ch2', $2, 'paid', $3)`, [
      readingId,
      owner,
      JSON.stringify(contentOf("ch2", "유료 완성문")),
    ]);
    const visible = async (user: string) =>
      (await asUser<{ section_id: string }>(user, `select section_id from public.reading_sections where reading_id = $1 order by section_id`, [readingId])).map(
        (row) => row.section_id,
      );

    expect(await visible(owner)).toEqual(["ch1"]);
    expect(await visible(other)).toEqual([]);

    expect((await redeem(owner, readingId)).outcome).toBe("redeemed");
    expect(await visible(owner)).toEqual(["ch1", "ch2"]);
    expect(await visible(other)).toEqual([]);

    // 권한을 회수하면(이용권 반환) 유료 최종문은 다시 보이지 않고 무료 최종문은 남는다.
    expect((await restore(ticket!.id)).outcome).toBe("restored");
    expect(await visible(owner)).toEqual(["ch1"]);
    await expect(db.run("anon", null, `select 1 from public.reading_sections`)).rejects.toThrow(/permission denied/);
  });

  it("무료 점유 기록은 본인 것만 읽는다", async () => {
    const owner = await member();
    const other = await member();
    const readingId = await createReading(owner);
    await claimFree(owner, readingId);
    expect(await asUser(owner, `select reading_id, status from public.reading_free_runs`)).toEqual([{ reading_id: readingId, status: "running" }]);
    expect(await asUser(other, `select 1 from public.reading_free_runs where reading_id = $1`, [readingId])).toHaveLength(0);
    await expect(db.run("anon", null, `select 1 from public.reading_free_runs`)).rejects.toThrow(/permission denied/);
  });

  it("초안·장 상태, 호출 기록, 사용량 집계와 관리자 조회는 소유자도 브라우저 권한으로 볼 수 없다", async () => {
    const owner = await member();
    const readingId = await createReading(owner);
    const { run } = await claimFree(owner, readingId);
    await saveDraft(readingId, "free", run!.attempts, "ch1");
    await record(call({ readingId, userId: owner }));
    for (const role of ["authenticated", "anon"] as const) {
      const user = role === "authenticated" ? owner : null;
      for (const sql of [
        `select * from public.reading_units`,
        `select * from public.llm_calls`,
        `select * from public.llm_call_usage`,
        `select admin_llm_usage(10)`,
      ]) {
        await expect(db.run(role, user, sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
      }
    }
  });

  it.each([
    [`update public.reading_free_runs set status = 'completed'`],
    [`insert into public.reading_free_runs (reading_id, user_id) values (gen_random_uuid(), gen_random_uuid())`],
    [`delete from public.reading_free_runs`],
    [`insert into public.reading_sections (reading_id, section_id, user_id, tier, content) values (gen_random_uuid(), 'ch2', gen_random_uuid(), 'free', '{}')`],
    [`update public.reading_sections set tier = 'free'`],
    [`delete from public.reading_sections`],
    [`update public.reading_units set status = 'done'`],
    [`insert into public.llm_calls (call_key, step, outcome, started_at, ended_at, usage_received) values ('x', 'pass1', 'usage', now(), now(), true)`],
    [`update public.generation_jobs set reference_date = '2026-01-01'`],
    [`update public.readings set situation_detail = '{}'`],
  ])("브라우저 권한으로 직접 바꿀 수 없다: %s", async (sql) => {
    const user = await member();
    await expect(asUser(user, sql)).rejects.toThrow(/permission denied/);
  });

  it.each([
    [`select claim_free_run(gen_random_uuid(), gen_random_uuid(), false, 'm', 'p', 's', 'low', 1, 1, 1)`],
    [`select release_free_run(gen_random_uuid(), 1)`],
    [`select complete_free_run(gen_random_uuid(), 1)`],
    [`select fail_free_run(gen_random_uuid(), 1, 'x', true)`],
    [`select lock_unit_writer(gen_random_uuid(), 'free', 1)`],
    [`select save_unit_draft(gen_random_uuid(), 'free', 1, 'ch1', '{}'::jsonb, '{}'::jsonb)`],
    [`select save_unit_final(gen_random_uuid(), 'free', 1, 'ch1', '{}'::jsonb, '{}'::jsonb)`],
    [`select fail_unit(gen_random_uuid(), 'free', 1, 'ch1', 'draft', 'x', true)`],
    [`select fix_reference_date(gen_random_uuid(), '2026-11-12')`],
    [`select release_generation(gen_random_uuid(), 1)`],
    [`select record_llm_call('{}'::jsonb)`],
    [`select admin_llm_usage(10)`],
    [`select create_reading(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, 1)`],
  ])("서버 전용 함수를 호출할 수 없다: %s", async (sql) => {
    const user = await member();
    await expect(asUser(user, sql)).rejects.toThrow(/permission denied/);
    await expect(db.run("anon", null, sql)).rejects.toThrow(/permission denied/);
  });
});

describe("무료 이용권과 무진", () => {
  it("무료 단계 점유 행이 있는 무진 풀이에도 이용권을 쓸 수 있고 (reading_closed 아님), 결제 주문도 막히지 않는다", async () => {
    const user = await member();
    const { ticket } = await grant(user);
    const readingId = await createReading(user);
    await claimFree(user, readingId);
    expect(await redeem(user, readingId)).toMatchObject({ outcome: "redeemed", readingId });
    const [entitlement] = await svc<{ source: string; ticket_id: string }>(`select source, ticket_id from public.entitlements where reading_id = $1`, [readingId]);
    expect(entitlement).toEqual({ source: "free_ticket", ticket_id: ticket!.id });
    const [job] = await svc<{ status: string; ticket_id: string }>(`select status, ticket_id from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(job).toEqual({ status: "queued", ticket_id: ticket!.id });
    // 무료 단계 점유는 그대로 이어진다.
    expect(await claimFree(user, readingId)).toMatchObject({ claimed: false, reason: "running" });

    // 결제 모드에서도 무료 단계 행 때문에 주문이 막히지 않는다.
    const payer = await member();
    const payerReading = await createReading(payer);
    await claimFree(payer, payerReading);
    const [order] = await svc<{ status: string; amount: number }>(
      `select (o).status, (o).amount from (select create_order($1, $2, 'mujin-overview', '1.0.0', 990, 'KRW', 'toss', '{}'::jsonb) as o) x`,
      [payer, payerReading],
    );
    expect(order).toEqual({ status: "pending", amount: 990 });
  });

  it("한 장을 무진에 쓰면 묘묘 풀이에는 쓸 수 없고, 반환하기 전에는 다시 쓸 수 없으며, 추가로 지급하지 않는다", async () => {
    const user = await member();
    const { ticket } = await grant(user);
    const mujin = await createReading(user);
    const myomyo = await createReading(user, MYOMYO_READING);
    expect((await redeem(user, mujin)).outcome).toBe("redeemed");
    expect(await redeem(user, myomyo, "first-overview", "3.2.1")).toEqual({ outcome: "ticket_used", readingId: mujin });
    expect(await redeem(user, await createReading(user))).toEqual({ outcome: "ticket_used", readingId: mujin });
    // 같은 캠페인으로 다시 지급하지 않는다.
    expect((await grant(user)).outcome).toBe("exists");
    expect(await count(`select count(*)::int as n from public.free_tickets where user_id = $1`, [user])).toBe(1);
    // 무진 풀이를 묘묘 상품으로 쓰지 못한다.
    await expect(redeem(user, mujin, "first-overview", "3.2.1")).rejects.toThrow(/product_mismatch/);
    expect(await count(`select count(*)::int as n from public.entitlements where user_id = $1`, [user])).toBe(1);

    // 복구할 수 없는 실패로 반환한 뒤에는 같은 한 장을 묘묘에 쓸 수 있다.
    expect((await restore(ticket!.id)).outcome).toBe("restored");
    expect(await redeem(user, myomyo, "first-overview", "3.2.1")).toMatchObject({ outcome: "redeemed", readingId: myomyo });
    const [row] = await svc<{ status: string; reading_id: string }>(`select status, reading_id from public.free_tickets where user_id = $1`, [user]);
    expect(row).toEqual({ status: "redeemed", reading_id: myomyo });
  });

  it("유료 생성은 시도 상한을 크게 주고, 시간 예산을 다 쓴 실행자가 반납하면 다음 요청이 바로 이어받는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    await redeem(user, readingId);
    expect(await claimPaid(user, readingId)).toMatchObject({ claimed: true, job: { attempts: 1 } });
    expect(await claimPaid(user, readingId)).toMatchObject({ claimed: false, reason: "running" });
    expect(await releasePaid(readingId, 1)).toBe(true);
    expect(await releasePaid(readingId, 1)).toBe(false);
    const [job] = await svc<{ status: string; lease_until: string | null }>(`select status, lease_until from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(job).toEqual({ status: "queued", lease_until: null });

    // 기본 상한(4)보다 많이 이어받아도 된다. 이전 시도 번호로는 반납하지 못한다.
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      expect(await claimPaid(user, readingId, false)).toMatchObject({ claimed: true, job: { attempts: attempt, model_id: "gpt-5.6-luna" } });
      expect(await releasePaid(readingId, attempt - 1)).toBe(false);
      expect(await releasePaid(readingId, attempt)).toBe(true);
    }
    const last = await claimPaid(user, readingId);
    expect(last.job.attempts).toBe(7);
    // 끝난 작업은 반납하지 않는다.
    expect(await completePaid(readingId, last.job.attempts)).toBe(true);
    expect(await releasePaid(readingId, last.job.attempts)).toBe(false);
  });

  it("유료 장을 저장한 뒤 기존 완료 함수(메시지 없음)로 작업과 이용권을 함께 완료하고, 완료 뒤에는 장을 저장하지 않는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    await redeem(user, readingId);
    const { job } = await claimPaid(user, readingId);
    expect(await saveDraft(readingId, "paid", job.attempts, "ch2")).toBe(true);
    expect(await saveFinal(readingId, "paid", job.attempts, "ch2")).toBe(true);
    expect(await completePaid(readingId, job.attempts)).toBe(true);
    const [ticket] = await svc<{ status: string }>(`select status from public.free_tickets where user_id = $1`, [user]);
    expect(ticket!.status).toBe("completed");
    expect(await count(`select count(*)::int as n from public.reading_messages where reading_id = $1`, [readingId])).toBe(0);
    expect(await saveFinal(readingId, "paid", job.attempts, "ch3")).toBe(false);
    expect(await asUser(user, `select section_id from public.reading_sections where reading_id = $1`, [readingId])).toEqual([{ section_id: "ch2" }]);
  });

  it("기준일은 처음 고정한 날짜를 유지하고, 작업이 없거나 반환으로 닫힌 풀이는 null이다", async () => {
    const user = await member();
    const { ticket } = await grant(user);
    const readingId = await createReading(user);
    expect(await fixDate(readingId, "2026-11-12")).toBeNull();
    await redeem(user, readingId);
    const { job } = await claimPaid(user, readingId);
    expect(await fixDate(readingId, "2026-11-12")).toBe("2026-11-12");
    expect(await fixDate(readingId, "2026-12-01")).toBe("2026-11-12");
    // 재시도(이어받기)에서도 같은 날짜다.
    await releasePaid(readingId, job.attempts);
    await claimPaid(user, readingId);
    expect(await fixDate(readingId, "2027-01-01")).toBe("2026-11-12");
    const [row] = await svc<{ reference_date: string }>(`select reference_date::text as reference_date from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(row!.reference_date).toBe("2026-11-12");

    // 반환으로 닫힌 작업은 기준일을 돌려주지 않는다.
    await svc(`update public.generation_jobs set status = 'failed', lease_until = null where reading_id = $1`, [readingId]);
    expect((await restore(ticket!.id)).outcome).toBe("restored");
    expect(await fixDate(readingId, "2026-11-12")).toBeNull();
  });
});

describe("호출 단위 토큰 기록 (llm_calls)", () => {
  type UsageRow = {
    tier: string | null;
    step: string;
    calls: number;
    calls_with_usage: number;
    calls_without_usage: number;
    input_tokens: unknown;
    cached_input_tokens: unknown;
    uncached_input_tokens: unknown;
    output_tokens: unknown;
    reasoning_tokens: unknown;
    total_tokens: unknown;
    usage_complete: boolean;
    models: string[] | null;
    prompt_versions: string[] | null;
  };
  const usageRows = async (readingId: string) =>
    (await svc<UsageRow>(`select * from public.llm_call_usage where reading_id = $1 order by tier, step`, [readingId])).map((row) => ({
      tier: row.tier,
      step: row.step,
      calls: row.calls,
      withUsage: row.calls_with_usage,
      withoutUsage: row.calls_without_usage,
      tokens: [row.input_tokens, row.cached_input_tokens, row.uncached_input_tokens, row.output_tokens, row.reasoning_tokens, row.total_tokens].map(num),
      complete: row.usage_complete,
      models: row.models,
      promptVersions: row.prompt_versions,
    }));

  it("같은 호출 키를 다시 보내면 처음 기록을 두고, 재시도는 새 키라 이전 기록을 덮지 않는다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const first = call({ readingId, userId: user });
    expect(await record(first)).toBe(true);
    expect(await record({ ...first, inputTokens: 9999, outcome: "unknown", usageReceived: false })).toBe(false);
    const rows = await svc<{ input_tokens: number; outcome: string; usage_received: boolean }>(
      `select input_tokens, outcome, usage_received from public.llm_calls where call_key = $1`,
      [first.callKey],
    );
    expect(rows).toEqual([{ input_tokens: 1000, outcome: "usage", usage_received: true }]);
    // 같은 장의 재시도는 새 호출 키로 따로 남는다.
    expect(await record(call({ readingId, userId: user, inputTokens: 500, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 20 }))).toBe(true);
    expect(await count(`select count(*)::int as n from public.llm_calls where reading_id = $1`, [readingId])).toBe(2);
    expect((await usageRows(readingId))[0]).toMatchObject({ calls: 2, tokens: [1500, 600, 900, 300, 70, 1800], complete: true });
  });

  it("캐시 입력이 입력보다 크거나, 추론이 출력보다 크거나, 음수이거나, 정해진 값이 아니면 거부한다", async () => {
    await expect(record(call({ inputTokens: 100, cachedInputTokens: 101 }))).rejects.toThrow(/llm_calls_cached_subset/);
    await expect(record(call({ outputTokens: 10, reasoningTokens: 11 }))).rejects.toThrow(/llm_calls_reasoning_subset/);
    await expect(record(call({ inputTokens: -1, cachedInputTokens: null }))).rejects.toThrow(/llm_calls_tokens_check/);
    await expect(record(call({ step: "pass3" }))).rejects.toThrow(/llm_calls_step_check/);
    await expect(record(call({ outcome: "ok" }))).rejects.toThrow(/llm_calls_outcome_check/);
    await expect(record(call({ tier: "trial" }))).rejects.toThrow(/llm_calls_tier_check/);
    await expect(record(call({ startedAt: null }))).rejects.toThrow(/started_at/);
    // 한쪽 값을 모르면 비교할 수 없으므로 받는다.
    expect(await record(call({ inputTokens: null, cachedInputTokens: 50 }))).toBe(true);
  });

  it("받지 못한 값(null)과 실제 0을 구분하고, usageReceived가 없으면 결과 종류로 정한다", async () => {
    const zero = call({ cachedInputTokens: 0, reasoningTokens: 0 });
    const missing = call({ cachedInputTokens: null, reasoningTokens: null });
    const unknown = call({ outcome: "unknown", ...NO_USAGE, usageReceived: undefined });
    for (const entry of [zero, missing, unknown]) expect(await record(entry)).toBe(true);
    const rows = await svc<{ call_key: string; cached_input_tokens: number | null; reasoning_tokens: number | null; usage_received: boolean }>(
      `select call_key, cached_input_tokens, reasoning_tokens, usage_received from public.llm_calls where call_key = any($1::text[])`,
      [[zero.callKey, missing.callKey, unknown.callKey]],
    );
    const byKey = new Map(rows.map((row) => [row.call_key, row]));
    expect(byKey.get(zero.callKey as string)).toMatchObject({ cached_input_tokens: 0, reasoning_tokens: 0, usage_received: true });
    expect(byKey.get(missing.callKey as string)).toMatchObject({ cached_input_tokens: null, reasoning_tokens: null, usage_received: true });
    expect(byKey.get(unknown.callKey as string)).toMatchObject({ cached_input_tokens: null, usage_received: false });
  });

  it("단계별 합계는 받은 값만 더하고, 사용량을 받지 못한 호출이 있거나 캐시 값이 빠지면 불완전으로 표시한다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const base = { readingId, userId: user };
    await record(call({ ...base, step: "classify", unitId: null, promptVersion: "mujin-question-1.0.0", inputTokens: 300, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 10 }));
    await record(call({ ...base, step: "pass1", unitId: "free-basics" }));
    // 중간에 끊은 스트림: 토큰이 쓰였을 수 있지만 값은 모른다.
    await record(call({ ...base, step: "pass1", unitId: "free-basics", outcome: "unknown", errorCode: "timeout", ...NO_USAGE }));
    // 사용량은 받았지만 캐시 값이 빠졌다.
    await record(call({ ...base, step: "pass2", unitId: "ch1", promptVersion: "mujin-pass2-1.0.0", inputTokens: 800, outputTokens: 300, cachedInputTokens: null, reasoningTokens: 30 }));
    // 오류 응답으로 생성하지 않은 호출.
    await record(call({ ...base, tier: "paid", step: "pass1", unitId: "paid-work", outcome: "rejected", errorCode: "server_error", modelActual: null, ...NO_USAGE }));

    expect(await usageRows(readingId)).toEqual([
      {
        tier: "free",
        step: "classify",
        calls: 1,
        withUsage: 1,
        withoutUsage: 0,
        tokens: [300, 0, 300, 40, 10, 340],
        complete: true,
        models: ["gpt-5.6-luna-2026-11-01"],
        promptVersions: ["mujin-question-1.0.0"],
      },
      {
        tier: "free",
        step: "pass1",
        calls: 2,
        withUsage: 1,
        withoutUsage: 1,
        tokens: [1000, 600, 400, 200, 50, 1200],
        complete: false,
        models: ["gpt-5.6-luna-2026-11-01"],
        promptVersions: ["mujin-pass1-1.0.0"],
      },
      {
        tier: "free",
        step: "pass2",
        calls: 1,
        withUsage: 1,
        withoutUsage: 0,
        tokens: [800, null, null, 300, 30, 1100],
        complete: false,
        models: ["gpt-5.6-luna-2026-11-01"],
        promptVersions: ["mujin-pass2-1.0.0"],
      },
      // 받은 값이 하나도 없으면 null이다 (0으로 채우지 않는다). 사용량을 모르는 호출은 없으므로 불완전은 아니다.
      {
        tier: "paid",
        step: "pass1",
        calls: 1,
        withUsage: 0,
        withoutUsage: 0,
        tokens: [null, null, null, null, null, null],
        complete: true,
        models: ["gpt-5.6-luna"],
        promptVersions: ["mujin-pass1-1.0.0"],
      },
    ]);
  });

  it("관리자 조회는 최근 호출 순으로 풀이별 단계 합계와 전체 합계를 돌려주고 원문을 담지 않는다", async () => {
    const user = await member();
    const older = await createReading(user);
    const newer = await createReading(user);
    // 다른 테스트의 호출(2026년)보다 뒤 시각이라 목록 맨 앞에 온다.
    const at = (year: number, second: number) => new Date(Date.UTC(year, 0, 1, 0, 0, second)).toISOString();
    await record(call({ readingId: older, userId: user, startedAt: at(2029, 0), endedAt: at(2029, 5) }));
    await record(call({ readingId: newer, userId: user, step: "classify", unitId: null, startedAt: at(2030, 0), endedAt: at(2030, 2), inputTokens: 300, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 10 }));
    await record(call({ readingId: newer, userId: user, startedAt: at(2030, 3), endedAt: at(2030, 9) }));
    await record(call({ readingId: newer, userId: user, tier: "paid", step: "pass2", unitId: "ch2", outcome: "unknown", ...NO_USAGE, startedAt: at(2030, 10), endedAt: at(2030, 20) }));
    // 생성 문장이 저장된 풀이여도 조회 결과에는 담기지 않는다.
    await db.pg.query(`insert into public.reading_sections (reading_id, section_id, user_id, tier, content) values ($1, 'ch1', $2, 'free', $3)`, [
      newer,
      user,
      JSON.stringify(contentOf("ch1", "가상 완성문 원문")),
    ]);

    type Totals = Record<string, unknown>;
    type Entry = { readingId: string; userId: string; productId: string; productVersion: string; personaId: string; createdAt: string; firstCallAt: string; lastCallAt: string; steps: Totals[]; total: Totals };
    const result = await one<{ limit: number; readings: Entry[]; total: Totals }>(`select admin_llm_usage(10) as r`);
    expect(result.limit).toBe(10);
    expect(result.readings.slice(0, 2).map((entry) => entry.readingId)).toEqual([newer, older]);
    const entry = result.readings[0]!;
    expect(entry).toMatchObject({ userId: user, productId: "mujin-overview", productVersion: "1.0.0", personaId: "mujin" });
    expect(typeof entry.createdAt).toBe("string");
    expect(new Date(entry.firstCallAt).toISOString()).toBe(at(2030, 0));
    expect(new Date(entry.lastCallAt).toISOString()).toBe(at(2030, 20));
    // 단계 순서: 무료(분류 → Pass 1) → 유료.
    expect(entry.steps.map((step) => [step.tier, step.step])).toEqual([
      ["free", "classify"],
      ["free", "pass1"],
      ["paid", "pass2"],
    ]);
    expect(entry.steps[1]).toMatchObject({
      calls: 1,
      callsWithUsage: 1,
      callsWithoutUsage: 0,
      inputTokens: 1000,
      cachedInputTokens: 600,
      uncachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1200,
      usageComplete: true,
      models: ["gpt-5.6-luna-2026-11-01"],
      promptVersions: ["mujin-pass1-1.0.0"],
    });
    expect(entry.steps[2]).toMatchObject({ calls: 1, callsWithoutUsage: 1, inputTokens: null, usageComplete: false });
    expect(entry.total).toMatchObject({
      calls: 3,
      callsWithUsage: 2,
      callsWithoutUsage: 1,
      inputTokens: 1300,
      cachedInputTokens: 600,
      uncachedInputTokens: 700,
      outputTokens: 240,
      reasoningTokens: 60,
      totalTokens: 1540,
      usageComplete: false,
    });

    // 한 건만 보면 전체 합계는 그 풀이의 합계와 같다.
    const latest = await one<{ limit: number; readings: Entry[]; total: Totals }>(`select admin_llm_usage(1) as r`);
    expect(latest.readings.map((item) => item.readingId)).toEqual([newer]);
    expect(latest.total).toEqual(latest.readings[0]!.total);
    // 개수는 1~200으로 맞춘다.
    expect((await one<{ limit: number }>(`select admin_llm_usage(0) as r`)).limit).toBe(1);
    expect((await one<{ limit: number }>(`select admin_llm_usage(null) as r`)).limit).toBe(20);

    // 별명, 궁금한 점 원문, 생성 문장은 담지 않는다.
    const text = JSON.stringify(result);
    for (const secret of [MUJIN_READING.nickname, MUJIN_READING.concern, "가상 완성문 원문"]) expect(text).not.toContain(secret);
  });
});

describe("삭제 연쇄", () => {
  it("풀이 기록이나 회원이 지워지면 무진 진행 기록·최종문·호출 기록도 함께 지워진다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const { run } = await claimFree(user, readingId);
    await saveDraft(readingId, "free", run!.attempts, "ch1");
    await saveFinal(readingId, "free", run!.attempts, "ch1");
    await saveDraft(readingId, "free", run!.attempts, "ch1-extra");
    await record(call({ readingId, userId: user }));
    // 풀이와 연결되지 않은 호출(회원만 있음)
    await record(call({ userId: user, step: "classify", unitId: null }));
    const left = async () =>
      Promise.all(
        ["reading_free_runs", "reading_units", "reading_sections"].map((table) =>
          count(`select count(*)::int as n from public.${table} where reading_id = $1`, [readingId]),
        ),
      );
    expect(await left()).toEqual([1, 2, 1]);
    await db.pg.query(`delete from public.readings where id = $1`, [readingId]);
    expect(await left()).toEqual([0, 0, 0]);
    expect(await count(`select count(*)::int as n from public.llm_calls where reading_id = $1`, [readingId])).toBe(0);
    expect(await count(`select count(*)::int as n from public.llm_calls where user_id = $1`, [user])).toBe(1);
    await db.pg.query(`delete from auth.users where id = $1`, [user]);
    expect(await count(`select count(*)::int as n from public.llm_calls where user_id = $1`, [user])).toBe(0);
  });
});

describe("무진 기간 재료 저장 (reading_analyses 재사용, 제약 변경 없음)", () => {
  it("kind 'timing'과 'mujin:' 접두 키로 저장하고, 같은 키는 처음 값을 돌려주며, 기존 크기·종류 제약은 그대로다", async () => {
    const user = await member();
    const readingId = await createReading(user);
    const save = (key: string, kind: string, payload: unknown) =>
      one<unknown>(`select save_reading_analysis($1, $2, $3, 'mujin-timing-1.0.0', $4) as r`, [readingId, key, kind, JSON.stringify(payload)]);

    const key = "mujin:timing@2026-11-12";
    expect(await save(key, "timing", { referenceDate: "2026-11-12", v: 1 })).toEqual({ referenceDate: "2026-11-12", v: 1 });
    expect(await save(key, "timing", { referenceDate: "2026-11-12", v: 2 })).toEqual({ referenceDate: "2026-11-12", v: 1 });

    // 12개월 × 4분야 표지와 근거 ID 정도의 재료는 들어간다 (256KB 미만).
    const months = Array.from({ length: 12 }, (_, month) => ({
      periodId: `monthly:2026-${String(month + 1).padStart(2, "0")}`,
      cells: Array.from({ length: 4 }, (_, domain) => ({
        domain,
        markers: Array.from({ length: 4 }, (_, marker) => ({
          text: `가상 표지 설명 ${month}-${domain}-${marker} `.repeat(6),
          evidence: [`evidence:${month}:${domain}:${marker}`],
        })),
      })),
    }));
    expect(await save("mujin:timing@2026-11-13", "timing", { months })).toMatchObject({ months: expect.any(Array) });

    // 키 길이(120자), 종류(question, timing), 내용 크기(256KB 미만)는 기존 제약 그대로다.
    await expect(save(`mujin:${"x".repeat(115)}`, "timing", {})).rejects.toThrow(/reading_analyses_key_length/);
    await expect(save("mujin:luck@2026-11-12", "mujin-timing", {})).rejects.toThrow(/reading_analyses_kind_check/);
    const huge = { blob: Array.from({ length: 15000 }, (_, index) => `가상 자료 ${index} ${(index * 7919) % 104729}`) };
    await expect(save("mujin:timing@2026-11-14", "timing", huge)).rejects.toThrow(/reading_analyses_payload_size/);
  });
});
