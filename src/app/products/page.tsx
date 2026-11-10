import { ProductCard } from "@/components/product-card";
import { BottomNav } from "@/components/ui/bottom-nav";
import { Screen } from "@/components/ui/layout";
import { PRODUCTS } from "@/domain/products";

export default function ProductsPage() {
  return (
    <>
      <Screen>
        <h1 className="type-h2">탐색</h1>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {PRODUCTS.map((product, index) => (
            <ProductCard key={product.id} product={product} order={index} />
          ))}
        </div>
      </Screen>
      <BottomNav />
    </>
  );
}
