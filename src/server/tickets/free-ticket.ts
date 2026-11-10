import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findProduct } from "@/domain/products";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { checkoutMode, FREE_TRIAL, grantsOpen, type CheckoutMode } from "@/server/checkout/mode";
import { getReading, USER_RETRY_LIMIT, type JobRow } from "@/server/readings/store";

/**
 * 무료 이용권 (회원당 한 장, 캠페인 free-trial-2026-11).
 * 지급·사용·완료·반환은 모두 supabase/migrations의 서버 전용 함수가 한 트랜잭션으로 처리한다.
 * 회원 판정도 DB 함수(is_kakao_member)가 Supabase Auth의 실제 연결 정보로 다시 한다.
 */

export type GrantOutcome = "granted" | "exists" | "not_eligible" | "closed" | "error";

/**
 * 지급이 열려 있으면(무료 테스트 모드) 한 장을 보장한다. 이미 있으면 그대로 둔다.
 * 신규 가입(콜백), 로그인 후 누락 복구(이용권 조회), 사용 직전에 같은 함수를 쓴다.
 * 오류는 던지지 않고 결과로 돌려준다. 지급 오류가 로그인을 망가뜨리지 않게 하고, 다음 조회에서 다시 시도한다.
 */
export async function ensureFreeTicket(userId: string, mode: CheckoutMode = checkoutMode()): Promise<GrantOutcome> {
  return (await grantFreeTicket(userId, mode)).outcome;
}

/** ensureFreeTicket과 같고, 지급 함수가 돌려준 이용권 행도 함께 돌려준다. */
async function grantFreeTicket(userId: string, mode: CheckoutMode): Promise<{ outcome: GrantOutcome; ticket: TicketRow | null }> {
  if (!grantsOpen(mode)) return { outcome: "closed", ticket: null };
  try {
    const { data, error } = await createSupabaseAdminClient().rpc("grant_free_ticket", {
      p_user_id: userId,
      p_campaign_id: FREE_TRIAL.campaignId,
    });
    if (error) {
      console.error("[free-ticket] grant failed", { code: error.code ?? "unknown" });
      return { outcome: "error", ticket: null };
    }
    const result = data as { outcome: GrantOutcome; ticket?: TicketRow };
    return { outcome: result.outcome, ticket: result.ticket ?? null };
  } catch (error) {
    console.error("[free-ticket] grant failed", { reason: error instanceof Error ? error.name : typeof error });
    return { outcome: "error", ticket: null };
  }
}

export type RedeemOutcome = "redeemed" | "already_redeemed" | "already_entitled" | "ticket_used";

export interface RedeemResult {
  readonly outcome: RedeemOutcome;
  /** 이동할 풀이. ticket_used면 이용권을 이미 쓴 다른 풀이다. */
  readonly readingId: string;
}

/**
 * 맛보기에서 "무료 이용권 1장으로 풀이받기"를 눌렀을 때. 이용권 한 장을 이 풀이 한 건에 연결하고
 * 이용 권한과 생성 작업을 한 트랜잭션으로 만든다. 같은 요청이 다시 오거나 이미 권한이 있으면 추가로 쓰지 않는다.
 * 결제 기록이나 결제 승인 번호는 만들지 않는다.
 */
