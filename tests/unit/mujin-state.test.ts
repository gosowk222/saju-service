import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_NOW } from "@/domain/mujin/now";
import type { ScrollSectionContent } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeMujinBirth } from "@/server/engine/mujin";
import { searchPlaces } from "@/server/places/search";
import { SCROLL_SETTINGS } from "@/server/scroll/config";
import { createScrollReading } from "@/server/scroll/create";
import { buildScrollStateView, loadScrollState, type ScrollStateInput, type UnitStateRecord } from "@/server/scroll/state";
import { createScrollStore, loadFinalSections } from "@/server/scroll/store";
import { prepareScrollTiming } from "@/server/scroll/timing";
import { createTestDb, type DbRole, type TestDb } from "../support/test-db";

/**
 * 족자 화면 상태(state.ts). 권한이 없으면 유료 장 본문과 기간표가 응답에 섞이지 않는지, 다른 회원에게는 없는 풀이인지,
 * 생성 진행 상태(대기·작성 중·완료·실패)가 저장 상태와 맞는지 본다.
 * 앞부분은 순수 함수, 뒷부분은 실제 migration을 적용한 PGlite와 사용자 권한(RLS)으로 확인한다. 입력은 모두 가상 값이다.
 */

const NOW = Date.parse("2026-11-12T03:00:00Z");
const LEASE_MS = SCROLL_SETTINGS.leaseSeconds * 1000;
const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const known: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };

let base: ReturnType<typeof analyzeMujinBirth>;

const content = (sectionId: string): ScrollSectionContent => ({
  sectionId,
  coreAnswer: `${sectionId} 핵심 답`,
  blocks: [{ type: "paragraph", questionIds: [], refs: ["m1", "q1"], text: "가상 본문", items: [] }],
});

const unit = (unitId: string, extra: Partial<UnitStateRecord> = {}): UnitStateRecord => ({
  unitId,
  status: "pending",
  draftAttempts: 0,
  voiceAttempts: 0,
  errorStage: null,
  updatedAt: new Date(NOW).toISOString(),
  ...extra,
});

function input(extra: Partial<ScrollStateInput> = {}): ScrollStateInput {
  return {
    reading: { id: "r1", persona_id: "mujin", nickname: "가람", created_at: new Date(NOW).toISOString(), chart: base.chart },
    product: MUJIN_OVERVIEW,
    personaName: "무진 도사",
    plan: base.plan,
    entitled: false,
    freeRun: null,
    job: null,
    units: [],
    finals: [],
    timing: null,
    now: NOW,
    ...extra,
  };
}

const running = (claimedAgoMs = 1_000) => ({
  status: "running",
  attempts: 1,
  leaseUntil: new Date(NOW - claimedAgoMs + LEASE_MS).toISOString(),
  errorCode: null,
  errorRetryable: null,
});

const sectionOf = (view: ReturnType<typeof buildScrollStateView>, id: string) => view.sections.find((section) => section.id === id)!;

beforeAll(() => {
  base = analyzeMujinBirth({ birth: toPublicBirthInput(known), product: MUJIN_OVERVIEW, nickname: "가람", now: EMPTY_NOW });
});

