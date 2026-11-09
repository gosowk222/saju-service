"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Provider = "kakao" | "google";

const BASE =
  "motion-fast pressable relative flex h-button-lg w-full items-center justify-center rounded-md type-label font-semibold disabled:opacity-60";

function KakaoSymbol() {
  return (
    <svg className="absolute left-5" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <path d="M9 1C4.58 1 1 3.8 1 7.26c0 2.25 1.5 4.22 3.77 5.32-.13.46-.8 2.8-.83 3-.04.27.1.27.21.2.09-.06 2.68-1.82 3.77-2.57.35.05.71.08 1.08.08 4.42 0 8-2.8 8-6.27S13.42 1 9 1z" />
    </svg>
  );
}

function GoogleSymbol() {
  return (
    <svg className="absolute left-5" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.61z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function LoginButtons({ next }: { next: string }) {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 로그인 창에서 뒤로 돌아오면 브라우저가 이전 화면을 복원하므로 버튼을 다시 활성화한다.
  useEffect(() => {
    const reset = () => setPending(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  async function signIn(provider: Provider) {
    setError(null);
    setPending(provider);
    // 돌아올 주소를 쿠키에 잠시 둔다. 서버의 콜백에서 다시 검증한다.
    document.cookie = `auth_next=${encodeURIComponent(next)}; Path=/; Max-Age=600; SameSite=Lax`;
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (signInError) {
      setPending(null);
      setError("로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" disabled={pending !== null} onClick={() => signIn("kakao")} className={`${BASE} bg-kakao text-kakao-text`}>
        <KakaoSymbol />
        카카오 로그인
      </button>
      <button type="button" disabled={pending !== null} onClick={() => signIn("google")} className={`${BASE} google-login bg-white`}>
        <GoogleSymbol />
        Google 계정으로 로그인
      </button>
      {error ? (
        <p role="alert" className="type-label font-normal text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
