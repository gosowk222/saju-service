/** Node.js 서버에서 실행한다. 이 파일은 LLM이나 외부 API를 호출하지 않는다. */
import {
  PublicBirthInputSchema,
  createFeatureSession,
  createInquiryReader,
  defineFeatureSet,
  toAnalysisInput,
} from "sajuengine";
import { createDefaultDependencies } from "sajuengine/node";

// 실제 사용자의 정보가 아닌 실행 확인용 입력이다.
export const exampleBirthInput = {
  birthDate: "1998-09-19",
  birthTime: { status: "known", time: "16:00" },
  gender: "male",
  calendar: { type: "solar" },
  birthPlace: { timezoneId: "Asia/Seoul", longitudeDeg: 126.978 },
  timeCorrection: "standard",
};

// 상품명이 아니라, 그 상품에 필요한 계산 재료의 묶음을 정의한다.
export const featureSet = defineFeatureSet([
  {
    id: "service-natal",
    version: "1.0.0",
    modules: ["M01", "M02", "M03", "M04"],
    topics: ["romance", "wealth", "career"],
    targetKind: "none",
    selection: {
      version: "1.0.0",
      rules: [
        { module: "M01" },
        { module: "M02" },
        { module: "M03" },
        { module: "M04" },
      ],
    },
  },
  {
    id: "service-year-months",
    version: "1.0.0",
    modules: ["M01", "M02", "M04", "M06", "M07"],
    targetKind: "year-months",
    selection: {
      version: "1.0.0",
      rules: [{ module: "M04" }, { module: "M06" }, { module: "M07" }],
    },
  },
]);

export function calculateServiceMaterials(rawBirth: unknown, year: number) {
  const birth = PublicBirthInputSchema.parse(rawBirth);
  const input = toAnalysisInput(birth);
  const session = createFeatureSession(createDefaultDependencies());
  try {
    const natal = session.execute(featureSet, {
      ...input,
      featureId: "service-natal",
    });
    const calendar = session.execute(featureSet, {
      ...input,
      featureId: "service-year-months",
      target: {
        kind: "year-months",
        year,
        timezoneId: birth.birthPlace.timezoneId,
      },
    });
    // 같은 요청 안에서 원국 계산을 재사용한다. 결과에는 출생 정보가 포함될 수 있으므로
    // 전체 값을 일반 로그에 출력하지 말고 접근 권한이 있는 저장소에서 관리한다.
    return [natal, calendar] as const;
  } finally {
    session.dispose();
  }
}

export function answerStarterQuestions(rawBirth: unknown, year: number) {
  const materials = calculateServiceMaterials(rawBirth, year);
  const reader = createInquiryReader(materials);
  const monthlyPeriodIds = reader.periods
    .filter((period) => period.kind === "monthly")
    .map((period) => period.id);
  return {
    materials,
    periods: reader.periods,
    natalWealth: reader.answer({ domain: "wealth", kind: "natal" }),
    natalCareer: reader.answer({ domain: "career", kind: "natal" }),
    monthlyRomance: reader.answer({
      domain: "romance",
      kind: "timing",
      periodIds: monthlyPeriodIds,
    }),
    // 기본 건강 판단은 unsupported다. 질병 또는 건강 상태를 추정하지 않는다.
    health: reader.answer({ domain: "health", kind: "natal" }),
  };
}
