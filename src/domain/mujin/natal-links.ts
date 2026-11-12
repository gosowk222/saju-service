import type { CompareDetail } from "../rules/common";
import { ELEMENT_HANJA, ELEMENT_INDUSTRY, type Element } from "../rules/life-tables";
import { withJosa } from "../rules/materials";
import type { Weakness } from "../rules/natal-tables";

/**
 * 무진 원국 질문(기초 분석 P02~P05, 1장~8장)과 기존 규칙 판단의 연결표.
 * 명세: docs/implementation/mujin/02_DECISION_RULES.md 3~11절, 14절. 규칙 설명: docs/rules/mujin-overview.md.
 *
 * - 재사용: 기존 first-overview 규칙의 결론을 결론 key 기준으로 질문에 배분한다 (JUDGMENT_ROUTES).
 * - 수정: 강약을 체력·회복·수입 변동 감당과 잇는 문장은 무진용 중립 문장으로 바꾸거나 쓰지 않는다 (NEUTRAL_*, EXCLUDED_JUDGMENTS).
 * - 신규 연결: 채택 판단의 의미 태그(tags.ts)에서 질문별 설명을 잇는다 (LINK_SPECS). 새 계산 근거가 아니다.
 *
 * 문장은 작성 재료의 의미 메모다. 모델이 그대로 옮겨 적을 대본이 아니다. AI 초안이며 검토 전이다(unreviewed).
 */

export const MUJIN_RULESET = { id: "mujin-overview", version: "1.0.0", reviewStatus: "unreviewed" } as const;

/** 원국 질문을 받는 분야. family(부모·형제·성장기 짐작)와 place(지역·행운)는 무진 질문에 쓰지 않아 묻지 않는다. */
export const ASKED_DOMAINS = ["temperament", "strengths", "career", "wealth", "romance", "social", "friends"] as const;

/** 계획에 넣는 섹션. 원국표(chart)는 글이 없고, 9·10장과 마지막 정리는 유료 생성 때 기간 재료로 만든다. */
export const NATAL_SECTION_IDS = [
  "basics-structure",
  "basics-elements",
  "basics-stages",
  "basics-ten-gods",
  "ch1",
  "ch2",
  "ch3",
  "ch4",
  "ch5",
  "ch6",
  "ch7",
  "ch8",
] as const;

export interface JudgmentRoute {
  readonly ruleId: string;
  readonly key: string;
  /** 이 판단으로 답할 질문. 첫 질문이 속한 섹션에 재료를 둔다. */
  readonly questionIds: readonly string[];
}

/** 기존 규칙 결론 → 무진 질문. 목록 순서가 섹션 안 재료 순서다. 여기 없는 결론은 무진 재료로 쓰지 않는다. */
export const JUDGMENT_ROUTES: readonly JudgmentRoute[] = [
  { ruleId: "first-overview.temperament", key: "core", questionIds: ["1-1", "1-4"] },
  { ruleId: "first-overview.temperament", key: "mix", questionIds: ["1-2", "1-4"] },
  { ruleId: "first-overview.temperament", key: "reaction", questionIds: ["1-3"] },
  { ruleId: "first-overview.temperament", key: "condition", questionIds: ["1-3", "1-4"] },
  { ruleId: "first-overview.strengths", key: "ability", questionIds: ["2-1", "2-4"] },
  { ruleId: "first-overview.strengths", key: "environment", questionIds: ["2-2"] },
  // 가장 약한 계열의 보완 행동은 고른 능력과 관련될 때만 2-4의 보조로 쓴다 (plan.ts의 relatedScarce).
  { ruleId: "first-overview.strengths", key: "action", questionIds: ["2-4"] },
  { ruleId: "first-overview.career", key: "style", questionIds: ["3-1"] },
  { ruleId: "first-overview.career", key: "orientation", questionIds: ["3-1"] },
  { ruleId: "first-overview.jobs", key: "family", questionIds: ["3-1"] },
  { ruleId: "first-overview.jobs", key: "industry", questionIds: ["3-1"] },
  { ruleId: "first-overview.career", key: "org-fit", questionIds: ["3-2"] },
  { ruleId: "first-overview.career", key: "path-compare", questionIds: ["3-3"] },
  { ruleId: "first-overview.wealth", key: "income", questionIds: ["4-1"] },
  { ruleId: "first-overview.wealth", key: "keeping", questionIds: ["4-2"] },
  { ruleId: "first-overview.wealth", key: "relations", questionIds: ["4-3"] },
  { ruleId: "first-overview.investment", key: "investment", questionIds: ["4-4"] },
  { ruleId: "first-overview.romance", key: "attraction", questionIds: ["5-1"] },
  { ruleId: "first-overview.romance", key: "comfort", questionIds: ["5-2"] },
  { ruleId: "first-overview.romance", key: "deepening", questionIds: ["5-3"] },
  { ruleId: "first-overview.romance", key: "conflict", questionIds: ["5-3"] },
  { ruleId: "first-overview.friends", key: "image", questionIds: ["6-1"] },
  { ruleId: "first-overview.social", key: "cooperation", questionIds: ["6-1", "6-2"] },
  { ruleId: "first-overview.social", key: "competition", questionIds: ["6-2"] },
  { ruleId: "first-overview.social", key: "conflict", questionIds: ["6-2"] },
  { ruleId: "first-overview.social", key: "boundary", questionIds: ["6-3"] },
  { ruleId: "first-overview.friends", key: "fortune", questionIds: ["6-4"] },
];

