/**
 * 무진 의미 태그표 (mujin-tags-1.0.0).
 *
 * 태그는 규칙 작성자가 채택 판단에 붙인다. 태그는 판단을 고른 규칙의 (규칙 ID, 결론 key, 변형)에서만 찾는다.
 * 변형은 규칙이 RuleDetail.variant에 기록한 값이다. 판단 문장이나 생성된 문장의 단어를 검색해 태그를 붙이지 않고,
 * LLM이 새 판단을 내려 태그를 붙이지도 않는다 (docs/implementation/mujin/02_DECISION_RULES.md 14절).
 *
 * - 여러 갈래를 함께 고른 결론의 변형은 '+'로 이은 조각이다 (예: 강점 환경 "munchang+hwagae"). 조각마다 태그를 찾는다.
 * - 표에 없는 변형은 태그가 없다. 태그가 없으면 이어 쓰는 설명(derived)을 만들지 않고 일반 점검으로 남긴다.
 * - 목록 순서가 고정 카탈로그 순서다. 같은 질문에서 태그가 겹치면 이 순서와 규칙 ID로 정한다.
 *
 * AI가 작성한 초안이며 명리 전문가의 검토 전이다(unreviewed). 내용을 바꾸면 버전을 올리고 docs/rules/mujin-overview.md를 고친다.
 */

export const TAG_CATALOG_VERSION = "mujin-tags-1.0.0";

/**
 * ability: 격국 능력(명세 14절). environment: 능력이 드러나는 환경 신살. tendency: 행동 경향.
 * expression: 마음을 표현하는 방식(5장). money: 돈과 관계가 얽히는 경향(5·7장의 돈 이야기).
 */
export type MujinTagKind = "ability" | "environment" | "tendency" | "expression" | "money";

export interface MujinTagDefinition {
  readonly id: string;
  readonly kind: MujinTagKind;
  readonly label: string;
  /** 능력 태그만: 명세 14절의 능력 / 약점 → 연결 활동. */
  readonly ability?: { readonly strength: string; readonly weakness: string; readonly activity: string };
}

/** 고정 카탈로그 순서. 행동 경향은 명세에 나온 순서를 따른다. */
export const MUJIN_TAGS: readonly MujinTagDefinition[] = [
  { id: "refusal-difficulty", kind: "tendency", label: "거절 어려움" },
  { id: "solo-solving", kind: "tendency", label: "혼자 해결함" },
  { id: "responsibility-burden", kind: "tendency", label: "책임 떠안음" },
  { id: "finish-delay", kind: "tendency", label: "계속 준비함·완성 지연" },
  { id: "over-expansion", kind: "tendency", label: "과도한 확장" },
  { id: "autonomy-need", kind: "tendency", label: "자율성 필요" },
  { id: "role-clarity", kind: "tendency", label: "역할 명확성" },
  { id: "alone-time", kind: "tendency", label: "혼자 있는 시간" },
  { id: "over-comparison", kind: "tendency", label: "비교 과함" },
  { id: "all-urgent", kind: "tendency", label: "모든 상황을 긴급하게 다룸" },
  { id: "hidden-opinion", kind: "tendency", label: "기준이 불명확하면 의견을 숨김" },
  { id: "collaboration", kind: "tendency", label: "함께할 때 힘이 남(협업)" },
  { id: "output-expression", kind: "tendency", label: "결과물로 드러냄(성과 표현)" },
  { id: "expression-direct", kind: "expression", label: "마음을 바로 표현함" },
  { id: "expression-reserved", kind: "expression", label: "마음을 늦게 드러냄" },
  { id: "expression-adaptive", kind: "expression", label: "상대에 맞춰 표현을 조절함" },
  { id: "relational-spending", kind: "money", label: "관계·사람에게 쓰는 돈이 커짐" },
  { id: "money-talk-avoid", kind: "money", label: "돈 이야기를 미룸" },
  {
    id: "ability.eating-god",
    kind: "ability",
    label: "식신",
    ability: { strength: "꾸준한 결과물", weakness: "익숙한 방식에 머묾", activity: "반복 완성과 작은 변형 비교" },
  },
  {
    id: "ability.hurting-officer",
    kind: "ability",
    label: "상관",
    ability: { strength: "문제 발견·개선", weakness: "비판 전달의 마찰", activity: "문제·대안·내 역할 구분" },
  },
  {
    id: "ability.direct-wealth",
    kind: "ability",
    label: "정재",
    ability: { strength: "일정·자원 관리", weakness: "작은 오차에 과도하게 매임", activity: "계획과 조정 여지" },
  },
  {
    id: "ability.indirect-wealth",
    kind: "ability",
    label: "편재",
    ability: { strength: "기회 연결", weakness: "넓히다 마무리하지 못함", activity: "작은 시도를 끝낸 뒤 다음 범위 결정" },
  },
  {
    id: "ability.direct-officer",
    kind: "ability",
    label: "정관",
    ability: { strength: "기준·신뢰", weakness: "기준이 불명확하면 자기 의견을 숨김", activity: "기준과 예외에서 자기 판단 설명" },
  },
  {
    id: "ability.seven-killings",
    kind: "ability",
    label: "편관",
    ability: { strength: "압박 속 판단", weakness: "모든 상황을 긴급하게 다룸", activity: "긴급한 것과 일반 과제 구분" },
  },
  {
    id: "ability.direct-resource",
    kind: "ability",
    label: "정인",
    ability: { strength: "정리·설명", weakness: "준비가 길어짐", activity: "설명 자료와 작은 실습 연결" },
  },
  {
    id: "ability.indirect-resource",
    kind: "ability",
    label: "편인",
    ability: { strength: "깊이·독특한 관점", weakness: "완성 전 관심 전환", activity: "여러 관점을 결과물로 기록" },
  },
  {
    id: "ability.month-prosperity",
    kind: "ability",
    label: "건록",
    ability: { strength: "스스로 시작", weakness: "도움을 받지 않음", activity: "자율 과제와 나눌 역할" },
  },
  {
    id: "ability.month-robbery",
    kind: "ability",
    label: "월겁",
    ability: { strength: "경쟁 속 추진", weakness: "비교가 과해짐", activity: "자신의 과정과 목표 기록" },
  },
  { id: "env.munchang", kind: "environment", label: "문창 표지(기록·정리·설명)" },
  { id: "env.hakdang", kind: "environment", label: "학당 표지(계속 배우는 환경)" },
  { id: "env.hwagae", kind: "environment", label: "화개 표지(혼자 몰입하는 시간)" },
  { id: "env.jangseong", kind: "environment", label: "장성 표지(역할과 권한이 주어지는 자리)" },
];

