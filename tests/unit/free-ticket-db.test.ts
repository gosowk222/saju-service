import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 무료 이용권의 지급·사용·생성·반환을 실제 migration을 적용한 테스트용 Postgres(PGlite)로 확인한다.
 * PGlite는 연결이 하나라 진짜 병렬 실행이 아니다. 실제 동시 요청은 tests/db/concurrency.test.ts(실제 Postgres)가 확인한다.
 */
let db: TestDb;
const CAMPAIGN = "free-trial-2026-11";

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const asUser = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  db.run<T>("authenticated", user, sql, params);

async function member(providers: readonly string[] = ["kakao"]): Promise<string> {
  const id = randomUUID();
  await db.addUser(id, null, providers);
  return id;
}

async function createReading(user: string, productId = "first-overview"): Promise<string> {
  const reading = {
    product_id: productId,
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

type Outcome = { outcome: string; ticket?: { id: string; status: string }; readingId?: string; source?: string };

const grant = async (user: string, campaign = CAMPAIGN) =>
  (await svc<{ r: Outcome }>(`select grant_free_ticket($1, $2) as r`, [user, campaign]))[0]!.r;

const redeem = async (user: string, readingId: string, requestId = randomUUID(), productId = "first-overview") =>
  (
    await svc<{ r: Outcome }>(`select redeem_free_ticket($1, $2, $3, $4, $5, '3.2.1', 3, '{"productId":"first-overview"}'::jsonb) as r`, [
      user,
      readingId,
      requestId,
      CAMPAIGN,
      productId,
    ])
  )[0]!.r;

const claim = async (user: string, readingId: string, retry = false, maxAttempts = 4) =>
  (
    await svc<{ r: { claimed: boolean; reason: string; job: { attempts: number } } }>(
      `select claim_generation($1, $2, $3, 'gpt-5.6-luna', 'reading-2.5.0', 'narration-2.1.0', 'low', 300, $4) as r`,
      [user, readingId, retry, maxAttempts],
    )
  )[0]!.r;

const MESSAGES = JSON.stringify([{ seq: 1, topicId: null, kind: "transition", text: "안녕", refs: [] }]);
const META = JSON.stringify({ actualModel: "m", usage: {}, durationMs: 1, llmCalls: 1, issueCount: 0 });
const complete = async (readingId: string, attempt: number) =>
  (await svc<{ r: boolean }>(`select complete_generation($1, $2, $3, $4) as r`, [readingId, attempt, MESSAGES, META]))[0]!.r;
const fail = async (readingId: string, attempt: number) =>
  (await svc<{ r: boolean }>(`select fail_generation($1, $2, 'internal', true, 0) as r`, [readingId, attempt]))[0]!.r;
const restore = async (ticketId: string, reason = "생성 시도 소진") =>
  (await svc<{ r: Outcome }>(`select restore_free_ticket($1, $2) as r`, [ticketId, reason]))[0]!.r;

const ticketOf = async (user: string) =>
  (await svc<{ id: string; status: string; reading_id: string | null; restore_count: number }>(
    `select id, status, reading_id, restore_count from public.free_tickets where user_id = $1`,
    [user],
  ));

const count = async (sql: string, params: unknown[]) => (await svc<{ n: number }>(sql, params))[0]!.n;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe("회원 판정과 지급", () => {
  it("카카오 회원에게 한 장을 지급하고, 다시 요청해도 같은 한 장을 돌려준다", async () => {
    const user = await member();
    const first = await grant(user);
    const again = await grant(user);
    expect(first.outcome).toBe("granted");
    expect(again.outcome).toBe("exists");
    expect(again.ticket!.id).toBe(first.ticket!.id);
    expect(await ticketOf(user)).toHaveLength(1);
  });

  it("구글만 연결된 계정, 탈퇴·익명·이용 정지 계정은 지급하지 않는다", async () => {
    const googleOnly = await member(["google"]);
    expect((await grant(googleOnly)).outcome).toBe("not_eligible");

    const deleted = await member();
    await db.pg.query(`update auth.users set deleted_at = now() where id = $1`, [deleted]);
    const anonymous = await member();
    await db.pg.query(`update auth.users set is_anonymous = true where id = $1`, [anonymous]);
    const banned = await member();
    await db.pg.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [banned]);
    for (const user of [deleted, anonymous, banned]) expect((await grant(user)).outcome).toBe("not_eligible");

    for (const user of [googleOnly, deleted, anonymous, banned]) expect(await ticketOf(user)).toHaveLength(0);
  });

  it("처음 구글로 가입했어도 카카오가 연결되어 있으면 회원이다", async () => {
    const user = await member(["google", "kakao"]);
    expect((await grant(user)).outcome).toBe("granted");
  });

  it("사용자가 바꿀 수 있는 user_metadata의 provider 값은 판정에 쓰지 않는다", async () => {
    const user = await member(["google"]);
    await db.pg.query(`update auth.users set raw_user_meta_data = '{"provider":"kakao","providers":["kakao"]}' where id = $1`, [user]);
    expect((await grant(user)).outcome).toBe("not_eligible");
  });

  it("고정된 캠페인이 아닌 식별자로는 지급할 수 없다", async () => {
    const user = await member();
    await expect(grant(user, "free-trial-again")).rejects.toThrow(/free_tickets_campaign_check/);
  });

  it("기존 회원 일괄 지급은 반복해도 회원당 한 장이고, 결과 수를 기록한다", async () => {
    const before = await member();
    await grant(before);
    const fresh = await member();
    const googleOnly = await member(["google"]);

    const [{ r: first }] = await svc<{ r: Record<string, number> }>(`select grant_free_tickets_to_kakao_members($1) as r`, [CAMPAIGN]);
    expect(first.granted).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    expect(first.users).toBe(first.granted + first.skippedExisting + first.notEligible + first.failed);

    const [{ r: second }] = await svc<{ r: Record<string, number> }>(`select grant_free_tickets_to_kakao_members($1) as r`, [CAMPAIGN]);
    expect(second.granted).toBe(0);
    expect(second.skippedExisting).toBe(first.granted + first.skippedExisting);

    expect(await ticketOf(before)).toHaveLength(1);
    expect(await ticketOf(fresh)).toHaveLength(1);
    expect(await ticketOf(googleOnly)).toHaveLength(0);
    expect(await count(`select count(*)::int as n from public.free_ticket_events where kind = 'backfill'`, [])).toBe(2);
  });
});

describe("사용", () => {
  it("맛보기를 만들어도 이용권은 그대로이고, 사용하면 풀이 한 건에 권한과 작업이 함께 생긴다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    expect((await ticketOf(user))[0]!.status).toBe("available");

    const result = await redeem(user, readingId);
    expect(result).toMatchObject({ outcome: "redeemed", readingId });
    const [ticket] = await ticketOf(user);
    expect(ticket).toMatchObject({ status: "redeemed", reading_id: readingId });

    const [entitlement] = await svc<{ source: string; ticket_id: string; order_id: string | null; question_limit: number }>(
      `select source, ticket_id, order_id, question_limit from public.entitlements where reading_id = $1`,
      [readingId],
    );
    expect(entitlement).toEqual({ source: "free_ticket", ticket_id: ticket!.id, order_id: null, question_limit: 3 });
    const [job] = await svc<{ status: string; ticket_id: string; order_id: string | null }>(
      `select status, ticket_id, order_id from public.generation_jobs where reading_id = $1`,
      [readingId],
    );
    expect(job).toEqual({ status: "queued", ticket_id: ticket!.id, order_id: null });
    // 결제 기록이나 가짜 결제 승인 번호를 만들지 않는다.
    expect(await count(`select count(*)::int as n from public.orders where reading_id = $1`, [readingId])).toBe(0);
  });

  it("같은 요청을 다시 보내거나 다시 열어도 추가로 쓰지 않는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    const requestId = randomUUID();
    expect((await redeem(user, readingId, requestId)).outcome).toBe("redeemed");
    expect((await redeem(user, readingId, requestId)).outcome).toBe("already_redeemed");
    expect((await redeem(user, readingId)).outcome).toBe("already_redeemed");
    expect(await count(`select count(*)::int as n from public.free_ticket_events where kind = 'redeemed' and reading_id = $1`, [readingId])).toBe(1);
  });

  it("다른 입력(다른 풀이)으로 같은 이용권을 다시 쓸 수 없다", async () => {
    const user = await member();
    await grant(user);
    const first = await createReading(user);
    const second = await createReading(user);
    await redeem(user, first);
    const result = await redeem(user, second);
    expect(result).toMatchObject({ outcome: "ticket_used", readingId: first });
    expect(await count(`select count(*)::int as n from public.entitlements where reading_id = $1`, [second])).toBe(0);
    expect(await count(`select count(*)::int as n from public.generation_jobs where reading_id = $1`, [second])).toBe(0);
  });

  it("다른 사람의 풀이에는 쓸 수 없고, 다른 사람의 이용권도 쓸 수 없다", async () => {
    const owner = await member();
    const other = await member();
    await grant(owner);
    await grant(other);
    const ownersReading = await createReading(owner);
    await expect(redeem(other, ownersReading)).rejects.toThrow(/not_found/);
    expect((await ticketOf(other))[0]!.status).toBe("available");
    expect((await ticketOf(owner))[0]!.status).toBe("available");
  });

  it("이용권이 없거나 카카오 회원이 아니면 쓸 수 없다", async () => {
    const noTicket = await member();
    const readingId = await createReading(noTicket);
    await expect(redeem(noTicket, readingId)).rejects.toThrow(/no_ticket/);

    const googleOnly = await member(["google"]);
    const googleReading = await createReading(googleOnly);
    await expect(redeem(googleOnly, googleReading)).rejects.toThrow(/not_eligible/);
  });

  it("상품이 맞지 않으면 쓰지 않는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user, "first-overview");
    await expect(redeem(user, readingId, randomUUID(), "other-product")).rejects.toThrow(/product_mismatch/);
    expect((await ticketOf(user))[0]!.status).toBe("available");
  });

  it("이미 결제한 풀이에는 이용권을 쓰지 않는다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    const [order] = await svc<{ id: string }>(
      `select (o).id from (select create_order($1, $2, 'first-overview', '3.2.1', 990, 'KRW', 'toss', '{}'::jsonb) as o) x`,
      [user, readingId],
    );
    await svc(`select mark_order_paid($1, $2, 'pk', 990, 'KRW', '카드', 3)`, [order!.id, user]);
    expect((await redeem(user, readingId)).outcome).toBe("already_entitled");
    expect((await ticketOf(user))[0]!.status).toBe("available");
  });

  it("대기 중인 결제 주문은 이용권 사용과 함께 닫고, 이용권을 쓴 풀이로는 주문을 만들 수 없다", async () => {
    const user = await member();
    await grant(user);
    const readingId = await createReading(user);
    const [order] = await svc<{ id: string }>(
      `select (o).id from (select create_order($1, $2, 'first-overview', '3.2.1', 990, 'KRW', 'toss', '{}'::jsonb) as o) x`,
      [user, readingId],
    );
    await redeem(user, readingId);
    const [row] = await svc<{ status: string }>(`select status from public.orders where id = $1`, [order!.id]);
    expect(row!.status).toBe("cancelled");
    await expect(svc(`select mark_order_paid($1, $2, 'pk-late', 990, 'KRW', '카드', 3)`, [order!.id, user])).rejects.toThrow(/invalid_state/);
    await expect(
      svc(`select create_order($1, $2, 'first-overview', '3.2.1', 990, 'KRW', 'toss', '{}'::jsonb)`, [user, readingId]),
    ).rejects.toThrow(/already_paid/);
  });
});