/** 무진 재료에서 뺀 기존 판단과 이유 (문서 표와 같은 내용). key "*"는 그 규칙의 모든 결론이다. */
export const EXCLUDED_JUDGMENTS: readonly { readonly ruleId: string; readonly key: string; readonly reason: string }[] = [
  {
    ruleId: "first-overview.energy",
    key: "*",
    reason: "강약(신약→회복이 느림, 그 밖→회복이 빠름)과 오행 35% 이상으로 회복 리듬을 정하는 규칙이다. 8장은 강약·오행으로 체력·회복을 판정하지 않는다(8-1).",
  },
  { ruleId: "first-overview.friends", key: "match", reason: "용신 오행으로 곁에 둘 사람을 고른다. 본인의 용신·기신으로 타인의 좋고 나쁨을 판정하지 않는다(6-4)." },
  { ruleId: "first-overview.friends", key: "drain", reason: "기신 오행으로 멀리할 사람을 고른다. 본인의 용신·기신으로 타인의 좋고 나쁨을 판정하지 않는다(6-4)." },
  { ruleId: "first-overview.family", key: "*", reason: "부모·형제·자녀·성장기를 짐작하는 문장이다. 7장은 새 연결로 만들고 가족사를 추정하지 않는다(7-1). 무진은 family 분야를 묻지 않는다." },
  { ruleId: "first-overview.place", key: "*", reason: "지역·행운의 방향·색·숫자는 무진 1~8장 질문에 없다. 무진은 place 분야를 묻지 않는다." },
];

export const isExcluded = (ruleId: string, key: string) =>
  EXCLUDED_JUDGMENTS.some((entry) => entry.ruleId === ruleId && (entry.key === "*" || entry.key === key));

/** 무진용 중립 문장. 원래 문장의 판단(조건·근거·상태)은 그대로 두고 체력·회복 연결만 뺀다. */
export interface NeutralOverride {
  readonly text?: string;
  readonly weakness?: Weakness;
  readonly action?: string;
  /** 문서와 테스트에서 확인하는 바꾼 이유. 작성 재료에는 넣지 않는다. */
  readonly reason: string;
}

/** 열쇠: `${ruleId}|${key}|${variant}`. */
export const NEUTRAL_OVERRIDES: Readonly<Record<string, NeutralOverride>> = {
  "first-overview.temperament|reaction|weak": {
    text: "주변 분위기와 사람의 기대에 영향을 많이 받는 쪽이에요. 혼자 정하기보다 함께 의논할 때 움직이기 쉬워요.",
    weakness: {
      what: "남의 기대와 분위기에 끌려가는 것",
      when: "부탁을 연달아 받거나 여러 사람 사이에 끼었을 때",
      cost: "거절을 못 해 내 일이 밀리고, 뒤늦게 한꺼번에 정리하느라 애를 먹어요",
      change: "들어줄 수 있는 부탁의 기준(시간·횟수)을 미리 정해 두기",
    },
    reason: "신약을 '에너지가 쉽게 바닥남', '지친 뒤 무너짐', '혼자 버티기보다'로 잇는 문장을 뺐다 (1-3, P02).",
  },
  "first-overview.temperament|reaction|strong": {
    text: "압박이 오면 물러서기보다 정면으로 밀어붙이는 쪽이에요. 막혀도 혼자 끝까지 해 보려는 마음이 강해요.",
    reason: "신강을 '혼자서도 버티는 힘이 좋다'로 잇는 문장을 뺐다. 버티는 힘을 체력이나 손실 감당 능력으로 읽지 않게 한다 (1-3, P02).",
  },
  "first-overview.temperament|condition|weak-outer": {
    text: "해야 할 일과 바깥의 요구가 내 기준보다 커지기 쉬운 구조예요. 맡을 범위와 도움받을 사람을 먼저 정해 두면 능력이 살고, 범위 없이 다 받으면 일이 밀려요.",
    action: "한 번에 맡는 일의 수를 정하고, 도움을 청할 사람을 먼저 정해 두기",
    reason: "신약을 '쓸 힘보다 해야 할 것이 많아 충전이 먼저', '회복 시간을 먼저 확보'로 잇는 문장을 뺐다 (1-3, 8-1).",
  },
  "first-overview.temperament|condition|strong-inner": {
    action: "추진력을 쓸 곳(프로젝트, 맡은 역할, 표현할 자리)을 일정에 먼저 정해 두기",
    reason: "신강을 '에너지를 쓸 곳(운동…)'으로 잇는 행동 제안을 뺐다 (1-3, 8-1).",
  },
  // 친구들이 보는 나: 주변 사람이 실제로 그렇게 평가했다거나 그런 말을 들었을 것이라는 과거 짐작을 빼고 관계에서 맡기 쉬운 역할로만 쓴다 (6-1, 04 문서 6절).
  "first-overview.friends|image|peer": {
    text: "관계에서는 의리 있게 편을 들어 주고, 모임의 방향을 정하는 쪽에 서기 쉬운 경향이에요. 다만 같은 모습이 고집으로 비칠 수 있어요.",
    reason: "'친구들 눈에는'과 '맡곤 했을 거예요'(주변 평가 단정, 과거 짐작)를 뺐다 (6-1).",
  },
  "first-overview.friends|image|output": {
    text: "관계에서는 분위기를 살리고 대화를 이어 가는 쪽에 서기 쉬운 경향이에요.",
    reason: "'친구들 눈에는'과 '들어 봤을 거예요'(주변 평가 단정, 과거 짐작)를 뺐다 (6-1).",
  },
  "first-overview.friends|image|wealth": {
    text: "관계에서는 막연한 고민을 현실적인 해결책으로 바꿔 주는 쪽에 서기 쉬운 경향이에요.",
    reason: "'친구들 눈에는', '사람으로 통해요'(주변 평가 단정)를 뺐다 (6-1).",
  },
  "first-overview.friends|image|authority": {
    text: "관계에서는 약속과 선을 지키는 믿음직한 쪽에 서기 쉬운 경향이에요. 다만 선을 지키는 만큼 가까워지는 데 시간이 걸릴 수 있어요.",
    reason: "'친구들 눈에는'과 '들었을 거예요'(주변 평가 단정, 과거 짐작)를 뺐다 (6-1).",
  },
  "first-overview.friends|image|resource": {
    text: "관계에서는 이야기를 들어 주고 받아 주는 상담자 같은 쪽에 서기 쉬운 경향이에요.",
    reason: "'친구들 눈에는'과 '늘 나였을 거예요'(주변 평가 단정, 과거 짐작)를 뺐다 (6-1).",
  },
  "first-overview.friends|fortune|helped": {
    text: "도움을 주는 사람과 이어지는 귀인 표지가 원국에 있어요. 막힐 때 도움을 청하면 길이 열리기 쉬운 구조로 읽는 보조 표지예요.",
    reason: "'손을 내밀어 준 경험, 한 번쯤 있었을 거예요'(과거 짐작)를 뺐다 (6-4, 04 문서 6절).",
  },
  "first-overview.friends|fortune|few": {
    text: "넓은 인맥보다 소수의 깊은 인연이 맞는 구조예요.",
    reason: "'느낀 적, 있었을 거예요'(과거 짐작)를 뺐다 (6-4, 04 문서 6절).",
  },
};

