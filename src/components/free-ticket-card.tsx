import { LinkButton } from "@/components/ui/button";
import { Badge, Card, Notice } from "@/components/ui/layout";
import { findProduct } from "@/domain/products";
import { READINGS_CLOSED_MESSAGE } from "@/server/access";
import { FREE_TRIAL } from "@/server/checkout/mode";
import type { FreeTicketView, TicketUse } from "@/server/tickets/free-ticket";

/**
 * 무료 이용권 상태와 다음 동선. 홈과 마이에서 쓴다.
 * 생성 중 → 이어서 보기, 실패 → 추가 차감 없이 다시 시도, 사용 가능 → 시작하기, 완료 → 내 풀이 보기.
 * 풀이 상품 이용이 막힌 회원(allowed = false)에게는 시작 버튼 대신 안내를 보여 준다.
 */
export function FreeTicketCard({ ticket, allowed = true }: { ticket: FreeTicketView; allowed?: boolean }) {
  const product = findProduct(FREE_TRIAL.productIds[0]!);
  const productName = product?.name ?? "사주 풀이";

  if (ticket.state === "none") {
    if (ticket.reason !== "error") return null;
    return <Notice tone="warning">무료 이용권을 확인하지 못했어요. 잠시 후 새로고침해 주세요.</Notice>;
  }

  const remaining = ticket.available > 0 ? `남은 무료 이용권 ${ticket.available}장` : null;
  const focus: TicketUse | { state: "available" } | null =
    ticket.current && ticket.current.state !== "completed" ? ticket.current : ticket.available > 0 ? { state: "available" } : ticket.current;
  if (!focus) return null;

  const readingHref = "readingId" in focus ? `/readings/${focus.readingId}` : "";
  const content = {
    available: {
      badge: <Badge tone="success">무료 이용권 {ticket.available}장</Badge>,
      title: `${productName}을 무료로 받아 보세요`,
      description: "결제 없이 이용권 1장으로 메신저 풀이, 후속 질문, 보관함, PDF까지 받아요.",
      action: { href: product ? `/products/${product.id}` : "/products", label: "무료 이용권으로 시작하기" },
    },
    generating: {
      badge: <Badge tone="progress">풀이 작성 중</Badge>,
      title: "무료 이용권으로 풀이를 만들고 있어요",
      description: remaining ? `화면을 닫아도 이어서 만들어요. ${remaining}.` : "화면을 닫아도 이어서 만들어요.",
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
