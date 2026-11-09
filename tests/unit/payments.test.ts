import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentError, confirmTossPayment, tossClientKey, verifyPaymentBody } from "@/server/payments/toss";

const env = { TOSS_SECRET_KEY: "test_gsk_x", NEXT_PUBLIC_TOSS_CLIENT_KEY: "test_gck_x" } as unknown as NodeJS.ProcessEnv;
const expected = { orderId: "order-1", amount: 990, currency: "KRW" };
const done = { paymentKey: "pk", orderId: "order-1", status: "DONE", totalAmount: 990, currency: "KRW", method: "카드" };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(responses: { status: number; body: unknown }[]) {
  const mock = vi.fn(async () => {
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentError);
    return (error as PaymentError).code;
  }
}

describe("결제 응답 대조", () => {
  it("주문, 금액, 통화, 상태가 모두 맞아야 통과한다", () => {
    expect(verifyPaymentBody(done, expected).totalAmount).toBe(990);
    expect(() => verifyPaymentBody({ ...done, status: "CANCELED" }, expected)).toThrow(PaymentError);
    expect(() => verifyPaymentBody({ ...done, totalAmount: 1 }, expected)).toThrow(PaymentError);
    expect(() => verifyPaymentBody({ ...done, currency: "USD" }, expected)).toThrow(PaymentError);
    expect(() => verifyPaymentBody({ ...done, orderId: "other" }, expected)).toThrow(PaymentError);
  });
});

describe("결제 승인", () => {
  const input = { paymentKey: "pk", ...expected };

  it("주문 번호를 Idempotency-Key로 보내고 서버 금액을 전달한다", async () => {
    const mock = stubFetch([{ status: 200, body: done }]);
    await confirmTossPayment(input, env);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tosspayments.com/v1/payments/confirm");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("order-1");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("test_gsk_x:").toString("base64")}`);
    expect(JSON.parse(init.body as string)).toEqual({ paymentKey: "pk", orderId: "order-1", amount: 990 });
  });

  it("이미 처리된 결제는 조회해서 같은 기준으로 확인한다", async () => {
    const mock = stubFetch([
      { status: 400, body: { code: "ALREADY_PROCESSED_PAYMENT", message: "x" } },
      { status: 200, body: done },
    ]);
    await expect(confirmTossPayment(input, env)).resolves.toMatchObject({ paymentKey: "pk" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("거절과 일시 장애를 구분한다", async () => {
    stubFetch([{ status: 400, body: { code: "REJECT_CARD_COMPANY", message: "x" } }]);
    expect(await errorCode(confirmTossPayment(input, env))).toBe("rejected");
    stubFetch([{ status: 500, body: { code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "x" } }]);
    expect(await errorCode(confirmTossPayment(input, env))).toBe("unavailable");
  });

  it("응답 금액이 주문과 다르면 완료로 처리하지 않는다", async () => {
    stubFetch([{ status: 200, body: { ...done, totalAmount: 10 } }]);
    expect(await errorCode(confirmTossPayment(input, env))).toBe("mismatch");
  });
});

describe("실제 과금 방지", () => {
  it("테스트 키가 아니면 막는다", async () => {
    const live = { TOSS_SECRET_KEY: "live_gsk_x" } as unknown as NodeJS.ProcessEnv;
    const mock = stubFetch([{ status: 200, body: done }]);
    expect(await errorCode(confirmTossPayment({ paymentKey: "pk", ...expected }, live))).toBe("config");
    expect(mock).not.toHaveBeenCalled();
    expect(() => tossClientKey({ NEXT_PUBLIC_TOSS_CLIENT_KEY: "live_gck_x" } as unknown as NodeJS.ProcessEnv)).toThrow(PaymentError);
  });

  it("명시적으로 허용해야만 실제 키를 쓸 수 있다", () => {
    expect(tossClientKey({ NEXT_PUBLIC_TOSS_CLIENT_KEY: "live_gck_x", PAYMENTS_ALLOW_LIVE: "true" } as unknown as NodeJS.ProcessEnv)).toBe("live_gck_x");
  });
});
