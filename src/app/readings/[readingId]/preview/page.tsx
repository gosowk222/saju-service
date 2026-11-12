import { Lock } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ChartTable } from "@/components/chart-table";
import { PurchaseButton } from "@/components/purchase-button";
import { RedeemButton } from "@/components/redeem-button";
import { LinkButton } from "@/components/ui/button";
import { Badge, Card, LoadingScreen, Notice, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { BRANCH_OPTIONS } from "@/domain/birth/input";
import { parseIsoDate, formatKoreanDate } from "@/domain/birth/date";
import { findPersona } from "@/domain/personas";
import { findMessengerProduct, findProduct, formatPrice, isScrollProduct } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getReadingAccess, READINGS_CLOSED_MESSAGE } from "@/server/access";
import { requirePageUser } from "@/server/auth";
import { checkoutMode, FREE_TRIAL, paymentsOpen, type CheckoutMode } from "@/server/checkout/mode";
import { getEntitlement, getJob, getReading, type ReadingRow } from "@/server/readings/store";
import { loadFreeTicket, type FreeTicketView } from "@/server/tickets/free-ticket";

function birthSummary(reading: ReadingRow): string {
  const { birth_input: birth, place_snapshot: place } = reading;
  const date = formatKoreanDate(parseIsoDate(birth.birthDate));
  const calendar = birth.calendar.type === "solar" ? "양력" : birth.calendar.isLeapMonth ? "음력 윤달" : "음력";
  const time =
    birth.birthTime.status === "unknown"
      ? "시간 모름"
      : (BRANCH_OPTIONS.find((option) => option.value === (birth.birthTime as { branch: string }).branch)?.label ?? "");
  return `${calendar} ${date} · ${time} · ${place.label}`;
}

async function Preview({ params }: { params: Promise<{ readingId: string }> }) {
  const { readingId } = await params;
  const user = await requirePageUser(`/readings/${readingId}/preview`);
  const supabase = await createSupabaseServerClient();
  const [reading, entitlement, job] = await Promise.all([
    getReading(supabase, readingId),
    getEntitlement(supabase, readingId),
    getJob(supabase, readingId),
  ]);
  if (!reading) notFound();
  if (entitlement) redirect(`/readings/${readingId}`);
  // 족자 상품(무진)은 구매 전에도 풀이 화면에서 무료 부분을 보여 주므로 메신저 맛보기를 쓰지 않는다.
  if (isScrollProduct(findProduct(reading.product_id))) redirect(`/readings/${readingId}`);

  const product = findMessengerProduct(reading.product_id);
  const persona = findPersona(reading.persona_id);
  if (!product || !persona) notFound();
  const mode = checkoutMode();
  const [ticket, access] = await Promise.all([loadFreeTicket(supabase, user.id), getReadingAccess(user.id)]);

  return (
    <>
      <PageHeader title="사주원국과 맛보기" backHref="/home" />
      <main className="flex flex-1 flex-col gap-7 px-5 py-6">
        <section className="flex flex-col gap-2">
          <h1 className="wrap-break-word type-h2">{reading.nickname} 님의 사주</h1>
          <p className="wrap-break-word type-caption text-gray-600">{birthSummary(reading)}</p>
          <div>
            <LinkButton href={`/readings/new?product=${product.id}&edit=${reading.id}`} variant="secondary">
              입력 수정
            </LinkButton>
          </div>
        </section>

        <Card>
          <ChartTable chart={reading.chart} />
        </Card>
        {reading.preview.limitNotes.map((note) => (
          <Notice key={note}>{note}</Notice>
        ))}

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="type-title">맛보기</h2>
            <p className="type-caption text-gray-600">
              {persona.name} · {persona.intro}
            </p>
          </div>
          {reading.preview.bubbles.map((bubble) => (
            <div key={bubble} className="flex items-start gap-3">
              <PersonaAvatar persona={persona} />
              <p className="wrap-break-word rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-4 type-body text-gray-900">{bubble}</p>
            </div>
          ))}
        </section>

        <Card>
          <h2 className="type-title">풀이를 받으면 볼 수 있어요</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {product.topics.map((topic) => (
              <li key={topic.id} className="flex items-center gap-3 type-label font-normal text-gray-700">
                <Lock size={18} className="shrink-0 text-gray-500" aria-hidden />
                {topic.title}
              </li>
            ))}
          </ul>
          <p className="mt-4 type-caption text-gray-600">
            {persona.name}의 메신저 풀이 {product.expectedBubbles} · 후속 질문 {product.followupLimit}회 · 보관함 · PDF
          </p>
        </Card>
      </main>
      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-gray-200 bg-white px-5 py-4 pb-safe">
        <PreviewAction
          readingId={reading.id}
          productId={product.id}
          productName={product.name}
          priceKrw={product.priceKrw}
          ticket={ticket}
          closed={job?.status === "cancelled"}
          mode={mode}
          allowed={access.allowed}
        />
      </div>
    </>
  );
}