describe("생성, 실패, 재시도", () => {
  async function redeemed() {
    const user = await member();
    const { ticket } = await grant(user);
    const readingId = await createReading(user);
    await redeem(user, readingId);
    return { user, readingId, ticketId: ticket!.id };
  }

  it("생성이 끝나면 같은 트랜잭션에서 이용권도 완료가 된다", async () => {
    const { user, readingId } = await redeemed();
    const { job } = await claim(user, readingId);
    expect(await complete(readingId, job.attempts)).toBe(true);
    const [ticket] = await ticketOf(user);
    expect(ticket!.status).toBe("completed");
    expect(await count(`select count(*)::int as n from public.free_ticket_events where kind = 'completed' and reading_id = $1`, [readingId])).toBe(1);
  });

  it("생성이 실패해도 이용권과 권한은 그대로이고, 같은 풀이로 추가 차감 없이 다시 시도한다", async () => {
    const { user, readingId } = await redeemed();
    const first = await claim(user, readingId);
    expect(await fail(readingId, first.job.attempts)).toBe(true);
    expect((await ticketOf(user))[0]!.status).toBe("redeemed");

    const retry = await claim(user, readingId, true);
    expect(retry.claimed).toBe(true);
    expect(await complete(readingId, retry.job.attempts)).toBe(true);
    expect((await ticketOf(user))[0]!.status).toBe("completed");
    expect(await count(`select count(*)::int as n from public.entitlements where user_id = $1`, [user])).toBe(1);
  });

  it("완료 후 다시 완료하거나 다시 시작하지 않는다", async () => {
    const { user, readingId } = await redeemed();
    const { job } = await claim(user, readingId);
    await complete(readingId, job.attempts);
    expect(await complete(readingId, job.attempts)).toBe(false);
    expect((await claim(user, readingId, true)).reason).toBe("completed");
  });

  it("이용권으로 받은 풀이도 후속 질문 횟수를 상품 설정대로 쓰고, 다시 시도해도 초기화되지 않는다", async () => {
    const { user, readingId } = await redeemed();
    const { job } = await claim(user, readingId);
    await complete(readingId, job.attempts);
    const [{ r: begun }] = await svc<{ r: { outcome: string; followup: { id: string }; limit: number } }>(
      `select begin_followup($1, $2, $3, '질문', 90, 100) as r`,
      [user, readingId, randomUUID()],
    );
    expect(begun).toMatchObject({ outcome: "started", limit: 3 });
    const [{ r: done }] = await svc<{ r: { used: number } }>(
      `select complete_followup($1, $2, 'answered', '답', '[]'::jsonb, '{}'::jsonb) as r`,
      [begun.followup.id, user],
    );
    expect(done.used).toBe(1);
    await redeem(user, readingId);
    expect(await count(`select count(*)::int as n from public.question_usage where reading_id = $1`, [readingId])).toBe(1);
  });
});

