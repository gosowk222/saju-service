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
]);
