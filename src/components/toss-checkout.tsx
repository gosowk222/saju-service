"use client";

import { ANONYMOUS, loadTossPayments, type TossPaymentsWidgets } from "@tosspayments/tosspayments-sdk";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";

interface Props {
  readonly clientKey: string;
  readonly orderId: string;
  readonly orderName: string;
  readonly amount: number;
}

/**
 * 토스페이먼츠 결제 위젯. 금액은 서버의 주문 기록이 내려준 값이고,
 * 완료 처리는 결제사가 돌려보낸 뒤 서버에서 다시 확인한다.
 */
export function TossCheckout({ clientKey, orderId, orderName, amount }: Props) {
  const widgetsRef = useRef<TossPaymentsWidgets | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function mount() {
      try {
        const tossPayments = await loadTossPayments(clientKey);
        if (cancelled) return;
        const widgets = tossPayments.widgets({ customerKey: ANONYMOUS });
        await widgets.setAmount({ currency: "KRW", value: amount });
        await Promise.all([
          widgets.renderPaymentMethods({ selector: "#payment-methods", variantKey: "DEFAULT" }),
          widgets.renderAgreement({ selector: "#payment-agreement", variantKey: "AGREEMENT" }),
        ]);
        if (cancelled) return;
        widgetsRef.current = widgets;
        setReady(true);
      } catch {
        if (!cancelled) setError("결제 화면을 불러오지 못했어요. 새로고침해 주세요.");
      }
    }
    void mount();
    return () => {
      cancelled = true;
    };
  }, [clientKey, amount]);

  async function pay() {
    if (!widgetsRef.current) return;
    setRequesting(true);
    setError(null);
    try {
      await widgetsRef.current.requestPayment({
        orderId,
        orderName,
        successUrl: `${window.location.origin}/checkout/${orderId}/complete`,
        failUrl: `${window.location.origin}/checkout/${orderId}/failed`,
      });
    } catch {
      setError("결제를 시작하지 못했어요. 다시 시도해 주세요.");
      setRequesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div id="payment-methods" />
      <div id="payment-agreement" />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button size="lg" disabled={!ready || requesting} onClick={pay}>
        {requesting ? "결제창을 여는 중이에요" : `${amount.toLocaleString("ko-KR")}원 결제하기`}
      </Button>
    </div>
  );
}
