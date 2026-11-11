import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../support/test-db";

/**
 * 실제 migration을 테스트용 Postgres에 적용해 권한과 상태 전이를 확인한다.
 * PGlite는 연결이 하나라 진짜 병렬 실행이 아니다. 동시 요청은 순차 중복 호출로 확인한다.
 */
let db: TestDb;
const userA = randomUUID();
const userB = randomUUID();

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.run<T>("service_role", null, sql, params);
const asUser = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  db.run<T>("authenticated", user, sql, params);

async function createReading(user: string): Promise<string> {
  const reading = {
    product_id: "first-overview",
    product_version: "1.0.0",
    nickname: "달빛",
    birth_input: {},
    place_snapshot: { latitudeDeg: 37.5 },
    chart: {},
    preview: {},
    persona_id: "myomyo",
    persona_version: "1.0.0",
    ruleset_id: "first-overview",
    ruleset_version: "1.0.0",
    engine_meta: {},
  };
  const [row] = await svc<{ id: string }>(`select create_reading($1, $2, $3, 1000) as id`, [
    user,
    JSON.stringify(reading),
    JSON.stringify({ plan: { secret: true }, trace: [] }),
  ]);
  return row!.id;
}

async function createOrder(user: string, readingId: string, amount = 990) {
  const [row] = await svc<{ id: string; status: string; amount: number }>(
    `select (o).id, (o).status, (o).amount from (select create_order($1, $2, 'first-overview', '1.0.0', $3, 'KRW', 'toss', '{}'::jsonb) as o) x`,
    [user, readingId, amount],
  );
  return row!;
}

const markPaid = (orderId: string, user: string, key: string, amount = 990, currency = "KRW") =>
  svc<{ r: { readingId: string; newlyPaid: boolean } }>(`select mark_order_paid($1, $2, $3, $4, $5, '카드', 3) as r`, [orderId, user, key, amount, currency]);

const claim = (user: string, readingId: string, retry = false, model = "gpt-5.6-luna") =>
  svc<{ r: { claimed: boolean; reason: string; job: Record<string, unknown> } }>(
    `select claim_generation($1, $2, $3, $4, 'reading-1.0.0', 'narration-1.0.0', 'low', 300, 4) as r`,
    [user, readingId, retry, model],
  );

const MESSAGES = JSON.stringify([{ seq: 1, topicId: null, kind: "transition", text: "안녕", refs: [] }]);
const META = JSON.stringify({ actualModel: "m", usage: {}, durationMs: 1, llmCalls: 1, issueCount: 0 });

async function paidCompletedReading(user: string) {
  const readingId = await createReading(user);
  const order = await createOrder(user, readingId);
  await markPaid(order.id, user, `pk-${order.id}`);
  const [{ r }] = await claim(user, readingId);
  await svc(`select complete_generation($1, $2, $3, $4)`, [readingId, r.job.attempts, MESSAGES, META]);
  return { readingId, orderId: order.id };
}

const begin = (user: string, readingId: string, requestId: string, rate = 100) =>
  svc<{ r: { outcome: string; used: number; limit: number; followup?: { id: string } } }>(
    `select begin_followup($1, $2, $3, '질문', 90, $4) as r`,
    [user, readingId, requestId, rate],
  );

const complete = (followupId: string, user: string, status = "answered") =>
  svc<{ r: { saved: boolean; used: number; limit: number } }>(
    `select complete_followup($1, $2, $3, '답변', '[]'::jsonb, '{"modelId":"m"}'::jsonb) as r`,
    [followupId, user, status],
  );

beforeAll(async () => {
  db = await createTestDb();
  await db.addUser(userA);
  await db.addUser(userB, "same@example.com");
});

afterAll(async () => {
  await db.close();
});

