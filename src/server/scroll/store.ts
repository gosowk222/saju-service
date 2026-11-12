import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicBirthInput } from "sajuengine";
import type { MujinPlan, MujinTimingBundle, ScrollDraftContent, ScrollSectionContent, ScrollTier } from "@/domain/mujin/types";
import type { ChartView } from "@/domain/reading/types";
import { supabaseCallWriter, type LlmCallRow } from "@/server/llm/call-log";

/**
 * 무진 족자 생성의 저장소 래퍼. 모든 쓰기는 supabase/migrations의 서버 전용 함수(RPC)로 한다
 * (20261113120000_mujin_scroll.sql: claim_free_run, save_unit_draft, save_unit_final, fail_unit, release_generation 등).
 *
 * - admin은 서버(service_role) 클라이언트다. 호출 전에 사용자 ID를 서버가 확인한다 (풀이 소유는 user_id 조건으로 다시 본다).
 * - 사용자 클라이언트를 넘기는 함수(loadFinalSections)는 RLS가 무료 장·구매 권한을 강제한다.
 * - 저장소 오류는 앱 고정 코드의 Error로 바꿔 던진다. 로그에는 이 코드만 남는다 (생성 문장, 질문 원문, 출생정보 없음).
 * - 쿼리는 eq·order·maybeSingle과 RPC만 쓴다 (테스트용 가짜 게이트웨이와 같은 범위).
 */

type Db = SupabaseClient;

/** 질문 분석 저장 키 (reading_analyses.cache_key). 궁금한 점을 처음 정리한 결과 하나만 둔다. */
export const SCROLL_QUESTION_KEY = "mujin-question:initial";

/** 9·10장 기간 재료 저장 키. 기준일마다 하나다 (첫 유료 생성 때 고정한 기준일만 쓴다). */
export const scrollTimingKey = (referenceDate: string) => `mujin-timing:${referenceDate}`;

/** 생성 실행기가 읽는 풀이 기록 칸. 소유자 확인을 거친 행만 돌려준다. */
export interface ScrollReadingRecord {
  readonly id: string;
  readonly user_id: string;
  readonly product_id: string;
  readonly persona_id: string;
  readonly nickname: string;
  /** 궁금한 점 원문. 생성 입력에는 넣지 않고 질문 정리 요청에만 쓴다. */
  readonly concern: string;
  readonly birth_input: PublicBirthInput;
  readonly chart: ChartView;
  readonly created_at: string;
}

export interface FinalSection {
  readonly sectionId: string;
  readonly tier: ScrollTier;
  readonly content: ScrollSectionContent;
}

export type UnitStatus = "pending" | "drafted" | "done" | "failed";

/** reading_units 한 행 (서버 전용). draft는 Pass 1 초안이며 브라우저로 보내지 않는다. */
export interface UnitRecord {
  readonly unitId: string;
  readonly tier: ScrollTier;
  readonly status: UnitStatus;
  readonly draft: ScrollDraftContent | null;
  readonly draftAttempts: number;
  readonly voiceAttempts: number;
  readonly errorStage: "draft" | "voice" | null;
  readonly errorCode: string | null;
  readonly errorRetryable: boolean | null;
  readonly updatedAt: string | null;
}

/** 점유한 실행의 고정 설정 (claim이 처음 시작할 때 고정한 값). */
export interface ClaimedRun {
  readonly attempts: number;
  readonly modelId: string | null;
  readonly promptVersion: string | null;
  readonly schemaVersion: string | null;
  readonly reasoningEffort: string | null;
}

export type ClaimOutcome =
  | { readonly claimed: true; readonly run: ClaimedRun }
  | { readonly claimed: false; readonly reason: "completed" | "running" | "failed" | "exhausted" | "daily_limited" | "not_entitled" };

export interface ClaimRequest {
  readonly userId: string;
  readonly readingId: string;
  readonly retry: boolean;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly reasoningEffort: string;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
}

