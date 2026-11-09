import "server-only";
import { findPersona } from "@/domain/personas";
import type { ChartView, ReadingPlan } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import { narrateReading, toStoredMessages, type GenerationConfig } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";

interface ClaimResult {
  readonly claimed: boolean;
  readonly reason: "claimed" | "completed" | "running" | "failed" | "exhausted";
  readonly job: {
    readonly attempts: number;
    readonly model_id: string | null;
    readonly prompt_version: string | null;
    readonly schema_version: string | null;
    readonly reasoning_effort: string | null;
  };
}

/** 코드나 설정이 바뀌어야 해결되는 오류인지 표시한다. */
function retryable(error: LlmError): boolean {
  return !error.isConfigurationError;
}

/**
 * 요청 안에서 생성을 끝낸다. 요청이 끊기면 점유 시간이 지난 뒤 다음 요청이 이어받는다.
 * 서버 응답 뒤에 작업이 계속된다고 가정하지 않는다.
 *
 * 메시지와 완료 상태는 한 트랜잭션으로 저장되므로 절반만 저장되는 일은 없다.
 */
export async function runGeneration(userId: string, readingId: string, retry: boolean): Promise<ClaimResult["reason"]> {
  const admin = createSupabaseAdminClient();

  let modelForNewJob: string;
  try {
    modelForNewJob = resolveModelId();
  } catch {
    modelForNewJob = "unconfigured";
  }

  const { data, error } = await admin.rpc("claim_generation", {
    p_user_id: userId,
    p_reading_id: readingId,
    p_retry: retry,
    p_model: modelForNewJob,
    p_prompt_version: CURRENT_READING_PROMPT,
    p_schema_version: NARRATION_SCHEMA_VERSION,
    p_reasoning_effort: LLM_SETTINGS.reasoningEffort,
    p_lease_seconds: LLM_SETTINGS.generationLeaseSeconds,
    p_max_attempts: LLM_SETTINGS.generationMaxAttempts,
  });
  if (error) {
    if (error.message.includes("not_entitled")) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
    throw new ApiError(500, "claim_failed", "풀이를 시작하지 못했어요.");
  }
  const claim = data as ClaimResult;
  if (!claim.claimed) return claim.reason;

  const attempt = claim.job.attempts;
  const fail = async (code: string, isRetryable: boolean, calls: number) => {
    await admin.rpc("fail_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_code: code,
      p_retryable: isRetryable,
      p_llm_calls: calls,
    });
  };

  try {
    const config: GenerationConfig = {
      modelId: claim.job.model_id!,
      promptVersion: claim.job.prompt_version!,
      schemaVersion: claim.job.schema_version!,
      reasoningEffort: claim.job.reasoning_effort!,
    };
    if (config.modelId === "unconfigured") throw new LlmError("model_not_configured", "모델이 설정되지 않았습니다.", 0);

    const [{ data: internals, error: internalsError }, { data: reading, error: readingError }] = await Promise.all([
      admin.from("reading_internals").select("plan").eq("reading_id", readingId).single(),
      admin.from("readings").select("chart, persona_id").eq("id", readingId).eq("user_id", userId).single(),
    ]);
    if (internalsError || readingError || !internals || !reading) throw new Error("reading_load_failed");

    const persona = findPersona(reading.persona_id as string);
    if (!persona) throw new Error("persona_unavailable");

    const { output, meta } = await narrateReading({
      plan: internals.plan as ReadingPlan,
      chart: reading.chart as ChartView,
      persona,
      config,
    });

    const { data: saved, error: saveError } = await admin.rpc("complete_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_messages: toStoredMessages(output),
      p_meta: meta,
    });
    if (saveError) {
      await fail("save_failed", true, meta.llmCalls);
      return "failed";
    }
    return saved ? "completed" : "running";
  } catch (error) {
    if (error instanceof LlmError) {
      console.error("[generation] failed", { readingId, code: error.code });
      await fail(error.code, retryable(error), error.calls);
    } else {
      console.error("[generation] failed", { readingId, code: "internal" });
      await fail("internal", true, 0);
    }
    return "failed";
  }
}
