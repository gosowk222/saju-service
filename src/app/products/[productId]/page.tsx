import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { sectionEyebrow } from "@/components/mujin/scroll-model";
import { ProductHero } from "@/components/product-card";
import { RichText } from "@/components/rich-text";
import { LinkButton } from "@/components/ui/button";
import { Badge, Card, Notice, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { SkeletonBlock, SkeletonScreen } from "@/components/ui/skeleton";
import { findPersona } from "@/domain/personas";
import { findProduct, formatPrice, isMessengerProduct, isScrollProduct, type ScrollProductDefinition, type ScrollSectionSpec } from "@/domain/products";
import { checkoutMode, FREE_TRIAL, grantsOpen, paymentsOpen } from "@/server/checkout/mode";

/** 족자 상품의 칸 목록 (무료 또는 유료). 장 번호와 제목, 구매 전에도 보여 주는 설명만 쓴다. */
function ScrollContentsList({ title, badge, sections }: { title: string; badge: ReactNode; sections: readonly ScrollSectionSpec[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="type-title">{title}</h2>
        {badge}
      </div>
      <ol className="flex flex-col gap-3">
        {sections.map((section) => (
          <li key={section.id} className="flex items-start gap-3">
            <span className="inline-flex h-7 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 type-caption-sm text-primary-600">
              {sectionEyebrow(section)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="type-label font-semibold">{section.title}</span>
              <span className="type-caption text-gray-600">{section.summary}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 족자 상품은 무료로 바로 보는 칸과 이용권·결제 뒤 받는 칸을 나눠 보여 준다. */
function ScrollContents({ product }: { product: ScrollProductDefinition }) {
  const sections = product.scroll.sections;
  return (
    <>
      <ScrollContentsList title="무료로 바로 보는 부분" badge={<Badge tone="success">무료</Badge>} sections={sections.filter((section) => section.tier === "free")} />
      <ScrollContentsList title="이어서 받는 부분" badge={<Badge tone="warning">유료</Badge>} sections={sections.filter((section) => section.tier === "paid")} />
    </>
  );
}

/**
 * 족자 상품의 받는 방법 안내. 이용 방식(결제 모드)은 요청 시점의 서버 설정으로 정한다.
 * 무료 테스트 모드에서 이용권 대상이면 이용권을, 결제 모드면 결제를 안내한다. 가격이 임시값이면 그렇다고 밝힌다.
 */
async function ScrollAccessNote({ productId, provisional }: { productId: string; provisional: boolean }) {
  await connection();
  const mode = checkoutMode();
  if (grantsOpen(mode) && FREE_TRIAL.productIds.includes(productId)) {
    return <Notice>유료 부분은 지금 결제 없이 무료 이용권 1장으로 받을 수 있어요. 이용권 한 장은 풀이 하나에만 쓸 수 있어요.</Notice>;
  }
  if (paymentsOpen(mode)) {
    return <Notice>{provisional ? "유료 부분은 결제 후 받아요. 표시된 가격은 출시 전 임시 가격이에요." : "유료 부분은 결제 후 받아요."}</Notice>;
  }
  return null;
}

async function ProductDetail({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const product = findProduct(productId);
  if (!product) notFound();
  const persona = findPersona(product.personaId);
  const scroll = isScrollProduct(product) ? product : null;
  const messenger = isMessengerProduct(product) ? product : null;
  const provisional = product.priceStatus === "provisional";
  // 메신저 상품은 주제 목록을 보여 준다. 족자 상품은 ScrollContents가 무료·유료 칸을 나눠 보여 준다.
  const contents = (messenger?.topics ?? []).map((topic) => ({ id: topic.id, title: topic.title, summary: topic.summary }));

  const facts = [
    scroll ? ["구성", scroll.contentsLabel] : ["분량", messenger?.expectedBubbles ?? ""],
    ["가격", provisional ? `${formatPrice(product.priceKrw)} (출시 전 임시 가격)` : formatPrice(product.priceKrw)],
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

          {scroll ? (
            <ScrollContents product={scroll} />
          ) : (
            <section className="flex flex-col gap-3">
              <h2 className="type-title">다루는 내용</h2>
              <ol className="flex flex-col gap-3">
                {contents.map((topic, index) => (
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
          )}

          <Card>
            <dl className="flex flex-col gap-3">
              {facts.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  {/* 족자 상품은 구성 설명이 길어 줄이 바뀌므로 이름은 한 줄로 두고 값을 오른쪽에 맞춘다. */}
                  <dt className={`type-label font-normal text-gray-600${scroll ? " shrink-0" : ""}`}>{label}</dt>
                  <dd className={`type-label font-semibold text-gray-900${scroll ? " text-right" : ""}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {scroll ? (
            <Suspense fallback={null}>
              <ScrollAccessNote productId={scroll.id} provisional={provisional} />
            </Suspense>
          ) : null}

          {persona ? (
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
          ) : null}

          {messenger && persona ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="type-title">풀이 예시</h2>
              <Badge tone="warning">실제 개인 풀이가 아닌 예시예요</Badge>
            </div>
            <div className="flex flex-col gap-3 rounded-lg bg-gray-50 p-5">
              {messenger.sampleBubbles.map((bubble) => (
                <div key={bubble.text} className="flex items-start gap-3">
                  <PersonaAvatar persona={persona} />
                  <p className="rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-3 type-body text-gray-900">
                    <RichText text={bubble.text} />
                  </p>
                </div>
              ))}
            </div>
          </section>
          ) : null}
        </div>
      </main>
      <div className="sticky bottom-0 flex items-center gap-4 border-t border-gray-200 bg-white px-5 py-4 pb-safe">
        <Suspense fallback={<span className="type-title type-price">{formatPrice(product.priceKrw)}</span>}>
          <PriceLabel productId={product.id} priceKrw={product.priceKrw} provisional={provisional} />
        </Suspense>
        <LinkButton href={`/readings/new?product=${product.id}`} size="lg" className="flex-1">
          내 사주 입력하기
        </LinkButton>
      </div>
    </>
  );
}

/**
 * 가격 자리. 무료 테스트 모드에서는 정가에 취소선을 긋고 무료 이용권으로 받을 수 있다고 알린다.
 * 상품의 가격 설정은 바꾸지 않는다. 모드는 요청 시점의 서버 설정으로 정한다.
 * 출시 가격이 정해지지 않은 임시 가격(provisional)이면 가격 아래에 그렇다고 적는다.
 */
async function PriceLabel({ productId, priceKrw, provisional = false }: { productId: string; priceKrw: number; provisional?: boolean }) {
  await connection();
  if (!grantsOpen(checkoutMode()) || !FREE_TRIAL.productIds.includes(productId)) {
    if (provisional) {
      return (
        <span className="flex flex-col items-start gap-1">
          <span className="type-title type-price">{formatPrice(priceKrw)}</span>
          <span className="type-caption text-gray-600">임시 가격</span>
        </span>
      );
    }
    return <span className="type-title type-price">{formatPrice(priceKrw)}</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone="success">무료 이용권 1장</Badge>
      <span className="type-caption font-normal text-gray-500 line-through">{formatPrice(priceKrw)}</span>
    </span>
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
