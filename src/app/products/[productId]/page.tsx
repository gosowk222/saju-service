import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProductHero } from "@/components/product-card";
import { RichText } from "@/components/rich-text";
import { LinkButton } from "@/components/ui/button";
import { Badge, Card, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { SkeletonBlock, SkeletonScreen } from "@/components/ui/skeleton";
import { findPersona } from "@/domain/personas";
import { findProduct, formatPrice } from "@/domain/products";

async function ProductDetail({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const product = findProduct(productId);
  if (!product) notFound();
  const persona = findPersona(product.personaId)!;

  const facts = [
    ["분량", product.expectedBubbles],
    ["가격", formatPrice(product.priceKrw)],
    ["후속 질문", `${product.followupLimit}회 포함`],
    ["다시 보기", product.archive ? "보관함에서 언제든" : "제공하지 않음"],
    ["PDF", product.pdf ? "내려받기 가능" : "제공하지 않음"],
  ] as const;

  return (
    <>
      <PageHeader title={product.name} backHref="/products" />
      <main className="flex flex-1 flex-col">
        {/* 배너는 화면 폭을 꽉 채우고, 나머지 내용만 좌우 여백을 둔다. */}
        <ProductHero product={product} />
        <div className="flex flex-col gap-7 px-5 py-6">
          <section className="flex flex-col gap-2">
            <h2 className="type-title">어떤 풀이인가요?</h2>
            <p className="type-body text-gray-700">{product.description}</p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="type-title">다루는 내용</h2>
            <ol className="flex flex-col gap-3">
              {product.topics.map((topic, index) => (
                <li key={topic.id} className="flex items-start gap-3">
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-100 type-caption-sm text-primary-600">
                    {index + 1}
                  </span>
                  <span className="flex flex-col">
                    <span className="type-label font-semibold">{topic.title}</span>
                    <span className="type-caption text-gray-600">{topic.summary}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <Card>
            <dl className="flex flex-col gap-3">
              {facts.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <dt className="type-label font-normal text-gray-600">{label}</dt>
                  <dd className="type-label font-semibold text-gray-900">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <section className="flex flex-col gap-3" aria-label="풀이해 줄 캐릭터">
            <h2 className="type-title">풀이해 줄 캐릭터</h2>
            <div className="flex items-start gap-3">
              <PersonaAvatar persona={persona} large />
              <div className="flex min-w-0 flex-col gap-2">
                <p className="flex flex-col">
                  <span className="type-label font-semibold text-gray-900">{persona.name}</span>
                  <span className="type-caption text-gray-600">{persona.intro}</span>
                </p>
                <p className="rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-3 type-body text-gray-900">{persona.signatureLine}</p>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="type-title">풀이 예시</h2>
              <Badge tone="warning">실제 개인 풀이가 아닌 예시예요</Badge>
            </div>
            <div className="flex flex-col gap-3 rounded-lg bg-gray-50 p-5">
              {product.sampleBubbles.map((bubble) => (
                <div key={bubble.text} className="flex items-start gap-3">
                  <PersonaAvatar persona={persona} />
                  <p className="rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-3 type-body text-gray-900">
                    <RichText text={bubble.text} />
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
      <div className="sticky bottom-0 flex items-center gap-4 border-t border-gray-200 bg-white px-5 py-4 pb-safe">
        <span className="type-title type-price">{formatPrice(product.priceKrw)}</span>
        <LinkButton href={`/readings/new?product=${product.id}`} size="lg" className="flex-1">
          내 사주 입력하기
        </LinkButton>
      </div>
    </>
  );
}

/** 상세 화면과 같은 자리(머리글, 16:10 배너, 소개 글, 주제 목록)를 먼저 잡아 둔다. */
function ProductDetailSkeleton() {
  return (
    <SkeletonScreen className="flex flex-1 flex-col">
      <div className="flex h-header shrink-0 items-center border-b border-gray-100 px-5">
        <SkeletonBlock className="h-6 w-1/3 rounded-sm" />
      </div>
      <span aria-hidden className="block aspect-16/10 w-full bg-primary-900" />
      <div className="flex flex-col gap-7 px-5 py-6">
        <div className="flex flex-col gap-3">
          <SkeletonBlock className="h-6 w-1/3 rounded-sm" />
          <SkeletonBlock className="h-5 w-full rounded-sm" />
          <SkeletonBlock className="h-5 w-full rounded-sm" />
          <SkeletonBlock className="h-5 w-2/3 rounded-sm" />
        </div>
        <div className="flex flex-col gap-4">
          <SkeletonBlock className="h-6 w-1/4 rounded-sm" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <SkeletonBlock className="h-7 w-7 shrink-0 rounded-full" />
              <SkeletonBlock className="h-5 w-1/2 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}

export default function ProductPage(props: { params: Promise<{ productId: string }> }) {
  return (
    <Suspense fallback={<ProductDetailSkeleton />}>
      <ProductDetail params={props.params} />
    </Suspense>
  );
}
