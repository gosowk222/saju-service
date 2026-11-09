import assert from "node:assert/strict";
import {
  answerStarterQuestions,
  exampleBirthInput,
} from "./01-engine-materials.js";
import { readMonthlyStage } from "./02-custom-rule.js";

const result = answerStarterQuestions(exampleBirthInput, 2026);
const targetMonth = result.periods.find((period) => period.kind === "monthly");
assert.ok(targetMonth, "월운이 생성되어야 한다.");
const stage = readMonthlyStage(result.materials, targetMonth.id);
assert.equal(stage.policyVersion, "1.1.0");
assert.equal(stage.status, "available");
assert.equal(stage.conclusions.length, 1);
assert.equal(result.health.status, "unsupported");
const proof = stage.conclusions[0]!.supportingEvidence[0]!;
assert.equal(proof.kind, "twelve-stage");
assert.equal(proof.periodId, targetMonth.id);
assert.ok(proof.origins.length > 0);
assert.ok(proof.sourceRefs.length > 0);
assert.ok(stage.context.some((entry) => entry.kind === "month-sequence"));
assert.ok(
  !stage.context.some(
    (entry) =>
      entry.kind === "twelve-stage" &&
      entry.periodId !== null &&
      entry.periodId !== targetMonth.id,
  ),
);

// 출생 원문/계산 전체/풀이 본문을 출력하지 않고 연결 확인 결과만 출력한다.
console.log(
  JSON.stringify(
    {
      checks: "passed",
      natalWealth: result.natalWealth.status,
      natalCareer: result.natalCareer.status,
      monthlyRomance: result.monthlyRomance.status,
      monthlyStage: stage.status,
      defaultHealth: result.health.status,
      monthlyPeriods: result.periods.filter(
        (period) => period.kind === "monthly",
      ).length,
      inquiryPolicyVersion: stage.policyVersion,
      llm: "LIVE_NOT_RUN",
    },
    null,
    2,
  ),
);