const TAG_ORDER: ReadonlyMap<string, number> = new Map(MUJIN_TAGS.map((tag, index) => [tag.id, index]));

export function tagDefinition(id: string): MujinTagDefinition | undefined {
  return MUJIN_TAGS.find((tag) => tag.id === id);
}

/** 고정 카탈로그 순서. 표에 없는 태그는 맨 뒤다. */
export function tagOrder(id: string): number {
  return TAG_ORDER.get(id) ?? MUJIN_TAGS.length;
}

/** 서로 상반된 경향. 같은 판단(같은 조건)에서 함께 나오면 혼합으로, 다른 판단에서 나오면 조건별로 설명한다. */
export const OPPOSING_TAGS: readonly (readonly [string, string])[] = [
  ["autonomy-need", "role-clarity"],
  ["solo-solving", "collaboration"],
  ["expression-direct", "expression-reserved"],
];

export interface TagEntry {
  /** 이 변형을 고른 판단이 뜻하는 경향. 채택(candidate)된 판단에만 붙인다. */
  readonly tags: readonly string[];
  /**
   * 이 판단이 보완하는 경향 (강점의 보완 행동만). 판단의 뜻이 아니라 '이 행동이 무엇을 보완하는가'라서 tags와 따로 둔다.
   * 2-4에서 보완 행동이 고른 능력과 관련 있는지 볼 때만 쓴다.
   */
  readonly addresses?: readonly string[];
}

/**
 * (규칙 ID → 결론 key → 변형 조각) 태그표. 결론 key와 변형 이름은 src/domain/rules/first-overview.ts·life.ts의 문장표 키다.
 * 적지 않은 변형은 태그가 없다 (예: 기본 성향 core의 wealth·balanced, 조건 strong-inner, 직업군과 업종).
 */