describe("반환 (서버 관리용)", () => {
  async function redeemed() {
    const user = await member();
    const { ticket } = await grant(user);
    const readingId = await createReading(user);
    await redeem(user, readingId);
    return { user, readingId, ticketId: ticket!.id };
  }

  it("복구할 수 없는 실패는 반환하고, 늦게 끝난 이전 요청은 완료로 바꾸지 못한다", async () => {
    const { user, readingId, ticketId } = await redeemed();
    const { job } = await claim(user, readingId, false, 1);
    await fail(readingId, job.attempts);
    expect((await claim(user, readingId, true, 1)).reason).toBe("exhausted");

    expect(await restore(ticketId)).toMatchObject({ outcome: "restored", readingId });
    const [ticket] = await ticketOf(user);
    expect(ticket).toMatchObject({ status: "available", reading_id: null, restore_count: 1 });
    expect(await count(`select count(*)::int as n from public.entitlements where reading_id = $1`, [readingId])).toBe(0);

    // 이전 요청이 늦게 완료를 저장하려 해도 반영되지 않는다.
    expect(await complete(readingId, job.attempts)).toBe(false);
    await expect(claim(user, readingId, true)).rejects.toThrow(/not_entitled/);
    // 닫힌 풀이에는 이용권도 결제도 다시 쓰지 않는다.
    await expect(redeem(user, readingId)).rejects.toThrow(/reading_closed/);
    await expect(
      svc(`select create_order($1, $2, 'first-overview', '3.2.1', 990, 'KRW', 'toss', '{}'::jsonb)`, [user, readingId]),
    ).rejects.toThrow(/reading_closed/);

    // 돌려받은 이용권은 새 입력으로 쓸 수 있다.
    const next = await createReading(user);
    expect((await redeem(user, next)).outcome).toBe("redeemed");
  });

  it("두 번 반환해도 한 번만 반영된다", async () => {
    const { user, ticketId } = await redeemed();
    await restore(ticketId);
    expect((await restore(ticketId)).outcome).toBe("already_available");
    expect((await ticketOf(user))[0]!.restore_count).toBe(1);
  });

  it("정상 제공된 풀이와 실행 중인 작업은 반환하지 않는다", async () => {
    const running = await redeemed();
    await claim(running.user, running.readingId);
    await expect(restore(running.ticketId)).rejects.toThrow(/still_running/);

    const done = await redeemed();
    const { job } = await claim(done.user, done.readingId);
    await complete(done.readingId, job.attempts);
    await expect(restore(done.ticketId)).rejects.toThrow(/already_delivered/);
  });

  it("사유 없이는 반환하지 않는다", async () => {
    const { ticketId } = await redeemed();
    await expect(restore(ticketId, " ")).rejects.toThrow(/reason_required/);
  });
});

