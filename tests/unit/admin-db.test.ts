import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 회원 역할, 서버 설정(풀이 상품 이용 범위), 관리자 지급 이용권을 실제 migration을 적용한 테스트용 Postgres(PGlite)로 확인한다.
 * 동시 요청은 tests/db/concurrency.test.ts(실제 Postgres)가 확인한다.
 */
let db: TestDb;
const CAMPAIGN = "free-trial-2026-11";

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const asUser = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  db.run<T>("authenticated", user, sql, params);
const one = async <T>(sql: string, params: unknown[] = []) => (await svc<{ r: T }>(sql, params))[0]!.r;

async function member(providers: readonly string[] = ["kakao"], email: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.addUser(id, email, providers);
  return id;
}

async function admin(): Promise<string> {
  const id = await member();
  await svc(`select set_user_role($1, 'admin', '테스트 운영자')`, [id]);
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
  const [row] = await svc<{ id: string }>(`select create_reading($1, $2, $3, 1000) as id`, [user, JSON.stringify(reading), JSON.stringify({ plan: {}, trace: [] })]);
  return row!.id;
}

type Access = { role: string; openToAll: boolean; allowed: boolean };
const access = (user: string) => one<Access>(`select get_reading_access($1) as r`, [user]);
const setOpen = (adminId: string, open: boolean) => one<{ openToAll: boolean }>(`select set_readings_open_to_all($1, $2) as r`, [adminId, open]);
const adminGrant = (adminId: string, user: string, requestId = randomUUID()) =>
  one<{ outcome: string; ticketId?: string }>(`select admin_grant_free_ticket($1, $2, $3, '테스트') as r`, [adminId, user, requestId]);
const redeem = (user: string, readingId: string, requestId = randomUUID()) =>
  one<{ outcome: string; readingId: string; ticketId?: string }>(`select redeem_free_ticket($1, $2, $3, 'first-overview', '3.2.1', 3, '{}'::jsonb) as r`, [user, readingId, requestId]);
const tickets = (user: string) =>
  svc<{ id: string; source: string; status: string; reading_id: string | null }>(`select id, source, status, reading_id from public.free_tickets where user_id = $1 order by granted_at, id`, [user]);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe("역할과 풀이 상품 이용 범위", () => {
  it("역할 행이 없으면 일반 회원이고, 기본 설정은 관리자만이다", async () => {
    const user = await member();
    expect(await access(user)).toEqual({ role: "user", openToAll: false, allowed: false });
    const boss = await admin();
    expect(await access(boss)).toEqual({ role: "admin", openToAll: false, allowed: true });
  });

  it("관리자가 켜면 모든 회원이, 끄면 관리자만 이용한다", async () => {
    const boss = await admin();
    const user = await member();
    expect(await setOpen(boss, true)).toEqual({ openToAll: true });
    expect((await access(user)).allowed).toBe(true);
    await setOpen(boss, false);
    expect((await access(user)).allowed).toBe(false);
    expect((await access(boss)).allowed).toBe(true);
    const [{ n }] = await svc<{ n: number }>(`select count(*)::int as n from public.admin_actions where admin_id = $1 and action = 'set_setting'`, [boss]);
    expect(n).toBe(2);
  });

  it("관리자가 아니면 설정을 바꿀 수 없다", async () => {
    const user = await member();
    await expect(setOpen(user, true)).rejects.toThrow(/not_admin/);
    expect((await access(user)).openToAll).toBe(false);
  });

  it("역할은 user와 admin만 있고, 다시 user로 내릴 수 있다", async () => {
    const user = await member();
    await expect(svc(`select set_user_role($1, 'owner')`, [user])).rejects.toThrow(/invalid_role/);
    await svc(`select set_user_role($1, 'admin')`, [user]);
    expect((await access(user)).role).toBe("admin");
    await svc(`select set_user_role($1, 'user')`, [user]);
    expect((await access(user)).role).toBe("user");
  });
});