describe("사용자 간 격리", () => {
  it("다른 사용자의 풀이, 주문, 메시지, 질문을 읽을 수 없다", async () => {
    const { readingId, orderId } = await paidCompletedReading(userA);
    for (const [table, column, value] of [
      ["readings", "id", readingId],
      ["orders", "id", orderId],
      ["entitlements", "reading_id", readingId],
      ["generation_jobs", "reading_id", readingId],
      ["reading_messages", "reading_id", readingId],
    ] as const) {
      expect(await asUser(userA, `select 1 from public.${table} where ${column} = $1`, [value])).toHaveLength(1);
      expect(await asUser(userB, `select 1 from public.${table} where ${column} = $1`, [value])).toHaveLength(0);
    }
  });

  it("로그인하지 않으면 테이블에 접근할 수 없다", async () => {
    await expect(db.run("anon", null, `select 1 from public.readings`)).rejects.toThrow(/permission denied/);
    await expect(db.run("anon", null, `select 1 from public.reading_drafts`)).rejects.toThrow(/permission denied/);
  });

  it("작성 재료와 판단 기록은 소유자도 브라우저 권한으로 읽을 수 없다", async () => {
    await expect(asUser(userA, `select * from public.reading_internals`)).rejects.toThrow(/permission denied/);
  });

  it("초안은 본인 것만 읽고 쓴다", async () => {
    await asUser(userA, `select save_my_draft('first-overview', '{"nickname":"A"}'::jsonb)`);
    await asUser(userB, `select save_my_draft('first-overview', '{"nickname":"B"}'::jsonb)`);
    const mine = await asUser<{ payload: { nickname: string } }>(userA, `select payload from public.reading_drafts`);
    expect(mine.map((row) => row.payload.nickname)).toEqual(["A"]);
    await expect(
      asUser(userA, `insert into public.reading_drafts (user_id, product_id, payload) values ($1, 'x', '{}')`, [userB]),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("브라우저의 임의 변경 차단", () => {
  it.each([
    ["orders", `update public.orders set status = 'paid'`],
    ["entitlements", `update public.entitlements set question_limit = 999`],
    ["generation_jobs", `update public.generation_jobs set status = 'completed'`],
    ["reading_messages", `insert into public.reading_messages (reading_id, user_id, seq, kind, text) values (gen_random_uuid(), gen_random_uuid(), 1, 'transition', 'x')`],
    ["question_usage", `delete from public.question_usage`],
    ["readings", `update public.readings set chart = '{}'`],
  ])("%s를 직접 바꿀 수 없다", async (_table, sql) => {
    await expect(asUser(userA, sql)).rejects.toThrow(/permission denied/);
  });

  it.each([
    [`select mark_order_paid(gen_random_uuid(), gen_random_uuid(), 'k', 990, 'KRW', 'x', 3)`],
    [`select create_reading(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, 1)`],
    [`select claim_generation(gen_random_uuid(), gen_random_uuid(), false, 'm', 'p', 's', 'low', 1, 1)`],
    [`select complete_generation(gen_random_uuid(), 1, '[]'::jsonb, '{}'::jsonb)`],
    [`select begin_followup(gen_random_uuid(), gen_random_uuid(), 'x', 'q', 1, 1)`],
    [`select complete_followup(gen_random_uuid(), gen_random_uuid(), 'answered', 'a', '[]'::jsonb, '{}'::jsonb)`],
  ])("서버 전용 함수를 호출할 수 없다: %s", async (sql) => {
    await expect(asUser(userA, sql)).rejects.toThrow(/permission denied/);
  });
});

describe("주문과 결제", () => {
  it("다른 사용자의 풀이로 주문을 만들 수 없다", async () => {
    const readingId = await createReading(userA);
    await expect(createOrder(userB, readingId)).rejects.toThrow(/not_found/);
  });

  it("같은 풀이의 대기 주문은 다시 쓴다", async () => {
    const readingId = await createReading(userA);
    const first = await createOrder(userA, readingId);
    const second = await createOrder(userA, readingId);
    expect(second.id).toBe(first.id);
  });

  it("가격이 바뀌면 이전 대기 주문을 닫고 새 주문을 만든다", async () => {
    const readingId = await createReading(userA);
    const first = await createOrder(userA, readingId, 990);
    const second = await createOrder(userA, readingId, 1500);
    expect(second.id).not.toBe(first.id);
    const [old] = await svc<{ status: string }>(`select status from public.orders where id = $1`, [first.id]);
    expect(old!.status).toBe("cancelled");
  });

  it("금액이나 통화가 다르면 완료 처리하지 않는다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await expect(markPaid(order.id, userA, "k1", 1)).rejects.toThrow(/amount_mismatch/);
    await expect(markPaid(order.id, userA, "k1", 990, "USD")).rejects.toThrow(/amount_mismatch/);
  });

  it("다른 사용자는 완료 처리할 수 없다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await expect(markPaid(order.id, userB, "k2")).rejects.toThrow(/not_found/);
  });

  it("콜백이 반복되어도 권한과 작업은 하나만 생긴다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    const [first] = await markPaid(order.id, userA, "k3");
    const [second] = await markPaid(order.id, userA, "k3");
    expect(first!.r.newlyPaid).toBe(true);
    expect(second!.r.newlyPaid).toBe(false);
    const [{ count }] = await svc<{ count: number }>(`select count(*)::int as count from public.entitlements where reading_id = $1`, [readingId]);
    const [{ jobs }] = await svc<{ jobs: number }>(`select count(*)::int as jobs from public.generation_jobs where reading_id = $1`, [readingId]);
    expect([count, jobs]).toEqual([1, 1]);
  });

  it("같은 주문을 다른 결제 키로 다시 완료할 수 없다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, "k4");
    await expect(markPaid(order.id, userA, "other")).rejects.toThrow(/payment_key_mismatch/);
  });

  it("실패하거나 취소된 주문은 완료할 수 없다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await svc(`select close_order($1, $2, 'failed', 'CODE', 'msg')`, [order.id, userA]);
    await expect(markPaid(order.id, userA, "k5")).rejects.toThrow(/invalid_state/);
  });

  it("결제 완료 후에는 주문을 닫아도 상태가 바뀌지 않고 추가 주문도 막는다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, "k6");
    await svc(`select close_order($1, $2, 'cancelled', 'CODE', 'msg')`, [order.id, userA]);
    const [row] = await svc<{ status: string }>(`select status from public.orders where id = $1`, [order.id]);
    expect(row!.status).toBe("paid");
    await expect(createOrder(userA, readingId)).rejects.toThrow(/already_paid/);
  });
});

