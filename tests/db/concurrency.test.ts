import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADD_USER_SQL, BOOTSTRAP, migrationSql } from "../support/test-db";

/**
 * 실제 Postgres에서 동시 요청을 확인한다. PGlite는 연결이 하나라 진짜 병렬 실행을 만들 수 없다.
 *
 *   TEST_PG_URL=postgres://postgres:비밀번호@127.0.0.1:5432/postgres npm run test:db-concurrency
 *
 * 로컬 Postgres(운영과 같은 17버전 권장)의 슈퍼유저 연결이 필요하다. 임시 데이터베이스를 만들고 끝나면 지운다.
 * Supabase 같은 원격 데이터베이스에는 연결하지 않는다 (아래에서 거부).
 *
 * 경쟁 상황은 advisory lock으로 만든다. 모든 작업 연결이 같은 잠금 앞에서 기다리게 한 뒤 한꺼번에 풀어,
 * 각 요청이 실제로 같은 순간에 서버 함수를 실행하게 한다.
 */
const BASE_URL = process.env.TEST_PG_URL;
const CAMPAIGN = "free-trial-2026-11";
const META = JSON.stringify({ actualModel: "m", usage: {}, durationMs: 1, llmCalls: 1, issueCount: 0 });
const MESSAGES = JSON.stringify([{ seq: 1, topicId: null, kind: "transition", text: "안녕", refs: [] }]);

let admin: pg.Client;
let pool: pg.Pool;
let dbName = "";
let lockKey = 1000;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const result = await client.query(sql, params);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 작업들을 같은 순간에 실행한다. 각 작업은 자기 연결과 트랜잭션에서 공유 잠금을 기다리다가,
 * 모두 기다리는 것을 확인한 뒤 주 연결이 독점 잠금을 풀면 동시에 출발한다.
 */
async function race<T>(jobs: readonly { sql: string; params: unknown[] }[]): Promise<Settled<T>[]> {
  const key = lockKey++;
  const gate = await pool.connect();
  await gate.query("select pg_advisory_lock($1)", [key]);
  const runs = jobs.map(async ({ sql, params }): Promise<Settled<T>> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock_shared($1)", [key]);
      await client.query("set local role service_role");
      const result = await client.query(sql, params);
      await client.query("commit");
      return { ok: true, value: (result.rows[0] as { r: T }).r };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      client.release();
    }
  });
  try {
    for (let waited = 0; ; waited += 20) {
      const { rows } = await gate.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted",
        [key],
      );
      if (rows[0]!.n >= jobs.length) break;
      if (waited > 20_000) throw new Error("작업 연결이 잠금 앞에 모이지 않았습니다");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await gate.query("select pg_advisory_unlock($1)", [key]);
    gate.release();
  }
  return Promise.all(runs);
}

async function member(providers: readonly string[] = ["kakao"]): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query(ADD_USER_SQL, [id, null, providers]);
  } finally {
    client.release();
  }
  return id;
}

async function createReading(user: string): Promise<string> {
  const reading = {
    product_id: "first-overview",
    product_version: "3.2.1",
    nickname: "달빛",
    birth_input: {},
    place_snapshot: {},
    chart: {},
    preview: {},
    persona_id: "myomyo",
    persona_version: "1.0.0",
    ruleset_id: "first-overview",
    ruleset_version: "3.2.0",
    engine_meta: {},
  };
  const [row] = await svc<{ id: string }>(`select create_reading($1, $2, $3, 1000) as id`, [
    user,
    JSON.stringify(reading),
    JSON.stringify({ plan: {}, trace: [] }),
  ]);
  return row!.id;
}

const grantSql = (user: string) => ({ sql: `select grant_free_ticket($1, $2) as r`, params: [user, CAMPAIGN] });
const redeemSql = (user: string, readingId: string, requestId: string) => ({
  sql: `select redeem_free_ticket($1, $2, $3, 'first-overview', '3.2.1', 3, '{}'::jsonb) as r`,
  params: [user, readingId, requestId],
});
const adminGrantSql = (adminId: string, user: string, requestId: string) => ({
  sql: `select admin_grant_free_ticket($1, $2, $3) as r`,
  params: [adminId, user, requestId],
});