const USED_TICKET_LINK: Readonly<Record<"generating" | "failed" | "completed", string>> = {
  generating: "이어서 보기",
  failed: "다시 시도하러 가기",
  completed: "내 풀이 보기",
};

/**
 * 맛보기 아래의 다음 동선. 무료 이용권이 있으면 이용권으로, 결제 모드이고 이용권이 없으면 결제로 받는다.
 * 어떤 경우에도 이 화면까지는 이용권을 쓰지 않는다.
 */
function PreviewAction({
  readingId,
  productId,
  productName,
  priceKrw,
  ticket,
  closed,
  mode,
  allowed,
}: {
  readingId: string;
  productId: string;
  productName: string;
  priceKrw: number;
  ticket: FreeTicketView;
  closed: boolean;
  mode: CheckoutMode;
  /** 풀이 상품 이용 범위(관리자만 / 모든 회원) 안에 있는가 */
  allowed: boolean;
}) {
  if (closed) {
    return (
      <>
        <Notice tone="warning">이 풀이는 만들지 못해 닫았고, 무료 이용권은 돌려드렸어요. 같은 정보로 새로 만들 수 있어요.</Notice>
        <LinkButton href={`/readings/new?product=${productId}&edit=${readingId}`} size="lg">
          새로 만들기
        </LinkButton>
      </>
    );
  }

  const payment = paymentsOpen(mode) ? (
    <>
      <div className="flex items-center justify-between">
        <span className="type-label font-normal text-gray-600">{productName}</span>
        <span className="type-title type-price">{formatPrice(priceKrw)}</span>
      </div>
      <PurchaseButton readingId={readingId} label="결제하고 풀이 받기" />
    </>
  ) : null;

  if (!allowed) return <Notice tone="warning">{READINGS_CLOSED_MESSAGE}</Notice>;

  if (ticket.state === "ready" && ticket.available > 0 && FREE_TRIAL.productIds.includes(productId)) {
    return (
      <>
        <div className="flex items-center justify-between gap-3">
          <span className="type-label font-normal text-gray-600">{productName}</span>
          <Badge tone="success">무료 이용권 {ticket.available}장</Badge>
        </div>
        <RedeemButton readingId={readingId} />
        <p className="type-caption text-gray-600">결제 수단은 필요 없어요. 풀이를 만들다 실패해도 추가로 차감하지 않고 다시 시도할 수 있어요.</p>
      </>
    );
  }

  if (ticket.state === "ready" && ticket.current) {
    const used = ticket.current;
    return (
      <>
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
      </>
    );
  }

  if (payment) return payment;
  return (
    <Notice tone="warning">
      {mode === "free_trial" ? "무료 이용권을 확인하지 못했어요. 잠시 후 새로고침해 주세요." : "지금은 풀이를 시작할 수 없어요. 잠시 후 다시 시도해 주세요."}
    </Notice>
  );
}

export default function PreviewPage(props: { params: Promise<{ readingId: string }> }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Preview params={props.params} />
    </Suspense>
  );
}
