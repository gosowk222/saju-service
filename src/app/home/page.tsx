import { Suspense } from "react";
import { ProductCard } from "@/components/product-card";
import { BottomNav } from "@/components/ui/bottom-nav";
import { LinkButton } from "@/components/ui/button";
import { Card, LoadingScreen, Screen } from "@/components/ui/layout";
import { DEFAULT_PRODUCT_ID, findProduct, PRODUCTS } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";

async function ContinueBanner() {
  await requirePageUser("/home");
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
        <Suspense fallback={<LoadingScreen />}>
          <ContinueBanner />
        </Suspense>
        <section className="flex flex-col gap-4">
          <h2 className="type-title">풀이 고르기</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
            {PRODUCTS.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>
      </Screen>
      <BottomNav />
    </>
  );
}
