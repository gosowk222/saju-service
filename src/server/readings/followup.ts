import "server-only";
import { findPersona } from "@/domain/personas";
import type { ChartView, ReadingPlan, StoredMessage } from "@/domain/reading/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import { answerFollowup } from "@/server/llm/narrate";
import { CURRENT_FOLLOWUP_PROMPT, FOLLOWUP_SCHEMA_VERSION } from "@/server/llm/prompts";

export const OFF_TOPIC_REPLY = "방금 받은 풀이에 대해 궁금한 점을 물어봐 주세요.";

export interface FollowupResponse {
  readonly status: "answered" | "off_topic";
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

/**
 * 후속 질문 처리. 답변이 정상 저장될 때만 한 번 차감한다.
 * 관련 없는 질문, 생성 실패, 저장 실패는 차감하지 않는다.
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
    if (previous.status === "answered" || previous.status === "off_topic") {
      return {
        status: previous.status,
        answer: previous.status === "off_topic" ? OFF_TOPIC_REPLY : (previous.answer ?? ""),
        questionsUsed: begin.used,
        questionLimit: begin.limit,
        replayed: true,
      };
    }
    throw new ApiError(409, "busy", "이전 질문을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
  }

  const followupId = begin.followup!.id;
  const failFollowup = (code: string) =>
    admin.rpc("fail_followup", { p_followup_id: followupId, p_user_id: userId, p_code: code });

  try {
    const modelId = resolveModelId();
    const [internals, reading, messages, previous] = await Promise.all([
      admin.from("reading_internals").select("plan").eq("reading_id", readingId).single(),
      admin.from("readings").select("chart, persona_id").eq("id", readingId).eq("user_id", userId).single(),
      admin.from("reading_messages").select("seq, topic_id, kind, text, refs").eq("reading_id", readingId).order("seq", { ascending: true }),
      admin
        .from("followups")
        .select("question, answer, status, created_at")
        .eq("reading_id", readingId)
        .in("status", ["answered"])
        .order("created_at", { ascending: false })
        .limit(LLM_SETTINGS.followupContextTurns),
    ]);
    if (internals.error || reading.error || messages.error || previous.error) throw new Error("load_failed");

    const persona = findPersona(reading.data.persona_id as string);
    if (!persona) throw new Error("persona_unavailable");

    const stored: StoredMessage[] = (messages.data as { seq: number; topic_id: string | null; kind: StoredMessage["kind"]; text: string; refs: string[] }[]).map(
      (row) => ({ seq: row.seq, topicId: row.topic_id, kind: row.kind, text: row.text, refs: row.refs }),
    );
    const recentConversation = ((previous.data ?? []) as { question: string; answer: string | null }[])
      .reverse()
      .map((row) => ({ question: row.question, answer: row.answer ?? "" }));

    const { output, meta } = await answerFollowup({
      plan: internals.data.plan as ReadingPlan,
      chart: reading.data.chart as ChartView,
      persona,
      messages: stored,
      recentConversation,
      question,
      modelId,
    });

    const status = output.relevance === "related" ? "answered" : "off_topic";
    const answer = status === "answered" ? output.answer.trim() : OFF_TOPIC_REPLY;

    const { data: completed, error: completeError } = await admin.rpc("complete_followup", {
      p_followup_id: followupId,
      p_user_id: userId,
      p_status: status,
      p_answer: answer,
      p_refs: status === "answered" ? output.refs : [],
      p_meta: {
        modelId,
        actualModel: meta.actualModel,
        promptVersion: CURRENT_FOLLOWUP_PROMPT,
        schemaVersion: FOLLOWUP_SCHEMA_VERSION,
        usage: meta.usage,
        durationMs: meta.durationMs,
      },
    });
    if (completeError) {
      await failFollowup("save_failed");
      throw new ApiError(500, "save_failed", "답변을 저장하지 못했어요. 질문 횟수는 줄지 않았어요.");
    }
    const result = completed as { saved: boolean; used: number; limit: number };
    if (!result.saved) throw new ApiError(409, "exhausted", "질문을 모두 사용했어요.");

    return { status, answer, questionsUsed: result.used, questionLimit: result.limit, replayed: false };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = error instanceof LlmError ? error.code : "internal";
    console.error("[followup] failed", { readingId, code });
    await failFollowup(code);
    throw new ApiError(502, "generation_failed", "답변을 만들지 못했어요. 질문 횟수는 줄지 않았어요.");
  }
}