/** 어울리는 업종(jobs.industry): '같은 일을 해도 덜 지친다'는 연결을 빼고 업종 예시로만 쓴다 (3-1, 8-1). */
export function neutralIndustryText(useful: Element): string {
  return `업종 예시로는 ${withJosa(ELEMENT_INDUSTRY[useful], "을/를")} 꼽아요. 엔진이 계산한 용신 ${useful}(${ELEMENT_HANJA[useful]}) 기운의 전통 오행 대응으로 고른 예시예요.`;
}

/** 취업·창업 비교에서 무진이 쓰지 않는 기준. 강약으로 수입 변동을 견딜 능력을 판정하지 않는다 (3-3). */
export const EXCLUDED_COMPARE_CRITERIA = ["안정성과 변동성"] as const;

/** 무진의 3-3 비교 문장. 기준마다 맞는 쪽을 나란히 보여 주고 어느 길이 맞는지 결론 내리지 않는다. */
export const NEUTRAL_COMPARE_TEXT =
  "취업·프리랜서·사업 가운데 하나를 사주가 정해 주지는 않아요. 같은 기준을 나란히 두고 기준마다 어느 쪽 조건과 맞는지를 비교하고, 자금·경력·고객 같은 현실 조건은 따로 확인해요.";

export const NEUTRAL_COMPARE_OPTIONS: CompareDetail["options"] = ["취업(조직에 들어가는 길)", "프리랜서·사업(스스로 일을 꾸리는 길)"];

/**
 * 같은 원인(같은 계열의 비중)에서 나온 판단. 한 질문에 함께 들어가면 뒤의 판단에 '근거는 한 번만 설명한다'는 한계를 붙인다
 * (6-1 "공통 원인을 중복 설명하지 않는다"). 열쇠는 `${ruleId}|${key}`, 값은 변형 → 계열.
 */
export const SAME_CAUSE_FAMILY: Readonly<Record<string, (variant: string | undefined) => string | null>> = {
  "first-overview.temperament|core": (variant) => variant ?? null,
  "first-overview.career|style": (variant) => variant ?? null,
  "first-overview.jobs|family": (variant) => variant ?? null,
  "first-overview.friends|image": (variant) => variant ?? null,
  "first-overview.social|cooperation": (variant) => (variant === "crew" || variant === "few" ? "peer" : variant === "listener" ? "resource" : null),
};

/** 1위·2위 계열로 고르는 판단. 동률이면 이름순으로 한쪽만 고르게 되므로 무진은 조건부로 전한다. */
export const TOP_FAMILY_JUDGMENTS: readonly string[] = [
  "first-overview.temperament|core",
  "first-overview.career|style",
  "first-overview.jobs|family",
  "first-overview.friends|image",
];
export const SECOND_FAMILY_JUDGMENTS: readonly string[] = ["first-overview.temperament|mix"];

// ─── 질문별 주의와 일반 점검 ─────────────────────────────────────

/**
 * 판단 재료에 필요한 계산 자료. 하나라도 없고 재료도 없으면 그 질문은 unavailable이다.
 * 첫 상품의 원국 규칙은 모두 십성 계열 비율(families)이 있어야 판단하므로 모든 장 질문에 들어간다.
 * strength: 강약, pattern: 격국.
 */
export type DataNeed = "families" | "strength" | "pattern";

export interface QuestionGuide {
  readonly id: string;
  /** 02 문서 4~11절의 질문별 주의. 질문 note에 넣는다. */
  readonly cautions: readonly string[];
  /** 판단이 없을 때 쓰는 일반 점검 (사주 판단이 아니다). */
  readonly general: string;
  readonly needs: readonly DataNeed[];
}

const HEALTH_CAUTION = "강약·오행으로 체력·장기·질병·회복 속도를 판정하지 않는다.";

