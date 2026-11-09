import {
  createInquiryReader,
  type FeatureResult,
  type InquiryRule,
  type TwelveStage,
} from "sajuengine";

const stageNames: Readonly<Record<TwelveStage, string>> = {
  jangsaeng: "장생",
  mogyok: "목욕",
  gwandae: "관대",
  geonrok: "건록",
  jewang: "제왕",
  soe: "쇠",
  byeong: "병",
  sa: "사",
  myo: "묘",
  jeol: "절",
  tae: "태",
  yang: "양",
};

/**
 * 서비스 소유 규칙의 최소 예제다. 대상 기간의 12운성 표지를 읽고 근거를 연결한다.
 * 상품용 길흉·사건·만남 날짜 판단 공식이 아니며 전문가 검토가 완료된 규칙도 아니다.
 * 실제 해석을 추가한다면 적용 조건·반대 근거·한계·출처·버전을 함께 정의한다.
 */
export const monthlyStageObservationRule: InquiryRule = {
  metadata: {
    ruleId: "service.monthly-stage.observation",
    version: "1.0.0",
    sourceRefs: ["example:monthly-stage-observation"],
    reviewStatus: "unreviewed",
  },
  domains: ["monthly-stage"],
  kinds: ["timing"],
  evaluate: ({ period, periodId, twelveStages, evidence }) => {
    if (period?.kind !== "monthly") return [];
    const stage = twelveStages.find(
      (entry) =>
        entry.scope === "period" &&
        entry.periodId === periodId &&
        entry.basis === "day-master",
    );
    if (!stage) return [];
    const source = evidence.find(
      (entry) =>
        entry.kind === "twelve-stage" &&
        entry.periodId === periodId &&
        entry.tags.includes(`stage:${stage.stage}`) &&
        entry.tags.includes(`basis:${stage.basis}`) &&
        entry.tags.includes(`position:${stage.position}`),
    );
    if (!source) return [];
    return [
      {
        key: "observed-stage",
        statement: `이 월운의 일간 기준 12운성 표지는 ${stageNames[stage.stage]}이다.`,
        status: "observation",
        supportingEvidenceIds: [source.id],
        counterEvidenceIds: [],
        contextualEvidenceIds: [],
        caveats: [
          "12운성은 기운의 단계 표지이며 사건·길흉을 단독으로 확정하지 않는다.",
        ],
      },
    ];
  },
};

export function readMonthlyStage(
  results: readonly FeatureResult[],
  periodId: string,
) {
  const reader = createInquiryReader(results, {
    rules: [monthlyStageObservationRule],
  });
  // periodId는 reader.periods에서 선택한다. 다른 기간의 근거 ID를 직접 끼워 넣지 않는다.
  return reader.answer({
    domain: "monthly-stage",
    kind: "timing",
    periodIds: [periodId],
  });
}