describe("풀이 생성", () => {
  async function paidReading() {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, `pk-${order.id}`);
    return readingId;
  }

  it("미결제 풀이는 시작할 수 없다", async () => {
    const readingId = await createReading(userA);
    await expect(claim(userA, readingId)).rejects.toThrow(/not_entitled/);
  });

  it("다른 사용자는 시작할 수 없다", async () => {
    const readingId = await paidReading();
    await expect(claim(userB, readingId)).rejects.toThrow(/not_entitled/);
  });

  it("실행 중이면 중복으로 시작하지 않는다", async () => {
    const readingId = await paidReading();
    const [first] = await claim(userA, readingId);
    const [second] = await claim(userA, readingId);
    expect(first!.r.claimed).toBe(true);
    expect(second!.r).toMatchObject({ claimed: false, reason: "running" });
  });

  it("점유 시간이 지나면 이어받되 모델과 프롬프트는 처음 값을 유지한다", async () => {
    const readingId = await paidReading();
    await claim(userA, readingId, false, "gpt-5.6-luna");
    await svc(`update public.generation_jobs set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);
    const [{ r }] = await claim(userA, readingId, false, "gpt-6-luna");
    expect(r.claimed).toBe(true);
    expect(r.job).toMatchObject({ model_id: "gpt-5.6-luna", attempts: 2 });
  });

  it("실패 후 재시도는 같은 주문으로 진행하고 추가 결제를 요구하지 않는다", async () => {
    const readingId = await paidReading();
    const [{ r }] = await claim(userA, readingId);
    await svc(`select fail_generation($1, $2, 'timeout', true, 1)`, [readingId, r.job.attempts]);
    const [auto] = await claim(userA, readingId, false);
    expect(auto!.r).toMatchObject({ claimed: false, reason: "failed" });
    const [retry] = await claim(userA, readingId, true);
    expect(retry!.r.claimed).toBe(true);
    const [{ count }] = await svc<{ count: number }>(`select count(*)::int as count from public.orders where reading_id = $1`, [readingId]);
    expect(count).toBe(1);
  });

  it("시도 횟수에 상한이 있다", async () => {
    const readingId = await paidReading();
    for (let i = 0; i < 4; i += 1) {
      const [{ r }] = await claim(userA, readingId, true);
      await svc(`select fail_generation($1, $2, 'timeout', true, 1)`, [readingId, r.job.attempts]);
    }
    const [last] = await claim(userA, readingId, true);
    expect(last!.r).toMatchObject({ claimed: false, reason: "exhausted" });
  });

  it("끝난 작업의 뒤늦은 완료는 저장되지 않아 내용이 섞이지 않는다", async () => {
    const readingId = await paidReading();
    const [{ r: first }] = await claim(userA, readingId);
    await svc(`update public.generation_jobs set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);
    const [{ r: second }] = await claim(userA, readingId);
    await svc(`select complete_generation($1, $2, $3, $4)`, [readingId, second.job.attempts, MESSAGES, META]);
    const [late] = await svc<{ r: boolean }>(`select complete_generation($1, $2, $3, $4) as r`, [readingId, first.job.attempts, MESSAGES, META]);
    expect(late!.r).toBe(false);
    const rows = await svc(`select 1 from public.reading_messages where reading_id = $1`, [readingId]);
    expect(rows).toHaveLength(1);
  });

  it("완료 후에는 다시 생성하지 않는다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await claim(userA, readingId, true, "gpt-6-luna");
    expect(r).toMatchObject({ claimed: false, reason: "completed" });
    expect(r.job.model_id).toBe("gpt-5.6-luna");
  });

  it("구매 권한이 없는 본문은 RLS로 막힌다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    await db.pg.query(`delete from public.generation_jobs where reading_id = $1`, [readingId]);
    await db.pg.query(`delete from public.entitlements where reading_id = $1`, [readingId]);
    expect(await asUser(userA, `select 1 from public.reading_messages where reading_id = $1`, [readingId])).toHaveLength(0);
  });
});

