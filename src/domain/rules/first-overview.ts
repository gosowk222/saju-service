import type { InquiryConclusionDraft, InquiryEvidence, InquiryRule, InquiryRuleContext } from "sajuengine";
import type { InquiryDomain } from "../products/types";

/**
 * 첫 상품의 앱 규칙. 설명과 검토 상태는 docs/rules/first-overview.md에 있다.
 *
 * 구조화된 값(assessment, tags, ruleId)만 읽는다. assertion 문장은 해석하지 않는다.
 * AI가 작성한 초안이며 명리 전문가의 검토를 받지 않았으므로 reviewStatus는 unreviewed다.
 */

export const RULESET_ID = "first-overview";
export const RULESET_VERSION = "1.0.0";
const SOURCE_REF = "service:docs/rules/first-overview.md@1.0.0";

type Family = "peer" | "output" | "wealth" | "authority" | "resource";

const FAMILIES: readonly Family[] = ["peer", "output", "wealth", "authority", "resource"];

const FAMILY_LABEL: Readonly<Record<Family, string>> = {
  peer: "비겁",
  output: "식상",
  wealth: "재성",
  authority: "관성",
  resource: "인성",
};

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family as Family] ?? family;
}

/** 가장 두드러진 십성 계열로 각 주제를 어떻게 읽을지 정한 표. 결과나 사건을 판정하지 않는다. */
const DOMINANT_LENS: Readonly<Record<InquiryDomain, Readonly<Record<Family, string>>>> = {
  temperament: {
    peer: "자기 기준이 분명하고, 스스로 정한 방식대로 움직이려는 편으로 읽어요.",
    output: "떠오른 생각을 말이나 결과물로 밖에 꺼내면서 정리하는 편으로 읽어요.",
    wealth: "눈앞의 조건과 쓸 수 있는 자원을 먼저 따져 보는 현실 감각이 앞서는 편으로 읽어요.",
    authority: "맡은 역할과 지켜야 할 기준을 의식하면서 자신을 다잡는 편으로 읽어요.",
    resource: "먼저 충분히 받아들이고 이해한 뒤에 움직이는 편으로 읽어요.",
  },
  strengths: {
    peer: "혼자서도 밀고 나가는 추진력과 자기 몫을 책임지는 힘을 강점으로 봐요.",
    output: "아이디어를 말과 결과물로 바꿔 보여 주는 힘을 강점으로 봐요.",
    wealth: "상황을 빠르게 파악하고 필요한 것을 챙기는 실속을 강점으로 봐요.",
    authority: "규칙과 책임을 지키면서 일을 끝까지 가져가는 신뢰감을 강점으로 봐요.",
    resource: "배우고 정리해서 깊이를 쌓아 가는 힘을 강점으로 봐요.",
  },
  career: {
    peer: "재량이 있고 자기 방식으로 결과를 책임지는 환경에서 힘이 나는 편으로 읽어요.",
    output: "기획이나 표현처럼 결과물이 눈에 보이는 일에서 힘이 나는 편으로 읽어요.",
    wealth: "성과와 자원을 다루고 조율하는 일에서 감각이 살아나는 편으로 읽어요.",
    authority: "역할과 절차가 분명한 체계 안에서 안정적으로 힘을 내는 편으로 읽어요.",
    resource: "자료를 공부하고 정리해서 전달하는 일에서 힘이 나는 편으로 읽어요.",
  },
  wealth: {
    peer: "돈도 내 기준대로 쓰고 싶어 하는 편이라, 가까운 사람과 돈이 섞일 때 경계를 정해 두면 좋아요.",
    output: "내가 만든 결과물이 돈으로 이어지는 흐름에 관심이 가는 편이고, 씀씀이가 함께 커지지 않게 챙기면 좋아요.",
    wealth: "들어오고 나가는 돈을 구체적으로 챙기는 편이고, 눈앞의 이익에 쏠리지 않게 살피면 좋아요.",
    authority: "안정과 규칙적인 관리를 선호하는 편이고, 지나치게 조심스러워지지 않게 살피면 좋아요.",
    resource: "당장의 돈보다 배움과 준비에 먼저 쓰는 편이고, 실행을 미루지 않게 챙기면 좋아요.",
  },
  romance: {
    peer: "연애에서도 대등함과 내 페이스를 중요하게 여기는 편으로 읽어요.",
    output: "마음을 말과 행동으로 표현하면서 가까워지는 편으로 읽어요.",
    wealth: "말보다 실제로 챙겨 주는 방식으로 애정을 나타내는 편으로 읽어요.",
    authority: "책임감 있는 관계를 중요하게 여기고 나름의 기준이 뚜렷한 편으로 읽어요.",
    resource: "이해받고 안정감을 느낄 때 마음을 여는 편으로 읽어요.",
  },
  social: {
    peer: "또래나 동료와 대등하게 협력할 때 편안하고, 경쟁심은 조율이 필요한 편으로 읽어요.",
    output: "먼저 말을 건네고 분위기를 만드는 편이고, 말이 앞설 때는 한 박자 쉬면 좋아요.",
    wealth: "서로 실질적인 도움을 주고받는 관계에서 편안함을 느끼는 편으로 읽어요.",
    authority: "예의와 역할을 지키며 적당한 거리를 두고 지내는 편으로 읽어요.",
    resource: "먼저 듣고 받아 주는 쪽에 서는 일이 많은 편으로 읽어요.",
  },
};

