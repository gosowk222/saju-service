import type { InquiryEvidence, InquiryRuleContext } from "sajuengine";

/**
 * 규칙이 읽는 재료를 꺼내는 도우미. 엔진의 구조화된 필드(assessment, natalFacts, evidence의
 * kind·ruleId·tags·periodId)만 읽는다. assertion 같은 설명 문장은 읽지 않는다.
 */

export type Family = "peer" | "output" | "wealth" | "authority" | "resource";
export const FAMILIES: readonly Family[] = ["peer", "output", "wealth", "authority", "resource"];

export const FAMILY_LABEL: Readonly<Record<Family, string>> = {
  peer: "비겁",
  output: "식상",
  wealth: "재성",
  authority: "관성",
  resource: "인성",
};

/** 계열의 쉬운 뜻. 근거를 설명할 때 괄호 안에 쓴다. */
export const FAMILY_MEANING: Readonly<Record<Family, string>> = {
  peer: "자기 기준·주체성",
  output: "표현·산출",
  wealth: "현실 감각·자원",
  authority: "규칙·역할·책임",
  resource: "배움·생각·보호",
};

/** 기둥의 십성 이름을 계열로 묶는 표. 계산이 아니라 이름 분류다. */
const TEN_GOD_FAMILY: Readonly<Record<string, Family>> = {
  비견: "peer",
  겁재: "peer",
  식신: "output",
  상관: "output",
  편재: "wealth",
  정재: "wealth",
  편관: "authority",
  정관: "authority",
  편인: "resource",
  정인: "resource",
};

export function tenGodFamily(tenGod: string | null | undefined): Family | null {
  return tenGod ? (TEN_GOD_FAMILY[tenGod] ?? null) : null;
}

export type StrengthBand = "strong" | "balanced" | "weak";

export function strengthBand(strength: string | null | undefined): StrengthBand | null {
  if (strength === "strong" || strength === "slightly-strong") return "strong";
  if (strength === "weak" || strength === "slightly-weak") return "weak";
  if (strength === "balanced") return "balanced";
  return null;
}

export const STRENGTH_LABEL: Readonly<Record<string, string>> = {
  strong: "강한 편",
  "slightly-strong": "조금 강한 편",
  balanced: "균형 잡힌 편",
  "slightly-weak": "조금 약한 편",
  weak: "약한 편",
};

export const PATTERN_LABEL: Readonly<Record<string, string>> = {
  "eating-god": "식신격",
  "hurting-officer": "상관격",
  "direct-wealth": "정재격",
  "indirect-wealth": "편재격",
  "direct-officer": "정관격",
  "seven-killings": "칠살격",
  "direct-resource": "정인격",
  "indirect-resource": "편인격",
  "month-prosperity": "건록격",
  "month-robbery": "양인격",
};

export function familyPercents(context: InquiryRuleContext): Readonly<Record<Family, number>> | null {
  const percent = context.assessment?.familyPercent as Readonly<Record<Family, number>> | undefined;
  if (!percent) return null;
  return FAMILIES.every((family) => typeof percent[family] === "number") ? percent : null;
}

/** 비중 순서. 같으면 이름순으로 고정해 결과가 흔들리지 않게 한다. */
export function rankFamilies(percents: Readonly<Record<Family, number>>): Family[] {
  return [...FAMILIES].sort((a, b) => percents[b] - percents[a] || a.localeCompare(b));
}

export function isPartial(context: InquiryRuleContext): boolean {
  return context.assessment?.coverage !== undefined && context.assessment.coverage !== "complete";
}

/** 시주를 몰라 관측된 기둥에서만 안 보이는 계열인지 확인한다. 없다고 단정하지 않기 위한 값이다. */
export function observedOnlyMissing(context: InquiryRuleContext, family: Family): boolean {
  const observed = (context.assessment?.observedMissingFamilies as readonly string[] | undefined)?.includes(family) ?? false;
  const confirmed = (context.assessment?.missingFamilies as readonly string[] | undefined)?.includes(family) ?? false;
  return isPartial(context) && observed && !confirmed;
}

/** 기준값 근처라 시주를 알면 판단이 바뀔 수 있는지. */
export function nearThreshold(value: number, threshold: number, margin = 5): boolean {
  return Math.abs(value - threshold) <= margin;
}

type PositionKey = "year" | "month" | "day" | "hour";
interface NatalPositionView {
  readonly stem: { readonly tenGod: string | null };
  readonly branch: { readonly tenGod: string | null };
}

function natalPositions(context: InquiryRuleContext): Partial<Record<PositionKey, NatalPositionView | null>> {
  const facts = context.natalFacts as unknown as { positions?: Partial<Record<PositionKey, NatalPositionView | null>> } | null;
  return facts?.positions ?? {};
}