export const QUESTION_GUIDES: readonly QuestionGuide[] = [
  {
    id: "1-1",
    cautions: ["시주 미상 보류 조건(1·2위 차이 10%p 이내, 균형 분기의 25% 근처)을 지키고 보류는 결론으로 바꾸지 않는다."],
    general: "일반 점검: 최근 반복해서 고른 선택 몇 가지를 떠올려 보면 내가 중요하게 여기는 기준이 보인다.",
    needs: ["families"],
  },
  {
    id: "1-2",
    cautions: ["조합 판단이 없으면 억지로 이중성을 만들지 않는다."],
    general: "일반 점검: 중심 성향과 다르게 움직이는 순간이 언제인지 하나 적어 본다.",
    needs: ["families"],
  },
  {
    id: "1-3",
    cautions: ["강약을 체력 부족이나 경제적 손실을 견디는 능력으로 연결하지 않는다.", "반응은 조건이 붙은 행동으로 설명한다."],
    general: "일반 점검: 요구가 몰릴 때 먼저 하는 행동(미루기, 떠안기, 정면으로 부딪치기)을 하나 골라 본다.",
    needs: ["families", "strength"],
  },
  {
    id: "1-4",
    cautions: ["판단에 없는 약점을 새로 만들지 않는다. 약점은 경향 → 문제가 되는 조건 → 생길 수 있는 비용 → 조정 방법으로 쓴다."],
    general: "일반 점검: 강점이 지나치게 쓰였던 상황을 하나 떠올리고 그때 잃은 것을 적어 본다.",
    needs: ["families"],
  },
  {
    id: "2-1",
    cautions: ["실제 자격·경력·숙련도를 가졌다고 말하지 않는다.", "격국이 없으면 능력을 격국 근거로 확정하지 않는다."],
    general: "일반 점검: 남이 자주 부탁하거나 맡겨 온 일을 적어 보면 살릴 능력의 후보가 보인다.",
    needs: ["families", "pattern"],
  },
  {
    id: "2-2",
    cautions: ["계산된 표지(문창·학당·화개·장성)만 쓰고, 표지가 없다는 이유로 능력이 없다고 판단하지 않는다.", "신살은 보조 표지다."],
    general: "일반 점검: 능력이 잘 드러났던 장소·사람·시간의 공통점을 적어 본다. 표지가 없다고 능력이 없다는 뜻이 아니다.",
    needs: ["families"],
  },
  {
    id: "2-3",
    cautions: ["지능이나 고정된 학습 유형을 진단하지 않는다.", "연습 방법은 채택된 능력·환경에서 이은 연결이며 새 판단이 아니다."],
    general: "일반 점검: 배운 것을 직접 해 보는 연습과 남에게 설명하는 연습 가운데 어느 쪽이 오래 남았는지 비교해 본다.",
    needs: ["families"],
  },
  {
    id: "2-4",
    cautions: [
      "고른 능력의 약점을 먼저 쓴다. 가장 약한 계열의 보완 행동은 그 능력과 관련될 때만 보조로 쓴다.",
      "시각 미상에서 관측되지 않은 계열을 결핍으로 확정하지 않는다.",
    ],
    general: "일반 점검: 성과가 막혔던 때 무엇을 끝내지 못했는지 하나 적어 본다.",
    needs: ["families"],
  },
  {
    id: "3-1",
    cautions: ["직업과 업종은 활동 예시이며 성공이나 자격을 보장하지 않는다.", "업무 스타일 판단은 1위 계열이 25% 이상일 때만 있다."],
    general: "일반 점검: 지금까지 맡았던 역할 가운데 오래 할 수 있었던 일과 빨리 손을 놓은 일을 나눠 본다.",
    needs: ["families"],
  },
  {
    id: "3-2",
    cautions: ["조직형을 취업의 정답으로, 자율형을 창업의 정답으로 바꾸지 않는다."],
    general: "일반 점검: 정해진 절차가 있을 때와 스스로 정할 때 가운데 어느 쪽에서 일이 덜 밀렸는지 떠올려 본다.",
    needs: ["families"],
  },
  {
    id: "3-3",
    cautions: [
      "사주가 취업·프리랜서·사업 가운데 하나를 정해 주지 않는다.",
      "강약으로 수입 변동을 견딜 능력을 판정하지 않는다.",
      "자금·경험·고객은 사용자가 알려 준 정보가 있을 때만 쓴다.",
    ],
    general: "일반 점검: 취업·프리랜서·사업을 역할의 분명함, 재량의 크기, 함께 일할 사람, 결과물이 드러나는 방식으로 나란히 적어 본다.",
    needs: ["families"],
  },
  {
    id: "3-4",
    cautions: [
      "학생·취업 준비·재직·프리랜서·사업·휴식 어느 상황에도 쓸 수 있게 쓰고, 상황은 사용자가 고른 것만 쓴다.",
      "알 수 없는 현실 조건(자금, 경력, 일정)은 확인할 항목으로 남긴다.",
    ],
    general: "일반 점검: 지금 상황에서 한 달 안에 끝낼 수 있는 준비 하나를 정해 본다.",
    needs: ["families"],
  },
  {
    id: "4-1",
    cautions: ["재산 규모나 돈의 많고 적음을 말하지 않는다.", "시주 미상에서 관측되지 않은 재성으로 '돈보다 의미' 판단을 확정하지 않는다."],
    general: "일반 점검: 돈을 쓰거나 벌 때 가장 먼저 따지는 기준(의미, 결과물, 기회, 안정)을 하나 골라 본다.",
    needs: ["families"],
  },
  {
    id: "4-2",
    cautions: ["실제 지출 이력으로 단정하지 않는다."],
    general: "일반 점검: 예산을 넘긴 지출이 주로 어떤 상황에서 나왔는지 적어 본다.",
    needs: ["families"],
  },
  {
    id: "4-3",
    cautions: ["배신·사기·부채 발생으로 확장하지 않는다."],
    general: "일반 점검: 돈이 사람 관계와 얽힐 때(빌려주기, 함께 내기)의 내 기준을 미리 적어 본다.",
    needs: ["families"],
  },
  {
    id: "4-4",
    cautions: ["자산 종류·매매 시점·수익률을 추천하지 않고 돈을 관리하는 습관으로 설명한다."],
    general: "일반 점검: 지킬 수 있는 돈 관리 규칙 하나(예산, 기록, 비상금)를 정해 본다.",
    needs: ["families"],
  },
  {
    id: "5-1",
    cautions: ["인기나 연애 경험을 확정하지 않는다.", "함지·홍염 표지는 보조로만 쓴다."],
    general: "일반 점검: 호감을 말로 드러내는지 행동으로 드러내는지 떠올려 본다.",
    needs: ["families"],
  },
  {
    id: "5-2",
    cautions: ["실제 상대의 외모·직업·성격을 예언하지 않는다.", "상대 정보가 없으므로 두 사람의 궁합이라고 부르지 않는다."],
    general: "일반 점검: 편안했던 관계에 공통으로 있던 조건을 적어 본다.",
    needs: ["families"],
  },
  {
    id: "5-3",
    cautions: ["일지에 합과 충이 함께 있으면 둘 다 설명한다.", "합으로 충이 사라진다거나 충이 이별을 확정한다고 말하지 않는다."],
    general: "일반 점검: 가까워진 뒤 자주 부딪히는 주제를 하나 골라 미리 이야기해 본다.",
    needs: ["families"],
  },
  {
    id: "5-4",
    cautions: ["배우자·결혼 연도·자녀를 만들지 않는다.", "돈은 재물 판단이나 사용자 질문이 있을 때만 연결한다."],
    general: "일반 점검: 오래 함께할 사람과 미리 맞춰 둘 것(시간, 돈, 역할, 표현) 가운데 하나를 골라 본다.",
    needs: ["families"],
  },
  {
    id: "6-1",
    cautions: ["주변 사람들이 실제로 그렇게 평가했다고 쓰지 않는다.", "같은 근거에서 나온 판단은 근거를 한 번만 설명한다."],
    general: "일반 점검: 모임에서 내가 자주 맡는 역할을 하나 적어 본다.",
    needs: ["families"],
  },
  {
    id: "6-2",
    cautions: ["십성으로 특정 사람을 좋은 사람·나쁜 사람으로 나누지 않는다."],
    general: "일반 점검: 함께 일이 잘 풀렸던 사람과 역할을 어떻게 나눴는지 떠올려 본다.",
    needs: ["families"],
  },
  {
    id: "6-3",
    cautions: ["근거 없이 이용당하거나 해로운 관계가 있다고 만들지 않는다."],
    general: "일반 점검: 최근 받은 부탁 가운데 들어주기 어려웠던 것을 하나 떠올리고 그때 쓸 말을 정해 본다.",
    needs: ["families"],
  },
  {
    id: "6-4",
    cautions: [
      "본인의 용신·기신 오행으로 다른 사람의 좋고 나쁨을 판정하지 않는다.",
      "귀인의 외모·직업·만나는 날을 만들지 않는다. 귀인 표지는 보조로만 쓴다.",
    ],
    general: "일반 점검: 최근에 받은 도움과 준 도움을 하나씩 적어 본다.",
    needs: ["families"],
  },
  {
    id: "7-1",
    cautions: ["부모의 성격·성장 환경·간섭이 있었다고 추정하지 않는다.", "기존 가족사 짐작 문장을 쓰지 않는다.", "가족 구성을 가정하지 않는다."],
    general: "일반 점검: 가까운 사람의 기대 가운데 받아들일 것과 내가 정할 것을 나눠 적어 본다.",
    needs: ["families"],
  },
  {
    id: "7-2",
    cautions: ["실제 돌봄 대상은 사용자가 밝혔을 때만 쓴다.", "가족 관심 선택은 실제 사건이 아니다."],
    general: "일반 점검: 맡고 있는 책임 가운데 기간과 범위를 정해 둔 것이 있는지 확인해 본다.",
    needs: ["families"],
  },
  {
    id: "7-3",
    cautions: ["소득·주거 정보를 모르면 경제적 독립 가능성을 판정하지 않는다."],
    general: "일반 점검: 혼자 정할 일과 도움을 청할 일을 나눠 적어 본다.",
    needs: ["families"],
  },
  {
    id: "7-4",
    cautions: [
      "실제 갈등이나 가족의 속마음을 만들지 않는다.",
      "질문이 없으면 쟁점 하나만 점검한다. 가족 관심으로 고른 범주가 있으면 그 범주를 먼저, 없으면 목록의 첫 쟁점을 쓴다.",
    ],
    general: "일반 점검: 가까운 사람과 먼저 나눌 이야기를 시간·돈·역할·선택권 가운데 하나로 골라 본다.",
    needs: ["families"],
  },
  {
    id: "8-1",
    cautions: [HEALTH_CAUTION, "생활 리듬을 설명하는 장이며 건강 진단이 아니다."],
    general: "일반 점검: 일정이 과해졌던 주를 떠올리고 그때 더해진 일이 무엇이었는지 적어 본다.",
    needs: ["families"],
  },
  {
    id: "8-2",
    cautions: ["실제 수면·피로 정보가 없으면 증상이 있다고 말하지 않는다.", HEALTH_CAUTION],
    general: "일반 점검: 쉬는 시간을 미룬 이유를 하나 적어 본다.",
    needs: ["families"],
  },
  {
    id: "8-3",
    cautions: ["치료·약·건강식품을 권하지 않는다.", "일반 실천 제안과 사주 판단을 구분한다."],
    general: "일반 점검: 이번 주 일정에서 줄이거나 나눌 수 있는 일 하나를 골라 본다.",
    needs: ["families"],
  },
  {
    id: "8-4",
    cautions: ["개인화 근거가 없는 항목은 일반 점검이라고 구분한다."],
    general: "일반 점검: 이번 주 일정에 쉬는 시간을 먼저 넣었는지 확인해 본다.",
    needs: ["families"],
  },
];