describe("화면 상태 만들기 (순수 함수)", () => {
  it("권한이 없으면 유료 장은 잠금이고 본문·기간표가 없다 (완성문이 넘어와도 쓰지 않는다)", () => {
    const view = buildScrollStateView(
      input({
        finals: [
          { sectionId: "ch1", tier: "free", content: content("ch1") },
          // RLS가 잘못되어 유료 완성문이 넘어온 경우에도 화면에는 내보내지 않는다.
          { sectionId: "ch2", tier: "paid", content: content("ch2") },
          // tier가 잘못 저장된 유료 장도 상품 정의의 tier로 거른다.
          { sectionId: "ch3", tier: "free", content: content("ch3") },
        ],
        job: { ...running(), referenceDate: "2026-11-12" },
        timing: { luck: { status: "unavailable", reason: "hour-unknown", referenceAt: "", previous: null, current: null, next: null }, months: {} as never },
      }),
    );
    expect(view.entitled).toBe(false);
    expect(view.paid).toEqual({ status: "locked", canRetry: false, errorCode: null, referenceDate: null });
    expect(view.timing).toBeNull();
    for (const section of view.sections.filter((entry) => entry.tier === "paid")) {
      expect(section.state).toBe("locked");
      expect(section.content).toBeNull();
    }
    expect(sectionOf(view, "ch1")).toMatchObject({ state: "done", content: { coreAnswer: "ch1 핵심 답" } });
    expect(JSON.stringify(view)).not.toContain("ch2 핵심 답");
    expect(JSON.stringify(view)).not.toContain("ch3 핵심 답");
  });

  it("원국표 칸은 done이고 본문이 없으며, 장 순서는 목차 순서다. 블록의 작성용 참조는 보내지 않는다", () => {
    const view = buildScrollStateView(input({ finals: [{ sectionId: "ch1", tier: "free", content: content("ch1") }] }));
    expect(view.sections.map((section) => section.id)).toEqual(MUJIN_OVERVIEW.scroll.sections.map((section) => section.id));
    expect(sectionOf(view, "chart")).toMatchObject({ state: "done", content: null, tables: ["pillars"] });
    expect(sectionOf(view, "ch1").content?.blocks[0]?.refs).toEqual([]);
    expect(view).toMatchObject({ productId: "mujin-overview", personaName: "무진 도사", hourKnown: true, tables: base.plan.tables });
  });

  it("단계 상태: 처음은 idle, 점유가 만료되면 queued, 재시도 가능 여부는 오류 성격과 시작 횟수로 정한다", () => {
    expect(buildScrollStateView(input()).free).toEqual({ status: "idle", canRetry: false, errorCode: null });
    expect(buildScrollStateView(input({ freeRun: running() })).free.status).toBe("running");
    expect(buildScrollStateView(input({ freeRun: running(LEASE_MS + 1_000) })).free.status).toBe("queued");
    expect(buildScrollStateView(input({ freeRun: { ...running(), status: "queued", leaseUntil: null } })).free.status).toBe("queued");
    const failed = { status: "failed", attempts: 2, leaseUntil: null, errorCode: "units_failed", errorRetryable: true };
    expect(buildScrollStateView(input({ freeRun: failed })).free).toEqual({ status: "failed", canRetry: true, errorCode: "units_failed" });
    expect(buildScrollStateView(input({ freeRun: { ...failed, errorRetryable: false } })).free.canRetry).toBe(false);
    expect(buildScrollStateView(input({ freeRun: { ...failed, attempts: SCROLL_SETTINGS.freeMaxRuns } })).free.canRetry).toBe(false);
    const paid = buildScrollStateView(input({ entitled: true, job: { ...failed, attempts: 3, referenceDate: "2026-11-12" } })).paid;
    expect(paid).toEqual({ status: "failed", canRetry: true, errorCode: "units_failed", referenceDate: "2026-11-12" });
    expect(buildScrollStateView(input({ entitled: true, job: { ...running(), status: "queued", leaseUntil: null, referenceDate: null } })).paid.status).toBe("queued");
  });

  it("실행 중이면 초안을 저장한 장과 지금 Pass 1 묶음의 장만 작성 중이고, 그 뒤 묶음은 대기다", () => {
    const view = buildScrollStateView(
      input({
        freeRun: running(),
        units: [unit("basics-structure", { status: "done" }), unit("basics-elements", { status: "drafted" })],
        finals: [{ sectionId: "basics-structure", tier: "free", content: content("basics-structure") }],
      }),
    );
    expect(sectionOf(view, "basics-structure").state).toBe("done");
    expect(sectionOf(view, "basics-elements").state).toBe("writing");
    expect(sectionOf(view, "basics-stages").state).toBe("writing");
    expect(sectionOf(view, "basics-ten-gods").state).toBe("writing");
    expect(sectionOf(view, "ch1").state).toBe("waiting");
    // 실행 중이 아니면 쓰는 칸이 없다.
    const idle = buildScrollStateView(input({ units: [unit("basics-elements", { status: "drafted" })] }));
    expect(idle.sections.filter((section) => section.state === "writing")).toEqual([]);
  });

  it("진행 중인 단계의 실패 장: 이번 시작 전에 실패한 장은 이 실행이 다시 쓰고(작성 중), 이번 실행에서 실패했지만 시도 수가 남은 장은 대기, 시도 수를 다 쓴 장만 실패다", () => {
    const before = new Date(NOW - 60_000).toISOString();
    const after = new Date(NOW - 500).toISOString();
    const view = buildScrollStateView(
      input({
        freeRun: running(10_000),
        units: [
          unit("basics-structure", { status: "failed", errorStage: "draft", draftAttempts: 1, updatedAt: before }),
          unit("basics-elements", { status: "failed", errorStage: "voice", voiceAttempts: 1, updatedAt: before }),
          unit("basics-stages", { status: "failed", errorStage: "draft", draftAttempts: SCROLL_SETTINGS.draftAttemptsPerUnit, updatedAt: before }),
          unit("basics-ten-gods", { status: "failed", errorStage: "draft", draftAttempts: 1, updatedAt: after }),
        ],
      }),
    );
    expect(sectionOf(view, "basics-structure").state).toBe("writing");
    expect(sectionOf(view, "basics-elements").state).toBe("writing");
    expect(sectionOf(view, "basics-stages").state).toBe("failed");
    // 이번 실행에서 실패했지만 시도 수가 남았다: 다음 요청이 곧 다시 쓴다 ('횟수를 모두 썼어요'가 아니다).
    expect(sectionOf(view, "basics-ten-gods").state).toBe("waiting");
    // 실행 중이 아니면(단계 기록 없음) 실패는 그대로 실패다.
    const stopped = buildScrollStateView(input({ units: [unit("basics-structure", { status: "failed", errorStage: "draft", draftAttempts: 1, updatedAt: before })] }));
    expect(sectionOf(stopped, "basics-structure").state).toBe("failed");
  });

  it("반납 직후(queued)나 점유가 만료된 단계도 시도 수가 남은 실패 장은 대기이고, 시도 수를 다 쓴 장만 실패다", () => {
    const failedUnits = [
      unit("basics-structure", { status: "failed", errorStage: "voice", voiceAttempts: 1 }),
      unit("basics-elements", { status: "failed", errorStage: "draft", draftAttempts: 2 }),
      unit("basics-stages", { status: "failed", errorStage: "voice", voiceAttempts: SCROLL_SETTINGS.voiceAttemptsPerUnit }),
    ];
    const released = buildScrollStateView(input({ freeRun: { ...running(), status: "queued", leaseUntil: null }, units: failedUnits }));
    expect(released.free.status).toBe("queued");
    expect(sectionOf(released, "basics-structure").state).toBe("waiting");
    expect(sectionOf(released, "basics-elements").state).toBe("waiting");
    expect(sectionOf(released, "basics-stages").state).toBe("failed");

    const expired = buildScrollStateView(input({ freeRun: running(LEASE_MS + 1_000), units: failedUnits }));
    expect(expired.free.status).toBe("queued");
    expect(sectionOf(expired, "basics-structure").state).toBe("waiting");
    expect(sectionOf(expired, "basics-stages").state).toBe("failed");

    // 유료 단계도 같다.
    const paid = buildScrollStateView(
      input({
        entitled: true,
        job: { ...running(), status: "queued", leaseUntil: null, referenceDate: "2026-11-12" },
        units: [unit("ch3", { status: "failed", errorStage: "draft", draftAttempts: 1 }), unit("ch4", { status: "failed", errorStage: "draft", draftAttempts: 3 })],
      }),
    );
    expect(sectionOf(paid, "ch3").state).toBe("waiting");
    expect(sectionOf(paid, "ch4").state).toBe("failed");
  });

  it("단계 전체가 실패로 끝났으면 장별 실패 기록이 없어도 그 단계의 끝나지 않은 칸은 모두 실패다 (원국표·완성 칸·잠긴 칸 제외)", () => {
    // 질문 정리 실패처럼 장을 쓰기 전에 단계가 실패했다 (reading_units 행이 없다).
    const classifyFailed = { status: "failed", attempts: 1, leaseUntil: null, errorCode: "timeout", errorRetryable: true };
    const free = buildScrollStateView(input({ freeRun: classifyFailed }));
    expect(free.free).toEqual({ status: "failed", canRetry: true, errorCode: "timeout" });
    expect(sectionOf(free, "chart")).toMatchObject({ state: "done", content: null });
    for (const id of ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"]) {
      expect(sectionOf(free, id)).toMatchObject({ state: "failed", content: null });
    }
    // 권한이 없으면 유료 칸은 잠금 그대로다.
    expect(free.sections.filter((section) => section.tier === "paid").every((section) => section.state === "locked")).toBe(true);

    // 저장 오류로 단계가 실패했다: 완성된 칸은 그대로, 초안만 있거나 행이 없는 칸은 실패다. 다시 시도할 수 없으면 canRetry가 false다.
    const saveFailed = buildScrollStateView(
      input({
        freeRun: { ...classifyFailed, errorCode: "internal", errorRetryable: false },
        units: [unit("basics-structure", { status: "done" }), unit("basics-elements", { status: "drafted" })],
        finals: [{ sectionId: "basics-structure", tier: "free", content: content("basics-structure") }],
      }),
    );
    expect(saveFailed.free).toMatchObject({ status: "failed", canRetry: false });
    expect(sectionOf(saveFailed, "basics-structure").state).toBe("done");
    expect(sectionOf(saveFailed, "basics-elements")).toMatchObject({ state: "failed", content: null });
    expect(sectionOf(saveFailed, "ch1").state).toBe("failed");

    // 유료 단계가 단계 단위로 실패했다 (기준일 고정 실패 등): 유료의 끝나지 않은 칸만 실패이고 무료 칸은 그대로다.
    const paid = buildScrollStateView(
      input({
        entitled: true,
        freeRun: { status: "completed", attempts: 1, leaseUntil: null, errorCode: null, errorRetryable: null },
        job: { status: "failed", attempts: 2, leaseUntil: null, errorCode: "reference_date_unavailable", errorRetryable: true, referenceDate: null },
        units: [unit("ch2", { status: "done" })],
        finals: [
          { sectionId: "ch1", tier: "free", content: content("ch1") },
          { sectionId: "ch2", tier: "paid", content: content("ch2") },
        ],
      }),
    );
    expect(paid.paid).toMatchObject({ status: "failed", canRetry: true, errorCode: "reference_date_unavailable" });
    expect(sectionOf(paid, "ch1").state).toBe("done");
    expect(sectionOf(paid, "ch2").state).toBe("done");
    for (const id of ["ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10", "closing"]) {
      expect(sectionOf(paid, id)).toMatchObject({ state: "failed", content: null });
    }
    // 끝나지 않은 무료 칸은 무료 단계가 실패가 아니면 실패로 바꾸지 않는다.
    expect(sectionOf(paid, "basics-elements").state).toBe("waiting");
  });
});

