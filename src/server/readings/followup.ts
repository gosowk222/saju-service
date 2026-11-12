import "server-only";
import type { PublicBirthInput } from "sajuengine";
import { findPersona } from "@/domain/personas";
import { findMessengerProduct } from "@/domain/products";
import { focusTopicsOf } from "@/domain/reading/focus";
import { inScopeItems, limitToTopics, seoulDate, type QuestionAnalysis } from "@/domain/reading/question";
import { isPlanV2, type AnyReadingPlan, type ChartView } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import { classifyQuestion } from "@/server/llm/narrate";
import { CURRENT_FOLLOWUP_PROMPT, FOLLOWUP_SCHEMA_VERSION, personaVersionFor, QUESTION_PROMPT_VERSION } from "@/server/llm/prompts";
import { UsageMeter } from "@/server/llm/usage";
import { internalReason } from "@/server/log";
import { INITIAL_QUESTION_KEY, loadAnalysis, timingFor } from "./analysis";
import { answerAnalyzedFollowup, isReactionOnly, routeWithoutItems, type FollowupStatus } from "./followup-core";

export type { FollowupStatus };

export interface FollowupResponse {
  readonly status: FollowupStatus;
  readonly answer: string;
  readonly questionsUsed: number;
  readonly questionLimit: number;
  readonly replayed: boolean;
}

interface BeginResult {
  readonly outcome: "started" | "duplicate" | "busy" | "rate_limited" | "exhausted";
  readonly used: number;
  readonly limit: number;
  readonly followup?: { readonly id: string; readonly status: string; readonly answer: string | null };
}

/** 시간이 지나 다른 요청이 이 질문을 실패로 정리했다. 더 저장하지 않는다. */
class FollowupHandedOver extends Error {}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 분석 결과 중 남겨 둘 최소 기록. 질문 원문은 followups.question에 따로 있다. */
function analysisRecord(analysis: QuestionAnalysis, llmCalls: number) {
  return {
    version: analysis.version,
    promptVersion: QUESTION_PROMPT_VERSION,
    referenceDate: analysis.referenceDate,
    items: analysis.items.map(({ id, domain, intent, scope, answerability, timingSupported, period }) => ({ id, domain, intent, scope, answerability, timingSupported, period })),
    needsClarification: analysis.needsClarification,
    reaction: analysis.reaction ?? "none",
    llmCalls,
  };
}

/**
 * 후속 질문 처리. 상품 범위 안에서 기존 풀이 설명, 상황 적용, 필요한 기간 분석까지 한다.
 *
 * - 정상 답변이 저장될 때만 한 번 차감한다. 한 메시지 안의 소질문 여러 개도 한 번이다.
 * - 범위 밖 안내, 되묻기, 생성 실패, 저장 실패는 차감하지 않는다.
 * - 원국 계산은 저장된 작성 재료를 다시 쓰고, 기간 재료는 필요한 기간만 계산해 저장해 둔다.
 */
