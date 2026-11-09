"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";

export function PurchaseButton({ readingId, label }: { readingId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function order() {
    setPending(true);
    setError(null);
    try {
      const { orderId } = await apiFetch<{ orderId: string }>(`/api/readings/${readingId}/orders`, { method: "POST" });
      router.push(`/checkout/${orderId}`);
    } catch (failure) {
      if (failure instanceof ClientApiError && failure.code === "already_paid") {
        router.replace(`/readings/${readingId}`);
        return;
      }
      setError(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button size="lg" disabled={pending} onClick={order}>
        {pending ? "주문을 준비하고 있어요" : label}
      </Button>
    </div>
  );
}
