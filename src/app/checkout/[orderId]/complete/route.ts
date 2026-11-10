import { NextResponse, type NextRequest } from "next/server";
import { findProduct } from "@/domain/products";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { isMember } from "@/server/auth";
import { checkoutMode, paymentsOpen } from "@/server/checkout/mode";
import { confirmTossPayment, PaymentError } from "@/server/payments/toss";
import { getOrder } from "@/server/readings/store";

/**
 * 결제사가 성공 후 돌려보내는 주소. 쿼리의 금액을 믿지 않고
 * 서버 주문 기록과 결제사의 승인 응답을 대조한 뒤에만 완료 처리한다.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { searchParams, pathname, search } = request.nextUrl;
  const origin = requestOrigin(request);
  const toCheckout = (reason: string) => NextResponse.redirect(new URL(`/checkout/${orderId}?result=${reason}`, origin));

  const supabase = await createSupabaseServerClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  const nextPath = encodeURIComponent(`${pathname}${search}`);
  if (authError || !auth.user) {
    return NextResponse.redirect(new URL(`/login?next=${nextPath}`, origin));
  }
  if (!isMember(auth.user)) return NextResponse.redirect(new URL(`/login?error=kakao_required&next=${nextPath}`, origin));
  const userId = auth.user.id;

  const order = await getOrder(supabase, orderId);
  if (!order) return NextResponse.redirect(new URL("/library", origin));

  const toReading = () => NextResponse.redirect(new URL(`/readings/${order.reading_id}`, origin));
  if (order.status === "paid") return toReading();
  if (order.status !== "pending") return toCheckout("failed");

  const admin = createSupabaseAdminClient();
  const closeAsFailed = (code: string, message: string) =>
    admin.rpc("close_order", { p_order_id: orderId, p_user_id: userId, p_status: "failed", p_code: code, p_message: message });

  // 무료 테스트 모드에서는 결제사에 승인을 요청하지 않는다. 승인하지 않은 결제는 청구되지 않는다.
  if (!paymentsOpen(checkoutMode())) {
    await admin.rpc("close_order", {
      p_order_id: orderId,
      p_user_id: userId,
      p_status: "cancelled",
      p_code: "PAYMENTS_DISABLED",
      p_message: "무료 테스트 기간이라 결제를 받지 않습니다.",
    });
    return toCheckout("disabled");
  }

  const paymentKey = searchParams.get("paymentKey");
  const reportedOrderId = searchParams.get("orderId");
  const reportedAmount = Number(searchParams.get("amount"));
  if (!paymentKey || reportedOrderId !== orderId) {
    await closeAsFailed("INVALID_CALLBACK", "결제 정보가 올바르지 않습니다.");
    return toCheckout("failed");
  }
  if (reportedAmount !== order.amount) {
    await closeAsFailed("AMOUNT_MISMATCH", "결제 금액이 주문과 다릅니다.");
    return toCheckout("failed");
  }

  const product = findProduct(order.product_id);
  if (!product) return toCheckout("failed");

  try {
    const verified = await confirmTossPayment({
      paymentKey,
      orderId,
      amount: order.amount,
      currency: order.currency,
    });

    const { error } = await admin.rpc("mark_order_paid", {
      p_order_id: orderId,
      p_user_id: userId,
      p_payment_key: verified.paymentKey,
      p_amount: verified.totalAmount,
      p_currency: verified.currency,
      p_method: verified.method,
      p_question_limit: product.followupLimit,
    });
    if (error) {
      console.error("[payment] mark paid failed", { orderId });
      return toCheckout("pending");
    }
    return toReading();
  } catch (error) {
    if (error instanceof PaymentError) {
      console.error("[payment] confirm failed", { orderId, code: error.providerCode });
      if (error.code === "unavailable") return toCheckout("pending");
      if (error.code === "config") return toCheckout("config");
      await closeAsFailed(error.providerCode, error.message);
      return toCheckout("failed");
    }
    console.error("[payment] confirm failed", { orderId, code: "internal" });
    return toCheckout("pending");
  }
}
