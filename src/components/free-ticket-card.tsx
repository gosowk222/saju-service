import { LinkButton } from "@/components/ui/button";
import { Badge, Card, Notice } from "@/components/ui/layout";
import { findProduct, type ProductFormat } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { READINGS_CLOSED_MESSAGE } from "@/server/access";
import { FREE_TRIAL } from "@/server/checkout/mode";
import type { FreeTicketView, TicketUse } from "@/server/tickets/free-ticket";

/**
 * 생성 중인 풀이의 안내 (화면 문구). format은 그 풀이의 상품 형식이고, 모르면 null이다.
 * 메신저 상품(묘묘)은 기존 문구 그대로다. 족자 상품(무진)은 한 요청의 시간 예산 안에서만 서버가 쓰고, 그 뒤에는 풀이 화면이
 * 다시 요청해야 이어서 쓰므로 화면을 닫아도 계속 만든다고 말하지 않는다.
 */
export function generatingDescription(format: ProductFormat | null, remaining: string | null): string {
  const base = format === "scroll" ? "풀이 화면을 다시 열면 이어서 써요." : "화면을 닫아도 이어서 만들어요.";
  return remaining ? `${base} ${remaining}.` : base;
}

/** 이용권으로 생성 중인 풀이의 상품 형식. 본인 풀이만 읽힌다(RLS). 읽지 못하면 null (기존 문구를 쓴다). */
async function readingFormat(readingId: string): Promise<ProductFormat | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.from("readings").select("product_id").eq("id", readingId).maybeSingle();
    const product = data ? findProduct(String((data as { product_id: unknown }).product_id)) : undefined;
    return product ? (product.format ?? "messenger") : null;
  } catch {
    return null;
  }
}

/**
 * 무료 이용권 상태와 다음 동선. 홈과 마이에서 쓴다 (서버 컴포넌트).
 * 생성 중 → 이어서 보기, 실패 → 추가 차감 없이 다시 시도, 사용 가능 → 시작하기, 완료 → 내 풀이 보기.
 * 풀이 상품 이용이 막힌 회원(allowed = false)에게는 시작 버튼 대신 안내를 보여 준다.
 * 이용권 대상이 여럿이면(묘묘·무진) '무료 이용권으로 시작하기'는 탐색(/products)으로 가고, 받을 수 있는 풀이 이름을 적는다.
 */
export async function FreeTicketCard({ ticket, allowed = true }: { ticket: FreeTicketView; allowed?: boolean }) {
  // 이용권으로 받을 수 있는 상품 (상품 설정에 있는 것만). 하나면 그 상품 화면으로, 여럿이면 탐색 화면에서 고른다.
  const products = FREE_TRIAL.productIds.flatMap((id) => {
    const product = findProduct(id);
    return product ? [product] : [];
  });
  const startHref = products.length === 1 ? `/products/${products[0]!.id}` : "/products";
  const productNames = products.map((product) => product.name).join(", ");

  if (ticket.state === "none") {
    if (ticket.reason !== "error") return null;
    return <Notice tone="warning">무료 이용권을 확인하지 못했어요. 잠시 후 새로고침해 주세요.</Notice>;
  }

  const remaining = ticket.available > 0 ? `남은 무료 이용권 ${ticket.available}장` : null;
  const focus: TicketUse | { state: "available" } | null =
    ticket.current && ticket.current.state !== "completed" ? ticket.current : ticket.available > 0 ? { state: "available" } : ticket.current;
  if (!focus) return null;

  const readingHref = "readingId" in focus ? `/readings/${focus.readingId}` : "";
  // 생성 중 문구만 상품 형식에 따라 다르다. 그때만 그 풀이의 상품을 읽는다.
  const generatingFormat = focus.state === "generating" ? await readingFormat(focus.readingId) : null;
  const content = {
    available: {
      badge: <Badge tone="success">무료 이용권 {ticket.available}장</Badge>,
      title: "무료 이용권으로 풀이를 받아 보세요",
      description: productNames
        ? `결제 없이 이용권 1장으로 풀이 하나를 받고 후속 질문, 보관함, PDF까지 이용해요. 받을 수 있는 풀이: ${productNames}.`
        : "결제 없이 이용권 1장으로 풀이 하나를 받고 후속 질문, 보관함, PDF까지 이용해요.",
      action: { href: startHref, label: "무료 이용권으로 시작하기" },
    },
    generating: {
      badge: <Badge tone="progress">풀이 작성 중</Badge>,
      title: "무료 이용권으로 풀이를 만들고 있어요",
      description: generatingDescription(generatingFormat, remaining),
      action: { href: readingHref, label: "이어서 보기" },
    },
    failed: {
      badge: <Badge tone="danger">다시 시도 필요</Badge>,
      title: "풀이를 만들지 못했어요",
      description:
        focus.state === "failed" && !focus.canRetry
          ? "여러 번 시도했지만 만들지 못했어요. 고객센터로 문의해 주시면 이용권을 확인해 드려요."
          : "이용권은 그대로예요. 추가 차감 없이 다시 시도할 수 있어요.",
      action: { href: readingHref, label: focus.state === "failed" && !focus.canRetry ? "풀이 보기" : "다시 시도하러 가기" },
    },
    completed: {
      badge: <Badge>사용 완료</Badge>,
      title: "무료 이용권으로 받은 풀이가 있어요",
      description: "후속 질문과 PDF는 풀이 화면에서 이어서 이용할 수 있어요.",
      action: { href: readingHref, label: "내 풀이 보기" },
    },
  }[focus.state];

  // 이용이 막혀 있어도 이미 받은 풀이는 볼 수 있다. 새로 시작하는 동선만 안내로 바꾼다.
  const blocked = !allowed && focus.state === "available";

  return (
    <Card className="flex flex-col gap-3">
      <div>{content.badge}</div>
      <div className="flex flex-col gap-1">
        <p className="type-title text-gray-900">{content.title}</p>
        <p className="type-label font-normal text-gray-600">{blocked ? READINGS_CLOSED_MESSAGE : content.description}</p>
      </div>
      {blocked ? null : (
        <div className="flex flex-wrap gap-3">
          <LinkButton href={content.action.href}>{content.action.label}</LinkButton>
          {focus.state === "completed" ? (
            <LinkButton href="/library" variant="secondary">
              보관함
            </LinkButton>
          ) : null}
        </div>
      )}
    </Card>
  );
}
