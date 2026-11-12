import "server-only";
import { defineFeatureSet } from "sajuengine";

/**
 * 첫 상품이 엔진에 요청하는 재료 묶음. 원국(풀이 기록을 만들 때 한 번)과,
 * 시기 질문이 있을 때만 요청하는 세운·월운(year-months)과 대운(decade)이다. 일운은 쓰지 않는다.
 */
const NATAL_TOPICS = ["temperament", "strengths", "career", "wealth", "romance", "social"] as const;

export const FEATURE_IDS = {
  natal: "first-overview-natal",
  yearMonths: "first-overview-year-months",
  decade: "first-overview-decade",
} as const;

/**
 * 무진의 종합 사주가 엔진에 요청하는 재료 묶음. 원국(풀이 기록을 만들 때 한 번)과, 유료 생성을 시작할 때
 * 한 번 계산하는 대운 목록(9장)과 세운·월운(10장)이다. 첫 상품의 정의와 결과는 바꾸지 않는다
 * (같은 묶음에 정의를 더해도 기존 기능의 결과와 cacheKey는 그대로다. tests/unit/mujin-engine.test.ts).
 */
export const MUJIN_FEATURE_IDS = {
  natal: "mujin-overview-natal",
  luck: "mujin-overview-luck",
  yearMonths: "mujin-overview-year-months",
} as const;

export const FEATURE_SET = defineFeatureSet([
  {
    id: FEATURE_IDS.natal,
    version: "1.0.0",
    modules: ["M01", "M02", "M03", "M04"],
    topics: [...NATAL_TOPICS],
    targetKind: "none",
    selection: {
      version: "1.0.0",
      rules: [{ module: "M01" }, { module: "M02" }, { module: "M03" }, { module: "M04" }],
    },
  },
  {
    id: FEATURE_IDS.yearMonths,
    version: "1.0.0",
    modules: ["M01", "M02", "M04", "M06", "M07"],
    targetKind: "year-months",
    selection: { version: "1.0.0", rules: [{ module: "M04" }, { module: "M06" }, { module: "M07" }] },
  },
  {
    id: FEATURE_IDS.decade,
    version: "1.0.0",
    modules: ["M01", "M02", "M04", "M05", "M07"],
    targetKind: "decade",
    selection: { version: "1.0.0", rules: [{ module: "M05" }, { module: "M07" }] },
  },
  {
    // 무진 원국: 첫 상품 원국과 같은 모듈과 주제.
    id: MUJIN_FEATURE_IDS.natal,
    version: "1.0.0",
    modules: ["M01", "M02", "M03", "M04"],
    topics: [...NATAL_TOPICS],
    targetKind: "none",
    selection: {
      version: "1.0.0",
      rules: [{ module: "M01" }, { module: "M02" }, { module: "M03" }, { module: "M04" }],
    },
  },
  {
    // 무진 9장 대운 목록: luck-sequence 처리기를 쓰면 기준 시각이 든 대운만이 아니라 대운 전부가
    // facets.periods에 들어온다(기준 시각이 든 대운만 focus). 시각 미상이면 엔진이 대운을 계산하지 않는다.
    id: MUJIN_FEATURE_IDS.luck,
    version: "1.0.0",
    modules: ["M01", "M02", "M04", "M05", "M07"],
    targetKind: "decade",
    processors: ["luck-sequence"],
    selection: { version: "1.0.0", rules: [{ module: "M05" }, { module: "M07" }] },
  },
  {
    // 무진 10장 세운·월운: M07은 M05(대운)를 의존성으로 끌어온다. M05를 modules에 넣고 optional로 선언해야
    // 시각 미상(대운 없음)에서 결과 status가 unavailable이 되지 않고 선택 판단도 남는다.
    id: MUJIN_FEATURE_IDS.yearMonths,
    version: "1.0.0",
    modules: ["M01", "M02", "M04", "M05", "M06", "M07"],
    optional: ["M05"],
    targetKind: "year-months",
    selection: { version: "1.0.0", rules: [{ module: "M04" }, { module: "M06" }, { module: "M07" }] },
  },
]);