/** 관측된 기둥의 겉 천간과 지지 본기의 십성 개수. 일간 자리는 제외한다. */
export function tenGodCounts(context: InquiryRuleContext): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [key, position] of Object.entries(natalPositions(context))) {
    if (!position) continue;
    const symbols = key === "day" ? [position.branch.tenGod] : [position.stem.tenGod, position.branch.tenGod];
    for (const tenGod of symbols) {
      if (tenGod && TEN_GOD_FAMILY[tenGod]) counts[tenGod] = (counts[tenGod] ?? 0) + 1;
    }
  }
  return counts;
}

/** 일지(배우자 자리) 본기의 십성. */
export function dayBranchTenGod(context: InquiryRuleContext): string | null {
  return natalPositions(context).day?.branch.tenGod ?? null;
}

export function hourKnown(context: InquiryRuleContext): boolean {
  return Boolean(natalPositions(context).hour);
}

export function findJudgment(evidence: readonly InquiryEvidence[], ruleId: string): InquiryEvidence | undefined {
  return evidence.find((entry) => entry.kind === "judgment" && entry.ruleId === ruleId && entry.periodId === null);
}

/** 해당 주제의 구조 검토 표지. 단정하지 않을 이유로 반대 근거에 연결한다. */
export function topicGuards(evidence: readonly InquiryEvidence[], domain: string): InquiryEvidence[] {
  return evidence.filter(
    (entry) =>
      entry.kind === "judgment" &&
      entry.periodId === null &&
      entry.disposition === "review-required" &&
      entry.tags.includes(`topic:${domain}`),
  );
}

/** 두 계열 조합을 관측한 엔진 판단(예: f02.observation.peer-authority). 순서는 어느 쪽이든 받는다. */
export function pairObservation(evidence: readonly InquiryEvidence[], a: Family, b: Family): InquiryEvidence | undefined {
  return evidence.find(
    (entry) =>
      entry.kind === "judgment" &&
      entry.periodId === null &&
      entry.disposition === "accepted" &&
      (entry.ruleId.endsWith(`.observation.${a}-${b}`) || entry.ruleId.endsWith(`.observation.${b}-${a}`)),
  );
}

export function shinsalEvidence(evidence: readonly InquiryEvidence[], shinsalId: string, periodId: string | null): InquiryEvidence[] {
  return evidence.filter(
    (entry) => entry.kind === "shinsal" && entry.periodId === periodId && entry.tags.includes(`shinsal:${shinsalId}`),
  );
}

export const OPPOSING_RELATIONS = ["branch-clash", "branch-punishment", "branch-self-punishment", "branch-harm", "branch-break", "branch-wonjin"] as const;

export function relationEvidence(
  evidence: readonly InquiryEvidence[],
  options: { readonly periodId: string | null; readonly dayBranch?: boolean; readonly types: readonly string[] },
): InquiryEvidence[] {
  return evidence.filter(
    (entry) =>
      entry.kind === "relation" &&
      entry.periodId === options.periodId &&
      options.types.some((type) => entry.tags.includes(`relation:${type}`)) &&
      (options.dayBranch === undefined || entry.tags.includes("day-branch") === options.dayBranch),
  );
}

export function periodEvidence(evidence: readonly InquiryEvidence[], periodId: string): InquiryEvidence | undefined {
  return evidence.find((entry) => entry.kind === "period" && entry.periodId === periodId);
}

export function periodStageEvidence(evidence: readonly InquiryEvidence[], periodId: string): InquiryEvidence | undefined {
  return evidence.find(
    (entry) =>
      entry.kind === "twelve-stage" &&
      entry.periodId === periodId &&
      entry.tags.includes("basis:day-master") &&
      entry.tags.includes("position:period"),
  );
}

export function percentText(family: Family, percents: Readonly<Record<Family, number>>): string {
  return `${FAMILY_LABEL[family]}(${FAMILY_MEANING[family]}) ${percents[family]}%`;
}

/** 마지막 글자의 받침에 맞춰 조사를 붙인다. 괄호로 끝나면 괄호 앞 글자를 본다. */
export function withJosa(word: string, pair: "이/가" | "과/와" | "은/는" | "을/를"): string {
  const base = word.replace(/\([^)]*\)$/, "");
  const code = base.charCodeAt(base.length - 1);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  const [withFinal, withoutFinal] = pair.split("/") as [string, string];
  return `${word}${hasFinal ? withFinal : withoutFinal}`;
}

export const uniqueIds = (entries: readonly (InquiryEvidence | undefined)[]): string[] => [
  ...new Set(entries.filter((entry): entry is InquiryEvidence => Boolean(entry)).map((entry) => entry.id)),
];