/** 기초 분석의 질문별 주의. */
export const BASICS_CAUTIONS: Readonly<Record<string, readonly string[]>> = {
  P02: ["엔진이 계산하지 않은 격국·용신을 새로 고르지 않는다.", "강약을 체력이나 경제적 위험을 감수하는 능력으로 바꾸지 않는다.", "격국 이름은 엔진 표기(예: 편관격, 월겁격)를 쓴다."],
  P03: [
    "글자 수(단순 개수)와 세력 비율(가중 비율)을 구분하고 서로 더하지 않는다.",
    "같은 값으로 가장 큰 오행이 여럿이면 공동으로 설명한다.",
    "가장 적거나 없는 오행을 용신·결핍·질병으로 연결하지 않는다.",
  ],
  P04: [
    "원국 항목만 쓰고 대운·세운·월운 같은 기간 항목을 섞지 않는다.",
    "병·사·절을 질병·사망·불운으로 옮기지 않는다.",
    "단계의 전통적 의미만 설명하고 12운성 하나로 사건이나 길흉을 정하지 않는다.",
  ],
  P05: ["실제 가족사나 사건으로 확장하지 않는다.", "관측되지 않은 십성을 그 기질의 결핍으로 확정하지 않는다."],
};

// ─── 신규 연결 (의미 태그 → 질문) ───────────────────────────────

export interface LinkGroup {
  readonly id: string;
  readonly tags: readonly string[];
  readonly text: string;
}

export interface LinkSpec {
  readonly questionId: string;
  /** 부모로 쓸 수 있는 규칙. 없으면 무진 재료가 된 모든 원국 판단. */
  readonly sources?: readonly string[];
  /** 태그별 연결 문장. 태그는 카탈로그 순서로 고른다. */
  readonly links?: Readonly<Record<string, string>>;
  /** 태그를 묶음(대화 범주, 줄이는 방법)으로 합치는 질문. 묶음 순서대로 고른다. */
  readonly groups?: readonly LinkGroup[];
  /** 앞 질문에서 고른 원인(태그)만 쓰는 질문 (8-3, 8-4). */
  readonly fromQuestions?: readonly string[];
  /** 이 질문에 둘 연결 재료의 최대 개수. */
  readonly max: number;
  /** 연결 재료에 붙이는 한계. */
  readonly caveats: readonly string[];
}

