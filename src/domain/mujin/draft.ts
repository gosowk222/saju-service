import type { MujinMaterial } from "./types";

/**
 * 작성 계획을 만드는 동안 쓰는 재료 초안. ref(m1, m2 …)는 목차 순서로 모두 모은 뒤 한 번에 붙인다.
 * key는 계획 안에서 고유한 내부 열쇠이며 저장하지 않는다. derived는 parentKeys로 부모를 가리키고, 마지막에 parentRefs로 바꾼다.
 */
export type DraftMaterial = Omit<MujinMaterial, "ref" | "parentRefs"> & {
  readonly key: string;
  readonly parentKeys?: readonly string[];
};
