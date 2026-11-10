import type { AssessmentFacet, InquiryEvidence, InquiryRuleContext } from "sajuengine";
import { describe, expect, it } from "vitest";
import { dominantFamilyLensRule, scarceFamilyBalanceRule } from "@/domain/rules/first-overview";

function evidence(partial: Partial<InquiryEvidence> & Pick<InquiryEvidence, "id" | "ruleId">): InquiryEvidence {
  return {
    subject: "primary",
    periodId: null,
    kind: "judgment",
    tags: [],
    assertion: "이 문장은 규칙이 읽으면 안 된다",
    precision: "confirmed",
    disposition: "accepted",
    ruleVersion: "2.2.0",
    sourceRefs: [],
    origins: [],
    paths: [],
    caveats: [],
    ...partial,
  };
}

const familiesEvidence = evidence({ id: "families", ruleId: "m01.assessment.families" });
const guard = evidence({
  id: "guard",
  ruleId: "m03.career.context-review",
  disposition: "review-required",
  tags: ["module:M03", "topic:career"],
});

function assessment(overrides: Partial<AssessmentFacet>): AssessmentFacet {
  return {
    coverage: "complete",
    missingPositions: [],
    strength: "weak",
    pattern: "eating-god",
    usefulElement: "토",
    helpfulElement: "화",
    adverseElements: [],
    usefulGodBasis: { adopted: "fuyi", rule: 2, season: "autumn" },
    dominantElement: "금",
    missingElements: [],
    observedMissingElements: [],
    dominantFamily: "output",
    missingFamilies: [],
    observedMissingFamilies: [],
    familyPercent: { resource: 14, output: 41, authority: 10, wealth: 15, peer: 20 },
    elementPercent: { 목: 9, 화: 13, 토: 27, 금: 38, 수: 13 },
    ...overrides,
  } as AssessmentFacet;
}

function context(domain: string, assess: AssessmentFacet | null, entries: InquiryEvidence[] = [familiesEvidence]): InquiryRuleContext {
  return {
    question: { domain, kind: "natal", subject: "primary", periodIds: [], contextPeriodIds: [], context: {} },
    periodId: null,
    evidence: entries,
    contextEvidence: [],
    limitations: [],
    natalFacts: null,
    otherNatalFacts: null,
    assessment: assess,
    period: null,
    contextPeriods: [],
    twelveStages: [],
    contextTwelveStages: [],
    monthSequence: null,
    pair: null,
  } as unknown as InquiryRuleContext;
}

describe("두드러진 계열 규칙", () => {
  it("적용: 두드러진 계열이 있으면 후보 결론과 근거를 낸다", () => {
    const [result] = dominantFamilyLensRule.evaluate(context("temperament", assessment({})));
    expect(result).toMatchObject({ key: "dominant", status: "candidate", supportingEvidenceIds: ["families"] });
    expect(result!.statement).toContain("말이나 결과물");
  });

  it("비적용: 비중이 기준 미만이면 결론을 내지 않는다", () => {
    const flat = assessment({ familyPercent: { resource: 20, output: 24, authority: 20, wealth: 18, peer: 18 } as AssessmentFacet["familyPercent"] });
    expect(dominantFamilyLensRule.evaluate(context("temperament", flat))).toEqual([]);
  });

  it("비적용: 판단 재료가 없으면 결론을 내지 않는다", () => {
    expect(dominantFamilyLensRule.evaluate(context("temperament", null))).toEqual([]);
    expect(dominantFamilyLensRule.evaluate(context("temperament", assessment({}), []))).toEqual([]);
    expect(dominantFamilyLensRule.evaluate(context("temperament", assessment({ dominantFamily: null })))).toEqual([]);
  });

  it("반대 근거: 해당 주제의 검토 표지를 연결하고 경향으로 전달한다", () => {
    const [result] = dominantFamilyLensRule.evaluate(context("career", assessment({}), [familiesEvidence, guard]));
    expect(result!.counterEvidenceIds).toEqual(["guard"]);
    expect(result!.caveats.some((caveat) => caveat.includes("단정하지"))).toBe(true);
  });

  it("다른 주제의 검토 표지는 연결하지 않는다", () => {
    const [result] = dominantFamilyLensRule.evaluate(context("wealth", assessment({}), [familiesEvidence, guard]));
    expect(result!.counterEvidenceIds).toEqual([]);
  });

  it("보류: 시주 미상이고 1, 2위가 가까우면 deferred다", () => {
    const close = assessment({
      coverage: "partial",
      missingPositions: ["hour"],
      familyPercent: { resource: 20, output: 30, authority: 13, wealth: 12, peer: 25 } as AssessmentFacet["familyPercent"],
    });
    const [result] = dominantFamilyLensRule.evaluate(context("temperament", close));
    expect(result!.status).toBe("deferred");
  });

  it("시주 미상이라도 차이가 크면 한계를 붙인 후보로 둔다", () => {
    const [result] = dominantFamilyLensRule.evaluate(context("temperament", assessment({ coverage: "partial" })));
    expect(result!.status).toBe("candidate");
    expect(result!.caveats.some((caveat) => caveat.includes("시주"))).toBe(true);
  });

  it("assertion 문장이 달라도 결과가 같다", () => {
    const changed = { ...familiesEvidence, assertion: "전혀 다른 문장" };
    expect(dominantFamilyLensRule.evaluate(context("temperament", assessment({}), [changed]))).toEqual(
      dominantFamilyLensRule.evaluate(context("temperament", assessment({}))),
    );
  });
});

describe("낮은 비중 보완 규칙", () => {
  it("적용: 비중이 낮은 계열의 보완 제안을 낸다", () => {
    const [result] = scarceFamilyBalanceRule.evaluate(context("wealth", assessment({})));
    expect(result).toMatchObject({ key: "scarce", status: "candidate" });
  });

  it("비적용: 모든 계열이 기준보다 높으면 결론을 내지 않는다", () => {
    const even = assessment({ familyPercent: { resource: 20, output: 24, authority: 20, wealth: 18, peer: 18 } as AssessmentFacet["familyPercent"] });
    expect(scarceFamilyBalanceRule.evaluate(context("wealth", even))).toEqual([]);
  });

  it("보류: 시주 미상으로 안 보이는 계열을 없다고 단정하지 않는다", () => {
    const partial = assessment({
      coverage: "partial",
      familyPercent: { resource: 20, output: 43, authority: 13, wealth: 0, peer: 24 } as AssessmentFacet["familyPercent"],
      observedMissingFamilies: ["wealth"],
      missingFamilies: [],
    });
    const [result] = scarceFamilyBalanceRule.evaluate(context("wealth", partial));
    expect(result!.status).toBe("deferred");
  });
});

describe("규칙 메타데이터", () => {
  it("AI 초안을 사람이 검토한 규칙으로 표시하지 않는다", () => {
    for (const rule of [dominantFamilyLensRule, scarceFamilyBalanceRule]) {
      expect(rule.metadata.reviewStatus).toBe("unreviewed");
      expect(rule.metadata.sourceRefs.length).toBeGreaterThan(0);
      expect(rule.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