export const TAG_ASSIGNMENTS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, TagEntry>>>>>> = {
  "first-overview.temperament": {
    core: {
      peer: { tags: ["autonomy-need"] },
      output: { tags: ["output-expression", "finish-delay"] },
      authority: { tags: ["role-clarity", "responsibility-burden"] },
      resource: { tags: ["finish-delay"] },
    },
    mix: {
      "output|peer": { tags: ["autonomy-need", "output-expression"] },
      "peer|wealth": { tags: ["autonomy-need"] },
      "authority|peer": { tags: ["autonomy-need", "responsibility-burden"] },
      "peer|resource": { tags: ["autonomy-need"] },
      "output|wealth": { tags: ["output-expression"] },
      "authority|output": { tags: ["hidden-opinion"] },
      "output|resource": { tags: ["finish-delay"] },
      "authority|wealth": { tags: ["responsibility-burden"] },
      "resource|wealth": { tags: ["finish-delay"] },
      "authority|resource": { tags: ["role-clarity"] },
    },
    reaction: {
      strong: { tags: ["solo-solving", "responsibility-burden"] },
      balanced: { tags: ["hidden-opinion"] },
      weak: { tags: ["refusal-difficulty"] },
    },
    condition: {
      "strong-outer": { tags: ["over-expansion"] },
      "weak-inner": { tags: ["finish-delay"] },
      "weak-outer": { tags: ["responsibility-burden"] },
    },
  },
  "first-overview.strengths": {
    ability: {
      "eating-god": { tags: ["ability.eating-god"] },
      "hurting-officer": { tags: ["ability.hurting-officer"] },
      "direct-wealth": { tags: ["ability.direct-wealth"] },
      "indirect-wealth": { tags: ["ability.indirect-wealth", "over-expansion"] },
      "direct-officer": { tags: ["ability.direct-officer", "hidden-opinion", "role-clarity"] },
      "seven-killings": { tags: ["ability.seven-killings", "all-urgent"] },
      "direct-resource": { tags: ["ability.direct-resource", "finish-delay"] },
      "indirect-resource": { tags: ["ability.indirect-resource", "finish-delay"] },
      "month-prosperity": { tags: ["ability.month-prosperity", "solo-solving", "autonomy-need"] },
      "month-robbery": { tags: ["ability.month-robbery", "over-comparison"] },
    },
    environment: {
      munchang: { tags: ["env.munchang"] },
      hakdang: { tags: ["env.hakdang"] },
      hwagae: { tags: ["env.hwagae", "alone-time"] },
      jangseong: { tags: ["env.jangseong", "role-clarity"] },
    },
    // 가장 약한 계열의 보완 행동. 판단의 뜻이 아니라 보완하는 경향만 적는다.
    action: {
      peer: { tags: [], addresses: ["hidden-opinion"] },
      output: { tags: [], addresses: ["finish-delay", "hidden-opinion"] },
      wealth: { tags: [], addresses: ["finish-delay"] },
      authority: { tags: [], addresses: ["finish-delay", "over-expansion"] },
      resource: { tags: [], addresses: ["all-urgent", "over-expansion"] },
    },
  },
  "first-overview.career": {
    style: {
      peer: { tags: ["autonomy-need"] },
      output: { tags: ["output-expression", "finish-delay"] },
      authority: { tags: ["role-clarity"] },
      resource: { tags: ["finish-delay"] },
    },
    "org-fit": {
      structured: { tags: ["role-clarity"] },
      autonomous: { tags: ["autonomy-need"] },
      mixed: { tags: ["role-clarity", "autonomy-need"] },
    },
    orientation: {
      "strong:peer": { tags: ["collaboration"] },
      "strong:output": { tags: ["output-expression"] },
    },
  },
  "first-overview.wealth": {
    income: {
      opportunity: { tags: ["over-expansion"] },
      detached: { tags: ["money-talk-avoid"] },
    },
    keeping: {
      spend: { tags: ["relational-spending"] },
    },
    relations: {
      leaky: { tags: ["refusal-difficulty", "relational-spending"] },
      solo: { tags: ["solo-solving"] },
    },
  },
  "first-overview.investment": {
    investment: {
      follow: { tags: ["over-comparison"] },
      opportunity: { tags: ["over-expansion"] },
      study: { tags: ["finish-delay"] },
    },
  },
  "first-overview.romance": {
    attraction: {
      direct: { tags: ["expression-direct"] },
      subtle: { tags: ["expression-reserved"] },
      adaptive: { tags: ["expression-adaptive"] },
    },
    comfort: {
      peer: { tags: ["autonomy-need"] },
      authority: { tags: ["role-clarity"] },
    },
    deepening: {
      "push-pull": { tags: ["alone-time"] },
      solitude: { tags: ["alone-time"] },
    },
    conflict: {
      talk: { tags: ["expression-direct"] },
      hold: { tags: ["solo-solving"] },
    },
  },
  "first-overview.social": {
    cooperation: {
      crew: { tags: ["collaboration"] },
      few: { tags: ["solo-solving", "role-clarity"] },
      listener: { tags: ["solo-solving"] },
    },
    competition: {
      rival: { tags: ["over-comparison"] },
    },
    boundary: {
      porous: { tags: ["refusal-difficulty", "responsibility-burden"] },
      recharge: { tags: ["alone-time"] },
      formal: { tags: ["role-clarity"] },
    },
    conflict: {
      procedural: { tags: ["role-clarity"] },
    },
  },
  "first-overview.friends": {
    image: {
      resource: { tags: ["solo-solving"] },
    },
  },
};

/** 변형 문자열을 조각으로 나눈다. 빈 변형은 조각이 없다. */
export function variantParts(variant: string | null | undefined): string[] {
  return variant ? variant.split("+").filter(Boolean) : [];
}

function entriesFor(ruleId: string, key: string, variant: string | null | undefined): TagEntry[] {
  const table = TAG_ASSIGNMENTS[ruleId]?.[key];
  if (!table) return [];
  return variantParts(variant).flatMap((part) => (table[part] ? [table[part]!] : []));
}

const byCatalog = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => tagOrder(a) - tagOrder(b) || a.localeCompare(b));

/** (규칙 ID, 결론 key, 변형)의 태그. 카탈로그 순서로 돌려준다. 표에 없으면 빈 배열. */
export function tagsFor(ruleId: string, key: string, variant: string | null | undefined): string[] {
  return byCatalog(entriesFor(ruleId, key, variant).flatMap((entry) => entry.tags));
}

/** 보완 행동이 보완하는 경향 (강점의 보완 행동만). */
export function addressesFor(ruleId: string, key: string, variant: string | null | undefined): string[] {
  return byCatalog(entriesFor(ruleId, key, variant).flatMap((entry) => entry.addresses ?? []));
}
