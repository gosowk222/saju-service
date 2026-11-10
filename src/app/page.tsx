import { LinkButton } from "@/components/ui/button";

/** 스플래시. 시작하면 로그인 없이 홈(메인 화면)으로 간다. 이미 로그인한 사용자는 proxy에서 바로 홈으로 보낸다. */
export default function SplashPage() {
  return (
    <main className="flex flex-1 flex-col gap-5 p-5">
      <div className="relative flex flex-1 flex-col justify-end overflow-hidden rounded-xl bg-primary-900 p-6">
        <div className="absolute inset-0 bg-scrim" />
        <span className="absolute left-6 top-6 font-serif type-h3 text-white">사주풀이</span>
        <div className="relative flex flex-col gap-3">
          <h1 className="type-h1 text-white">
            나를 읽는 시간,
            <br />
            메신저로 가볍게.
          </h1>
          <p className="type-body text-on-image-muted">어려운 한자 없이, 상담사가 내 사주를 차근차근 설명해 드려요.</p>
        </div>
      </div>
      <LinkButton href="/home" size="lg">
        시작하기
      </LinkButton>
    </main>
  );
}
