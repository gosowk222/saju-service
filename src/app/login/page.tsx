import { Suspense } from "react";
import { LoginButtons } from "@/components/login-buttons";
import { LoadingScreen, Notice, PersonaAvatar } from "@/components/ui/layout";
import { safeNextPath } from "@/domain/auth/safe-next";
import { findPersona } from "@/domain/personas";
import { DEFAULT_PRODUCT_ID, findProduct } from "@/domain/products";
import { checkoutMode, grantsOpen } from "@/server/checkout/mode";

/** 첫 상품의 캐릭터가 맞이한다. */
const HOST = findPersona(findProduct(DEFAULT_PRODUCT_ID)!.personaId)!;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  cancelled: "로그인을 취소했어요. 다시 시도하려면 아래 버튼을 눌러 주세요.",
  oauth: "로그인을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.",
  expired: "로그인이 만료되었어요. 다시 로그인해 주세요.",
  unsupported_provider: "카카오 로그인만 지원해요. 아래 버튼으로 로그인해 주세요.",
  kakao_required: "카카오 계정으로 로그인한 회원만 이용할 수 있어요. 카카오로 다시 로그인해 주세요.",
};

async function LoginContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const errorKey = typeof params.error === "string" ? params.error : "";
  const message = ERROR_MESSAGES[errorKey];
  const freeTrial = grantsOpen(checkoutMode());

  return (
    <main className="flex flex-1 flex-col justify-center gap-8 px-5 py-8">
      <div className="flex flex-col items-center gap-5 text-center">
        <PersonaAvatar persona={HOST} large />
        <div className="flex flex-col gap-2">
          <h1 className="type-h1">반가워요</h1>
          <p className="type-body text-gray-700">카카오로 간편하게 시작해요.</p>
        </div>
      </div>
      {message ? <Notice tone="warning">{message}</Notice> : null}
      {freeTrial ? <Notice>지금은 무료 테스트 기간이에요. 처음 로그인하면 풀이 무료 이용권 1장을 드려요.</Notice> : null}
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
