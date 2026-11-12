import { FIRST_OVERVIEW } from "./first-overview";
import { MUJIN_OVERVIEW } from "./mujin-overview";
import { isMessengerProduct, isScrollProduct, type AnyProductDefinition, type ProductDefinition, type ScrollProductDefinition } from "./types";

export type {
  AnyProductDefinition,
  InquiryDomain,
  ProductBase,
  ProductDefinition,
  ProductFormat,
  ProductTopic,
  QuestionDomain,
  QuestionIntent,
  ScrollProductDefinition,
  ScrollSectionSpec,
} from "./types";
export { isMessengerProduct, isScrollProduct, topicTitlesOf } from "./types";

/** 새 상품은 정의 파일을 만들어 여기에 추가한다. */
export const PRODUCTS: readonly AnyProductDefinition[] = [FIRST_OVERVIEW, MUJIN_OVERVIEW];

/** 로그인 화면 캐릭터와 입력 기본값에 쓰는 상품. 묘묘로 유지한다. */
export const DEFAULT_PRODUCT_ID = FIRST_OVERVIEW.id;

export function findProduct(productId: string): AnyProductDefinition | undefined {
  return PRODUCTS.find((product) => product.id === productId);
}

/** 메신저 상품만 찾는다. 메신저 전용 경로(말풍선 생성·맛보기·메신저 PDF)가 쓴다. */
export function findMessengerProduct(productId: string): ProductDefinition | undefined {
  const product = findProduct(productId);
  return isMessengerProduct(product) ? product : undefined;
}

/** 족자 상품만 찾는다. */
export function findScrollProduct(productId: string): ScrollProductDefinition | undefined {
  const product = findProduct(productId);
  return isScrollProduct(product) ? product : undefined;
}

export function formatPrice(krw: number): string {
  return `${krw.toLocaleString("ko-KR")}원`;
}
