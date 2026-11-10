import { Suspense } from "react";
import { BottomNav } from "@/components/ui/bottom-nav";
import { Button } from "@/components/ui/button";
import { Card, LoadingScreen, PageHeader } from "@/components/ui/layout";
import { requirePageUser } from "@/server/auth";

async function Account() {
  const user = await requirePageUser("/my");
  const provider = user.app_metadata?.provider;
  const label = provider === "kakao" ? "카카오" : provider === "google" ? "Google" : "소셜";
  return (
    <Card>
      <p className="type-label font-normal text-gray-600">로그인 방식</p>
      <p className="mt-1 type-title">{label} 계정</p>
    </Card>
  );
}

export default function MyPage() {
  return (
    <>
      <PageHeader title="마이" />
      <main className="flex flex-1 flex-col gap-5 px-5 py-6">
        <Suspense fallback={<LoadingScreen />}>
          <Account />
        </Suspense>
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="secondary" size="lg">
            로그아웃
          </Button>
        </form>
        <section className="flex flex-col gap-2 type-caption text-gray-600">
          <p>
            출생지역 자료: <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>, CC BY 4.0
          </p>
          <p>PDF 글꼴: Noto Sans KR, SIL Open Font License 1.1</p>
          <p>풀이는 전통 명리 해석을 바탕으로 한 참고용 콘텐츠예요.</p>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
