import "server-only";

/**
 * 토스페이먼츠 결제 승인. 금액은 항상 서버의 주문 기록에서 가져온다.
 * 테스트 키만 허용하며, 실제 과금으로 바꾸려면 PAYMENTS_ALLOW_LIVE=true를 명시해야 한다.
 */

export type PaymentErrorCode = "config" | "rejected" | "already_processed" | "mismatch" | "unavailable";

export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    readonly providerCode: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifiedPayment {
  readonly paymentKey: string;
  readonly orderId: string;
  readonly totalAmount: number;
  readonly currency: string;
  readonly method: string | null;
}

interface TossPaymentBody {
  paymentKey?: string;
  orderId?: string;
  status?: string;
  totalAmount?: number;
  currency?: string;
  method?: string;
  code?: string;
  message?: string;
}

function assertTestKey(key: string, label: string, env: NodeJS.ProcessEnv): void {
  if (key.startsWith("test_")) return;
  if (env.PAYMENTS_ALLOW_LIVE === "true") return;
  throw new PaymentError("config", "LIVE_KEY_BLOCKED", `${label}: 테스트 키가 아닙니다.`);
}

export function tossClientKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.NEXT_PUBLIC_TOSS_CLIENT_KEY ?? "";
  if (!key) throw new PaymentError("config", "CLIENT_KEY_MISSING", "결제 클라이언트 키가 없습니다.");
  assertTestKey(key, "client key", env);
  return key;
}

function secretKey(env: NodeJS.ProcessEnv): string {
  const key = env.TOSS_SECRET_KEY ?? "";
  if (!key) throw new PaymentError("config", "SECRET_KEY_MISSING", "결제 시크릿 키가 없습니다.");
  assertTestKey(key, "secret key", env);
  return key;
}

function apiBase(env: NodeJS.ProcessEnv): string {
  return env.TOSS_API_BASE_URL ?? "https://api.tosspayments.com";
}

function authHeader(env: NodeJS.ProcessEnv): string {
  return `Basic ${Buffer.from(`${secretKey(env)}:`, "utf8").toString("base64")}`;
}

/** 공식 응답의 주문, 금액, 통화, 상태를 서버 기록과 대조한다. */
export function verifyPaymentBody(
  body: TossPaymentBody,
  expected: { readonly orderId: string; readonly amount: number; readonly currency: string },
): VerifiedPayment {
  if (body.status !== "DONE") {
    throw new PaymentError("mismatch", body.status ?? "NO_STATUS", "결제가 완료 상태가 아닙니다.");
  }
  if (body.orderId !== expected.orderId) throw new PaymentError("mismatch", "ORDER_MISMATCH", "주문 번호가 다릅니다.");
  if (body.totalAmount !== expected.amount) throw new PaymentError("mismatch", "AMOUNT_MISMATCH", "결제 금액이 다릅니다.");
  if (body.currency !== expected.currency) throw new PaymentError("mismatch", "CURRENCY_MISMATCH", "통화가 다릅니다.");
  if (!body.paymentKey) throw new PaymentError("mismatch", "NO_PAYMENT_KEY", "결제 키가 없습니다.");
  return {
    paymentKey: body.paymentKey,
    orderId: body.orderId,
    totalAmount: body.totalAmount,
    currency: body.currency,
    method: body.method ?? null,
  };
}

async function readBody(response: Response): Promise<TossPaymentBody> {
  try {
    return (await response.json()) as TossPaymentBody;
  } catch {
    return {};
  }
}

async function requestToss(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), cache: "no-store" });
  } catch {
    throw new PaymentError("unavailable", "NETWORK", "결제사에 연결하지 못했습니다.");
  }
}

export async function fetchPaymentByKey(
  paymentKey: string,
  expected: { readonly orderId: string; readonly amount: number; readonly currency: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedPayment> {
  const response = await requestToss(`${apiBase(env)}/v1/payments/${encodeURIComponent(paymentKey)}`, {
    headers: { Authorization: authHeader(env) },
  });
  const body = await readBody(response);
  if (!response.ok) throw new PaymentError("rejected", body.code ?? `HTTP_${response.status}`, body.message ?? "조회에 실패했습니다.");
  return verifyPaymentBody(body, expected);
}

/**
 * 같은 주문은 같은 Idempotency-Key로 보내므로 콜백이 반복되어도 결제는 한 번만 승인된다.
 * 이미 승인된 결제라는 응답을 받으면 결제 내역을 조회해서 같은 기준으로 확인한다.
 */
export async function confirmTossPayment(
  input: { readonly paymentKey: string; readonly orderId: string; readonly amount: number; readonly currency: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedPayment> {
  const response = await requestToss(`${apiBase(env)}/v1/payments/confirm`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
      "Idempotency-Key": input.orderId,
    },
    body: JSON.stringify({ paymentKey: input.paymentKey, orderId: input.orderId, amount: input.amount }),
  });
  const body = await readBody(response);
  if (response.ok) return verifyPaymentBody(body, input);
  if (body.code === "ALREADY_PROCESSED_PAYMENT") return fetchPaymentByKey(input.paymentKey, input, env);
  if (response.status >= 500 || body.code === "IDEMPOTENT_REQUEST_PROCESSING") {
    throw new PaymentError("unavailable", body.code ?? `HTTP_${response.status}`, "결제 승인이 지연되고 있어요.");
  }
  throw new PaymentError("rejected", body.code ?? `HTTP_${response.status}`, body.message ?? "결제가 승인되지 않았습니다.");
}
