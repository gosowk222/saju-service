"use client";

import { useEffect, useState } from "react";
import { LOGIN_PROVIDERS } from "@/domain/auth/providers";

const BASE =
  "motion-fast pressable relative flex h-button-lg w-full items-center justify-center rounded-md type-label font-semibold disabled:opacity-60";

function KakaoSymbol() {
  return (
    <svg className="absolute left-5" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <path d="M9 1C4.58 1 1 3.8 1 7.26c0 2.25 1.5 4.22 3.77 5.32-.13.46-.8 2.8-.83 3-.04.27.1.27.21.2.09-.06 2.68-1.82 3.77-2.57.35.05.71.08 1.08.08 4.42 0 8-2.8 8-6.27S13.42 1 9 1z" />
    </svg>
  );
}

/**
 * 로그인 버튼. 이 앱은 카카오만 지원한다 (src/domain/auth/providers.ts).
 * 버튼은 서버의 로그인 시작 경로(/auth/login)로 폼을 보내고, 서버가 제공자를 다시 확인한 뒤 카카오로 보낸다.
 */
export function LoginButtons({ next }: { next: string }) {
  const [pending, setPending] = useState(false);

  // 로그인 창에서 뒤로 돌아오면 브라우저가 이전 화면을 복원하므로 버튼을 다시 활성화한다.
  useEffect(() => {
    const reset = () => setPending(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <form action="/auth/login" method="post" onSubmit={() => setPending(true)} className="flex flex-col gap-3">
      <input type="hidden" name="provider" value={LOGIN_PROVIDERS[0]} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" disabled={pending} className={`${BASE} bg-kakao text-kakao-text`}>
        <KakaoSymbol />
        카카오로 시작하기
      </button>
    </form>
  );
}