/** 장 단위 저장의 공통 인자. tier는 상품 정의(ScrollSectionSpec.tier)에서 정한 값이어야 한다 (DB는 서버가 보낸 tier를 믿는다). */
export interface UnitWrite {
  readonly readingId: string;
  readonly tier: ScrollTier;
  /** 지금 점유한 실행의 시도 번호 (claim 결과의 attempts). */
  readonly attempt: number;
  readonly unitId: string;
}

export interface UnitFailure {
  readonly saved: boolean;
  readonly draftAttempts: number;
  readonly voiceAttempts: number;
}

export interface AnalysisStore {
  loadAnalysis<T>(readingId: string, cacheKey: string): Promise<T | null>;
  /** 같은 키가 이미 있으면 처음 저장한 값을 돌려준다. 저장하지 못하면 saved false와 넘긴 값을 돌려준다. */
  saveAnalysis<T>(readingId: string, cacheKey: string, kind: "question" | "timing", version: string, payload: T): Promise<{ readonly saved: boolean; readonly payload: T }>;
}

/** 생성 실행기(runner.ts)가 쓰는 저장소. 테스트는 같은 모양의 가짜를 넣어 DB 없이 순서와 저장을 확인한다. */
export interface ScrollStore extends AnalysisStore {
  loadReading(readingId: string, userId: string): Promise<{ readonly reading: ScrollReadingRecord; readonly plan: MujinPlan } | null>;
  hasEntitlement(readingId: string, userId: string): Promise<boolean>;
  /** 무료 단계 실행 행의 상태 (queued | running | completed | failed). 행이 없으면 null. */
  freeRunStatus(readingId: string): Promise<string | null>;
  claimFree(request: ClaimRequest & { readonly dailyLimit: number }): Promise<ClaimOutcome>;
  claimPaid(request: ClaimRequest): Promise<ClaimOutcome>;
  /** 첫 유료 생성 때 기준일을 고정하고, 이미 있으면 고정된 값을 돌려준다. 작업이 없거나 닫혔으면 null. */
  fixReferenceDate(readingId: string, date: string): Promise<string | null>;
  loadUnits(readingId: string): Promise<UnitRecord[]>;
  loadFinals(readingId: string): Promise<FinalSection[]>;
  /** false면 이 실행이 점유를 잃었다(다른 요청이 이어받음). 더 저장하지 않는다. */
  saveDraft(unit: UnitWrite & { readonly draft: ScrollDraftContent; readonly meta: Record<string, unknown> }): Promise<boolean>;
  saveFinal(unit: UnitWrite & { readonly content: ScrollSectionContent; readonly meta: Record<string, unknown> }): Promise<boolean>;
  failUnit(unit: UnitWrite & { readonly stage: "draft" | "voice"; readonly code: string; readonly retryable: boolean }): Promise<UnitFailure>;
  releaseRun(tier: ScrollTier, readingId: string, attempt: number): Promise<boolean>;
  /** 유료 단계는 complete_generation(reading, attempt, '[]'::jsonb, meta)로 작업 완료와 이용권 완료를 한 트랜잭션에 한다. */
  completeRun(tier: ScrollTier, readingId: string, attempt: number, meta: Record<string, unknown>): Promise<boolean>;
  failRun(tier: ScrollTier, readingId: string, attempt: number, code: string, retryable: boolean, llmCalls: number): Promise<boolean>;
  /** 호출 단위 기록 한 줄 (record_llm_call). 실패하면 던지고, 기록기(createCallRecorder)가 실패 수만 센다. */
  writeCall(row: LlmCallRow): Promise<void>;
}

/** 잘못된 UUID처럼 행이 있을 수 없는 입력(22P02)은 '없음'으로 본다. 그 밖의 오류는 앱 고정 코드로 던진다. */
function rowsOrNull<T>(result: { readonly data: T | null; readonly error: { readonly code?: string } | null }, code: string): T | null {
  if (!result.error) return result.data;
  if (result.error.code === "22P02") return null;
  throw new Error(code);
}

