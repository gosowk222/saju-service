import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findProduct, isScrollProduct } from "@/domain/products";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { checkoutMode, FREE_TRIAL, grantsOpen, type CheckoutMode } from "@/server/checkout/mode";
import { getReading, USER_RETRY_LIMIT, type JobRow } from "@/server/readings/store";
import { SCROLL_SETTINGS } from "@/server/scroll/config";

/**
 * 무료 이용권.
 * - 캠페인 이용권: 카카오 회원당 한 장 (free-trial-2026-11, 무료 테스트 모드에서 지급)
 * - 관리자 지급 이용권: 관리자 화면에서 고른 회원에게 한 장씩 더 준다
 * 지급·사용·완료·반환은 모두 supabase/migrations의 서버 전용 함수가 한 트랜잭션으로 처리한다.
 * 회원 판정도 DB 함수(is_kakao_member)가 Supabase Auth의 실제 연결 정보로 다시 한다.
 */

export type GrantOutcome = "granted" | "exists" | "not_eligible" | "closed" | "error";

interface TicketRow {
  readonly id: string;
  readonly status: "available" | "redeemed" | "completed";
  readonly reading_id: string | null;
  readonly source: "campaign" | "admin";
  readonly redeemed_at: string | null;
}

/**
 * 지급이 열려 있으면(무료 테스트 모드) 캠페인 이용권 한 장을 보장한다. 이미 있으면 그대로 둔다.
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
 * 맛보기에서 "무료 이용권 1장으로 풀이받기"를 눌렀을 때. 사용 가능한 이용권 한 장(캠페인 → 먼저 받은 순)을
 * 이 풀이 한 건에 연결하고 이용 권한과 생성 작업을 한 트랜잭션으로 만든다.
 * 같은 요청이 다시 오거나 이미 권한이 있으면 추가로 쓰지 않는다. 결제 기록이나 결제 승인 번호는 만들지 않는다.
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

/** 이용권으로 진행 중이거나 실패했거나 완료한 풀이. */
export type TicketUse =
  | { readonly state: "generating"; readonly readingId: string }
  | { readonly state: "failed"; readonly readingId: string; readonly canRetry: boolean }
  | { readonly state: "completed"; readonly readingId: string };

/** 화면에 보여 줄 이용권 상태. 이용권 코드나 결제 정보는 없다. */
export type FreeTicketView =
  | { readonly state: "none"; readonly reason: "closed" | "not_eligible" | "error" }
  | {
      readonly state: "ready";
      /** 사용 가능한 이용권 수 */
      readonly available: number;
      /** 손이 필요한 풀이(생성 중·실패)를 먼저, 없으면 가장 최근에 완료한 풀이 */
      readonly current: TicketUse | null;
    };

async function readTickets(supabase: SupabaseClient): Promise<TicketRow[]> {
  // 본인 이용권만 RLS로 읽힌다.
  const { data } = await supabase
    .from("free_tickets")
    .select("id, status, reading_id, source, redeemed_at")
    .order("granted_at", { ascending: true });
  return (data ?? []) as TicketRow[];
}

/**
 * 로그인한 회원의 이용권 상태. 지급이 열려 있는데 캠페인 이용권이 없으면 이때 지급한다 (가입 때 일시적으로 실패한 경우의 복구).
 * supabase는 로그인한 사용자 권한의 클라이언트, userId는 서버가 검증한 사용자 ID다.
 */
export async function loadFreeTicket(supabase: SupabaseClient, userId: string): Promise<FreeTicketView> {
  const mode = checkoutMode();
  let tickets = await readTickets(supabase);
  if (!tickets.some((ticket) => ticket.source === "campaign")) {
    // 같은 렌더링 안에서 같은 조회를 다시 보내면 Next가 앞의 결과를 재사용하므로, 지급 함수가 돌려준 행을 쓴다.
    const granted = await grantFreeTicket(userId, mode);
    if (granted.ticket) tickets = [...tickets, { ...granted.ticket, source: "campaign" }];
    else if (tickets.length === 0) {
      const reason = granted.outcome === "not_eligible" ? "not_eligible" : granted.outcome === "closed" ? "closed" : "error";
      return { state: "none", reason };
    }
  }

  const available = tickets.filter((ticket) => ticket.status === "available").length;
  const used = tickets
    .filter((ticket): ticket is TicketRow & { reading_id: string } => ticket.status !== "available" && Boolean(ticket.reading_id))
    .sort((a, b) => (b.redeemed_at ?? "").localeCompare(a.redeemed_at ?? ""));
  if (used.length === 0) return { state: "ready", available, current: null };

  const readingIds = used.map((ticket) => ticket.reading_id);
  const [{ data }, { data: readingRows }] = await Promise.all([
    supabase.from("generation_jobs").select("reading_id, status, attempts").in("reading_id", readingIds),
    supabase.from("readings").select("id, product_id").in("id", readingIds),
  ]);
  const jobs = new Map(((data ?? []) as Pick<JobRow, "reading_id" | "status" | "attempts">[]).map((job) => [job.reading_id, job]));
  const products = new Map(((readingRows ?? []) as { id: string; product_id: string }[]).map((row) => [row.id, row.product_id]));
  // 족자 상품(무진)의 유료 작업은 시간 예산마다 반납·이어받기를 해서 시작 횟수가 묘묘보다 많다. 그 상품의 상한으로 다시 시도 여부를 본다.
  const retryLimitOf = (readingId: string) => (isScrollProduct(findProduct(products.get(readingId) ?? "")) ? SCROLL_SETTINGS.paidMaxRuns : USER_RETRY_LIMIT);

  const uses: TicketUse[] = used.map((ticket) => {
    const job = jobs.get(ticket.reading_id);
    if (ticket.status === "completed" || job?.status === "completed") return { state: "completed", readingId: ticket.reading_id };
    if (job?.status === "failed") return { state: "failed", readingId: ticket.reading_id, canRetry: job.attempts < retryLimitOf(ticket.reading_id) };
    // 대기·생성 중, 또는 점유 시간이 지나 다시 시작을 기다리는 작업. 풀이 화면에 들어가면 이어서 만든다.
    return { state: "generating", readingId: ticket.reading_id };
  });
  const current = uses.find((use) => use.state !== "completed") ?? uses[0] ?? null;
  return { state: "ready", available, current };
}

export type AdminGrantOutcome = "granted" | "exists" | "not_eligible";

/** 관리자가 고른 회원에게 무료 이용권 한 장을 준다. 같은 요청 ID는 한 번만 반영된다. */
export async function adminGrantFreeTicket(input: {
  readonly adminId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly note?: string;
}): Promise<AdminGrantOutcome> {
  const { data, error } = await createSupabaseAdminClient().rpc("admin_grant_free_ticket", {
    p_admin_id: input.adminId,
    p_user_id: input.userId,
    p_request_id: input.requestId,
    p_note: input.note ?? null,
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("not_admin")) throw new ApiError(404, "not_found", "찾을 수 없어요.");
    if (message.includes("request_conflict")) throw new ApiError(409, "request_conflict", "같은 요청이 다른 회원에게 이미 쓰였어요. 화면을 새로고침해 주세요.");
    if (message.includes("foreign key")) throw new ApiError(404, "member_not_found", "회원을 찾을 수 없어요.");
    throw new ApiError(500, "grant_failed", "이용권을 주지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  return (data as { outcome: AdminGrantOutcome }).outcome;
}
