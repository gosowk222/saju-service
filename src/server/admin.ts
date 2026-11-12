import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";

/**
 * 관리자 화면의 서버 작업. 호출 전에 requireApiAdmin/requirePageAdmin으로 관리자인지 확인하고,
 * DB 함수도 관리자 역할을 한 번 더 확인한다 (not_admin).
 */

export interface MemberRow {
  readonly id: string;
  /** 카카오가 준 표시용 이름. 권한 판단에는 쓰지 않는다. */
  readonly name: string | null;
  readonly email: string | null;
  readonly created_at: string;
  readonly last_sign_in_at: string | null;
  readonly role: "user" | "admin";
  readonly kakao: boolean;
  readonly tickets_available: number;
  readonly tickets_used: number;
}

export async function listMembers(adminId: string, search: string | null): Promise<MemberRow[]> {
  const { data, error } = await createSupabaseAdminClient().rpc("admin_list_members", {
    p_admin_id: adminId,
    p_search: search,
    p_limit: 100,
  });
  if (error) throw new ApiError(500, "members_failed", "회원 목록을 불러오지 못했어요.");
  return (data ?? []) as MemberRow[];
}

/** 풀이 상품 이용 범위. true면 모든 회원, false면 관리자만. */
export async function setReadingsOpenToAll(adminId: string, open: boolean): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().rpc("set_readings_open_to_all", {
    p_admin_id: adminId,
    p_open: open,
  });
  if (error) {
    if (error.message?.includes("not_admin")) throw new ApiError(404, "not_found", "찾을 수 없어요.");
    throw new ApiError(500, "setting_failed", "설정을 저장하지 못했어요.");
  }
  return (data as { openToAll: boolean }).openToAll;
}

// ─── 무진 생성 사용량 (llm_calls, admin_llm_usage) ─────────────────────────────────────────

/**
 * 호출 단위 사용량의 합계 칸. 토큰은 API가 돌려준 값만 더한 것이고, 받은 값이 하나도 없으면 null(모름)이다.
 * cachedInputTokens는 inputTokens에, reasoningTokens는 outputTokens에 이미 들어 있다. totalTokens = inputTokens + outputTokens.
 */
