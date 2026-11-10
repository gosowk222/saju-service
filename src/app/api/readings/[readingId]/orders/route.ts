import { ApiError, ok, route } from "@/server/api";
import { requireReadingAccess } from "@/server/access";
import { checkoutMode, paymentsOpen } from "@/server/checkout/mode";
import { createOrder } from "@/server/readings/orders";

export const POST = route<{ readingId: string }>(async (_request, { readingId }) => {
  const { user } = await requireReadingAccess();
  // 무료 테스트 모드에서는 새 결제를 서버에서도 막는다. 화면의 버튼을 숨기는 것만으로 끝내지 않는다.
  if (!paymentsOpen(checkoutMode())) {
    throw new ApiError(403, "payments_disabled", "지금은 결제를 받지 않아요. 무료 이용권으로 이용해 주세요.");
  }
  const order = await createOrder(user.id, readingId);
  return ok({ orderId: order.id }, 201);
});