const DERIVED_CAVEAT = "채택된 판단의 의미 태그에서 이은 설명 연결이며 새 사주 판단이나 계산 근거가 아니다.";
const SHINSAL_SUPPORT = "신살 표지는 보조 표지이며 능력을 단독으로 확정하지 않는다.";

export const LINK_SPECS: readonly LinkSpec[] = [
  {
    questionId: "2-3",
    sources: ["first-overview.strengths"],
    links: {
      "ability.eating-god": "반복 완성과 작은 변형 비교: 같은 과제를 끝까지 완성하는 반복을 기본으로 하되, 할 때마다 한 가지만 바꿔 보고 결과를 비교한다. 익숙한 방식에만 머무는 약점을 연습 안에서 조금씩 깬다.",
      "ability.hurting-officer": "문제·대안·내 역할 구분: 배우면서 찾은 허점을 '문제-대안-내가 할 수 있는 것' 순서로 정리하는 연습. 비판으로 들리는 마찰을 줄이고 개선 능력을 결과로 남긴다.",
      "ability.direct-wealth": "계획과 조정 여지: 학습 일정과 분량을 계획표로 관리하되 틀어져도 되는 여유 칸을 미리 넣어, 작은 오차에 매이지 않게 한다.",
      "ability.indirect-wealth": "작은 시도를 끝낸 뒤 다음 범위 결정: 배울 거리를 넓히기 전에 작은 단위 하나를 끝까지 마치고, 그 결과를 보고 다음 범위를 정한다.",
      "ability.direct-officer": "기준과 예외에서 자기 판단 설명: 정해진 기준을 익히는 데서 멈추지 않고, 기준이 맞지 않는 예외 사례에서 내 판단과 이유를 말이나 글로 설명해 보는 연습.",
      "ability.seven-killings": "긴급한 것과 일반 과제 구분: 마감 앞의 집중력을 쓰되, 모든 과제를 급한 일처럼 다루지 않도록 정말 급한 것과 꾸준히 할 것을 나눠 계획한다.",
      "ability.direct-resource": "설명 자료와 작은 실습 연결: 배운 것을 설명 자료로 정리하는 강점을 살리되, 준비가 길어지지 않게 자료 하나마다 바로 해 볼 작은 실습을 붙인다.",
      "ability.indirect-resource": "여러 관점을 결과물로 기록: 깊이 파고든 관점과 아이디어를 메모나 글 같은 결과물로 남겨, 완성 전에 관심이 옮겨 가도 쌓인 것이 보이게 한다.",
      "ability.month-prosperity": "자율 과제와 나눌 역할: 스스로 정한 과제로 시작하는 힘을 살리되, 혼자 다 하지 않도록 함께하거나 맡길 부분을 미리 정한다.",
      "ability.month-robbery": "자신의 과정과 목표 기록: 경쟁 속에서 붙는 추진력을 쓰되, 남과 비교하기보다 나의 이전 기록과 목표를 기준으로 진도를 확인한다.",
      "env.munchang": "기록·정리·설명: 배운 것을 글로 정리하거나 남에게 설명하는 방식으로 익히는 연결 (문창 표지).",
      "env.hakdang": "계속 배우는 환경: 단계가 있는 과정이나 꾸준히 배울 수 있는 환경을 고르는 연결 (학당 표지).",
      "env.hwagae": "혼자 몰입하는 시간: 조용히 혼자 파고드는 시간을 연습 일정에 따로 떼어 두는 연결 (화개 표지).",
      "env.jangseong": "역할이 주어진 연습: 스터디나 팀에서 맡은 역할이 분명할 때 연습이 이어지는 연결 (장성 표지).",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "지능이나 고정된 학습 유형을 진단하지 않는다.", SHINSAL_SUPPORT],
  },
  {
    questionId: "3-3",
    sources: ["first-overview.temperament", "first-overview.strengths", "first-overview.career"],
    links: {
      "role-clarity": "역할 명확성: 취업(조직)은 역할과 평가 기준이 정해진 자리인지, 프리랜서·사업은 계약과 제공 범위로 역할을 스스로 정해야 하는지를 비교 기준으로 둔다.",
      "autonomy-need": "자율성: 조직에서는 내가 정할 수 있는 재량이 어디까지인지, 프리랜서·사업에서는 재량이 큰 대신 일정과 품질의 책임도 혼자 지는지를 비교한다.",
      collaboration: "협업: 함께 일할 동료나 팀이 있는 구조(조직, 협업 프로젝트)와 혼자 운영하는 구조의 차이를 비교한다.",
      "output-expression": "성과 표현: 결과물이 내 이름으로 드러나는 방식(작업물, 납품물, 자기 상품)과 조직 안의 평가로 드러나는 방식을 비교한다.",
    },
    max: 4,
    caveats: [
      DERIVED_CAVEAT,
      "사주가 취업·프리랜서·사업 가운데 하나를 정해 주지 않는다.",
      "강약으로 수입 변동을 견딜 능력을 판정하지 않는다.",
      "자금·경력·고객 같은 현실 조건은 사용자가 알려 준 정보가 있을 때만 쓴다.",
    ],
  },
  {
    questionId: "3-4",
    sources: ["first-overview.strengths", "first-overview.career"],
    links: {
      "finish-delay": "준비의 끝 정하기: 준비가 길어지는 경향이 있어, 지금 하는 준비마다 '여기까지 하면 낸다'는 마감과 제출 단위를 먼저 정한다.",
      "over-expansion": "범위 줄이기: 벌여 둔 준비가 많으면 하나를 먼저 끝내고 다음 범위를 정한다.",
      "role-clarity": "역할과 기준 확인: 지원하거나 맡을 자리의 역할·평가 기준·마감을 먼저 확인한다.",
      "autonomy-need": "재량의 범위 확인: 지금 자리나 지원할 자리에서 내가 정할 수 있는 부분이 어디까지인지 확인한다.",
      "hidden-opinion": "내 판단을 말로 준비: 면접·회의·협의에서 내 판단과 이유를 한두 문장으로 미리 정리해 둔다.",
      "output-expression": "보여 줄 결과물: 한 일을 결과물 형태(정리한 작업물, 사례, 기록)로 모아 둔다.",
    },
    max: 3,
    caveats: [
      DERIVED_CAVEAT,
      "학생·취업 준비·재직·프리랜서·사업·휴식 등 상황은 사용자가 고른 것만 쓴다.",
      "알 수 없는 현실 조건(자금, 경력, 일정)은 확인할 항목으로 남긴다.",
    ],
  },
  {
    questionId: "5-4",
    sources: ["first-overview.temperament", "first-overview.romance", "first-overview.social", "first-overview.wealth"],
    links: {
      "autonomy-need": "각자 정할 영역: 각자 결정할 일과 함께 정할 일을 미리 나눠 두는 합의.",
      "role-clarity": "생활의 역할과 약속: 생활에서 맡을 역할과 약속의 기준을 분명히 정해 두는 합의.",
      "alone-time": "혼자 있는 시간: 혼자 쉬는 시간이 거리 두기로 오해받지 않도록 언제·얼마나 필요한지 말로 정해 두는 합의.",
      "expression-direct": "표현의 속도: 마음과 서운함을 바로 말하는 편이라, 감정이 올라온 순간과 결론을 말할 때를 나누는 합의.",
      "expression-reserved": "표현의 신호: 마음을 늦게 드러내는 편이라, 좋거나 서운할 때 보낼 분명한 신호를 정해 두는 합의.",
      "expression-adaptive": "내 쪽의 요청: 상대에 맞춰 표현을 조절하는 편이라, 내가 원하는 것을 먼저 한 문장으로 말하는 합의.",
      "relational-spending": "돈 쓰는 기준: 사람과 모임에 쓰는 돈의 기준을 함께 정해 두는 합의 (재물 판단에서 이은 연결).",
      "money-talk-avoid": "돈 이야기의 자리: 돈 이야기를 미루는 경향이 있어, 생활비·지출 기준을 정기적으로 말하는 합의 (재물 판단에서 이은 연결).",
    },
    max: 4,
    caveats: [DERIVED_CAVEAT, "배우자·결혼 연도·자녀를 만들지 않는다.", "관계 상태는 사용자가 고른 것만 쓴다."],
  },
  {
    questionId: "6-3",
    links: {
      "refusal-difficulty": "요청의 범위: 부탁을 받으면 바로 답하지 않고 확인할 시간을 둔 뒤, 들어줄 수 있는 범위를 말하는 경계.",
      "solo-solving": "도움을 청하는 기준: 혼자 해결하려는 경향이 있어, 막힌 지 얼마가 지나면 누구에게 공유할지 미리 정해 두는 경계.",
      "responsibility-burden": "역할의 범위: 함께하는 일에서 내 몫과 남의 몫을 먼저 나눠 말하고, 남의 몫까지 떠안지 않는 경계.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "근거 없이 이용당하거나 해로운 관계가 있다고 말하지 않는다.", "특정 사람을 좋은 사람·나쁜 사람으로 나누지 않는다."],
  },
  {
    questionId: "6-4",
    sources: ["first-overview.temperament", "first-overview.strengths", "first-overview.social", "first-overview.friends"],
    links: {
      "solo-solving": "도움 받기: 혼자 해결하려는 경향이 있어, 도움을 청할 때 무엇을 언제까지 부탁할지 구체적으로 말하는 방식.",
      collaboration: "함께 하기: 비슷한 사람들과 함께할 때 힘이 나는 편이라, 정기적인 모임이나 협업 안에서 서로 돕는 방식.",
      "responsibility-burden": "주고받는 균형: 맡아 주는 쪽에 서기 쉬워, 도와준 만큼 나도 요청할 수 있게 균형을 정하는 방식.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "본인의 용신·기신 오행으로 다른 사람의 좋고 나쁨을 판정하지 않는다.", "귀인의 외모·직업·만나는 날을 만들지 않는다."],
  },
  {
    questionId: "7-1",
    links: {
      "refusal-difficulty": "기대를 거절하는 말: 요청을 거절하기 어려운 경향이 있어, 다 들어주기 전에 할 수 있는 것과 어려운 것을 나눠 말하는 연결.",
      "autonomy-need": "내 선택의 영역: 스스로 납득해야 움직이는 경향이 있어, 가까운 사람의 기대 가운데 받아들일 것과 내가 정할 것을 나눠 보는 연결.",
      "role-clarity": "기대의 기준 확인: 역할과 기준이 분명할 때 편한 경향이 있어, 상대가 기대하는 것이 무엇인지 말로 확인해 보는 연결.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "부모의 성격·성장 환경·간섭이 있었다고 추정하지 않는다.", "가족 구성(부모·형제·배우자·자녀)을 가정하지 않는다."],
  },
  {
    questionId: "7-2",
    links: {
      "refusal-difficulty": "추가 부탁의 기준: 거절이 어려운 경향이 있어, 이미 맡은 일이 있을 때 새 부탁을 받는 기준을 정해 두는 연결.",
      "solo-solving": "나눠 맡기: 혼자 해결하려는 경향이 있어, 맡은 일을 다른 사람과 나누는 방법을 미리 정해 두는 연결.",
      "responsibility-burden": "맡을 책임의 범위: 책임을 떠안는 경향이 있어, 돌봄이나 집안일을 맡을 때 내 몫의 범위와 기간을 먼저 정하는 연결.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "실제 돌봄 대상(아픈 가족·자녀 등)은 사용자가 밝혔을 때만 쓴다.", "가족 관심 선택은 실제 사건이 아니다."],
  },
  {
    questionId: "7-3",
    links: {
      "refusal-difficulty": "경계 설정: 거절이 어려운 경향이 있어, 도움을 주고받을 때도 내가 할 수 있는 범위를 먼저 말하는 연결.",
      "solo-solving": "도움 요청: 혼자 해결하려는 경향이 있어, 독립과 도움받기가 반대가 아니라는 점에서 필요한 도움을 구체적으로 청하는 연결.",
      "autonomy-need": "선택권: 스스로 정하고 싶은 경향이 있어, 생활의 어떤 부분을 내가 결정할지 분명히 하는 연결.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "소득·주거 정보를 모르면 경제적 독립 가능성을 판정하지 않는다.", "실제 독립 예정이나 가족 불화를 가정하지 않는다."],
  },
  {
    questionId: "7-4",
    groups: [
      { id: "time", tags: ["alone-time"], text: "시간에 관한 대화: 혼자 보내는 시간과 함께하는 시간을 어떻게 나눌지 먼저 이야기해 본다." },
      { id: "money", tags: ["relational-spending", "money-talk-avoid"], text: "돈에 관한 대화: 지원이나 지출을 주고받는 기준을 먼저 이야기해 본다." },
      {
        id: "role",
        tags: ["refusal-difficulty", "solo-solving", "responsibility-burden", "role-clarity"],
        text: "역할에 관한 대화: 각자 맡는 일과 들어줄 수 있는 부탁의 범위를 먼저 이야기해 본다.",
      },
      { id: "choice", tags: ["autonomy-need"], text: "선택권에 관한 대화: 내가 정할 일과 함께 정할 일을 먼저 이야기해 본다." },
    ],
    max: 4,
    caveats: [DERIVED_CAVEAT, "실제 갈등이나 가족의 속마음을 만들지 않는다."],
  },
  {
    questionId: "8-1",
    links: {
      "refusal-difficulty": "부탁이 겹칠 때: 거절하지 못한 부탁이 쌓이면 일정이 과해지는 조건.",
      "responsibility-burden": "책임을 떠안을 때: 맡은 일 위에 남의 몫까지 얹으면 일정이 과해지는 조건.",
      "finish-delay": "끝을 미룰 때: 준비나 마무리를 끝내지 못하고 붙잡고 있으면 일정이 밀려 쌓이는 조건.",
      "over-expansion": "일을 넓힐 때: 새 기회나 일을 계속 더하면 일정이 과해지는 조건.",
      "all-urgent": "모든 일을 급하게 다룰 때: 급한 일과 일반 과제를 구분하지 않으면 늘 바쁜 상태가 이어지는 조건.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, HEALTH_CAUTION, "실제 수면·피로·증상 정보가 없으면 증상이 있다고 말하지 않는다."],
  },
  {
    questionId: "8-2",
    links: {
      "refusal-difficulty": "추가 요청: 쉬려던 시간에 들어온 부탁을 받아 주며 쉬는 시간을 미루기 쉬워, 새 요청은 다음 일정으로 넘기는 말을 준비한다.",
      "solo-solving": "분담: 혼자 끝내려다 쉬는 시간을 미루기 쉬워, 나눌 수 있는 일을 먼저 떼어 낸다.",
      "finish-delay": "종료 기준: '조금만 더' 하다가 쉬는 시간을 미루기 쉬워, 오늘 끝낼 기준을 먼저 정한다.",
    },
    max: 3,
    caveats: [DERIVED_CAVEAT, "실제 수면·피로 정보가 없으면 증상이 있다고 말하지 않는다.", HEALTH_CAUTION],
  },
  {
    questionId: "8-3",
    fromQuestions: ["8-1", "8-2"],
    groups: [
      { id: "scope", tags: ["refusal-difficulty", "over-expansion"], text: "범위 협의: 받은 요청이나 새로 더한 일의 범위·기한을 다시 협의해, 이번에 하지 않을 것을 정한다." },
      { id: "finish", tags: ["finish-delay"], text: "종료 기준: 끝낼 기준을 정해 붙잡고 있던 일을 닫는다." },
      { id: "share", tags: ["responsibility-burden", "solo-solving"], text: "역할 분담: 맡은 일 가운데 다른 사람에게 넘기거나 함께할 몫을 떼어 낸다." },
      { id: "priority", tags: ["all-urgent"], text: "우선순위: 정말 급한 일과 미뤄도 되는 일을 나눠 한 번에 하는 일을 줄인다." },
    ],
    max: 4,
    caveats: [DERIVED_CAVEAT, "치료·약·건강식품을 권하지 않는다.", "일반 실천 제안이며 사주 판단과 구분한다."],
  },
  {
    questionId: "8-4",
    fromQuestions: ["8-1", "8-2"],
    links: {
      "refusal-difficulty": "점검 질문: 이번 주에 거절하거나 미룬 부탁이 있는가?",
      "solo-solving": "점검 질문: 혼자 붙잡고 있는 일 가운데 나눌 수 있는 것이 있는가?",
      "responsibility-burden": "점검 질문: 남의 몫까지 맡은 일이 있는가?",
      "finish-delay": "점검 질문: 오늘 끝낼 기준을 정했는가?",
      "over-expansion": "점검 질문: 새로 더한 일만큼 줄인 일이 있는가?",
      "all-urgent": "점검 질문: 이번 주 일정 가운데 정말 급한 것은 무엇인가?",
    },
    max: 4,
    caveats: [DERIVED_CAVEAT, "개인화 근거가 있는 점검 질문이며, 근거가 없는 항목은 일반 점검으로 구분한다."],
  },
];

/** 같은 판단에서 상반된 경향이 함께 나올 때(같은 조건) 혼합으로 남기는 한계. */
export const MIXED_CAVEAT = "같은 판단 안에 상반된 두 경향이 함께 있어 한쪽으로 정하지 않고 혼합으로 설명한다.";
/** 다른 판단에서 상반된 경향이 나올 때(다른 조건) 조건별로 설명하는 한계. */
export const SPLIT_CAVEAT = "다른 판단에서 나온 상반된 경향이라, 어느 판단의 조건에서 나오는지 나눠 설명한다.";

export function linkSpec(questionId: string): LinkSpec | undefined {
  return LINK_SPECS.find((spec) => spec.questionId === questionId);
}

export function questionGuide(questionId: string): QuestionGuide | undefined {
  return QUESTION_GUIDES.find((guide) => guide.id === questionId);
}