export interface LlmUsageTotals {
  readonly calls: number;
  readonly callsWithUsage: number;
  readonly callsWithoutUsage: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  /** 사용량을 받지 못한 호출이 없고, 받은 호출의 입력·출력·캐시 값이 모두 있으면 true. */
  readonly usageComplete: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export type LlmUsageStepName = "classify" | "pass1" | "pass2" | "followup";

export interface LlmUsageStep extends LlmUsageTotals {
  readonly tier: "free" | "paid" | null;
  readonly step: LlmUsageStepName;
  readonly models: readonly string[];
  readonly promptVersions: readonly string[];
}

/**
 * DB에 저장된 시각으로 계산한 생성 시간 (밀리초). 계산할 시각이 없으면 null.
 * 실제 화면에 보이기까지의 시간은 서버가 알 수 없어 넣지 않는다 (화면이 저장 상태를 주기적으로 받아 그린다).
 */
export interface GenerationTimings {
  /** 무료 단계 시작(reading_free_runs.started_at) → 첫 무료 칸 최종문 저장(reading_sections.created_at). */
  readonly freeFirstMs: number | null;
  /** 무료 단계 시작 → 무료 단계 완료(reading_free_runs.completed_at). */
  readonly freeDoneMs: number | null;
  /** 구매 권한(entitlements.created_at) → 첫 유료 장 최종문 저장. 앞의 무료 단계가 끝나기를 기다린 시간도 들어 있다. */
  readonly paidFirstMs: number | null;
  /** 구매 권한 → 유료 단계 완료(generation_jobs.completed_at). */
  readonly paidDoneMs: number | null;
}

export interface LlmUsageReading {
  readonly readingId: string;
  readonly productId: string | null;
  readonly productVersion: string | null;
  readonly personaId: string | null;
  readonly personaVersion: string | null;
  readonly createdAt: string | null;
  readonly firstCallAt: string | null;
  readonly lastCallAt: string | null;
  readonly steps: readonly LlmUsageStep[];
  readonly total: LlmUsageTotals;
  readonly timings: GenerationTimings;
}

export interface LlmUsageReport {
  readonly limit: number;
  readonly readings: readonly LlmUsageReading[];
  /** 나열한 풀이 전체의 합계. */
  readonly total: LlmUsageTotals;
}

const EMPTY_TIMINGS: GenerationTimings = { freeFirstMs: null, freeDoneMs: null, paidFirstMs: null, paidDoneMs: null };

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** 합계는 드라이버에 따라 문자열로 올 수 있다. 숫자가 아니면 null(모름)로 둔다. 0은 0이다. */
const count = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const texts = (value: unknown): string[] => asList(value).filter((item): item is string => typeof item === "string");

function totalsOf(raw: unknown): LlmUsageTotals {
  const value = asRecord(raw);
  return {
    calls: count(value.calls) ?? 0,
    callsWithUsage: count(value.callsWithUsage) ?? 0,
    callsWithoutUsage: count(value.callsWithoutUsage) ?? 0,
    inputTokens: count(value.inputTokens),
    cachedInputTokens: count(value.cachedInputTokens),
    uncachedInputTokens: count(value.uncachedInputTokens),
    outputTokens: count(value.outputTokens),
    reasoningTokens: count(value.reasoningTokens),
    totalTokens: count(value.totalTokens),
    usageComplete: value.usageComplete === true,
    startedAt: text(value.startedAt),
    endedAt: text(value.endedAt),
  };
}

const STEP_NAMES: readonly LlmUsageStepName[] = ["classify", "pass1", "pass2", "followup"];

/**
 * admin_llm_usage(p_limit)의 결과를 화면용 값으로 읽는다. 사용자 ID, 별명, 질문·생성 원문은 옮기지 않는다
 * (DB 함수도 원문을 담지 않는다). 모르는 단계 이름은 버린다.
 */
export function parseLlmUsage(raw: unknown): LlmUsageReport {
  const value = asRecord(raw);
  return {
    limit: count(value.limit) ?? 0,
    readings: asList(value.readings).flatMap((entry) => {
      const reading = asRecord(entry);
      const readingId = text(reading.readingId);
      if (!readingId) return [];
      return [
        {
          readingId,
          productId: text(reading.productId),
          productVersion: text(reading.productVersion),
          personaId: text(reading.personaId),
          personaVersion: text(reading.personaVersion),
          createdAt: text(reading.createdAt),
          firstCallAt: text(reading.firstCallAt),
          lastCallAt: text(reading.lastCallAt),
          steps: asList(reading.steps).flatMap((item) => {
            const step = asRecord(item);
            const name = STEP_NAMES.find((candidate) => candidate === step.step);
            if (!name) return [];
            const tier = step.tier === "free" || step.tier === "paid" ? step.tier : null;
            return [{ ...totalsOf(step), tier, step: name, models: texts(step.models), promptVersions: texts(step.promptVersions) }];
          }),
          total: totalsOf(reading.total),
          timings: EMPTY_TIMINGS,
        },
      ];
    }),
    total: totalsOf(value.total),
  };
}

/** 생성 시간 계산에 쓰는 행 (서버 권한으로 읽는다). 본문(content)과 원문은 읽지 않는다. */
export interface TimingRows {
  readonly freeRuns: readonly { readonly reading_id: string; readonly started_at: string | null; readonly completed_at: string | null }[];
  readonly sections: readonly { readonly reading_id: string; readonly tier: string; readonly created_at: string }[];
  readonly entitlements: readonly { readonly reading_id: string; readonly created_at: string }[];
  readonly jobs: readonly { readonly reading_id: string; readonly status: string; readonly started_at: string | null; readonly completed_at: string | null }[];
}

const timeOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};
const between = (start: number | null, end: number | null): number | null => (start !== null && end !== null && end >= start ? end - start : null);

/** 풀이 하나의 생성 시간. 시각이 없거나 순서가 맞지 않으면(시계 차이 등) 그 칸은 null이다. */
export function generationTimings(rows: TimingRows, readingId: string): GenerationTimings {
  const run = rows.freeRuns.find((row) => row.reading_id === readingId);
  const entitlement = rows.entitlements.find((row) => row.reading_id === readingId);
  const job = rows.jobs.find((row) => row.reading_id === readingId);
  const firstOf = (tier: string) => {
    const times = rows.sections
      .filter((row) => row.reading_id === readingId && row.tier === tier)
      .map((row) => timeOf(row.created_at))
      .filter((value): value is number => value !== null);
    return times.length ? Math.min(...times) : null;
  };
  const freeStart = timeOf(run?.started_at);
  const paidStart = timeOf(entitlement?.created_at);
  return {
    freeFirstMs: between(freeStart, firstOf("free")),
    freeDoneMs: between(freeStart, timeOf(run?.completed_at)),
    paidFirstMs: between(paidStart, firstOf("paid")),
    paidDoneMs: job?.status === "completed" ? between(paidStart, timeOf(job.completed_at)) : null,
  };
}