async function adminMember() {
  const id = await member();
  await svc(`select set_user_role($1, 'admin')`, [id]);
  return id;
}
const claimSql = (user: string, readingId: string) => ({
  sql: `select claim_generation($1, $2, true, 'gpt-5.6-luna', 'reading-2.5.0', 'narration-2.1.0', 'low', 300, 4) as r`,
  params: [user, readingId],
});
const completeSql = (readingId: string, attempt: number) => ({
  sql: `select complete_generation($1, $2, $3, $4) as r`,
  params: [readingId, attempt, MESSAGES, META],
});
const restoreSql = (ticketId: string) => ({ sql: `select restore_free_ticket($1, '복구 불가 실패') as r`, params: [ticketId] });

const count = async (sql: string, params: unknown[]) => (await svc<{ n: number }>(sql, params))[0]!.n;

async function redeemedAndRunning() {
  const user = await member();
  const [{ r }] = await svc<{ r: { ticket: { id: string } } }>(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN]);
  const readingId = await createReading(user);
  await svc(redeemSql(user, readingId, randomUUID()).sql, redeemSql(user, readingId, randomUUID()).params);
  const [{ r: claim }] = await svc<{ r: { job: { attempts: number } } }>(claimSql(user, readingId).sql, claimSql(user, readingId).params);
  return { user, readingId, ticketId: r.ticket.id, attempt: claim.job.attempts };
}

/** 무진 풀이 기록 (가상 값). 상품·캐릭터·규칙 ID와 '지금의 나'만 묘묘 풀이와 다르다. */
async function createMujinReading(user: string): Promise<string> {
  const reading = {
    product_id: "mujin-overview",
    product_version: "1.0.0",
    nickname: "달빛",
    birth_input: {},
    place_snapshot: {},
    chart: {},
    preview: {},
    persona_id: "mujin",
    persona_version: "1.0.0",
    ruleset_id: "mujin-overview",
    ruleset_version: "1.0.0",
    engine_meta: {},
    situation_detail: { now: { work: ["student"], interests: [], relationship: null, family: [] } },
  };
  const [row] = await svc<{ id: string }>(`select create_reading($1, $2, $3, 1000) as id`, [
    user,
    JSON.stringify(reading),
    JSON.stringify({ plan: {}, trace: [] }),
  ]);
  return row!.id;
}

const redeemProductSql = (user: string, readingId: string, productId: string, productVersion: string) => ({
  sql: `select redeem_free_ticket($1, $2, $3, $4, $5, 3, '{}'::jsonb) as r`,
  params: [user, readingId, randomUUID(), productId, productVersion],
});
const claimFreeSql = (user: string, readingId: string, dailyLimit = 100) => ({
  sql: `select claim_free_run($1, $2, false, 'gpt-5.6-luna', 'mujin-pass1-1.0.0', 'mujin-draft-1.0.0', 'medium', 300, 3, $3) as r`,
  params: [user, readingId, dailyLimit],
});
const saveDraftSql = (readingId: string, attempt: number, unitId: string) => ({
  sql: `select save_unit_draft($1, 'free', $2, $3, '{"coreAnswer":"가상 초안"}'::jsonb, '{}'::jsonb) as r`,
  params: [readingId, attempt, unitId],
});

async function mujinFreeRunning() {
  const user = await member();
  const readingId = await createMujinReading(user);
  const [{ r }] = await svc<{ r: { run: { attempts: number } } }>(claimFreeSql(user, readingId).sql, claimFreeSql(user, readingId).params);
  return { user, readingId, attempt: r.run.attempts };
}

