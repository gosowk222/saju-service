import Image from "next/image";
import Link from "next/link";
import { SquareArt } from "@/components/ui/art";
import { formatPrice, type ProductDefinition } from "@/domain/products";

/**
 * 상품 부설명. 문장마다 새 줄에서 시작해 좁은 칸에서도 문장 중간이 어색하게 끊기지 않게 한다.
 * 글자는 상품 설정 그대로이고 문장 사이 공백도 남긴다.
 */
function Tagline({ text, className }: { text: string; className: string }) {
  const sentences = text.match(/[^.?!]+[.?!]*\s*/g) ?? [text];
  return (
    <p className={`break-keep ${className}`}>
      {sentences.map((sentence, index) => (
        <span key={index} className="block text-balance">
          {sentence}
        </span>
      ))}
    </p>
  );
}

/**
 * 3:4 포스터. 그림 아래쪽 여백에 부설명과 제목을 올린다. 얼굴이 있는 위쪽은 글자로 가리지 않는다.
 * 그림이 오기 전에는 같은 비율의 밤 인디고 면이 자리를 잡는다.
 */
export function ProductPoster({ product }: { product: ProductDefinition }) {
  const { poster } = product.art;
  return (
    <div className="relative aspect-3/4 overflow-hidden rounded-md bg-primary-900">
      <Image src={poster.src} alt={poster.alt} fill sizes="(min-width: 600px) 184px, 50vw" className="object-cover object-top" />
      <div className="absolute inset-0 bg-scrim" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4">
        <Tagline text={product.tagline} className="type-caption text-on-image-muted" />
        <h2 className="type-poster text-balance break-keep text-white">{product.name}</h2>
      </div>
    </div>
  );
}

/**
 * 상품 상세의 16:10 배너. 디자인 보드처럼 화면 폭을 꽉 채운다.
 * 캐릭터는 오른쪽에 있고 왼쪽이 비어 있으므로 글자를 왼쪽 아래에 둔다. 부설명은 폭의 42% 안에서,
 * 제목은 한 줄에 다섯 글자 정도에서 줄을 바꿔 얼굴, 부채, 벽걸이, 책상 위 책을 가리지 않는다.
 */
export function ProductHero({ product }: { product: ProductDefinition }) {
  const { banner } = product.art;
  return (
    <div className="relative aspect-16/10 w-full overflow-hidden bg-primary-900">
      <Image src={banner.src} alt={banner.alt} fill preload sizes="(min-width: 600px) 600px, 100vw" className="object-cover object-right" />
      <div className="absolute inset-0 bg-scrim" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-5 pb-6 desktop:px-6 desktop:pb-8">
        <Tagline text={product.tagline} className="max-w-[42%] type-caption text-on-image-muted desktop:type-body" />
        <h1 className="max-w-[5em] type-poster text-balance break-keep text-white desktop:type-h1">{product.name}</h1>
      </div>
    </div>
  );
}

/** 보관함 같은 목록의 작은 정사각 썸네일. 포스터에서 얼굴 부분(square)만 보여 준다. 옆에 상품 이름이 있다. */
export function ProductThumb({ product }: { product: ProductDefinition }) {
  return <SquareArt image={product.art.poster} displayPx={56} className="h-tile w-tile rounded-md bg-primary-900" />;
}

export function ProductCard({ product }: { product: ProductDefinition }) {
  return (
    <Link href={`/products/${product.id}`} className="flex flex-col gap-3 text-gray-900 hover:text-gray-900 hover:no-underline">
      <ProductPoster product={product} />
      <span className="type-label font-semibold">{product.name}</span>
      <span className="type-label type-price">{formatPrice(product.priceKrw)}</span>
    </Link>
  );
}
