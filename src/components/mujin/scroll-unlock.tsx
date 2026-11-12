import { PurchaseButton } from "@/components/purchase-button";
import { RedeemButton } from "@/components/redeem-button";
import { LinkButton } from "@/components/ui/button";
import { Badge, Notice } from "@/components/ui/layout";
import { formatPrice } from "@/domain/products";
import { READINGS_CLOSED_MESSAGE } from "@/server/access";
import { FREE_TRIAL, paymentsOpen, type CheckoutMode } from "@/server/checkout/mode";
import type { FreeTicketView } from "@/server/tickets/free-ticket";

const USED_TICKET_LINK: Readonly<Record<"generating" | "failed" | "completed", string>> = {
  generating: "이어서 보기",
  failed: "다시 시도하러 가기",
  completed: "내 풀이 보기",
};

export interface UnlockProps {
  readonly readingId: string;
  readonly productId: string;
  readonly productName: string;
  readonly priceKrw: number;
  /** 출시 가격이 정해지지 않은 임시 가격인가 (상품 설정의 priceStatus). */
  readonly provisional: boolean;
  readonly ticket: FreeTicketView;
  /** 유료 작업을 닫고 이용권을 돌려준 풀이. 이 풀이로는 다시 받을 수 없다. */
  readonly closed: boolean;
  readonly mode: CheckoutMode;
  /** 풀이 상품 이용 범위(관리자만 / 모든 회원) 안에 있는가 */
  readonly allowed: boolean;
}

/**
 * 구매 전 족자 아래의 다음 동선. 맛보기 화면(PreviewAction)과 같은 기준으로 고른다.
 * 무료 테스트 모드(free_trial)에서는 이용권만, 결제 모드(payment)에서는 결제(이용권이 남아 있으면 이용권)를 보여 준다.
 * 이용권 사용·주문은 기존 버튼과 API가 처리하고, 성공하면 같은 족자 화면(/readings/{id})으로 돌아와 유료 장을 쓰기 시작한다.
 * 어떤 경우에도 이 화면까지는 이용권을 쓰거나 결제하지 않는다.
 */
function UnlockAction({ readingId, productId, productName, priceKrw, provisional, ticket, closed, mode, allowed }: UnlockProps) {
  if (closed) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="warning">이 풀이의 이어지는 장은 만들지 못해 닫았고, 무료 이용권은 돌려드렸어요. 같은 정보로 새로 입력하면 다시 받을 수 있어요.</Notice>
        <LinkButton href={`/readings/new?product=${productId}`} size="lg">
          새로 입력하기
        </LinkButton>
      </div>
    );
  }

  const payment = paymentsOpen(mode) ? (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="type-label font-normal text-gray-600">{productName}</span>
        <span className="flex flex-col items-end gap-1">
          <span className="type-title type-price">{formatPrice(priceKrw)}</span>
          {provisional ? <span className="type-caption text-gray-600">출시 전 임시 가격</span> : null}
        </span>
      </div>
      <PurchaseButton readingId={readingId} label="결제하고 이어서 받기" />
    </div>
  ) : null;

  if (!allowed) return <Notice tone="warning">{READINGS_CLOSED_MESSAGE}</Notice>;

  const eligible = FREE_TRIAL.productIds.includes(productId);
  if (ticket.state === "ready" && ticket.available > 0 && eligible) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="type-label font-normal text-gray-600">{productName}</span>
          <Badge tone="success">무료 이용권 {ticket.available}장</Badge>
        </div>
        <RedeemButton readingId={readingId} />
        <p className="type-caption text-gray-600">
          결제 수단은 필요 없어요. 이용권 한 장은 풀이 하나에만 쓸 수 있어요. 장을 쓰다 실패해도 추가로 차감하지 않고 그 장만 다시 시도할 수 있어요.
        </p>
      </div>
    );
  }

  if (ticket.state === "ready" && ticket.current) {
    const used = ticket.current;
    return (
      <div className="flex flex-col gap-3">
        <Notice>무료 이용권은 다른 풀이에 이미 썼어요. 받은 풀이는 보관함에서 다시 볼 수 있어요.</Notice>
        <div className="flex gap-3">
          <LinkButton href={`/readings/${used.readingId}`} className="flex-1">
            {USED_TICKET_LINK[used.state]}
          </LinkButton>
          <LinkButton href="/library" variant="secondary">
            보관함
          </LinkButton>
        </div>
        {payment}
      </div>
    );
  }

  if (payment) return payment;
  return (
    <Notice tone="warning">
      {mode === "free_trial"
        ? eligible
          ? "무료 이용권을 확인하지 못했어요. 잠시 후 새로고침해 주세요."
          : "지금은 이 풀이를 무료 이용권으로 받을 수 없어요."
        : "지금은 이어서 받을 수 없어요. 잠시 후 다시 시도해 주세요."}
    </Notice>
  );
}

/**
 * 족자 아래 '이어지는 장 받기' 영역의 내용 (서버 컴포넌트). 제목과 받는 범위를 보여 주고 아래에 이용권·결제 버튼을 둔다.
 * summary: 받는 범위 한 줄 (예: 2~10장과 궁금한 점 정리 · 후속 질문 3회 · 보관함 · PDF).
 */
export function ScrollUnlock({ summary, ...props }: UnlockProps & { readonly summary: string }) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 tabIndex={-1} className="type-title text-gray-900 outline-none">
          이어지는 장 받기
        </h2>
        <p className="type-caption text-gray-600">{summary}</p>
      </div>
      <UnlockAction {...props} />
    </>
  );
}
