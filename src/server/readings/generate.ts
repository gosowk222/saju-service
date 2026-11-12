import "server-only";
import type { PublicBirthInput } from "sajuengine";
import { findPersona } from "@/domain/personas";
import { findMessengerProduct } from "@/domain/products";
import { issueSummary } from "@/domain/reading/check";
import { isPlanV2, type AnyReadingPlan, type ChartView, type ReadingPlan, type StoredMessage } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { attemptLimitFor, findMessengerBundle, type MessengerBundle } from "@/server/generation/bundles";
import { MessengerRun } from "@/server/generation/messenger-run";
import { createMessengerStore } from "@/server/generation/messenger-store";
import { createCallRecorder, supabaseCallWriter } from "@/server/llm/call-log";
import { callStructured, callStructuredStream, LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import {
  narrateReading,
  narrateReadingProgressive,
  sentPartsFrom,
  toStoredMessages,
  type GenerationConfig,
  type GenerationMeta,
  type NarrationInput,
  type NewMessage,
} from "@/server/llm/narrate";
import { hasReadingPrompt, isPlanV2Prompt, isProgressivePrompt, personaVersionFor, PROMPTS_FOR_PLAN } from "@/server/llm/prompts";
import { UsageMeter } from "@/server/llm/usage";
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
 *
 * 토큰 사용량: 이 시도(attempt)에서 실제로 보낸 질문 분석·본문 작성·재작성 호출을 모두 한 meter에 기록하고,
 * 끝나는 방식(완료, 실패, 다른 요청이 이어받음, 시간 예산이 끝나 반납)과 관계없이 generation_attempts에 시도마다 한 줄로 남긴다
 * (record_generation_attempt). 같은 시도를 두 번 기록해도 한 줄만 남는다. 저장된 질문 분석을 다시 쓰거나 이미 끝난 풀이를 열면 호출이 없다.
 * 2-pass 묶음으로 시작한 작업은 호출마다 llm_calls에도 단계(질문 정리, Pass 1, Pass 2)·묶음·시도 번호와 함께 남는다. 시도 기록과 호출 기록은
 * 같은 사용량의 합계와 상세이며, 관리자 집계는 한 시도에 둘 중 하나만 센다 (20261114120000_generation_usage_by_product.sql).
 *
 * 생성 방식은 작업이 처음 시작할 때 고정한 버전(generation_jobs.prompt_version)으로만 정한다:
 * - 메신저 생성 묶음 ID(예: myomyo-2pass-1.0.0): 2-pass (src/server/generation/messenger-run.ts). 새 작업은 상품 설정의 generation.bundle을 고정한다.
 * - 이전 1-pass 지시 버전(reading-x.y.z): 그 버전으로 이어 쓴다 (이미 시작한 작업을 새 방식으로 바꾸지 않는다).
 * - 이 코드가 모르는 버전: 다시 시도할 수 없는 실패(prompt_version_unavailable)로 정리한다. 다른 버전으로 바꿔 이어 쓰지 않는다.
 */
export async function runGeneration(userId: string, readingId: string, retry: boolean): Promise<ClaimResult["reason"]> {
  const admin = createSupabaseAdminClient();
  const startedAt = Date.now();
  const deadlineAt = startedAt + LLM_SETTINGS.generationBudgetMs;

  const [{ data: reading }, { data: internals }, { data: existingJob }] = await Promise.all([
    admin.from("readings").select("chart, persona_id, product_id, concern, birth_input").eq("id", readingId).eq("user_id", userId).maybeSingle(),
    admin.from("reading_internals").select("plan").eq("reading_id", readingId).maybeSingle(),
    admin.from("generation_jobs").select("prompt_version").eq("reading_id", readingId).maybeSingle(),
  ]);
  if (!reading || !internals) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
  // 메신저 상품의 생성 경로다. 족자 상품(무진)은 장별 생성(POST /api/readings/{id}/scroll/generate)만 쓴다.
  // 생성 작업을 점유(claim_generation)하기 전에 막아, 무진 유료 작업의 시도 수와 고정된 프롬프트 버전이 바뀌지 않게 한다.
  if (!findMessengerProduct(reading.product_id as string)) {
    throw new ApiError(409, "unsupported_product", "이 풀이는 풀이 화면에서 이어서 만들어요.");
  }
  const plan = internals.plan as AnyReadingPlan;
  // 새 작업이 고정할 버전: 작성 재료 2.0.0이면 상품 설정의 생성 묶음, 이전 재료(1.0.0)면 그 재료의 1-pass 지시.
  // 이미 시작한 작업은 claim_generation이 처음 고정한 값을 그대로 쓴다 (아래 값으로 바뀌지 않는다).
  const messengerProduct = findMessengerProduct(reading.product_id as string)!;
  let versions: { readonly prompt: string; readonly schema: string };
  if (plan.planVersion === "2.0.0") {
    const bundle = findMessengerBundle(messengerProduct.generation.bundle);
    if (!bundle || bundle.personaId !== messengerProduct.personaId) {
      console.error("[generation] bundle unavailable", { readingId, bundle: messengerProduct.generation.bundle });
      throw new ApiError(500, "claim_failed", "풀이를 시작하지 못했어요.");
    }
    versions = { prompt: bundle.id, schema: bundle.voiceSchema };
  } else {
    versions = PROMPTS_FOR_PLAN[plan.planVersion] ?? PROMPTS_FOR_PLAN["1.0.0"]!;
  }
  // 작업 시작 상한은 고정된(또는 고정할) 버전으로 정한다. 2-pass는 시간 예산이 끝나 반납한 뒤 이어받기도 시작 수에 들어간다.
  const maxAttempts = attemptLimitFor((existingJob?.prompt_version as string | null | undefined) ?? versions.prompt);

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
    p_max_attempts: maxAttempts,
  });
  if (error) {
    if (error.message.includes("not_entitled")) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
    throw new ApiError(500, "claim_failed", "풀이를 시작하지 못했어요.");
  }
  const claim = data as ClaimResult;
  if (!claim.claimed) return claim.reason;

  const attempt = claim.job.attempts;
  /** 이 시도에서 보낸 모든 호출의 사용량과 호출 수. */
  const meter = new UsageMeter();
  let personaVersion: string | null = null;
  const fail = async (code: string, isRetryable: boolean) => {
    await admin.rpc("fail_generation", {
      p_reading_id: readingId,
      p_attempt: attempt,
      p_code: code,
      p_retryable: isRetryable,
      p_llm_calls: meter.calls,
    });
  };
  /** 이 시도의 사용량을 남긴다. 기록이 실패해도(예: migration 미적용) 풀이 생성 결과는 바꾸지 않고 로그만 남긴다. */
  const recordAttempt = async (
    outcome: "completed" | "failed" | "handed_over" | "released",
    errorCode: string | null,
    actualModel: string | null,
    issues: readonly string[] = [],
  ) => {
    try {
      const { error: recordError } = await admin.rpc("record_generation_attempt", {
        p_reading_id: readingId,
        p_attempt: attempt,
        p_outcome: outcome,
        p_record: {
          errorCode,
          modelId: claim.job.model_id,
          actualModel,
          promptVersion: claim.job.prompt_version,
          schemaVersion: claim.job.schema_version,
          personaVersion,
          reasoningEffort: claim.job.reasoning_effort,
          usage: meter.summary(),
          durationMs: Date.now() - startedAt,
          // 마지막 검사에서 걸린 문제의 종류. 생성 문장과 질문 원문은 빼고 남긴다 (issueSummary).
          issues: [...new Set(issues.map(issueSummary))].slice(0, 15),
        },
      });
      if (recordError) console.warn("[generation] usage not recorded", { readingId, attempt, code: recordError.code ?? "unknown" });
    } catch (error) {
      console.warn("[generation] usage not recorded", { readingId, attempt, reason: internalReason(error) });
    }
  };

  /**
   * 2-pass 묶음으로 시작한 작업 (Pass 1 중립 초안 → Pass 2 캐릭터 말풍선, src/server/generation/messenger-run.ts).
   * 풀이의 캐릭터와 묶음의 캐릭터가 다르거나 그 버전의 설정이 없으면 다른 캐릭터·버전으로 바꾸지 않고 다시 시도할 수 없는 실패로 정리한다.
   */
  const runTwoPass = async (bundle: MessengerBundle, config: GenerationConfig): Promise<ClaimResult["reason"]> => {
    const product = findMessengerProduct(reading.product_id as string);
    const persona = findPersona(bundle.personaId, bundle.personaVersion);
    if (!persona || persona.id !== reading.persona_id || !product || !isPlanV2(plan)) {
      const code = !persona || persona.id !== reading.persona_id ? "persona_unavailable" : "plan_version_mismatch";
      console.error("[generation] failed", { readingId, code, bundle: bundle.id });
      await fail(code, false);
      await recordAttempt("failed", code, null);
      return "failed";
    }
    personaVersion = persona.version;

    // 질문 정리 호출도 호출 단위로 남긴다 (단계 classify). 저장된 질문 분석을 다시 쓰면 호출이 없다.
    const calls = createCallRecorder(supabaseCallWriter(admin));
    let prepared: Awaited<ReturnType<typeof prepareNarration>>;
    try {
      prepared = await prepareNarration({
        admin,
        readingId,
        base: plan,
        product,
        birth: reading.birth_input as PublicBirthInput,
        concern: (reading.concern as string | null) ?? "",
        modelId: config.modelId,
        deadlineAt,
        meter,
        onCall: calls.forCall({
          readingId,
          userId,
          productId: product.id,
          tier: "paid",
          step: "classify",
          unitId: null,
          attempt,
          personaId: persona.id,
          policyVersion: bundle.id,
          promptVersion: bundle.questionPrompt,
          schemaVersion: null,
          personaVersion: null,
          reasoningEffort: LLM_SETTINGS.tasks.classify.reasoningEffort,
        }),
      });
    } finally {
      await calls.flush();
    }

    const run = new MessengerRun({
      deps: { callStructured, callStructuredStream, now: Date.now, store: createMessengerStore(admin) },
      bundle,
      persona,
      plan: prepared.plan,
      excluded: prepared.excluded,
      chart: reading.chart as ChartView,
      readingId,
      userId,
      productId: product.id,
      attempt,
      modelId: config.modelId,
      reasoningEffort: config.reasoningEffort,
      startedAt,
      meter,
    });
    const result = await run.execute();
    const summary = run.summary();
    const usage = meter.summary();
    const durationMs = Date.now() - startedAt;
    console.info("[generation] two-pass", {
      readingId,
      bundle: bundle.id,
      attempt,
      result: result.kind,
      calls: meter.calls,
      durationMs,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      usageComplete: usage.complete,
      issues: summary.issueCount,
    });

    if (result.kind === "completed") {
      const { data: saved, error: saveError } = await admin.rpc("complete_generation", {
        p_reading_id: readingId,
        p_attempt: attempt,
        p_messages: [result.closing],
        p_meta: {
          actualModel: summary.actualModel,
          usage,
          llmCalls: meter.calls,
          durationMs,
          issueCount: summary.issueCount,
          versions: {
            ...prepared.versions,
            generationPolicy: "two-pass",
            bundle: bundle.id,
            promptVersion: bundle.id,
            schemaVersion: bundle.voiceSchema,
            draftPrompt: bundle.draftPrompt,
            draftSchema: bundle.draftSchema,
            voicePrompt: bundle.voicePrompt,
            voiceSchema: bundle.voiceSchema,
            questionPrompt: bundle.questionPrompt,
            personaId: persona.id,
            personaVersion: persona.version,
            planPersonaVersion: plan.personaVersion,
            // Pass 2 지시에 넣은 문답 예시 (단위마다 고른 ID는 reading_sections.meta.examples에 있다). 예시 문장은 넣지 않는다.
            exampleCatalog: bundle.examples.catalogVersion,
            examplePolicy: bundle.examples.policyVersion,
            exampleGuide: bundle.examples.guideVersion,
            exampleIds: summary.examples.ids,
          },
        },
      });
      if (saveError) {
        await fail("save_failed", true);
        await recordAttempt("failed", "save_failed", summary.actualModel);
        return "failed";
      }
      await recordAttempt(saved ? "completed" : "handed_over", null, summary.actualModel);
      return saved ? "completed" : "running";
    }
    if (result.kind === "release") {
      // 시간 예산이 끝나 남은 단위가 있다. 반납하면 화면이 곧바로 다음 생성 요청을 보내 이어 쓴다 (저장된 단위는 다시 만들지 않는다).
      const { error: releaseError } = await admin.rpc("release_generation", { p_reading_id: readingId, p_attempt: attempt });
      if (releaseError) console.warn("[generation] release failed", { readingId, attempt, code: releaseError.code ?? "unknown" });
      await recordAttempt("released", null, summary.actualModel);
      return "running";
    }
    if (result.kind === "lost") {
      console.info("[generation] handed over", { readingId, attempt });
      await recordAttempt("handed_over", null, summary.actualModel);
      return "running";
    }
    console.error("[generation] failed", { readingId, code: result.code, issues: summary.issueCount });
    await fail(result.code, result.retryable);
    await recordAttempt("failed", result.code, summary.actualModel);
    return "failed";
  };

  try {
    const config: GenerationConfig = {
      modelId: claim.job.model_id!,
      promptVersion: claim.job.prompt_version!,
      schemaVersion: claim.job.schema_version!,
      reasoningEffort: claim.job.reasoning_effort!,
    };
    if (config.modelId === "unconfigured") throw new LlmError("model_not_configured", "모델이 설정되지 않았습니다.", 0);

    // 2-pass 묶음으로 시작한 작업. 캐릭터 설정·지시·예시는 묶음이 고정한 버전으로만 쓴다.
    const bundle = findMessengerBundle(config.promptVersion);
    if (bundle) {
      return await runTwoPass(bundle, config);
    }
    // 이 코드가 모르는 프롬프트에 고정된 작업 (예: 되돌린 작업에서 시작한 reading-3.0.0). 다시 시도해도 같으므로 재시도할 수 없는 실패로 정리한다.
    // 다른 버전으로 바꿔 이어 쓰지 않는다 (이미 보낸 말풍선과 지시가 섞이지 않게).
    if (!hasReadingPrompt(config.promptVersion)) {
      console.error("[generation] failed", { readingId, code: "prompt_version_unavailable", prompt: config.promptVersion });
      await fail("prompt_version_unavailable", false);
      await recordAttempt("failed", "prompt_version_unavailable", null);
      return "failed";
    }

    // 캐릭터 설정은 작업에 고정된 프롬프트 버전에 맞춘다. 이전 프롬프트로 이어 쓰는 작업에 새 캐릭터 설정이 섞이지 않게 한다.
    const persona = findPersona(reading.persona_id as string, personaVersionFor(config.promptVersion));
    if (!persona) throw new Error("persona_unavailable");
    personaVersion = persona.version;
    const product = findMessengerProduct(reading.product_id as string);
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
        meter,
      });
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
        meter,
        // 문답 예시(reading-3.2.0부터)는 풀이 ID와 저장된 작성 재료로 고른다. 재시도·이어 쓰기도 같은 예시를 받는다.
        exampleSeed: readingId,
      });
      messages = [{ ...progressive.closing, seq: nextSeq }];
      meta = progressive.meta;
    } else {
      const whole = await narrateReading({ narration, chart, persona, config, deadlineAt, meter, exampleSeed: readingId });
      messages = toStoredMessages(whole.output, product?.focusSection.id);
      meta = whole.meta;
    }
    // 질문 분석과 본문 작성(재작성 포함)을 합친 이 시도의 사용량. usage를 받지 못한 호출이 있으면 complete=false.
    const usage = meter.summary();
    const llmCalls = meter.calls;
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
          // 지시에 넣은 문답 예시 (reading-3.2.0부터). 예시 문장과 사용자 원문은 넣지 않는다.
          exampleCatalog: meta.examples?.catalogVersion ?? null,
          examplePolicy: meta.examples?.policyVersion ?? null,
          exampleIds: meta.examples?.ids ?? [],
        },
      },
    });
    console.info("[generation] done", {
      readingId,
      prompt: config.promptVersion,
      examples: meta.examples?.ids ?? [],
      calls: llmCalls,
      durationMs,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      usageComplete: usage.complete,
      issues: meta.issueCount,
    });
    if (saveError) {
      await fail("save_failed", true);
      await recordAttempt("failed", "save_failed", meta.actualModel);
      return "failed";
    }
    await recordAttempt(saved ? "completed" : "handed_over", null, meta.actualModel);
    return saved ? "completed" : "running";
  } catch (error) {
    if (error instanceof GenerationHandedOver) {
      console.info("[generation] handed over", { readingId, attempt });
      await recordAttempt("handed_over", null, null);
      return "running";
    }
    if (error instanceof LlmError) {
      // 검사 실패 내용(error.details)에는 생성 문장 일부가 들어 있어 남기지 않는다. 문제 수만 남긴다.
      console.error("[generation] failed", { readingId, code: error.code, issues: error.details.length });
      await fail(error.code, retryable(error));
      await recordAttempt("failed", error.code, null, error.details);
    } else {
      console.error("[generation] failed", { readingId, code: "internal", reason: internalReason(error) });
      await fail("internal", true);
      await recordAttempt("failed", "internal", null);
    }
    return "failed";
  }
}