export async function askFollowup(input: {
  readonly userId: string;
  readonly readingId: string;
  readonly clientRequestId: string;
  readonly question: string;
}): Promise<FollowupResponse> {
  const { userId, readingId, clientRequestId, question } = input;
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.rpc("begin_followup", {
    p_user_id: userId,
    p_reading_id: readingId,
    p_client_request_id: clientRequestId,
    p_question: question,
    p_lease_seconds: LLM_SETTINGS.followupLeaseSeconds,
    p_rate_per_minute: LLM_SETTINGS.followupRatePerMinute,
  });
  if (error) {
    if (error.message.includes("not_entitled")) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
    if (error.message.includes("not_ready")) throw new ApiError(409, "not_ready", "풀이가 끝난 뒤에 질문할 수 있어요.");
    throw new ApiError(500, "begin_failed", "질문을 시작하지 못했어요.");
  }
  const begin = data as BeginResult;

  if (begin.outcome === "busy") throw new ApiError(409, "busy", "이전 질문의 답변을 만들고 있어요. 잠시만 기다려 주세요.");
  if (begin.outcome === "rate_limited") throw new ApiError(429, "rate_limited", "질문이 너무 빨라요. 잠시 후 다시 시도해 주세요.");
  if (begin.outcome === "exhausted") throw new ApiError(409, "exhausted", "질문을 모두 사용했어요.");

  if (begin.outcome === "duplicate") {
    const previous = begin.followup!;
    if (previous.status === "answered" || previous.status === "off_topic" || previous.status === "clarify") {
      return { status: previous.status, answer: previous.answer ?? "", questionsUsed: begin.used, questionLimit: begin.limit, replayed: true };
    }
    throw new ApiError(409, "busy", "이전 질문을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
  }

  const followupId = begin.followup!.id;
  /** 이 후속 질문에서 보낸 호출(질문 분석, 답변, 재작성)의 사용량. 최초 풀이 사용량(generation_attempts)과 따로 followups.usage에 남는다. */
  const meter = new UsageMeter();
  const failFollowup = async (code: string) => {
    await admin.rpc("fail_followup", { p_followup_id: followupId, p_user_id: userId, p_code: code });
    // 실패한 질문도 이미 쓴 토큰은 남긴다. 호출이 없었으면 남길 것이 없다. 기록 실패는 응답에 영향을 주지 않는다.
    if (meter.calls) {
      const { error: usageError } = await admin.from("followups").update({ usage: meter.summary() }).eq("id", followupId).eq("status", "failed");
      if (usageError) console.warn("[followup] usage not recorded", { readingId, code: usageError.code ?? "unknown" });
    }
  };
  const startedAt = Date.now();
  const deadlineAt = startedAt + LLM_SETTINGS.followupBudgetMs;

  try {
    const modelId = resolveModelId();
    const [internals, reading, messages, previous] = await Promise.all([
      admin.from("reading_internals").select("plan").eq("reading_id", readingId).single(),
      admin.from("readings").select("chart, persona_id, product_id, birth_input").eq("id", readingId).eq("user_id", userId).single(),
      admin.from("reading_messages").select("seq, topic_id, text").eq("reading_id", readingId).order("seq", { ascending: true }),
      admin
        .from("followups")
        .select("question, answer, created_at")
        .eq("reading_id", readingId)
        .eq("status", "answered")
        .order("created_at", { ascending: false })
        .limit(LLM_SETTINGS.followupContextTurns),
    ]);
    if (internals.error || reading.error || messages.error || previous.error) throw new Error("load_failed");

    // 후속 답변은 요청 하나 안에서 끝나므로 현재 프롬프트에 맞는 캐릭터 설정을 쓴다 (followups.prompt_version으로 버전을 알 수 있다).
    const persona = findPersona(reading.data.persona_id as string, personaVersionFor(CURRENT_FOLLOWUP_PROMPT));
    const product = findMessengerProduct(reading.data.product_id as string);
    if (!persona || !product) throw new Error("configuration_unavailable");
    const plan = internals.data.plan as AnyReadingPlan;
    const last = (previous.data ?? [])[0] as { question: string; answer: string | null } | undefined;
    const lastTurn = last ? { question: last.question, answer: truncate(last.answer ?? "", 600) } : null;
    const referenceDate = seoulDate();

    const classified = await classifyQuestion({ product, referenceDate, mode: "followup", text: question, lastTurn, modelId, deadlineAt, meter });
    // 이 풀이에 있는 주제만 답한다. 주제가 늘기 전에 만든 풀이에서 새 주제를 물으면 차감 없이 안내한다.
    const analysis = limitToTopics(classified.analysis, new Set(focusTopicsOf(plan, product).map((topic) => topic.inquiryDomain)));
    let actualModel = classified.meta.actualModel;

    let result: { status: FollowupStatus; answer: string; refs: readonly string[] };
    const items = inScopeItems(analysis);
    if (!items.length) {
      // 반응만 보낸 메시지는 이 풀이에서 앞서 몇 번 보냈는지 센다 (무료 횟수를 넘으면 차감).
      let earlierReactions = 0;
      if (isReactionOnly(analysis)) {
        const { data: earlier } = await admin.from("followups").select("analysis").eq("reading_id", readingId).in("status", ["clarify", "answered"]);
        earlierReactions = ((earlier ?? []) as { analysis: { reaction?: string; items: unknown[] } | null }[]).filter((row) => isReactionOnly(row.analysis)).length;
      }
      result = { ...routeWithoutItems(product, persona, analysis, question, earlierReactions), refs: [] };
    } else {
      const { timing } = await timingFor({ admin, readingId, birth: reading.data.birth_input as PublicBirthInput, items, referenceDate });
      const initialAnalysis = isPlanV2(plan) ? await loadAnalysis<QuestionAnalysis>(admin, readingId, INITIAL_QUESTION_KEY) : null;
      const answered = await answerAnalyzedFollowup({
        plan,
        product,
        persona,
        chart: reading.data.chart as ChartView,
        analysis,
        initialAnalysis,
        timing,
        messages: ((messages.data ?? []) as { topic_id: string | null; text: string }[]).map((row) => ({ topicId: row.topic_id, text: row.text })),
        lastTurn,
        modelId,
        deadlineAt,
        meter,
        // 문단이 완성될 때마다 답을 먼저 저장해 화면에 보여 준다. 횟수 차감과 완료 상태는 complete_followup에서 한 번에 바꾼다.
        publish: async (partial) => {
          const { data: updated, error: updateError } = await admin
            .from("followups")
            .update({ answer: partial })
            .eq("id", followupId)
            .eq("status", "answering")
            .select("id");
          if (updateError || !updated?.length) throw new FollowupHandedOver();
        },
      });
      actualModel = answered.meta.actualModel;
      result = answered;
    }

    const usage = meter.summary();
    const llmCalls = meter.calls;
    const { data: completed, error: completeError } = await admin.rpc("complete_followup", {
      p_followup_id: followupId,
      p_user_id: userId,
      p_status: result.status,
      p_answer: result.answer,
      p_refs: result.refs,
      p_meta: {
        modelId,
        actualModel,
        promptVersion: CURRENT_FOLLOWUP_PROMPT,
        schemaVersion: FOLLOWUP_SCHEMA_VERSION,
        usage,
        durationMs: Date.now() - startedAt,
        analysis: analysisRecord(analysis, llmCalls),
      },
    });
    console.info("[followup] done", {
      readingId,
      status: result.status,
      calls: llmCalls,
      durationMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      usageComplete: usage.complete,
    });
    if (completeError) {
      await failFollowup("save_failed");
      throw new ApiError(500, "save_failed", "답변을 저장하지 못했어요. 질문 횟수는 줄지 않았어요.");
    }
    const saved = completed as { saved: boolean; used: number; limit: number };
    if (!saved.saved) throw new ApiError(409, "exhausted", "질문을 모두 사용했어요.");
    return { status: result.status, answer: result.answer, questionsUsed: saved.used, questionLimit: saved.limit, replayed: false };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof FollowupHandedOver) throw new ApiError(409, "busy", "답변을 만드는 시간이 지나 처리를 멈췄어요. 질문 횟수는 줄지 않았어요.");
    const code = error instanceof LlmError ? error.code : "internal";
    console.error("[followup] failed", { readingId, code, ...(code === "internal" ? { reason: internalReason(error) } : {}) });
    await failFollowup(code);
    throw new ApiError(502, "generation_failed", "답변을 만들지 못했어요. 질문 횟수는 줄지 않았어요.");
  }
}
