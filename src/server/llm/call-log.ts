import "server-only";
import { internalReason } from "../log";
import type { LlmCallLog } from "./client";

/**
 * LLM 호출 단위 기록 (docs/implementation/mujin/06_GENERATION_AND_IMPLEMENTATION.md 9절).
 * client.ts가 HTTP 요청 시도마다 넘기는 LlmCallLog에 풀이·단계·장·버전 태그를 붙여 DB 함수 record_llm_call(p_call jsonb)로 저장한다.
 *
 * - 재시도가 이전 기록을 덮지 않게 호출마다 새 키(callKey)를 만든다.
 * - 토큰 칸은 API가 돌려준 값 그대로다. 받지 못한 값은 null이며 0으로 채우거나 글자 수로 추정하지 않는다.
 *   cachedInputTokens는 inputTokens에 포함된 값이라 따로 더하지 않는다. reasoningTokens도 outputTokens에 포함된 값이다.
 * - 생성 문장, 질문 원문, 출생정보는 기록에 넣지 않는다 (LlmCallLog에도 없다).
 * - 저장은 기다리지 않고 시작해 생성 흐름을 막지 않는다. 작업이 끝날 때 flush()로 모두 기다린다.
 *   저장 실패는 생성 실패로 바꾸지 않고 횟수만 센다.
 */

/** classify: 질문 정리, pass1: 평문 초안(장 묶음), pass2: 무진 문장(장 하나), followup: 후속 질문 답변. */
export type LlmCallStep = "classify" | "pass1" | "pass2" | "followup";

export interface LlmCallTags {
  readonly readingId: string | null;
  readonly userId: string | null;
  readonly followupId?: string | null;
  readonly productId: string;
  /** 무료·유료 단계. 단계 구분이 없는 호출(후속 질문 등)은 null. */
  readonly tier: "free" | "paid" | null;
  readonly step: LlmCallStep;
  /** 장·묶음 ID (예: ch3, paid-work). 없으면 null. */
  readonly unitId: string | null;
  readonly promptVersion: string;
  readonly schemaVersion: string | null;
  readonly personaVersion: string | null;
  readonly reasoningEffort: string;
  /** 생성 작업의 시도 번호 (generation_jobs.attempts, 무진 무료 단계는 reading_free_runs.attempts). 후속 질문은 null. */
  readonly attempt?: number | null;
  /** 말한 캐릭터 ID. 캐릭터가 없는 호출(질문 정리, 중립 초안)도 풀이의 캐릭터를 남길 수 있다. 모르면 null. */
  readonly personaId?: string | null;
  /** 생성 묶음 ID (예: myomyo-2pass-1.0.0, mujin-1.1.0). 묶음 없이 만든 호출은 null. */
  readonly policyVersion?: string | null;
}

/**
 * record_llm_call(p_call jsonb)이 읽는 한 행. 키:
 * callKey, readingId, userId, followupId, productId, tier, step, unitId, modelRequested, modelActual, promptVersion,
 * schemaVersion, personaVersion, reasoningEffort, providerResponseId, providerRequestId, outcome, errorCode,
 * startedAt, endedAt, inputTokens, outputTokens, cachedInputTokens, reasoningTokens, usageReceived,
 * attempt, personaId, policyVersion (20261114120000_generation_usage_by_product.sql부터 저장한다. 이전 DB 함수는 이 키를 무시한다).
 */
export type LlmCallRow = Record<string, unknown>;

export interface LlmCallRecorder {
  /** 호출 하나에 붙일 태그를 받아 onCall에 넘길 함수를 만든다. 같은 함수가 전송 재시도마다 불려도 기록은 따로 남는다. */
  readonly forCall: (tags: LlmCallTags) => (log: LlmCallLog) => void;
  /** 시작한 저장을 모두 기다린다. 실패해도 예외를 던지지 않는다. */
  readonly flush: () => Promise<void>;
  /** 저장에 실패한 기록 수. */
  readonly failures: () => number;
}

function callRow(tags: LlmCallTags, log: LlmCallLog): LlmCallRow {
  const usage = log.usage;
  return {
    callKey: `${tags.readingId ?? "-"}:${tags.step}:${tags.unitId ?? "-"}:${crypto.randomUUID()}`,
    readingId: tags.readingId,
    userId: tags.userId,
    followupId: tags.followupId ?? null,
    productId: tags.productId,
    tier: tags.tier,
    step: tags.step,
    unitId: tags.unitId,
    modelRequested: log.requestedModel,
    modelActual: log.actualModel,
    promptVersion: tags.promptVersion,
    schemaVersion: tags.schemaVersion,
    personaVersion: tags.personaVersion,
    reasoningEffort: tags.reasoningEffort,
    attempt: tags.attempt ?? null,
    personaId: tags.personaId ?? null,
    policyVersion: tags.policyVersion ?? null,
    providerResponseId: log.responseId,
    providerRequestId: log.requestId,
    outcome: log.outcome,
    errorCode: log.errorCode,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    usageReceived: log.outcome === "usage" && usage !== null,
  };
}

/** 저장소 오류 코드(예: PGRST202, 42883)만 남긴다. 코드가 없으면 앱 고정 코드나 예외 이름만 남긴다. */
const STORE_CODE = /^[A-Za-z0-9_]{1,40}$/;

function failureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && STORE_CODE.test(code) ? code : internalReason(error);
}

export function createCallRecorder(write: (row: LlmCallRow) => Promise<void>): LlmCallRecorder {
  const pending = new Set<Promise<void>>();
  let failed = 0;

  const fail = (error: unknown) => {
    failed += 1;
    try {
      // 행 내용(풀이 ID, 버전, 토큰 수)은 로그에 남기지 않는다.
      console.warn("[llm-call] not recorded", { code: failureCode(error) });
    } catch {
      // 로그 실패도 생성 흐름을 바꾸지 않는다.
    }
  };

  const start = (row: LlmCallRow) => {
    let task: Promise<void>;
    try {
      task = Promise.resolve(write(row));
    } catch (error) {
      task = Promise.reject(error);
    }
    const settled: Promise<void> = task.then(() => undefined, fail).finally(() => pending.delete(settled));
    pending.add(settled);
  };

  return {
    forCall: (tags) => (log) => {
      try {
        start(callRow(tags, log));
      } catch (error) {
        fail(error);
      }
    },
    flush: async () => {
      // 기다리는 동안 새로 시작한 저장도 기다린다. settled는 거부되지 않는다.
      while (pending.size) await Promise.all(pending);
    },
    failures: () => failed,
  };
}

/** 관리자(service_role) 클라이언트로 record_llm_call을 부르는 저장 함수. 오류 응답은 거부로 바꿔 기록기가 실패로 센다. */
export function supabaseCallWriter(admin: {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
}): (row: LlmCallRow) => Promise<void> {
  return async (row) => {
    const { error } = await admin.rpc("record_llm_call", { p_call: row });
    if (error) throw error;
  };
}