describe("관리자 지급 이용권", () => {
  it("고른 회원에게 한 장씩 쌓이고, 같은 요청은 한 번만 반영된다", async () => {
    const boss = await admin();
    const user = await member();
    await one(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN]);
    const requestId = randomUUID();
    expect((await adminGrant(boss, user, requestId)).outcome).toBe("granted");
    expect((await adminGrant(boss, user, requestId)).outcome).toBe("exists");
    expect((await adminGrant(boss, user)).outcome).toBe("granted");
    const rows = await tickets(user);
    expect(rows.map((row) => row.source)).toEqual(["campaign", "admin", "admin"]);
    // 캠페인 이용권은 여전히 한 장이다.
    expect((await one<{ outcome: string }>(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN])).outcome).toBe("exists");
  });

  it("관리자가 아니면 줄 수 없고, 같은 요청 ID를 다른 회원에게 쓸 수 없다", async () => {
    const boss = await admin();
    const user = await member();
    const other = await member();
    await expect(adminGrant(user, other)).rejects.toThrow(/not_admin/);
    const requestId = randomUUID();
    await adminGrant(boss, user, requestId);
    await expect(adminGrant(boss, other, requestId)).rejects.toThrow(/request_conflict/);
    expect(await tickets(other)).toHaveLength(0);
  });

  it("카카오 연결이 없는 계정에는 주지 않는다", async () => {
    const boss = await admin();
    const googleOnly = await member(["google"]);
    expect((await adminGrant(boss, googleOnly)).outcome).toBe("not_eligible");
    expect(await tickets(googleOnly)).toHaveLength(0);
  });

  it("여러 장이면 캠페인 이용권부터 한 장씩 풀이에 쓰고, 다 쓰면 마지막 풀이를 알려 준다", async () => {
    const boss = await admin();
    const user = await member();
    await one(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN]);
    await adminGrant(boss, user);
    const [first, second, third] = [await createReading(user), await createReading(user), await createReading(user)];

    expect((await redeem(user, first)).outcome).toBe("redeemed");
    expect((await tickets(user)).find((row) => row.reading_id === first)?.source).toBe("campaign");
    expect((await redeem(user, second)).outcome).toBe("redeemed");
    expect((await tickets(user)).find((row) => row.reading_id === second)?.source).toBe("admin");
    // 다시 열거나 재전송해도 추가로 쓰지 않는다.
    expect((await redeem(user, first)).outcome).toBe("already_redeemed");
    expect(await redeem(user, third)).toMatchObject({ outcome: "ticket_used", readingId: second });
    const [{ n }] = await svc<{ n: number }>(`select count(*)::int as n from public.entitlements where user_id = $1`, [user]);
    expect(n).toBe(2);
  });
});

describe("관리자 회원 목록", () => {
  it("관리자만 보고, 이름·이메일·ID로 찾으며, 이용권 수를 함께 보여 준다", async () => {
    const boss = await admin();
    const user = await member(["kakao"], "find-me@example.com");
    await db.pg.query(`update auth.users set raw_user_meta_data = '{"name":"검색용이름"}' where id = $1`, [user]);
    await one(`select grant_free_ticket($1, $2) as r`, [user, CAMPAIGN]);
    await adminGrant(boss, user);

    type Row = { id: string; name: string | null; email: string | null; role: string; kakao: boolean; tickets_available: number; tickets_used: number };
    for (const search of ["검색용", "find-me", user.slice(0, 8)]) {
      const rows = await one<Row[]>(`select admin_list_members($1, $2, 50) as r`, [boss, search]);
      expect(rows.map((row) => row.id), search).toContain(user);
    }
    const [row] = (await one<Row[]>(`select admin_list_members($1, $2, 50) as r`, [boss, user])).filter((item) => item.id === user);
    expect(row).toMatchObject({ name: "검색용이름", email: "find-me@example.com", role: "user", kakao: true, tickets_available: 2, tickets_used: 0 });

    const plain = await member();
    await expect(one(`select admin_list_members($1, null, 50) as r`, [plain])).rejects.toThrow(/not_admin/);
  });
});

describe("브라우저 권한", () => {
  it("본인 역할만 읽고, 역할·설정·작업 기록은 바꾸거나 볼 수 없다", async () => {
    const boss = await admin();
    const user = await member();
    await svc(`select set_user_role($1, 'user')`, [user]);
    expect(await asUser(user, `select user_id, role from public.user_roles`)).toEqual([{ user_id: user, role: "user" }]);
    for (const sql of [
      `update public.user_roles set role = 'admin'`,
      `insert into public.user_roles (user_id, role) values ('${user}', 'admin')`,
      `select * from public.app_settings`,
      `update public.app_settings set value = 'true'`,
      `select * from public.admin_actions`,
    ]) {
      await expect(asUser(user, sql), sql).rejects.toThrow(/permission denied/);
    }
    void boss;
  });

  it.each([
    [`select is_admin(gen_random_uuid())`],
    [`select set_user_role(gen_random_uuid(), 'admin')`],
    [`select get_reading_access(gen_random_uuid())`],
    [`select set_readings_open_to_all(gen_random_uuid(), true)`],
    [`select admin_grant_free_ticket(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`],
    [`select admin_list_members(gen_random_uuid())`],
  ])("서버 전용 함수를 호출할 수 없다: %s", async (sql) => {
    const user = await member();
    await expect(asUser(user, sql)).rejects.toThrow(/permission denied/);
    await expect(db.run("anon", null, sql)).rejects.toThrow(/permission denied/);
  });
});