async function loadTimingRows(client: SupabaseClient, readingIds: readonly string[]): Promise<TimingRows | null> {
  const ids = [...readingIds];
  const [freeRuns, sections, entitlements, jobs] = await Promise.all([
    client.from("reading_free_runs").select("reading_id, started_at, completed_at").in("reading_id", ids),
    client.from("reading_sections").select("reading_id, tier, created_at").in("reading_id", ids),
    client.from("entitlements").select("reading_id, created_at").in("reading_id", ids),
    client.from("generation_jobs").select("reading_id, status, started_at, completed_at").in("reading_id", ids),
  ]);
  const failed = [freeRuns, sections, entitlements, jobs].find((result) => result.error);
  if (failed) {
    console.warn("[admin] timings unavailable", { code: (failed.error as { code?: string } | null)?.code ?? "unknown" });
    return null;
  }
  return {
    freeRuns: (freeRuns.data ?? []) as TimingRows["freeRuns"],
    sections: (sections.data ?? []) as TimingRows["sections"],
    entitlements: (entitlements.data ?? []) as TimingRows["entitlements"],
    jobs: (jobs.data ?? []) as TimingRows["jobs"],
  };
}

/** 관리자 화면에 보이는 풀이 수의 기본값과 상한 (DB 함수는 1~200으로 맞춘다). */
export const LLM_USAGE_LIMIT = 20;

/**
 * 최근 호출 순 풀이의 단계별(무료/유료 × 질문 정리/Pass 1/Pass 2/후속 질문) 호출 수와 토큰, 생성 시간.
 * 화면이 requirePageAdmin으로 먼저 막고, 여기서도 관리자 역할을 DB에서 다시 확인한다 (다른 관리자 함수의 not_admin과 같은 이중 확인).
 * admin_llm_usage는 서버 역할(service_role)만 실행할 수 있다.
 */
export async function loadLlmUsage(adminId: string, limit = LLM_USAGE_LIMIT, client: SupabaseClient = createSupabaseAdminClient()): Promise<LlmUsageReport> {
  const access = await client.rpc("get_reading_access", { p_user_id: adminId });
  if (access.error || (access.data as { role?: string } | null)?.role !== "admin") throw new ApiError(404, "not_found", "찾을 수 없어요.");
  const { data, error } = await client.rpc("admin_llm_usage", { p_limit: limit });
  if (error) throw new ApiError(500, "usage_failed", "사용량을 불러오지 못했어요.");
  const report = parseLlmUsage(data);
  const rows = report.readings.length ? await loadTimingRows(client, report.readings.map((reading) => reading.readingId)) : null;
  return rows ? { ...report, readings: report.readings.map((reading) => ({ ...reading, timings: generationTimings(rows, reading.readingId) })) } : report;
}

// ─── 화면 표시 ─────────────────────────────────────────

const STEP_LABEL: Readonly<Record<LlmUsageStepName, string>> = {
  classify: "질문 정리",
  pass1: "초안 (Pass 1)",
  pass2: "무진 문장 (Pass 2)",
  followup: "후속 질문",
};

/** 단계 이름 (예: 유료 · 무진 문장 (Pass 2)). */
export function usageStepLabel(step: Pick<LlmUsageStep, "tier" | "step">): string {
  const tier = step.tier === "free" ? "무료" : step.tier === "paid" ? "유료" : "단계 없음";
  return `${tier} · ${STEP_LABEL[step.step]}`;
}

const tokens = (value: number | null) => (value === null ? "모름" : value.toLocaleString("ko-KR"));

/**
 * 합계 칸의 표시 글자. 합계는 입력 + 출력이며 캐시 입력과 추론 토큰을 다시 더하지 않는다 (둘 다 이미 포함된 값).
 * 받지 못한 값은 0이 아니라 '모름'으로 보여 준다.
 */
export function usageCells(totals: LlmUsageTotals): {
  readonly calls: string;
  readonly callsWithUsage: string;
  readonly inputTokens: string;
  readonly cachedInputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string;
  readonly usageComplete: string;
} {
  const total = totals.inputTokens !== null && totals.outputTokens !== null ? totals.inputTokens + totals.outputTokens : totals.totalTokens;
  return {
    calls: totals.calls.toLocaleString("ko-KR"),
    callsWithUsage: totals.callsWithUsage.toLocaleString("ko-KR"),
    inputTokens: tokens(totals.inputTokens),
    cachedInputTokens: tokens(totals.cachedInputTokens),
    outputTokens: tokens(totals.outputTokens),
    totalTokens: tokens(total),
    usageComplete: totals.usageComplete ? "예" : "아니요",
  };
}

/** 시간 표시 (예: 12.3초, 3분 2초). 계산할 수 없으면 '기록 없음'. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "기록 없음";
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}초`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}
