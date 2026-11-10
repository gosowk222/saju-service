import { Suspense } from "react";
import { ProductCard } from "@/components/product-card";
import { BottomNav } from "@/components/ui/bottom-nav";
import { LinkButton } from "@/components/ui/button";
import { Card, Screen } from "@/components/ui/layout";
import { DEFAULT_PRODUCT_ID, findProduct, PRODUCTS } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/server/auth";

/** 로그인한 사용자에게만 작성 중인 입력을 이어서 하도록 보여 준다. 홈은 로그인 없이 볼 수 있다. */
async function ContinueBanner() {
  if (!(await getVerifiedUser())) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("reading_drafts")
    .select("product_id")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const product = findProduct(data.product_id as string) ?? findProduct(DEFAULT_PRODUCT_ID)!;
  return (
    <Card className="flex items-center justify-between gap-4 bg-gray-50">
      <div className="min-w-0">
        <p className="type-label font-semibold">작성 중인 입력이 있어요</p>
        <p className="truncate type-caption text-gray-600">{product.name}</p>
      </div>
      <LinkButton href={`/readings/new?product=${product.id}`}>이어서 입력</LinkButton>
    </Card>
  );
}

export default function HomePage() {
  return (
    <>
      <Screen>
        <h1 className="type-h2">오늘은 나를 읽어 볼까요?</h1>
        {/* 이어서 입력할 내용이 없으면 아무것도 보이지 않는 자리라, 큰 로딩 화면을 두면 아래 상품 카드가 올라오며 흔들린다. */}
        <Suspense fallback={null}>
          <ContinueBanner />
        </Suspense>
        <section className="flex flex-col gap-4">
          <h2 className="type-title">풀이 고르기</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {PRODUCTS.map((product, index) => (
              <ProductCard key={product.id} product={product} order={index} />
            ))}
          </div>
        </section>
      </Screen>
      <BottomNav />
    </>
  );
}
