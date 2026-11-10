import { ok, requireApiUser, route } from "@/server/api";
import { createOrder } from "@/server/readings/orders";

export const POST = route<{ readingId: string }>(async (_request, { readingId }) => {
  const { user } = await requireApiUser();
  const order = await createOrder(user.id, readingId);
  return ok({ orderId: order.id }, 201);
});
