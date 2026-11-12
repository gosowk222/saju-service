import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGeneration } from "@/server/readings/generate";
import { createTestDb, type DbRole, type TestDb } from "../support/test-db";

/**
 * 묘묘 생성 API(POST /api/readings/{id}/generate → runGeneration)는 메신저 상품만 쓴다. 족자 상품(무진) 풀이를 넘기면
 * 생성 작업(generation_jobs)을 점유하기 전에 409 unsupported_product로 거부해, 무진 유료 작업의 시도 수·프롬프트 버전이
 * 묘묘 값으로 바뀌지 않게 한다. 실제 migration을 적용한 PGlite에 서버 권한 클라이언트를 흉내 내어 연결한다.
 * 모델은 부르지 않는다 (거부는 claim 전이고, API 키도 비워 둔다). 입력은 모두 가상 값이다.
 */

const clients = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => clients.admin,
  createSupabaseServerClient: async () => {
    throw new Error("server client is not used in this test");
  },
}));

/** PostgREST처럼 동작하는 최소 클라이언트 (tests/unit/mujin-db-flow.test.ts와 같은 변환: eq·maybeSingle 조회와 RPC). */
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
    const clauses: string[] = [];
    const params: unknown[] = [];
    const execute = async () => {
      try {
        const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
        const rows = json(await db.run(role, userId, `select ${columns === "*" ? "t.*" : columns} from public.${table} t${where}`, params));
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
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db.run<T>("service_role", null, text, params);

const READING = {
  product_version: "1.0.0",
  nickname: "가상별명",
  birth_input: {},
  place_snapshot: {},
  chart: {},
  preview: {},
  ruleset_version: "1.0.0",
  engine_meta: {},
  concern: "가상 질문",
};
const MUJIN = { ...READING, product_id: "mujin-overview", persona_id: "mujin", persona_version: "1.0.0", ruleset_id: "mujin-overview" };
const MYOMYO = { ...READING, product_id: "first-overview", persona_id: "myomyo", persona_version: "2.1.0", ruleset_id: "first-overview", ruleset_version: "3.1.0" };

async function member(): Promise<string> {
  const id = randomUUID();
  await db.addUser(id);
  return id;
}

async function createReading(user: string, reading: Record<string, unknown>, planVersion: string): Promise<string> {
  const [row] = await sql<{ r: string }>(`select create_reading($1, $2, $3, 1000) as r`, [user, JSON.stringify(reading), JSON.stringify({ plan: { planVersion }, trace: [] })]);
  return row!.r;
}

async function redeem(user: string, readingId: string): Promise<void> {
  await sql(`select grant_free_ticket($1, 'free-trial-2026-11')`, [user]);
  const [row] = await sql<{ r: { outcome: string } }>(`select redeem_free_ticket($1, $2, $3, 'mujin-overview', '1.0.0', 3, '{}'::jsonb) as r`, [user, readingId, randomUUID()]);
  expect(row?.r.outcome).toBe("redeemed");
}

const jobOf = async (readingId: string) =>
  (
    await sql<{ status: string; attempts: number; prompt_version: string | null; model_id: string | null; error_code: string | null; lease_until: string | null }>(
      `select status, attempts, prompt_version, model_id, error_code, lease_until from public.generation_jobs where reading_id = $1`,
      [readingId],
    )
  )[0];
const attemptsOf = async (readingId: string) =>
  (await sql<{ n: number }>(`select count(*)::int as n from public.generation_attempts where reading_id = $1`, [readingId]))[0]!.n;

beforeAll(async () => {
  // 혹시라도 모델 호출 경로에 닿으면 요청을 보내기 전에 설정 오류가 나게 API 키를 비운다.
  vi.stubEnv("OPENAI_API_KEY", "");
  db = await createTestDb();
  clients.admin = pgClient(db, "service_role", null);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.close();
});

describe("묘묘 생성 API는 족자 상품 풀이를 claim 전에 거부한다 (runGeneration)", () => {
  it("이용권을 쓴 무진 풀이(유료 작업이 아직 시작 전): 409 unsupported_product, 작업 상태·시도 수·프롬프트 버전 그대로, 사용량 기록 없음", async () => {
    const user = await member();
    const readingId = await createReading(user, MUJIN, "mujin-plan-1.0.0");
    await redeem(user, readingId);
    const before = await jobOf(readingId);
    expect(before).toMatchObject({ status: "queued", attempts: 0, prompt_version: null });

    await expect(runGeneration(user, readingId, false)).rejects.toMatchObject({ status: 409, code: "unsupported_product" });
    await expect(runGeneration(user, readingId, true)).rejects.toMatchObject({ status: 409, code: "unsupported_product" });
    expect(await jobOf(readingId)).toEqual(before);
    expect(await attemptsOf(readingId)).toBe(0);
  });

  it("무진 유료 생성 도중(반납되어 queued, 시도 수가 많음)에도 작업을 바꾸지 않는다", async () => {
    const user = await member();
    const readingId = await createReading(user, MUJIN, "mujin-plan-1.0.0");
    await redeem(user, readingId);
    await sql(`update public.generation_jobs set attempts = 5, prompt_version = 'mujin-1.0.0', model_id = 'fake-model' where reading_id = $1`, [readingId]);
    const before = await jobOf(readingId);

    await expect(runGeneration(user, readingId, false)).rejects.toMatchObject({ status: 409, code: "unsupported_product" });
    expect(await jobOf(readingId)).toEqual(before);
    expect(before).toMatchObject({ status: "queued", attempts: 5, prompt_version: "mujin-1.0.0", error_code: null });
    expect(await attemptsOf(readingId)).toBe(0);
  });

  it("묘묘 풀이는 그대로 claim_generation까지 간다 (권한이 없으면 지금처럼 403 not_entitled)", async () => {
    const user = await member();
    const readingId = await createReading(user, MYOMYO, "3.0.0");
    await expect(runGeneration(user, readingId, false)).rejects.toMatchObject({ status: 403, code: "not_entitled" });
    expect(await jobOf(readingId)).toBeUndefined();
  });

  it("다른 회원의 풀이는 지금처럼 403 not_entitled다 (상품을 알려 주지 않는다)", async () => {
    const owner = await member();
    const other = await member();
    const readingId = await createReading(owner, MUJIN, "mujin-plan-1.0.0");
    await expect(runGeneration(other, readingId, false)).rejects.toMatchObject({ status: 403, code: "not_entitled" });
  });
});
