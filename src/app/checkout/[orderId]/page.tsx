import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PurchaseButton } from "@/components/purchase-button";
import { TossCheckout } from "@/components/toss-checkout";
import { Card, LoadingScreen, Notice, PageHeader } from "@/components/ui/layout";
import { findProduct, formatPrice } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import { PaymentError, tossClientKey } from "@/server/payments/toss";
import { getOrder } from "@/server/readings/store";

const RESULT_MESSAGES: Readonly<Record<string, { text: string; tone: "danger" | "warning" }>> = {
  failed: { text: "결제가 완료되지 않았어요. 카드나 결제 수단을 확인하고 다시 시도해 주세요.", tone: "danger" },
  cancelled: { text: "결제를 취소했어요. 원하시면 다시 결제할 수 있어요.", tone: "warning" },
  pending: { text: "결제 확인이 지연되고 있어요. 잠시 후 이 화면을 새로고침해 주세요.", tone: "warning" },
  config: { text: "결제 설정을 확인해야 해요. 잠시 후 다시 시도해 주세요.", tone: "danger" },
};

function resolveClientKey(): string | null {
  try {
    return tossClientKey();
  } catch (error) {
    if (error instanceof PaymentError) return null;
    throw error;
  }
}

async function Checkout({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  await requirePageUser(`/checkout/${orderId}`);
  const supabase = await createSupabaseServerClient();
  const order = await getOrder(supabase, orderId);
  if (!order) notFound();
  if (order.status === "paid") redirect(`/readings/${order.reading_id}`);

  const product = findProduct(order.product_id);
  const result = typeof query.result === "string" ? RESULT_MESSAGES[query.result] : undefined;
  const clientKey = resolveClientKey();

  return (
    <>
      <PageHeader title="결제" backHref={`/readings/${order.reading_id}/preview`} />
      <main className="flex flex-1 flex-col gap-7 px-5 py-6">
        <Card>
          <p className="type-label font-normal text-gray-600">{product?.name ?? "사주 풀이"}</p>
          <p className="mt-1 type-h3 type-price">{formatPrice(order.amount)}</p>
        </Card>
        {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
        {order.status === "pending" ? (
          clientKey ? (
            <TossCheckout clientKey={clientKey} orderId={order.id} orderName={product?.orderName ?? "사주 풀이"} amount={order.amount} />
          ) : (
            <Notice tone="danger">결제 설정이 아직 완료되지 않았어요. NEXT_PUBLIC_TOSS_CLIENT_KEY를 확인해 주세요.</Notice>
          )
        ) : (
          <PurchaseButton readingId={order.reading_id} label="다시 결제하기" />
        )}
      </main>
    </>
  );
}

export default function CheckoutPage(props: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Checkout params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}