describe("브라우저 권한", () => {
  it("본인 이용권만 읽는다", async () => {
    const owner = await member();
    const other = await member();
    await grant(owner);
    await grant(other);
    const rows = await asUser<{ user_id: string }>(owner, `select user_id from public.free_tickets`);
    expect(rows.map((row) => row.user_id)).toEqual([owner]);
    await expect(db.run("anon", null, `select 1 from public.free_tickets`)).rejects.toThrow(/permission denied/);
  });

  it.each([
    [`update public.free_tickets set status = 'available', reading_id = null`],
    [`update public.free_tickets set user_id = gen_random_uuid()`],
    [`insert into public.free_tickets (user_id, campaign_id) values (gen_random_uuid(), '${CAMPAIGN}')`],
    [`delete from public.free_tickets`],
    [`select 1 from public.free_ticket_events`],
    [`update public.entitlements set source = 'free_ticket'`],
    [`update public.generation_jobs set status = 'completed'`],
  ])("지급 여부, 상태, 소유자, 연결 풀이, 권한을 직접 바꿀 수 없다: %s", async (sql) => {
    const user = await member();
    await grant(user);
    await expect(asUser(user, sql)).rejects.toThrow(/permission denied/);
  });

  it.each([
    [`select is_kakao_member(gen_random_uuid())`],
    [`select grant_free_ticket(gen_random_uuid(), '${CAMPAIGN}')`],
    [`select grant_free_tickets_to_kakao_members('${CAMPAIGN}')`],
    [`select redeem_free_ticket(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${CAMPAIGN}', 'first-overview', '1', 3, '{}'::jsonb)`],
    [`select restore_free_ticket(gen_random_uuid(), 'x')`],
  ])("서버 전용 함수를 호출할 수 없다: %s", async (sql) => {
    const user = await member();
    await expect(asUser(user, sql)).rejects.toThrow(/permission denied/);
    await expect(db.run("anon", null, sql)).rejects.toThrow(/permission denied/);
  });

  it("이용권으로 받은 본문은 소유자만 읽는다", async () => {
    const owner = await member();
    const other = await member();
    await grant(owner);
    const readingId = await createReading(owner);
    await redeem(owner, readingId);
    const { job } = await claim(owner, readingId);
    await complete(readingId, job.attempts);
    expect(await asUser(owner, `select 1 from public.reading_messages where reading_id = $1`, [readingId])).toHaveLength(1);
    expect(await asUser(other, `select 1 from public.reading_messages where reading_id = $1`, [readingId])).toHaveLength(0);
  });

  it("service_role도 auth.identities를 직접 읽지 못한다 (판정은 is_kakao_member 하나로만)", async () => {
    await expect(svc(`select 1 from auth.identities`)).rejects.toThrow(/permission denied/);
  });
});