// ─── PGlite: 실제 migration과 사용자 권한(RLS) ─────────────────────

/**
 * PostgREST처럼 동작하는 최소 클라이언트. 가짜 게이트웨이(tests/support/fake-gateway.ts)와 같은 방식으로 RPC와 조회를 SQL로 옮기고,
 * 역할(service_role·authenticated)과 사용자를 정해 한 트랜잭션으로 실행한다. 응답은 JSON으로 한 번 바꿔 날짜를 문자열로 받는다.
 */
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

describe("loadScrollState (PGlite, 실제 migration과 RLS)", () => {
  let db: TestDb;
  const owner = randomUUID();
  const other = randomUUID();
  const admin = () => pgClient(db, "service_role", null);
  const as = (userId: string) => pgClient(db, "authenticated", userId);
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db.run<T>("service_role", null, text, params);
  const claim = { retry: false, model: "fake-model", promptVersion: "mujin-1.0.0", schemaVersion: "mujin-draft-schema-1.0.0", reasoningEffort: "medium", leaseSeconds: 300 };

  async function newReading(): Promise<string> {
    const geonameId = searchPlaces("서울")[0]!.geonameId;
    return createScrollReading(
      owner,
      {
        productId: "mujin-overview",
        nickname: "가람",
        gender: "female",
        yymmdd: "980919",
        calendar: "solar",
        isLeapMonth: false,
        geonameId,
        birthTime: { status: "branch", branch: "신" },
        situationId: null,
        concern: "",
        now: EMPTY_NOW,
      },
      { admin: admin() },
    );
  }

  async function redeem(readingId: string): Promise<void> {
    await sql(`select grant_free_ticket($1, 'free-trial-2026-11')`, [owner]);
    const [row] = await sql<{ r: { outcome: string } }>(`select redeem_free_ticket($1, $2, $3, 'mujin-overview', '1.0.0', 3, '{}'::jsonb) as r`, [owner, readingId, randomUUID()]);
    expect(row?.r.outcome).toBe("redeemed");
  }

  beforeAll(async () => {
    db = await createTestDb();
    await db.addUser(owner);
    await db.addUser(other);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("권한이 없으면 유료 장 본문은 null이고(유료 완성문이 남아 있어도), 무료 장은 보이며, 다른 회원에게는 없는 풀이다", async () => {
    const store = createScrollStore(admin());
    const readingId = await newReading();

    const free = await store.claimFree({ ...claim, userId: owner, readingId, maxAttempts: 8, dailyLimit: 10 });
    expect(free.claimed).toBe(true);
    const freeAttempt = free.claimed ? free.run.attempts : 0;
    const draft = { ...content("basics-structure"), scenes: [] };
    expect(await store.saveDraft({ readingId, tier: "free", attempt: freeAttempt, unitId: "basics-structure", draft, meta: {} })).toBe(true);
    expect(await store.saveFinal({ readingId, tier: "free", attempt: freeAttempt, unitId: "basics-structure", content: content("basics-structure"), meta: {} })).toBe(true);

    // 이용권으로 유료 장 하나를 쓴 뒤 이용권을 돌려받아 권한이 사라진 풀이 (유료 완성문은 표에 남아 있다).
    await redeem(readingId);
    const paid = await store.claimPaid({ ...claim, userId: owner, readingId, maxAttempts: 20 });
    expect(paid.claimed).toBe(true);
    const paidAttempt = paid.claimed ? paid.run.attempts : 0;
    expect(await store.saveDraft({ readingId, tier: "paid", attempt: paidAttempt, unitId: "ch2", draft: { ...content("ch2"), scenes: [] }, meta: {} })).toBe(true);
    expect(await store.saveFinal({ readingId, tier: "paid", attempt: paidAttempt, unitId: "ch2", content: content("ch2"), meta: {} })).toBe(true);
    expect(await store.releaseRun("paid", readingId, paidAttempt)).toBe(true);
    const [ticket] = await sql<{ id: string }>(`select id from public.free_tickets where user_id = $1`, [owner]);
    await sql(`select restore_free_ticket($1, '가상 반환 사유')`, [ticket!.id]);
    expect(await sql(`select 1 from public.entitlements where reading_id = $1`, [readingId])).toHaveLength(0);
    expect(await sql(`select 1 from public.reading_sections where reading_id = $1 and section_id = 'ch2'`, [readingId])).toHaveLength(1);

    // RLS: 소유자도 권한 없이는 유료 완성문을 읽지 못한다.
    expect((await loadFinalSections(as(owner), readingId)).map((section) => section.sectionId)).toEqual(["basics-structure"]);

    const view = await loadScrollState(owner, readingId, { user: as(owner), admin: admin() });
    expect(view).not.toBeNull();
    expect(view!.entitled).toBe(false);
    expect(view!.paid.status).toBe("locked");
    expect(view!.timing).toBeNull();
    for (const section of view!.sections.filter((entry) => entry.tier === "paid")) {
      expect(section.state).toBe("locked");
      expect(section.content).toBeNull();
    }
    expect(JSON.stringify(view)).not.toContain("ch2 핵심 답");
    expect(view!.sections.find((section) => section.id === "basics-structure")).toMatchObject({ state: "done", content: { coreAnswer: "basics-structure 핵심 답" } });
    expect(view!.sections.find((section) => section.id === "basics-elements")?.state).toBe("writing");
    expect(view!.sections.find((section) => section.id === "chart")).toMatchObject({ state: "done", content: null });
    expect(view!.free.status).toBe("running");
    // 초안·근거 ID는 응답에 없다.
    expect(JSON.stringify(view)).not.toContain('"draft"');
    expect(JSON.stringify(view)).not.toContain('"m1"');

    expect(await loadScrollState(other, readingId, { user: as(other), admin: admin() })).toBeNull();
    expect(await loadScrollState(owner, randomUUID(), { user: as(owner), admin: admin() })).toBeNull();
  });

  it("권한이 있으면 유료 완성문과 고정된 기준일의 기간표를 함께 보낸다", async () => {
    const store = createScrollStore(admin());
    const readingId = await newReading();
    await redeem(readingId);
    const paid = await store.claimPaid({ ...claim, userId: owner, readingId, maxAttempts: 20 });
    const attempt = paid.claimed ? paid.run.attempts : 0;
    expect(await store.fixReferenceDate(readingId, "2026-11-12")).toBe("2026-11-12");
    const loaded = await store.loadReading(readingId, owner);
    await prepareScrollTiming({ admin: admin(), readingId, birth: loaded!.reading.birth_input, referenceDate: "2026-11-12", gender: loaded!.plan.gender });
    expect(await store.saveDraft({ readingId, tier: "paid", attempt, unitId: "ch2", draft: { ...content("ch2"), scenes: [] }, meta: {} })).toBe(true);
    expect(await store.saveFinal({ readingId, tier: "paid", attempt, unitId: "ch2", content: content("ch2"), meta: {} })).toBe(true);

    const view = await loadScrollState(owner, readingId, { user: as(owner), admin: admin() });
    expect(view!.entitled).toBe(true);
    expect(view!.paid).toMatchObject({ status: "running", referenceDate: "2026-11-12" });
    expect(view!.timing?.months.months).toHaveLength(12);
    expect(view!.timing?.luck.status).toBe("available");
    expect(view!.sections.find((section) => section.id === "ch2")).toMatchObject({ state: "done", content: { coreAnswer: "ch2 핵심 답" } });
    expect(view!.sections.find((section) => section.id === "ch3")?.state).toBe("writing");
    expect(view!.sections.find((section) => section.id === "ch4")?.state).toBe("waiting");
    // 기간 재료의 분야별 원래 분석(근거 ID 포함)은 보내지 않는다.
    expect(Object.keys(view!.timing!)).toEqual(["luck", "months"]);
  });
});
