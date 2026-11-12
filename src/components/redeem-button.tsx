"use client";

import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";
import { apiFetch, ClientApiError } from "@/lib/client-api";

interface RedeemResponse {
  readonly outcome: "redeemed" | "already_redeemed" | "already_entitled" | "ticket_used";
  readonly readingId: string;
}

/**
 * 맛보기에서 무료 이용권을 쓰는 버튼. 한 번 누른 요청은 같은 요청 ID로만 다시 보낸다.
 * 중복 사용은 서버 함수가 막는다 (버튼 비활성화는 화면 편의일 뿐이다).
 */
export function RedeemButton({ readingId }: { readingId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const requestId = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [usedElsewhere, setUsedElsewhere] = useState<string | null>(null);

  async function redeem() {
    setPending(true);
    setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await apiFetch<RedeemResponse>(`/api/readings/${readingId}/redeem`, {
        method: "POST",
        json: { requestId: requestId.current },
      });
      if (result.outcome === "ticket_used") {
        setUsedElsewhere(result.readingId);
        return;
      }
      const target = `/readings/${result.readingId}`;
      // 족자 상품은 이용권을 쓰는 화면이 곧 풀이 화면이다. 주소가 같으면 이동 대신 서버 상태를 다시 그린다.
      startNavigation(() => (pathname === target ? router.refresh() : router.replace(target)));
    } catch (failure) {
      // 네트워크가 끊겨 결과를 모르면 같은 요청 ID로 다시 보낸다. 서버는 이미 처리한 요청이면 같은 결과를 돌려준다.
      if (!(failure instanceof ClientApiError) || failure.status !== 0) requestId.current = null;
      setError(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (usedElsewhere) {
    return (
      <div className="flex w-full flex-col gap-3">
        <Notice tone="warning">무료 이용권은 다른 풀이에 이미 썼어요. 그 풀이로 이동할게요.</Notice>
        <Button size="lg" onClick={() => startNavigation(() => router.push(`/readings/${usedElsewhere}`))}>
          내 풀이 보기
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button size="lg" disabled={pending || navigating} onClick={redeem}>
        {pending || navigating ? "풀이를 준비하고 있어요" : "무료 이용권 1장으로 풀이받기"}
      </Button>
    </div>
  );
}
