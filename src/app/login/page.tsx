import { Suspense } from "react";
import { LoginButtons } from "@/components/login-buttons";
import { LoadingScreen, Notice, PersonaAvatar } from "@/components/ui/layout";
import { safeNextPath } from "@/domain/auth/safe-next";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  cancelled: "로그인을 취소했어요. 다시 시도하려면 아래 버튼을 눌러 주세요.",
  oauth: "로그인을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.",
  expired: "로그인이 만료되었어요. 다시 로그인해 주세요.",
};

async function LoginContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const errorKey = typeof params.error === "string" ? params.error : "";
  const message = ERROR_MESSAGES[errorKey];

  return (
    <main className="flex flex-1 flex-col justify-center gap-8 px-5 py-8">
      <div className="flex flex-col items-center gap-5 text-center">
        <PersonaAvatar glyph="여" large />
        <div className="flex flex-col gap-2">
          <h1 className="type-h1">반가워요</h1>
          <p className="type-body text-gray-700">간편 로그인으로 시작해요.</p>
        </div>
      </div>
      {message ? <Notice tone="warning">{message}</Notice> : null}
      <LoginButtons next={next} />
      <p className="text-center type-caption text-gray-600">입력한 생년월일과 지역은 사주를 계산하고 풀이를 만드는 데 사용돼요.</p>
    </main>
  );
}

export default function LoginPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <LoginContent searchParams={props.searchParams} />
    </Suspense>
  );
}
