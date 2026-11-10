"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";
import { apiFetch, ClientApiError } from "@/lib/client-api";

const OPTIONS = [
  { value: false, label: "관리자만" },
  { value: true, label: "모든 회원" },
] as const;

/**
 * 풀이 상품 이용 범위 전환. 끄면(관리자만) 관리자 역할 회원만, 켜면 모든 회원이 풀이 상품을 이용한다.
 * 값은 서버가 저장하고, 저장 결과로 화면을 다시 그린다. 세그먼트 모양은 입력 화면의 양력·음력 선택과 같다.
 */
export function ReadingAccessControl({ openToAll }: { openToAll: boolean }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    if (next === openToAll || saving) return;
    const question = next
      ? "모든 회원이 풀이 상품을 이용할 수 있게 열까요? 테스트 링크를 받은 사람도 이용할 수 있어요."
      : "관리자만 풀이 상품을 이용하게 닫을까요? 다른 회원은 새 풀이와 후속 질문을 할 수 없어요.";
    if (!window.confirm(question)) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/api/admin/settings", { method: "POST", json: { readingsOpenToAll: next } });
      startRefresh(() => router.refresh());
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : "설정을 저장하지 못했어요.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="풀이 상품 이용 범위" className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-gray-100 p-1">
        {OPTIONS.map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={openToAll === option.value}
            disabled={saving || refreshing}
            onClick={() => change(option.value)}
            className={`motion-fast h-button rounded-md type-label ${openToAll === option.value ? "bg-white font-semibold text-gray-900" : "text-gray-600"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

/** 고른 회원에게 무료 이용권 한 장을 준다. 한 번 누른 요청은 같은 요청 ID로만 다시 보내 두 장이 되지 않게 한다. */
export function GrantTicketButton({ userId, label }: { userId: string; label: string }) {
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  async function grant() {
    if (!window.confirm(`${label}에게 무료 이용권 1장을 줄까요?`)) return;
    setPending(true);
    setMessage(null);
    requestId.current ??= crypto.randomUUID();
    try {
      await apiFetch("/api/admin/tickets", { method: "POST", json: { userId, requestId: requestId.current } });
      requestId.current = null;
      setMessage({ tone: "info", text: "무료 이용권 1장을 줬어요." });
      startRefresh(() => router.refresh());
    } catch (failure) {
      // 연결이 끊겨 결과를 모르면 같은 요청 ID로 다시 보낸다. 서버는 이미 처리한 요청을 한 번만 반영한다.
      if (!(failure instanceof ClientApiError) || failure.status !== 0) requestId.current = null;
      setMessage({ tone: "danger", text: failure instanceof ClientApiError ? failure.message : "이용권을 주지 못했어요." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="tonal" disabled={pending || refreshing} onClick={grant}>
        {pending ? "주는 중이에요" : "무료 이용권 1장 주기"}
      </Button>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </div>
  );
}