export async function redeemFreeTicket(input: {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly readingId: string;
  readonly requestId: string;
}): Promise<RedeemResult> {
  const reading = await getReading(input.supabase, input.readingId);
  if (!reading) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
  const product = findProduct(reading.product_id);
  if (!product) throw new ApiError(404, "unknown_product", "이용할 수 없는 상품이에요.");
  if (!FREE_TRIAL.productIds.includes(product.id)) {
    throw new ApiError(409, "product_not_eligible", "무료 이용권으로 받을 수 없는 상품이에요.");
  }

  // 가입 때 지급이 일시적으로 실패했다면 여기서 지급한다. 지급이 닫혀 있으면(결제 모드) 이미 받은 이용권만 쓴다.
  await ensureFreeTicket(input.userId);

  const { data, error } = await createSupabaseAdminClient().rpc("redeem_free_ticket", {
    p_user_id: input.userId,
    p_reading_id: reading.id,
    p_request_id: input.requestId,
    p_campaign_id: FREE_TRIAL.campaignId,
    p_product_id: product.id,
    p_product_version: product.version,
    p_question_limit: product.followupLimit,
    p_binding: {
      productId: product.id,
      productVersion: product.version,
      questionLimit: product.followupLimit,
      readingId: reading.id,
      engineFingerprint: reading.engine_meta.fingerprint,
      rulesetId: reading.ruleset_id,
      rulesetVersion: reading.ruleset_version,
      personaId: reading.persona_id,
      personaVersion: reading.persona_version,
      placeGeonameId: reading.place_snapshot.geonameId,
      placeDatasetVersion: reading.place_snapshot.datasetVersion,
    },
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("no_ticket")) throw new ApiError(409, "no_ticket", "사용할 수 있는 무료 이용권이 없어요.");
    if (message.includes("not_eligible")) throw new ApiError(403, "kakao_login_required", "카카오로 로그인한 회원만 이용할 수 있어요.");
    if (message.includes("not_found")) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
    if (message.includes("reading_closed")) {
      throw new ApiError(409, "reading_closed", "이 풀이는 다시 시작할 수 없어요. 입력 수정에서 새로 만들어 주세요.");
    }
    if (message.includes("already_entitled")) return { outcome: "already_entitled", readingId: reading.id };
    throw new ApiError(500, "redeem_failed", "이용권을 쓰지 못했어요. 이용권은 그대로예요. 잠시 후 다시 시도해 주세요.");
  }
  const result = data as { outcome: RedeemOutcome; readingId: string };
  return { outcome: result.outcome, readingId: result.readingId };
}

interface TicketRow {
  readonly id: string;
  readonly status: "available" | "redeemed" | "completed";
  readonly reading_id: string | null;
}

/** 화면에 보여 줄 이용권 상태. 이용권 코드나 결제 정보는 없다. */
export type FreeTicketView =
  | { readonly state: "none"; readonly reason: "closed" | "not_eligible" | "error" }
  | { readonly state: "available" }
  | { readonly state: "generating"; readonly readingId: string }
  | { readonly state: "failed"; readonly readingId: string; readonly canRetry: boolean }
  | { readonly state: "completed"; readonly readingId: string };

async function readTicket(supabase: SupabaseClient): Promise<TicketRow | null> {
  // 본인 이용권만 RLS로 읽힌다.
  const { data } = await supabase
    .from("free_tickets")
    .select("id, status, reading_id")
    .eq("campaign_id", FREE_TRIAL.campaignId)
    .maybeSingle();
  return (data as TicketRow | null) ?? null;
}

/**
 * 로그인한 회원의 이용권 상태. 지급이 열려 있는데 이용권이 없으면 이때 지급한다 (가입 때 일시적으로 실패한 경우의 복구).
 * supabase는 로그인한 사용자 권한의 클라이언트, userId는 서버가 검증한 사용자 ID다.
 */
export async function loadFreeTicket(supabase: SupabaseClient, userId: string): Promise<FreeTicketView> {
  const mode = checkoutMode();
  let ticket = await readTicket(supabase);
  if (!ticket) {
    // 같은 렌더링 안에서 같은 조회를 다시 보내면 Next가 앞의 결과(없음)를 재사용하므로, 지급 함수가 돌려준 행을 쓴다.
    const granted = await grantFreeTicket(userId, mode);
    ticket = granted.ticket;
    if (!ticket) {
      const reason = granted.outcome === "not_eligible" ? "not_eligible" : granted.outcome === "closed" ? "closed" : "error";
      return { state: "none", reason };
    }
  }
  if (ticket.status === "available" || !ticket.reading_id) return { state: "available" };
  if (ticket.status === "completed") return { state: "completed", readingId: ticket.reading_id };

  const { data } = await supabase
    .from("generation_jobs")
    .select("status, attempts")
    .eq("reading_id", ticket.reading_id)
    .maybeSingle();
  const job = data as Pick<JobRow, "status" | "attempts"> | null;
  if (job?.status === "completed") return { state: "completed", readingId: ticket.reading_id };
  if (job?.status === "failed") return { state: "failed", readingId: ticket.reading_id, canRetry: job.attempts < USER_RETRY_LIMIT };
  // 대기·생성 중, 또는 점유 시간이 지나 다시 시작을 기다리는 작업. 풀이 화면에 들어가면 이어서 만든다.
  return { state: "generating", readingId: ticket.reading_id };
}
