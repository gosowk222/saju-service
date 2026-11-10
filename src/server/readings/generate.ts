import "server-only";
import type { PublicBirthInput } from "sajuengine";
import { findPersona } from "@/domain/personas";
import { findProduct } from "@/domain/products";
import { isPlanV2, type AnyReadingPlan, type ChartView, type ReadingPlan } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import { mergeUsage, narrateReading, toStoredMessages, type GenerationConfig, type NarrationInput } from "@/server/llm/narrate";
import { isPlanV2Prompt, PROMPTS_FOR_PLAN } from "@/server/llm/prompts";
import { internalReason } from "@/server/log";
import { prepareNarration } from "./analysis";

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
 * 저장된 작성 재료의 버전에 맞는 프롬프트를 고른다. 이전 형식(1.0.0)으로 만든 풀이는 이전 프롬프트로 생성해
 * 저장된 재료와 출력 형식이 섞이지 않게 한다. 메시지와 완료 상태는 한 트랜잭션으로 저장된다.
 */
export async function runGeneration(userId: string, readingId: string, retry: boolean): Promise<ClaimResult["reason"]> {
  const admin = createSupabaseAdminClient();
  const startedAt = Date.now();
  const deadlineAt = startedAt + LLM_SETTINGS.generationBudgetMs;

  const [{ data: reading }, { data: internals }] = await Promise.all([
    admin.from("readings").select("chart, persona_id, product_id, concern, birth_input").eq("id", readingId).eq("user_id", userId).maybeSingle(),
    admin.from("reading_internals").select("plan").eq("reading_id", readingId).maybeSingle(),
  ]);
  if (!reading || !internals) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
  const plan = internals.plan as AnyReadingPlan;
  const versions = PROMPTS_FOR_PLAN[plan.planVersion] ?? PROMPTS_FOR_PLAN["1.0.0"]!;

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
    p_prompt_version: versions.prompt,
    p_schema_version: versions.schema,
    p_reasoning_effort: LLM_SETTINGS.tasks.reading.reasoningEffort,
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
  let preparedCalls = 0;
  const fail = async (code: string, isRetryable: boolean, calls: number) => {
    await admin.rpc("fail_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_code: code,
      p_retryable: isRetryable,
      p_llm_calls: calls + preparedCalls,
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

    const persona = findPersona(reading.persona_id as string);
    if (!persona) throw new Error("persona_unavailable");
    const product = findProduct(reading.product_id as string);
    const chart = reading.chart as ChartView;

    let narration: NarrationInput;
    let prepared: Awaited<ReturnType<typeof prepareNarration>> | null = null;
    // 프롬프트 이름을 직접 비교하면 새 버전(reading-2.1.0)이 이전 경로로 빠진다 (2026-11-10 브라우저 테스트에서 발견).
    if (isPlanV2Prompt(config.promptVersion)) {
      if (!isPlanV2(plan) || !product) throw new Error("plan_version_mismatch");
      prepared = await prepareNarration({
        admin,
        readingId,
        base: plan,
        product,
        birth: reading.birth_input as PublicBirthInput,
        concern: (reading.concern as string | null) ?? "",
        modelId: config.modelId,
        deadlineAt,
      });
      preparedCalls = prepared.llmCalls;
      narration = { version: "2.0.0", plan: prepared.plan, excluded: prepared.excluded };
    } else {
      narration = { version: "1.0.0", plan: plan as ReadingPlan };
    }

    const { output, meta } = await narrateReading({ narration, chart, persona, config, deadlineAt });
    const usage = prepared?.usage ? mergeUsage(prepared.usage, meta.usage) : meta.usage;
    const llmCalls = meta.llmCalls + preparedCalls;
    const durationMs = Date.now() - startedAt;

    const { data: saved, error: saveError } = await admin.rpc("complete_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_messages: toStoredMessages(output, product?.focusSection.id),
      p_meta: {
        ...meta,
        usage,
        llmCalls,
        durationMs,
        versions: { promptVersion: config.promptVersion, schemaVersion: config.schemaVersion, personaVersion: persona.version, ...(prepared?.versions ?? { planVersion: plan.planVersion }) },
      },
    });
    console.info("[generation] done", {
      readingId,
      prompt: config.promptVersion,
      calls: llmCalls,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      issues: meta.issueCount,
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
      console.error("[generation] failed", { readingId, code: "internal", reason: internalReason(error) });
      await fail("internal", true, 0);
    }
    return "failed";
  }
}