/** date 칸은 'YYYY-MM-DD'로 맞춘다 (드라이버에 따라 시각이 붙은 문자열로 올 수 있다). */
export function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

const READING_COLUMNS = "id, user_id, product_id, persona_id, nickname, concern, birth_input, chart, created_at";

/** 풀이 기록과 작성 계획. 소유자가 아니거나 없으면 null. */
export async function loadScrollReading(
  admin: Db,
  readingId: string,
  userId: string,
): Promise<{ readonly reading: ScrollReadingRecord; readonly plan: MujinPlan } | null> {
  const reading = rowsOrNull(
    await admin.from("readings").select(READING_COLUMNS).eq("id", readingId).eq("user_id", userId).maybeSingle(),
    "scroll_reading_load_failed",
  );
  if (!reading) return null;
  const internals = rowsOrNull(await admin.from("reading_internals").select("plan").eq("reading_id", readingId).maybeSingle(), "scroll_plan_load_failed");
  if (!internals) return null;
  return { reading: reading as unknown as ScrollReadingRecord, plan: (internals as { plan: MujinPlan }).plan };
}

/**
 * 완성된 장(Pass 2 최종문). 사용자 클라이언트를 넘기면 RLS가 무료 장은 소유자에게, 유료 장은 구매 권한이 있을 때만 보여 준다.
 * 서버 클라이언트를 넘기면 모든 장을 읽는다 (서버 안에서만 쓴다). 순서는 정하지 않는다. 목차 순서는 상품 정의를 따른다.
 */
export async function loadFinalSections(client: Db, readingId: string): Promise<FinalSection[]> {
  const rows = rowsOrNull(await client.from("reading_sections").select("section_id, tier, content").eq("reading_id", readingId), "scroll_sections_load_failed");
  return ((rows ?? []) as { section_id: string; tier: ScrollTier; content: ScrollSectionContent }[]).map((row) => ({
    sectionId: row.section_id,
    tier: row.tier,
    content: row.content,
  }));
}

/** 저장된 값이 그 기준일의 기간 재료 모양인지. */
export function isTimingBundle(value: unknown, referenceDate: string): value is MujinTimingBundle {
  const bundle = value as Partial<MujinTimingBundle> | null;
  return !!bundle && bundle.referenceDate === referenceDate && !!bundle.luck && !!bundle.months && Array.isArray(bundle.analyses);
}

/** 저장된 기간 재료 (prepareScrollTiming이 저장한 것). 없으면 null이며 계산하지 않는다. */
export async function loadTimingBundle(admin: Db, readingId: string, referenceDate: string): Promise<MujinTimingBundle | null> {
  const bundle = await loadAnalysisPayload<MujinTimingBundle>(admin, readingId, scrollTimingKey(referenceDate));
  return isTimingBundle(bundle, referenceDate) ? bundle : null;
}

/** 첫 유료 생성 때 고정한 기준일 (generation_jobs.reference_date). 아직 없거나 작업이 없거나 닫혔으면 null. */
export async function getReferenceDate(admin: Db, readingId: string): Promise<string | null> {
  const job = rowsOrNull(
    await admin.from("generation_jobs").select("status, reference_date").eq("reading_id", readingId).maybeSingle(),
    "scroll_job_load_failed",
  ) as { status: string; reference_date: unknown } | null;
  if (!job || job.status === "cancelled") return null;
  return dateOnly(job.reference_date);
}

async function loadAnalysisPayload<T>(admin: Db, readingId: string, cacheKey: string): Promise<T | null> {
  const row = rowsOrNull(
    await admin.from("reading_analyses").select("payload").eq("reading_id", readingId).eq("cache_key", cacheKey).maybeSingle(),
    "scroll_analysis_load_failed",
  ) as { payload: T } | null;
  return row?.payload ?? null;
}

async function rpc<T>(admin: Db, fn: string, args: Record<string, unknown>, code: string): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(code);
  return data as T;
}

interface RawClaim {
  readonly claimed: boolean;
  readonly reason: string;
  readonly run?: RawRun | null;
  readonly job?: RawRun | null;
}

