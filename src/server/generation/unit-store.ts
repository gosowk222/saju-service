import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseCallWriter } from "@/server/llm/call-log";
import type { UnitRecord, UnitStatus, UnitStore, UnitTier } from "./two-pass";

/**
 * 2-pass 단위 저장소의 Supabase 구현. 무진 족자(src/server/scroll/store.ts)와 묘묘 메신저(messenger-store.ts)가 같은 DB 함수를 쓴다
 * (20261113120000_mujin_scroll.sql: save_unit_draft, save_unit_final, fail_unit, record_llm_call).
 * 저장 함수는 지금 점유한 실행자(무료: reading_free_runs, 유료: generation_jobs + 구매 권한)만 저장하게 한다.
 * reading_units(초안)는 서버 전용이고, reading_sections(최종 단위)는 소유자가 읽을 수 있다 (유료는 구매 권한이 있을 때만).
 * 저장소 오류는 앱 고정 코드의 Error로 바꿔 던진다. 로그에는 이 코드만 남는다.
 */

type Db = SupabaseClient;

async function rpc<T>(admin: Db, fn: string, args: Record<string, unknown>, code: string): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(code);
  return data as T;
}

/** 잘못된 UUID처럼 행이 있을 수 없는 입력(22P02)은 '없음'으로 본다. 그 밖의 오류는 앱 고정 코드로 던진다. */
function rowsOrNull<T>(result: { readonly data: T | null; readonly error: { readonly code?: string } | null }, code: string): T | null {
  if (!result.error) return result.data;
  if (result.error.code === "22P02") return null;
  throw new Error(code);
}

interface RawUnit<D> {
  readonly unit_id: string;
  readonly tier: UnitTier;
  readonly status: UnitStatus;
  readonly draft: D | null;
  readonly draft_attempts: number;
  readonly voice_attempts: number;
  readonly error_stage: "draft" | "voice" | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
  readonly updated_at: string | null;
}

export interface SupabaseUnitStore<D, F> extends UnitStore<D, F> {
  loadUnits(readingId: string): Promise<UnitRecord<D>[]>;
  /** 저장된 최종 단위 (서버 클라이언트로 읽으므로 모든 단위). 순서는 정하지 않는다. */
  loadFinals(readingId: string): Promise<{ readonly unitId: string; readonly tier: UnitTier; readonly content: F }[]>;
}

/** loadCode: 단위 목록을 읽지 못했을 때의 오류 코드 (무진은 이전과 같은 scroll_units_load_failed). */
export function createUnitStore<D, F>(admin: Db, loadCode = "units_load_failed"): SupabaseUnitStore<D, F> {
  return {
    async loadUnits(readingId) {
      const rows = rowsOrNull(
        await admin
          .from("reading_units")
          .select("unit_id, tier, status, draft, draft_attempts, voice_attempts, error_stage, error_code, error_retryable, updated_at")
          .eq("reading_id", readingId),
        loadCode,
      ) as RawUnit<D>[] | null;
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

    async loadFinals(readingId) {
      const rows = rowsOrNull(await admin.from("reading_sections").select("section_id, tier, content").eq("reading_id", readingId), "unit_finals_load_failed");
      return ((rows ?? []) as { section_id: string; tier: UnitTier; content: F }[]).map((row) => ({ unitId: row.section_id, tier: row.tier, content: row.content }));
    },

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

    writeCall: supabaseCallWriter(admin),
  };
}