describe.skipIf(!BASE_URL)("실제 Postgres 동시 요청", () => {
  beforeAll(async () => {
    const url = new URL(BASE_URL!);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new Error("동시성 테스트는 로컬 Postgres에서만 실행합니다.");
    }
    admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    const { rows } = await admin.query<{ su: string; version: string }>("select current_setting('is_superuser') as su, version() as version");
    if (rows[0]!.su !== "on") throw new Error("임시 데이터베이스와 역할을 만들 슈퍼유저 연결이 필요합니다.");
    console.info("[concurrency]", rows[0]!.version);

    dbName = `saju_concurrency_${Date.now()}`;
    await admin.query(`create database ${dbName}`);
    pool = new pg.Pool({ connectionString: databaseUrl(BASE_URL!, dbName), max: 30 });
    const setup = await pool.connect();
    try {
      await setup.query(BOOTSTRAP);
      for (const sql of migrationSql()) await setup.query(sql);
    } finally {
      setup.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    }
  });

  it("같은 회원에게 지급 요청 20건이 동시에 와도 한 장만 생긴다", async () => {
    const user = await member();
    const results = await race<{ outcome: string }>(Array.from({ length: 20 }, () => grantSql(user)));
    expect(results.every((result) => result.ok)).toBe(true);
    const outcomes = results.map((result) => (result.ok ? result.value.outcome : "error"));
    expect(outcomes.filter((outcome) => outcome === "granted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "exists")).toHaveLength(19);
    expect(await count(`select count(*)::int as n from public.free_tickets where user_id = $1`, [user])).toBe(1);
    expect(await count(`select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'granted'`, [user])).toBe(1);
  });

  it("로그인 지급과 기존 회원 일괄 지급이 동시에 실행돼도 회원당 한 장이다", async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => member()));
    const jobs = [
      ...users.flatMap((user) => [grantSql(user), grantSql(user)]),
      { sql: `select grant_free_tickets_to_kakao_members($1) as r`, params: [CAMPAIGN] },
      { sql: `select grant_free_tickets_to_kakao_members($1) as r`, params: [CAMPAIGN] },
    ];
    const results = await race(jobs);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    for (const user of users) {
      expect(await count(`select count(*)::int as n from public.free_tickets where user_id = $1`, [user])).toBe(1);
    }
  });

  it("서로 다른 요청 ID로 여러 풀이에 동시에 써도 한 건만 새로 쓰인다", async () => {
    const user = await member();
    await svc(grantSql(user).sql, grantSql(user).params);
    const readings = await Promise.all(Array.from({ length: 10 }, () => createReading(user)));
    const results = await race<{ outcome: string; readingId: string }>(readings.map((readingId) => redeemSql(user, readingId, randomUUID())));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const values = results.flatMap((result) => (result.ok ? [result.value] : []));
    const winners = values.filter((value) => value.outcome === "redeemed");
    expect(winners).toHaveLength(1);
    // 진 요청은 이용권이 이미 연결된 풀이를 돌려받는다.
    expect(values.filter((value) => value.outcome === "ticket_used").every((value) => value.readingId === winners[0]!.readingId)).toBe(true);
    expect(await count(`select count(*)::int as n from public.entitlements where user_id = $1`, [user])).toBe(1);
    expect(await count(`select count(*)::int as n from public.generation_jobs where user_id = $1`, [user])).toBe(1);
  });

  it("같은 요청이 10번 동시에 재전송돼도 한 번만 쓰인다", async () => {
    const user = await member();
    await svc(grantSql(user).sql, grantSql(user).params);
    const readingId = await createReading(user);
    const requestId = randomUUID();
    const results = await race<{ outcome: string }>(Array.from({ length: 10 }, () => redeemSql(user, readingId, requestId)));
    const outcomes = results.map((result) => (result.ok ? result.value.outcome : result.error));
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_redeemed")).toHaveLength(9);
    expect(await count(`select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'redeemed'`, [user])).toBe(1);
  });

  it("같은 풀이의 생성 시작이 동시에 와도 한 요청만 생성한다", async () => {
    const user = await member();
    await svc(grantSql(user).sql, grantSql(user).params);
    const readingId = await createReading(user);
    await svc(redeemSql(user, readingId, randomUUID()).sql, redeemSql(user, readingId, randomUUID()).params);
    const results = await race<{ claimed: boolean }>(Array.from({ length: 8 }, () => claimSql(user, readingId)));
    expect(results.filter((result) => result.ok && result.value.claimed)).toHaveLength(1);
  });

  it("같은 시도의 완료 저장이 동시에 와도 한 번만 반영되고 이용권도 한 번만 완료된다", async () => {
    const { user, readingId, attempt } = await redeemedAndRunning();
    const results = await race<boolean>(Array.from({ length: 5 }, () => completeSql(readingId, attempt)));
    expect(results.filter((result) => result.ok && result.value === true)).toHaveLength(1);
    expect(await count(`select count(*)::int as n from public.reading_messages where reading_id = $1`, [readingId])).toBe(1);
    expect(await count(`select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'completed'`, [user])).toBe(1);
  });

  it("반환 요청이 동시에 와도 한 번만 반환된다", async () => {
    const { user, readingId, ticketId } = await redeemedAndRunning();
    await svc(`update public.generation_jobs set status = 'failed', lease_until = null where reading_id = $1`, [readingId]);
    const results = await race<{ outcome: string }>(Array.from({ length: 5 }, () => restoreSql(ticketId)));
    const outcomes = results.map((result) => (result.ok ? result.value.outcome : result.error));
    expect(outcomes.filter((outcome) => outcome === "restored")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_available")).toHaveLength(4);
    const [ticket] = await svc<{ restore_count: number; status: string }>(`select restore_count, status from public.free_tickets where user_id = $1`, [user]);
    expect(ticket).toEqual({ restore_count: 1, status: "available" });
  });

  it("반환과 늦은 완료가 겹쳐도 둘 중 하나만 반영된다", async () => {
    for (let round = 0; round < 10; round += 1) {
      const { user, readingId, ticketId, attempt } = await redeemedAndRunning();
      // 점유 시간이 지난 작업 (서버가 멈춘 것처럼 보이지만 이전 요청이 아직 살아 있는 상황)
      await svc(`update public.generation_jobs set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);
      const [completed, restored] = await race<unknown>([completeSql(readingId, attempt), restoreSql(ticketId)]);
      const [job] = await svc<{ status: string }>(`select status from public.generation_jobs where reading_id = $1`, [readingId]);
      const [ticket] = await svc<{ status: string }>(`select status from public.free_tickets where user_id = $1`, [user]);
      const entitlements = await count(`select count(*)::int as n from public.entitlements where reading_id = $1`, [readingId]);
      if (job!.status === "completed") {
        expect(completed).toEqual({ ok: true, value: true });
        expect(restored.ok).toBe(false);
        expect(ticket!.status).toBe("completed");
        expect(entitlements).toBe(1);
      } else {
        expect(job!.status).toBe("cancelled");
        expect(completed).toEqual({ ok: true, value: false });
        expect(restored.ok).toBe(true);
        expect(ticket!.status).toBe("available");
        expect(entitlements).toBe(0);
      }
    }
  });

  it("결제 완료와 이용권 사용이 같은 풀이에 동시에 와도 권한은 하나이고, 진 쪽 이용권은 보존된다", async () => {
    for (let round = 0; round < 10; round += 1) {
      const user = await member();
      await svc(grantSql(user).sql, grantSql(user).params);
      const readingId = await createReading(user);
      const [order] = await svc<{ id: string }>(
        `select (o).id from (select create_order($1, $2, 'first-overview', '3.2.1', 990, 'KRW', 'toss', '{}'::jsonb) as o) x`,
        [user, readingId],
      );
      await race([
        { sql: `select mark_order_paid($1, $2, $3, 990, 'KRW', '카드', 3) as r`, params: [order!.id, user, `pk-${order!.id}`] },
        redeemSql(user, readingId, randomUUID()),
      ]);
      const [entitlement] = await svc<{ source: string }>(`select source from public.entitlements where reading_id = $1`, [readingId]);
      const [ticket] = await svc<{ status: string }>(`select status from public.free_tickets where user_id = $1`, [user]);
      const [orderRow] = await svc<{ status: string }>(`select status from public.orders where id = $1`, [order!.id]);
      expect(await count(`select count(*)::int as n from public.entitlements where reading_id = $1`, [readingId])).toBe(1);
      if (entitlement!.source === "payment") {
        expect(orderRow!.status).toBe("paid");
        expect(ticket!.status).toBe("available");
      } else {
        expect(orderRow!.status).toBe("cancelled");
        expect(ticket!.status).toBe("redeemed");
      }
    }
  });

  it("관리자 지급을 같은 요청으로 10번 동시에 보내면 한 장, 다른 요청 5번이면 다섯 장이다", async () => {
    const boss = await adminMember();
    const user = await member();
    const requestId = randomUUID();
    const same = await race<{ outcome: string }>(Array.from({ length: 10 }, () => adminGrantSql(boss, user, requestId)));
    const outcomes = same.map((result) => (result.ok ? result.value.outcome : result.error));
    expect(outcomes.filter((outcome) => outcome === "granted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "exists")).toHaveLength(9);
    await race(Array.from({ length: 5 }, () => adminGrantSql(boss, user, randomUUID())));
    expect(await count(`select count(*)::int as n from public.free_tickets where user_id = $1 and source = 'admin'`, [user])).toBe(6);
  });

  it("이용권이 세 장일 때 서로 다른 풀이 10건이 동시에 와도 정확히 세 건만 쓰인다", async () => {
    const boss = await adminMember();
    const user = await member();
    await svc(grantSql(user).sql, grantSql(user).params);
    await svc(adminGrantSql(boss, user, randomUUID()).sql, adminGrantSql(boss, user, randomUUID()).params);
    await svc(adminGrantSql(boss, user, randomUUID()).sql, adminGrantSql(boss, user, randomUUID()).params);
    const readings = await Promise.all(Array.from({ length: 10 }, () => createReading(user)));
    const results = await race<{ outcome: string }>(readings.map((readingId) => redeemSql(user, readingId, randomUUID())));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const outcomes = results.map((result) => (result.ok ? result.value.outcome : ""));
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome === "ticket_used")).toHaveLength(7);
    expect(await count(`select count(*)::int as n from public.free_tickets where user_id = $1 and status = 'redeemed'`, [user])).toBe(3);
    expect(await count(`select count(*)::int as n from public.entitlements where user_id = $1`, [user])).toBe(3);
    expect(await count(`select count(distinct reading_id)::int as n from public.free_tickets where user_id = $1`, [user])).toBe(3);
  });

  it("관리자가 설정을 동시에 바꿔도 마지막 값 하나만 남는다", async () => {
    const boss = await adminMember();
    const results = await race(Array.from({ length: 6 }, (_, index) => ({ sql: `select set_readings_open_to_all($1, $2) as r`, params: [boss, index % 2 === 0] })));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(await count(`select count(*)::int as n from public.app_settings where key = 'readings_open_to_all'`, [])).toBe(1);
  });

  // 무진의 종합 사주 (20261113120000 migration)

  it("한 이용권으로 묘묘·무진 풀이에 동시에 10번 써도 한 건만 쓰인다", async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await member();
      await svc(grantSql(user).sql, grantSql(user).params);
      const myomyo = await createReading(user);
      const mujin = await createMujinReading(user);
      // 무진 풀이는 결제 전 무료 단계를 시작한 상태다. 이 점유 행은 이용권 사용을 막지 않는다.
      await svc(claimFreeSql(user, mujin).sql, claimFreeSql(user, mujin).params);
      const jobs = Array.from({ length: 10 }, (_, index) =>
        index % 2 === 0 ? redeemProductSql(user, myomyo, "first-overview", "3.2.1") : redeemProductSql(user, mujin, "mujin-overview", "1.0.0"),
      );
      const results = await race<{ outcome: string; readingId: string }>(jobs);
      expect(results.filter((result) => !result.ok)).toEqual([]);
      const values = results.flatMap((result) => (result.ok ? [result.value] : []));
      const winners = values.filter((value) => value.outcome === "redeemed");
      expect(winners).toHaveLength(1);
      const winner = winners[0]!.readingId;
      // 이긴 풀이의 나머지 요청은 이미 받은 풀이로, 다른 상품 풀이의 요청은 이용권을 쓴 풀이로 안내받는다.
      expect(values.filter((value) => value.outcome === "already_redeemed")).toHaveLength(4);
      const used = values.filter((value) => value.outcome === "ticket_used");
      expect(used).toHaveLength(5);
      expect(used.every((value) => value.readingId === winner)).toBe(true);
      expect(await count(`select count(*)::int as n from public.entitlements where user_id = $1`, [user])).toBe(1);
      expect(await count(`select count(*)::int as n from public.generation_jobs where user_id = $1`, [user])).toBe(1);
      expect(await count(`select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'redeemed'`, [user])).toBe(1);
      const [ticket] = await svc<{ status: string; reading_id: string }>(`select status, reading_id from public.free_tickets where user_id = $1`, [user]);
      expect(ticket).toEqual({ status: "redeemed", reading_id: winner });
    }
  });

  it("같은 무진 풀이의 무료 단계 시작이 동시에 와도 한 요청만 시작한다", async () => {
    const user = await member();
    const readingId = await createMujinReading(user);
    const results = await race<{ claimed: boolean; reason: string }>(Array.from({ length: 8 }, () => claimFreeSql(user, readingId)));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const values = results.flatMap((result) => (result.ok ? [result.value] : []));
    expect(values.filter((value) => value.claimed)).toHaveLength(1);
    expect(values.filter((value) => value.reason === "running")).toHaveLength(7);
    const [run] = await svc<{ status: string; attempts: number }>(`select status, attempts from public.reading_free_runs where reading_id = $1`, [readingId]);
    expect(run).toEqual({ status: "running", attempts: 1 });
  });

  it("같은 회원이 여러 무진 풀이의 무료 단계를 동시에 시작해도 하루 시작 수 제한을 넘지 않는다", async () => {
    const user = await member();
    const readings = await Promise.all(Array.from({ length: 6 }, () => createMujinReading(user)));
    const results = await race<{ claimed: boolean; reason: string }>(readings.map((readingId) => claimFreeSql(user, readingId, 2)));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const reasons = results.map((result) => (result.ok ? result.value.reason : ""));
    expect(reasons.filter((reason) => reason === "claimed")).toHaveLength(2);
    expect(reasons.filter((reason) => reason === "daily_limited")).toHaveLength(4);
    expect(await count(`select count(*)::int as n from public.reading_free_runs where user_id = $1`, [user])).toBe(2);
  });

  it("무료 단계 시작 재요청과 장 저장이 같은 풀이에 동시에 와도 교착 없이 처리된다", async () => {
    // 시작 요청은 풀이 행을, 장 저장은 외래 키 확인으로 같은 풀이 행을 잠근다. 서로 기다리다 멈추지 않아야 한다.
    for (let round = 0; round < 5; round += 1) {
      const { user, readingId, attempt } = await mujinFreeRunning();
      const jobs = Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? claimFreeSql(user, readingId) : saveDraftSql(readingId, attempt, `unit-${index}`)));
      const results = await race<{ reason?: string } | boolean>(jobs);
      expect(results.filter((result) => !result.ok)).toEqual([]);
      const values = results.map((result) => (result.ok ? result.value : null));
      expect(values.filter((_, index) => index % 2 === 0).map((value) => (value as { reason: string }).reason)).toEqual(Array(4).fill("running"));
      expect(values.filter((_, index) => index % 2 === 1)).toEqual(Array(4).fill(true));
      expect(await count(`select count(*)::int as n from public.reading_units where reading_id = $1 and status = 'drafted'`, [readingId])).toBe(4);
    }
  });

  it("같은 장의 최종문 저장이 동시에 와도 한 문장만 남는다", async () => {
    const { readingId, attempt } = await mujinFreeRunning();
    const results = await race<boolean>(
      Array.from({ length: 5 }, (_, index) => ({
        sql: `select save_unit_final($1, 'free', $2, 'ch1', $3, '{}'::jsonb) as r`,
        params: [readingId, attempt, JSON.stringify({ sectionId: "ch1", coreAnswer: `가상 완성문 ${index}`, blocks: [] })],
      })),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(await count(`select count(*)::int as n from public.reading_sections where reading_id = $1`, [readingId])).toBe(1);
    const [unit] = await svc<{ status: string }>(`select status from public.reading_units where reading_id = $1 and unit_id = 'ch1'`, [readingId]);
    expect(unit!.status).toBe("done");
  });
});
