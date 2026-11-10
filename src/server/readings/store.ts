import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartView, ReadingPreview, StoredMessage } from "@/domain/reading/types";

/**
 * 사용자 권한(RLS)으로 읽는 조회 함수. supabase는 로그인한 사용자의 클라이언트다.
 * 소유자가 아니면 행이 돌아오지 않는다.
 */

export interface ReadingRow {
  readonly id: string;
  readonly user_id: string;
  readonly product_id: string;
  readonly product_version: string;
  readonly nickname: string;
  readonly birth_input: {
    readonly birthDate: string;
    readonly calendar: { readonly type: "solar" } | { readonly type: "lunar"; readonly isLeapMonth: boolean };
    readonly gender: string;
    readonly birthTime: { readonly status: "unknown" } | { readonly status: "branch"; readonly branch: string };
  };
  readonly place_snapshot: {
    readonly geonameId: number;
    readonly name: string;
    readonly admin: string;
    readonly label: string;
    readonly latitudeDeg: number;
    readonly longitudeDeg: number;
    readonly timezoneId: string;
    readonly datasetVersion: string;
  };
  readonly situation_id: string | null;
  readonly concern: string;
  readonly chart: ChartView;
  readonly preview: ReadingPreview;
  readonly persona_id: string;
  readonly persona_version: string;
  readonly ruleset_id: string;
  readonly ruleset_version: string;
  readonly engine_meta: { readonly fingerprint: string };
  readonly created_at: string;
}

export interface OrderRow {
  readonly id: string;
  readonly user_id: string;
  readonly reading_id: string;
  readonly product_id: string;
  readonly product_version: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: "pending" | "paid" | "failed" | "cancelled";
  readonly provider: string;
  readonly payment_key: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly created_at: string;
}

export interface JobRow {
  readonly reading_id: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly attempts: number;
  readonly lease_until: string | null;
  readonly model_id: string | null;
  readonly prompt_version: string | null;
  readonly schema_version: string | null;
  readonly reasoning_effort: string | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
}

export interface EntitlementRow {
  readonly reading_id: string;
  readonly order_id: string;
  readonly question_limit: number;
  readonly created_at: string;
}

export interface FollowupRow {
  readonly id: string;
  readonly reading_id: string;
  readonly client_request_id: string;
  readonly question: string;
  readonly answer: string | null;
  /** clarify는 되묻기이며 질문 횟수를 차감하지 않는다. */
  readonly status: "answering" | "answered" | "clarify" | "off_topic" | "failed";
  readonly created_at: string;
}

type Db = SupabaseClient;

export async function getReading(supabase: Db, readingId: string): Promise<ReadingRow | null> {
  const { data } = await supabase.from("readings").select("*").eq("id", readingId).maybeSingle();
  return (data as ReadingRow | null) ?? null;
}

export async function getOrder(supabase: Db, orderId: string): Promise<OrderRow | null> {
  const { data } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
  return (data as OrderRow | null) ?? null;
}

export async function getEntitlement(supabase: Db, readingId: string): Promise<EntitlementRow | null> {
  const { data } = await supabase.from("entitlements").select("*").eq("reading_id", readingId).maybeSingle();
  return (data as EntitlementRow | null) ?? null;
}

export async function getJob(supabase: Db, readingId: string): Promise<JobRow | null> {
  const { data } = await supabase.from("generation_jobs").select("*").eq("reading_id", readingId).maybeSingle();
  return (data as JobRow | null) ?? null;
}

export async function getMessages(supabase: Db, readingId: string): Promise<StoredMessage[]> {
  const { data } = await supabase
    .from("reading_messages")
    .select("seq, topic_id, kind, text, refs")
    .eq("reading_id", readingId)
    .order("seq", { ascending: true });
  return ((data ?? []) as { seq: number; topic_id: string | null; kind: StoredMessage["kind"]; text: string; refs: string[] }[]).map(
    (row) => ({ seq: row.seq, topicId: row.topic_id, kind: row.kind, text: row.text, refs: row.refs }),
  );
}

export async function getFollowups(supabase: Db, readingId: string): Promise<FollowupRow[]> {
  const { data } = await supabase
    .from("followups")
    .select("id, reading_id, client_request_id, question, answer, status, created_at")
    .eq("reading_id", readingId)
    .order("created_at", { ascending: true });
  return (data ?? []) as FollowupRow[];
}

export async function countQuestionsUsed(supabase: Db, readingId: string): Promise<number> {
  const { count } = await supabase
    .from("question_usage")
    .select("id", { count: "exact", head: true })
    .eq("reading_id", readingId);
  return count ?? 0;
}

export type GenerationStatus = "queued" | "running" | "completed" | "failed";

/** 브라우저로 보내는 풀이 상태. 내부 근거 ID는 포함하지 않는다. */
export interface ReadingStateView {
  readonly status: GenerationStatus;
  readonly errorCode: string | null;
  readonly canRetry: boolean;
  readonly messages: readonly { seq: number; topicId: string | null; kind: StoredMessage["kind"]; text: string }[];
  readonly followups: readonly { id: string; question: string; answer: string | null; status: FollowupRow["status"]; createdAt: string }[];
  readonly questionsUsed: number;
  readonly questionLimit: number;
}

export const USER_RETRY_LIMIT = 4;

export async function loadReadingState(supabase: Db, readingId: string): Promise<ReadingStateView | null> {
  const [entitlement, job] = await Promise.all([getEntitlement(supabase, readingId), getJob(supabase, readingId)]);
  if (!entitlement || !job) return null;
  const leaseExpired = job.status === "running" && (!job.lease_until || new Date(job.lease_until) < new Date());
  const status: GenerationStatus = leaseExpired ? "queued" : job.status;

  // 생성 중에도 이미 완성된 주제의 메시지를 보낸다 (주제가 완성될 때마다 먼저 보여 준다).
  const [messages, followups, questionsUsed] = await Promise.all([
    getMessages(supabase, readingId),
    status === "completed" ? getFollowups(supabase, readingId) : Promise.resolve([]),
    countQuestionsUsed(supabase, readingId),
  ]);

  return {
    status,
    errorCode: job.error_code,
    canRetry: status === "failed" && job.attempts < USER_RETRY_LIMIT,
    messages: messages.map(({ seq, topicId, kind, text }) => ({ seq, topicId, kind, text })),
    followups: followups
      .filter((followup) => followup.status !== "failed")
      .map((followup) => ({
        id: followup.id,
        question: followup.question,
        answer: followup.answer,
        status: followup.status,
        createdAt: followup.created_at,
      })),
    questionsUsed,
    questionLimit: entitlement.question_limit,
  };
}