/** 비중이 낮은 계열을 어떻게 보완하면 좋은지 정한 표. */
const SCARCE_BALANCE: Readonly<Record<Family, string>> = {
  peer: "내 입장을 먼저 정해 두는 연습을 하면 다른 사람에게 휩쓸리는 일이 줄어요.",
  output: "생각을 밖으로 꺼내 보이는 시간을 일부러 만들면 좋아요.",
  wealth: "돈과 시간 같은 자원을 눈에 보이게 정리해 두면 도움이 돼요.",
  authority: "마감이나 약속처럼 나를 잡아 줄 틀을 하나 만들어 두면 좋아요.",
  resource: "혼자 정리하고 배우는 시간을 따로 확보해 두면 좋아요.",
};

const OUTCOME_CAVEAT = "성향을 읽는 해석이며 실제 사건, 금액, 합격 여부를 판단하지 않는다.";
const PARTIAL_CAVEAT = "태어난 시간을 몰라 시주를 뺀 범위에서 본 비율이다.";
const GUARD_CAVEAT = "구조의 불확실성 표지가 함께 있어 단정하지 않고 경향으로 전달한다.";

/** 적용 기준: 다섯 계열이 고르면 각 20%다. 25% 이상일 때만 두드러진다고 본다. */
export const DOMINANT_MIN_PERCENT = 25;
/** 시주를 모를 때 1위와 2위 차이가 이 값 이하이면 순서가 바뀔 수 있어 보류한다. */
export const PARTIAL_HOLD_MARGIN = 10;
/** 비중 낮음 기준. */
export const SCARCE_MAX_PERCENT = 12;

function findJudgment(evidence: readonly InquiryEvidence[], ruleId: string): InquiryEvidence | undefined {
  return evidence.find((entry) => entry.kind === "judgment" && entry.ruleId === ruleId);
}

function topicGuards(evidence: readonly InquiryEvidence[], domain: string): readonly InquiryEvidence[] {
  return evidence.filter(
    (entry) =>
      entry.kind === "judgment" &&
      entry.disposition === "review-required" &&
      entry.tags.includes(`topic:${domain}`),
  );
}

function familyPercents(context: InquiryRuleContext): Readonly<Record<Family, number>> | null {
  const percent = context.assessment?.familyPercent;
  if (!percent) return null;
  return percent as Readonly<Record<Family, number>>;
}

export const dominantFamilyLensRule: InquiryRule = {
  metadata: {
    ruleId: `${RULESET_ID}.dominant-family-lens`,
    version: RULESET_VERSION,
    sourceRefs: [SOURCE_REF],
    reviewStatus: "unreviewed",
  },
  domains: ["temperament", "strengths", "career", "wealth", "romance", "social"],
  kinds: ["natal"],
  evaluate: (context): readonly InquiryConclusionDraft[] => {
    const { assessment, evidence, question } = context;
    const percents = familyPercents(context);
    const dominant = assessment?.dominantFamily as Family | null | undefined;
    if (!assessment || !percents || !dominant) return [];

    const share = percents[dominant];
    if (share < DOMINANT_MIN_PERCENT) return [];

    const source = findJudgment(evidence, "m01.assessment.families");
    if (!source) return [];

    const guards = topicGuards(evidence, question.domain);
    const runnerUp = Math.max(...FAMILIES.filter((family) => family !== dominant).map((family) => percents[family]));
    const partial = assessment.coverage !== "complete";
    const hold = partial && share - runnerUp <= PARTIAL_HOLD_MARGIN;

    const statement = DOMINANT_LENS[question.domain as InquiryDomain]?.[dominant];
    if (!statement) return [];

    return [
      {
        key: "dominant",
        statement,
        status: hold ? "deferred" : "candidate",
        supportingEvidenceIds: [source.id],
        counterEvidenceIds: guards.map((guard) => guard.id),
        caveats: [
          OUTCOME_CAVEAT,
          ...(partial ? [PARTIAL_CAVEAT] : []),
          ...(guards.length ? [GUARD_CAVEAT] : []),
        ],
      },
    ];
  },
};

export const scarceFamilyBalanceRule: InquiryRule = {
  metadata: {
    ruleId: `${RULESET_ID}.scarce-family-balance`,
    version: RULESET_VERSION,
    sourceRefs: [SOURCE_REF],
    reviewStatus: "unreviewed",
  },
  domains: ["strengths", "career", "wealth"],
  kinds: ["natal"],
  evaluate: (context): readonly InquiryConclusionDraft[] => {
    const { assessment, evidence } = context;
    const percents = familyPercents(context);
    if (!assessment || !percents) return [];

    const source = findJudgment(evidence, "m01.assessment.families");
    if (!source) return [];

    const scarce = [...FAMILIES].sort((a, b) => percents[a] - percents[b] || a.localeCompare(b))[0]!;
    if (percents[scarce] > SCARCE_MAX_PERCENT) return [];

    // 시주를 몰라서 안 보이는 계열은 없다고 단정할 수 없으므로 보류한다.
    const observedOnly = (assessment.observedMissingFamilies as readonly string[] | undefined)?.includes(scarce) ?? false;
    const confirmedMissing = (assessment.missingFamilies as readonly string[] | undefined)?.includes(scarce) ?? false;
    const hold = assessment.coverage !== "complete" && observedOnly && !confirmedMissing;

    return [
      {
        key: "scarce",
        statement: SCARCE_BALANCE[scarce],
        status: hold ? "deferred" : "candidate",
        supportingEvidenceIds: [source.id],
        counterEvidenceIds: [],
        caveats: [OUTCOME_CAVEAT, ...(hold ? [PARTIAL_CAVEAT] : [])],
      },
    ];
  },
};

export const FIRST_OVERVIEW_RULES: readonly InquiryRule[] = [dominantFamilyLensRule, scarceFamilyBalanceRule];
