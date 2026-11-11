import "server-only";
import type { PublicBirthInput } from "sajuengine";
import { findProduct } from "@/domain/products";
import { isPlanV2, type AnyReadingPlan, type ChartView, type ReadingPlan, type StoredMessage } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import {
  mergeUsage,
  narrateReading,
  narrateReadingProgressive,
  sentPartsFrom,
  toStoredMessages,
  type GenerationConfig,
  type GenerationMeta,
  type NarrationInput,
  type NewMessage,
} from "@/server/llm/narrate";
import { isPlanV2Prompt, isProgressivePrompt, promptPersona, PROMPTS_FOR_PLAN } from "@/server/llm/prompts";
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

/** 점유 시간이 지나 다른 요청이 이 풀이를 이어받았다. 이 요청은 더 저장하지 않고 멈춘다. */
class GenerationHandedOver extends Error {}

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

    // 캐릭터 설정은 작업에 고정된 프롬프트 버전에 맞춘다. 이전 프롬프트로 이어 쓰는 작업은 이전 설정(legacy.ts)을,
    // 새 작업(reading-3.0.0)은 현재 설정(묘묘 2.0.0)을 받아 두 설정이 한 작업 안에서 섞이지 않는다.
    const persona = promptPersona(reading.persona_id as string, config.promptVersion);
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

    let messages: StoredMessage[];
    let meta: GenerationMeta;
    if (narration.version === "2.0.0" && isProgressivePrompt(config.promptVersion)) {
      // 주제가 완성될 때마다 메시지를 먼저 저장해 화면에 보여 준다. 이전 시도가 보낸 메시지는 그대로 두고 이어 쓴다.
      const focusSectionId = narration.plan.focusSection.id;
      const { data: existing } = await admin.from("reading_messages").select("seq, topic_id, text").eq("reading_id", readingId).order("seq", { ascending: true });
      const rows = (existing ?? []) as { seq: number; topic_id: string | null; text: string }[];
      let nextSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      const commit = async (batch: readonly NewMessage[]) => {
        const { data: job } = await admin.from("generation_jobs").select("status, attempts").eq("reading_id", readingId).maybeSingle();
        if (!job || job.status !== "running" || job.attempts !== attempt) throw new GenerationHandedOver();
        const { error: insertError } = await admin.from("reading_messages").insert(
          batch.map((message, index) => ({
            reading_id: readingId,
            user_id: userId,
            seq: nextSeq + index,
            topic_id: message.topicId,
            kind: message.kind,
            text: message.text,
            refs: message.refs,
          })),
        );
        // 같은 순번이 이미 있으면 다른 요청이 이어받아 쓰고 있다.
        if (insertError) throw new GenerationHandedOver();
        nextSeq += batch.length;
      };
      const progressive = await narrateReadingProgressive({
        plan: narration.plan,
        excluded: narration.excluded,
        chart,
        persona,
        config,
        deadlineAt,
        sent: sentPartsFrom(rows.map((row) => ({ topicId: row.topic_id, text: row.text })), focusSectionId),
        commit,
      });
      messages = [{ ...progressive.closing, seq: nextSeq }];
      meta = progressive.meta;
    } else {
      const whole = await narrateReading({ narration, chart, persona, config, deadlineAt });
      messages = toStoredMessages(whole.output, product?.focusSection.id);
      meta = whole.meta;
    }
    const usage = prepared?.usage ? mergeUsage(prepared.usage, meta.usage) : meta.usage;
    const llmCalls = meta.llmCalls + preparedCalls;
    const durationMs = Date.now() - startedAt;

    const { data: saved, error: saveError } = await admin.rpc("complete_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_messages: messages,
      p_meta: {
        ...meta,
        usage,
        llmCalls,
        durationMs,
        // personaVersion은 실제로 쓴 캐릭터 설정이다. 풀이 기록을 만들 때의 캐릭터 버전(작성 재료의 값)은 planPersonaVersion으로 따로 남긴다.
        // (이전에는 작성 재료의 값이 뒤에서 덮어써서 실제로 쓴 버전이 남지 않았다.)
        versions: {
          ...(prepared?.versions ?? { planVersion: plan.planVersion }),
          promptVersion: config.promptVersion,
          schemaVersion: config.schemaVersion,
          personaVersion: persona.version,
          planPersonaVersion: plan.personaVersion,
        },
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
    if (error instanceof GenerationHandedOver) {
      console.info("[generation] handed over", { readingId, attempt });
      return "running";
    }
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
