import { FIRST_OVERVIEW } from "./first-overview";
import type { ProductDefinition } from "./types";

export type { InquiryDomain, ProductDefinition, ProductTopic, QuestionDomain, QuestionIntent } from "./types";
export { INQUIRY_DOMAINS, topicTitlesOf } from "./types";

/** 새 상품은 정의 파일을 만들어 여기에 추가한다. */
export const PRODUCTS: readonly ProductDefinition[] = [FIRST_OVERVIEW];

export const DEFAULT_PRODUCT_ID = FIRST_OVERVIEW.id;

export function findProduct(productId: string): ProductDefinition | undefined {
  return PRODUCTS.find((product) => product.id === productId);
}

export function formatPrice(krw: number): string {
  return `${krw.toLocaleString("ko-KR")}원`;
}