describe("후속 질문 횟수", () => {
  it("정상 답변이 저장될 때 한 번만 차감한다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await begin(userA, readingId, "req-1");
    expect(r).toMatchObject({ outcome: "started", used: 0, limit: 3 });
    const [{ r: done }] = await complete(r.followup!.id, userA);
    expect(done).toMatchObject({ saved: true, used: 1 });
    const [{ r: again }] = await complete(r.followup!.id, userA);
    expect(again).toMatchObject({ saved: false, used: 1 });
  });

  it("같은 요청이 반복되면 새로 만들지 않고 차감도 늘지 않는다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r: first }] = await begin(userA, readingId, "dup");
    await complete(first.followup!.id, userA);
    const [{ r: second }] = await begin(userA, readingId, "dup");
    expect(second).toMatchObject({ outcome: "duplicate", used: 1 });
  });

  it("처리 중에는 다음 질문을 받지 않는다 (동시 요청 방지)", async () => {
    const { readingId } = await paidCompletedReading(userA);
    await begin(userA, readingId, "a");
    const [{ r }] = await begin(userA, readingId, "b");
    expect(r.outcome).toBe("busy");
  });

  it("관련 없는 질문은 차감하지 않는다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await begin(userA, readingId, "off");
    const [{ r: done }] = await complete(r.followup!.id, userA, "off_topic");
    expect(done).toMatchObject({ saved: true, used: 0 });
  });

  it("생성에 실패하면 차감하지 않는다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await begin(userA, readingId, "fail");
    await svc(`select fail_followup($1, $2, 'timeout')`, [r.followup!.id, userA]);
    const [{ r: next }] = await begin(userA, readingId, "after-fail");
    expect(next).toMatchObject({ outcome: "started", used: 0 });
  });

  it("중단된 답변은 점유 시간이 지나면 자동으로 풀린다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    await begin(userA, readingId, "stuck");
    await svc(`update public.followups set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);
    const [{ r }] = await begin(userA, readingId, "next");
    expect(r).toMatchObject({ outcome: "started", used: 0 });
  });

  it("제공 횟수를 넘길 수 없다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    for (const id of ["1", "2", "3"]) {
      const [{ r }] = await begin(userA, readingId, id);
      await complete(r.followup!.id, userA);
    }
    const [{ r }] = await begin(userA, readingId, "4");
    expect(r).toMatchObject({ outcome: "exhausted", used: 3, limit: 3 });
  });

  it("미결제 풀이와 다른 사용자의 풀이에는 질문할 수 없다", async () => {
    const readingId = await createReading(userA);
    await expect(begin(userA, readingId, "x")).rejects.toThrow(/not_entitled/);
    const { readingId: paid } = await paidCompletedReading(userA);
    await expect(begin(userB, paid, "x")).rejects.toThrow(/not_entitled/);
  });

  it("생성이 끝나기 전에는 질문할 수 없다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, `pk-${order.id}`);
    await expect(begin(userA, readingId, "x")).rejects.toThrow(/not_ready/);
  });

  it("요청 빈도를 제한한다", async () => {
    const user = randomUUID();
    await db.addUser(user);
    const { readingId } = await paidCompletedReading(user);
    const [{ r: first }] = await begin(user, readingId, "r1", 1);
    await complete(first.followup!.id, user);
    const [{ r }] = await begin(user, readingId, "r2", 1);
    expect(r.outcome).toBe("rate_limited");
  });
});

describe("풀이 품질 고도화 (20261110 migration)", () => {
  it("되묻기는 저장되지만 질문 횟수를 차감하지 않고, 같은 메시지의 소질문 여러 개도 한 번만 차감한다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await begin(userA, readingId, "clarify-1");
    const [{ r: clarified }] = await complete(r.followup!.id, userA, "clarify");
    expect(clarified).toMatchObject({ saved: true, used: 0 });
    const [{ r: next }] = await begin(userA, readingId, "multi");
    const [{ r: answered }] = await complete(next.followup!.id, userA, "answered");
    expect(answered).toMatchObject({ saved: true, used: 1 });
    const [usage] = await svc<{ count: number }>(`select count(*)::int as count from public.question_usage where reading_id = $1`, [readingId]);
    expect(usage!.count).toBe(1);
  });

  it("후속 질문 분석 기록을 남기고, 정해진 상태 외에는 저장하지 않는다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const [{ r }] = await begin(userA, readingId, "meta");
    await svc(`select complete_followup($1, $2, 'answered', '답', '[]'::jsonb, '{"modelId":"m","analysis":{"items":[{"id":"q1"}]}}'::jsonb)`, [r.followup!.id, userA]);
    const [row] = await svc<{ analysis: { items: unknown[] } }>(`select analysis from public.followups where id = $1`, [r.followup!.id]);
    expect(row!.analysis.items).toHaveLength(1);
    const [{ r: other }] = await begin(userA, readingId, "bad-status");
    await expect(complete(other.followup!.id, userA, "answering")).rejects.toThrow(/invalid_state/);
  });

  it("질문 분석과 기간 재료는 같은 키를 덮어쓰지 않고 처음 저장한 값을 돌려준다", async () => {
    const readingId = await createReading(userA);
    const save = (payload: object) =>
      svc<{ r: { v: number } }>(`select save_reading_analysis($1, 'timing:career:2026-11..2027-10@2026-11-10', 'timing', 'timing-analysis-1.0.0', $2) as r`, [
        readingId,
        JSON.stringify(payload),
      ]);
    const [{ r: first }] = await save({ v: 1 });
    const [{ r: second }] = await save({ v: 2 });
    expect(first).toEqual({ v: 1 });
    expect(second).toEqual({ v: 1 });
  });

  it("질문 분석과 기간 재료는 소유자도 브라우저 권한으로 읽거나 쓸 수 없다", async () => {
    const readingId = await createReading(userA);
    await svc(`select save_reading_analysis($1, 'question:initial', 'question', 'question-analysis-1.0.0', '{"items":[]}'::jsonb)`, [readingId]);
    await expect(asUser(userA, `select * from public.reading_analyses where reading_id = $1`, [readingId])).rejects.toThrow(/permission denied/);
    await expect(
      asUser(userA, `select save_reading_analysis($1, 'x', 'question', 'v', '{}'::jsonb)`, [readingId]),
    ).rejects.toThrow(/permission denied/);
  });

  it("생성 완료 시 쓰인 버전을 작업에 남긴다", async () => {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, `pk-${order.id}`);
    const [{ r }] = await claim(userA, readingId);
    const meta = JSON.stringify({ actualModel: "m", usage: {}, durationMs: 1, llmCalls: 2, issueCount: 0, versions: { planVersion: "2.0.0", promptVersion: "reading-2.0.0" } });
    await svc(`select complete_generation($1, $2, $3, $4)`, [readingId, r.job.attempts, MESSAGES, meta]);
    const [job] = await svc<{ generation_meta: { planVersion: string }; llm_calls: number }>(`select generation_meta, llm_calls from public.generation_jobs where reading_id = $1`, [readingId]);
    expect(job!.generation_meta.planVersion).toBe("2.0.0");
    expect(job!.llm_calls).toBe(2);
  });

  it("이전 형식으로 완료된 풀이의 메시지는 그대로 읽힌다", async () => {
    const { readingId } = await paidCompletedReading(userA);
    const rows = await asUser<{ text: string; topic_id: string | null }>(userA, `select text, topic_id from public.reading_messages where reading_id = $1`, [readingId]);
    expect(rows).toEqual([{ text: "안녕", topic_id: null }]);
  });
});

describe("지역 값 보존", () => {
  it("풀이 기록의 좌표는 나중에 바뀌지 않는다", async () => {
    const readingId = await createReading(userA);
    const [row] = await svc<{ place_snapshot: { latitudeDeg: number } }>(`select place_snapshot from public.readings where id = $1`, [readingId]);
    expect(row!.place_snapshot.latitudeDeg).toBe(37.5);
    await expect(asUser(userA, `update public.readings set place_snapshot = '{}' where id = $1`, [readingId])).rejects.toThrow(/permission denied/);
  });
});

describe("최초 풀이 토큰 사용량 (20261112 migration)", () => {
  async function paidReading() {
    const readingId = await createReading(userA);
    const order = await createOrder(userA, readingId);
    await markPaid(order.id, userA, `pk-${order.id}`);
    return readingId;
  }
  const record = (readingId: string, attempt: number, outcome: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    svc<{ r: boolean }>(`select record_generation_attempt($1, $2, $3, $4) as r`, [
      readingId,
      attempt,
      outcome,
      JSON.stringify({ modelId: "gpt-5.6-luna", actualModel: "gpt-5.6-luna-2026", promptVersion: "reading-3.1.0", personaVersion: "2.1.0", reasoningEffort: "medium", durationMs: 1000, usage, ...extra }),
    ]);
  type UsageRow = {
    status: string;
    attempts: number;
    recorded_attempts: number;
    llm_calls: number;
    calls_without_usage: number;
    input_tokens: string | null;
    cached_input_tokens: string | null;
    uncached_input_tokens: string | null;
    output_tokens: string | null;
    reasoning_tokens: string | null;
    total_tokens: string | null;
    usage_complete: boolean;
    persona_version: string | null;
  };
  const summary = async (readingId: string) => (await svc<UsageRow>(`select * from public.generation_usage where reading_id = $1`, [readingId]))[0]!;

  it("실패한 시도와 재시도의 사용량을 모두 더하고, 같은 시도를 다시 보내도 한 번만 남긴다", async () => {
    const readingId = await paidReading();
    const [{ r: first }] = await claim(userA, readingId);
    await svc(`select fail_generation($1, $2, 'validation_failed', true, 2)`, [readingId, first.job.attempts]);
    const failedUsage = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, reasoningTokens: 50, calls: 2, callsWithoutUsage: 0, complete: true };
    const [{ r: saved }] = await record(readingId, 1, "failed", failedUsage, { errorCode: "validation_failed", issues: ["work: 없는 근거를 참조했습니다 (s999)"] });
    expect(saved).toBe(true);
    // 같은 시도를 다시 보내면 처음 기록을 그대로 둔다 (두 번 더하지 않는다).
    const [{ r: again }] = await record(readingId, 1, "failed", { ...failedUsage, inputTokens: 9999 });
    expect(again).toBe(false);

    const [{ r: second }] = await claim(userA, readingId, true);
    expect(second.job.attempts).toBe(2);
    await svc(`select complete_generation($1, $2, $3, $4)`, [readingId, 2, MESSAGES, META]);
    await record(readingId, 2, "completed", { inputTokens: 500, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 20, calls: 1, callsWithoutUsage: 0, complete: true });
    // 시작하지 않은 시도 번호는 받지 않는다.
    const [{ r: future }] = await record(readingId, 3, "completed", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, calls: 1, callsWithoutUsage: 0, complete: true });
    expect(future).toBe(false);

    const row = await summary(readingId);
    expect(row).toMatchObject({ status: "completed", attempts: 2, recorded_attempts: 2, llm_calls: 3, calls_without_usage: 0, usage_complete: true, persona_version: "2.1.0" });
    // total = input + output (캐시·추론을 다시 더하지 않는다). 캐시되지 않은 입력 = 1500 - 600.
    expect([row.input_tokens, row.cached_input_tokens, row.uncached_input_tokens, row.output_tokens, row.reasoning_tokens, row.total_tokens].map(Number)).toEqual([1500, 600, 900, 300, 70, 1800]);
    const [attempt] = await svc<{ issues: string[]; error_code: string; total_tokens: string }>(`select issues, error_code, total_tokens from public.generation_attempts where reading_id = $1 and attempt = 1`, [readingId]);
    expect(attempt).toMatchObject({ issues: ["work: 없는 근거를 참조했습니다 (s999)"], error_code: "validation_failed" });
    expect(Number(attempt!.total_tokens)).toBe(1200);
  });

  it("usage를 받지 못한 호출이 있거나 기록되지 않은 시도가 있으면 합계를 불완전으로 표시하고 0으로 채우지 않는다", async () => {
    const readingId = await paidReading();
    await claim(userA, readingId);
    // 시도 1이 아직 기록되지 않았다 (진행 중이거나 중간에 멈춘 요청).
    let row = await summary(readingId);
    expect(row).toMatchObject({ recorded_attempts: 0, usage_complete: false, input_tokens: null, total_tokens: null });
    await record(readingId, 1, "handed_over", { inputTokens: 300, outputTokens: 100, cachedInputTokens: 0, calls: 2, callsWithoutUsage: 1, complete: false });
    row = await summary(readingId);
    expect(row).toMatchObject({ recorded_attempts: 1, calls_without_usage: 1, usage_complete: false });
    expect(Number(row.input_tokens)).toBe(300);
    // 받지 못한 호출이 있는데 완전하다고 기록할 수는 없다.
    await svc(`update public.generation_jobs set lease_until = now() - interval '1 second' where reading_id = $1`, [readingId]);
    await claim(userA, readingId);
    await expect(record(readingId, 2, "completed", { inputTokens: 300, outputTokens: 100, cachedInputTokens: 0, calls: 2, callsWithoutUsage: 1, complete: true })).rejects.toThrow(
      /generation_attempts_complete_check/,
    );
  });

  it("운영 문서(docs/LLM_OPERATIONS.md)의 조회 SQL이 실제 스키마에서 실행된다", async () => {
    const readingId = await paidReading();
    await claim(userA, readingId);
    await record(readingId, 1, "completed", { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600, calls: 1, callsWithoutUsage: 0, complete: true });
    const doc = readFileSync(path.resolve(process.cwd(), "docs/LLM_OPERATIONS.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 토큰 사용량 기록"), doc.indexOf("## 공식 문서 확인 결과"));
    const statements = [...section.matchAll(/```sql\r?\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1]!.split(/;\s*(?:\r?\n|$)/))
      .map((sql) => sql.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements.length).toBe(5);
    const results = [];
    for (const sql of statements) results.push(await svc(sql.replaceAll("'<풀이 ID>'", `'${readingId}'`)));
    expect(Number((results[0]![0] as { total_tokens: string }).total_tokens)).toBe(1200);
    expect(Number((results[0]![0] as { uncached_input_tokens: string }).uncached_input_tokens)).toBe(400);
  });

  it("사용량 기록은 서버 전용이다: 본인도 브라우저 권한으로 읽거나 쓸 수 없다", async () => {
    const readingId = await paidReading();
    await claim(userA, readingId);
    await record(readingId, 1, "completed", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, calls: 1, callsWithoutUsage: 0, complete: true });
    for (const role of ["authenticated", "anon"] as const) {
      const user = role === "authenticated" ? userA : null;
      await expect(db.run(role, user, `select * from public.generation_attempts`)).rejects.toThrow(/permission denied/);
      await expect(db.run(role, user, `select * from public.generation_usage`)).rejects.toThrow(/permission denied/);
      await expect(db.run(role, user, `select record_generation_attempt(gen_random_uuid(), 1, 'completed', '{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    }
  });
});
