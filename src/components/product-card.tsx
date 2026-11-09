import Link from "next/link";
import { formatPrice, type ProductDefinition } from "@/domain/products";

export function ProductPoster({ product, large = false }: { product: ProductDefinition; large?: boolean }) {
  return (
    <div className={`relative overflow-hidden bg-primary-900 ${large ? "aspect-[4/3] rounded-xl" : "aspect-[3/4] rounded-md"}`}>
      <div className="absolute inset-0 bg-scrim" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5">
        <p className="type-caption text-on-image-muted">{product.tagline}</p>
        <h2 className="type-poster text-white">{product.name}</h2>
      </div>
    </div>
  );
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