interface RawRun {
  readonly attempts: number;
  readonly model_id: string | null;
  readonly prompt_version: string | null;
  readonly schema_version: string | null;
  readonly reasoning_effort: string | null;
}

const CLAIM_REASONS = new Set(["completed", "running", "failed", "exhausted", "daily_limited"]);

function toClaim(raw: RawClaim, row: RawRun | null | undefined, code: string): ClaimOutcome {
  if (raw.claimed && row) {
    return {
      claimed: true,
      run: {
        attempts: row.attempts,
        modelId: row.model_id,
        promptVersion: row.prompt_version,
        schemaVersion: row.schema_version,
        reasoningEffort: row.reasoning_effort,
      },
    };
  }
  if (!raw.claimed && CLAIM_REASONS.has(raw.reason)) return { claimed: false, reason: raw.reason as Exclude<ClaimOutcome, { claimed: true }>["reason"] };
  throw new Error(code);
}

interface RawUnit {
  readonly unit_id: string;
  readonly tier: ScrollTier;
  readonly status: UnitStatus;
  readonly draft: ScrollDraftContent | null;
  readonly draft_attempts: number;
  readonly voice_attempts: number;
  readonly error_stage: "draft" | "voice" | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
  readonly updated_at: string | null;
}

/** 실제 DB 함수로 저장하는 실행기 저장소. */
export function createScrollStore(admin: Db): ScrollStore {
  const writeCall = supabaseCallWriter(admin);
  return {
    loadReading: (readingId, userId) => loadScrollReading(admin, readingId, userId),

    async hasEntitlement(readingId, userId) {
      const row = rowsOrNull(
        await admin.from("entitlements").select("reading_id").eq("reading_id", readingId).eq("user_id", userId).maybeSingle(),
        "scroll_entitlement_load_failed",
      );
      return row !== null;
    },

    async freeRunStatus(readingId) {
      const row = rowsOrNull(await admin.from("reading_free_runs").select("status").eq("reading_id", readingId).maybeSingle(), "scroll_free_run_load_failed") as {
        status: string;
      } | null;
      return row?.status ?? null;
    },

    async claimFree(request) {
      const raw = await rpc<RawClaim>(
        admin,
        "claim_free_run",
        {
          p_user_id: request.userId,
          p_reading_id: request.readingId,
          p_retry: request.retry,
          p_model: request.model,
          p_prompt_version: request.promptVersion,
          p_schema_version: request.schemaVersion,
          p_reasoning_effort: request.reasoningEffort,
          p_lease_seconds: request.leaseSeconds,
          p_max_attempts: request.maxAttempts,
          p_daily_limit: request.dailyLimit,
        },
        "free_claim_failed",
      );
      return toClaim(raw, raw.run, "free_claim_failed");
    },

    async claimPaid(request) {
      const { data, error } = await admin.rpc("claim_generation", {
        p_user_id: request.userId,
        p_reading_id: request.readingId,
        p_retry: request.retry,
        p_model: request.model,
        p_prompt_version: request.promptVersion,
        p_schema_version: request.schemaVersion,
        p_reasoning_effort: request.reasoningEffort,
        p_lease_seconds: request.leaseSeconds,
        p_max_attempts: request.maxAttempts,
      });
      if (error) {
        // 작업이 없거나(구매 권한 없음) 이용권 반환으로 닫힌 작업이다.
        if ((error.message ?? "").includes("not_entitled")) return { claimed: false, reason: "not_entitled" };
        throw new Error("paid_claim_failed");
      }
      const raw = data as RawClaim;
      return toClaim(raw, raw.job, "paid_claim_failed");
    },

    async fixReferenceDate(readingId, date) {
      const value = await rpc<unknown>(admin, "fix_reference_date", { p_reading_id: readingId, p_date: date }, "reference_date_failed");
      return dateOnly(value);
    },

    loadAnalysis: (readingId, cacheKey) => loadAnalysisPayload(admin, readingId, cacheKey),

    async saveAnalysis(readingId, cacheKey, kind, version, payload) {
      const { data, error } = await admin.rpc("save_reading_analysis", {
        p_reading_id: readingId,
        p_cache_key: cacheKey,
        p_kind: kind,
        p_version: version,
        p_payload: payload,
      });
      if (error) {
        console.warn("[scroll] analysis not saved", { kind, code: error.code ?? "unknown" });
        return { saved: false, payload };
      }
      return { saved: true, payload: (data as typeof payload | null) ?? payload };
    },

    async loadUnits(readingId) {
      const rows = rowsOrNull(
        await admin
          .from("reading_units")
          .select("unit_id, tier, status, draft, draft_attempts, voice_attempts, error_stage, error_code, error_retryable, updated_at")
          .eq("reading_id", readingId),
        "scroll_units_load_failed",
      ) as RawUnit[] | null;
      return (rows ?? []).map((row) => ({
        unitId: row.unit_id,
        tier: row.tier,
        status: row.status,
        draft: row.draft ?? null,
        draftAttempts: row.draft_attempts,
        voiceAttempts: row.voice_attempts,
        errorStage: row.error_stage,
        errorCode: row.error_code,
        errorRetryable: row.error_retryable,
        updatedAt: row.updated_at,
      }));
    },

    loadFinals: (readingId) => loadFinalSections(admin, readingId),

    saveDraft: (unit) =>
      rpc<boolean>(
        admin,
        "save_unit_draft",
        { p_reading_id: unit.readingId, p_tier: unit.tier, p_attempt: unit.attempt, p_unit_id: unit.unitId, p_draft: unit.draft, p_meta: unit.meta },
        "unit_draft_save_failed",
      ).then((saved) => saved === true),

    saveFinal: (unit) =>
      rpc<boolean>(
        admin,
        "save_unit_final",
        { p_reading_id: unit.readingId, p_tier: unit.tier, p_attempt: unit.attempt, p_unit_id: unit.unitId, p_content: unit.content, p_meta: unit.meta },
        "unit_final_save_failed",
      ).then((saved) => saved === true),

    async failUnit(unit) {
      const result = await rpc<{ saved?: boolean; draftAttempts?: number; voiceAttempts?: number } | null>(
        admin,
        "fail_unit",
        {
          p_reading_id: unit.readingId,
          p_tier: unit.tier,
          p_attempt: unit.attempt,
          p_unit_id: unit.unitId,
          p_stage: unit.stage,
          p_code: unit.code,
          p_retryable: unit.retryable,
        },
        "unit_fail_save_failed",
      );
      return { saved: result?.saved === true, draftAttempts: result?.draftAttempts ?? 0, voiceAttempts: result?.voiceAttempts ?? 0 };
    },

    releaseRun: (tier, readingId, attempt) =>
      rpc<boolean>(admin, tier === "free" ? "release_free_run" : "release_generation", { p_reading_id: readingId, p_attempt: attempt }, "run_release_failed").then(
        (released) => released === true,
      ),

    completeRun: (tier, readingId, attempt, meta) =>
      (tier === "free"
        ? rpc<boolean>(admin, "complete_free_run", { p_reading_id: readingId, p_attempt: attempt }, "run_complete_failed")
        : rpc<boolean>(admin, "complete_generation", { p_reading_id: readingId, p_attempt: attempt, p_messages: [], p_meta: meta }, "run_complete_failed")
      ).then((completed) => completed === true),

    failRun: (tier, readingId, attempt, code, retryable, llmCalls) =>
      (tier === "free"
        ? rpc<boolean>(admin, "fail_free_run", { p_reading_id: readingId, p_attempt: attempt, p_code: code, p_retryable: retryable }, "run_fail_save_failed")
        : rpc<boolean>(
            admin,
            "fail_generation",
            { p_reading_id: readingId, p_attempt: attempt, p_code: code, p_retryable: retryable, p_llm_calls: llmCalls },
            "run_fail_save_failed",
          )
      ).then((failed) => failed === true),

    writeCall,
  };
}
