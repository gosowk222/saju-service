/**
 * 무진 작성 계획의 개인화. 진짜 궁금한 점에서 정리한 범위 안 질문과 사용자 사실, '지금의 나'의 관심 주제를
 * 장별 계획에 붙인다. 규칙 설명: docs/rules/mujin-overview.md 11절
 *
 * - 설명 우선순위: 실제 자유 질문 → 관심 주제 → 관련 상황 → 기본 설명.
 * - 바꾸는 것: 장의 설명 비중(weight)과 편집 목표(targetChars), 질문·사실 재료와 그 연결(refs).
 * - 바꾸지 않는 것: 판단 상태(status), 기존 재료의 문장·근거. 관심은 설명 비중만 바꾸고 판단 강도를 바꾸지 않는다.
 * - 질문은 사용자 사실(user-fact)이 아니라 질문 재료(MujinQuestionMaterial)다. 계획·가정을 현재 사실로 올리지 않는다.
 *
 * 9·10장 작성 계획(timing-plan.ts)이 이 파일의 연결표를 함께 쓴다. 이 파일은 timing-plan.ts를 가져오지 않는다(순환 방지).
 */
import type { InquiryDomain, ProductBase, QuestionDomain, QuestionIntent, ScrollProductDefinition } from "../products/types";
import { QUESTION_DOMAINS } from "../reading/question";
import { FAMILIES, type Family } from "../rules/materials";
import { NOW_LIMITS, RELATIONSHIP_OPTIONS, WORK_OPTIONS, type MujinNow } from "./now";
import type { MonthDomain, MujinMaterial, MujinQuestionPlan, MujinSectionPlan, SectionWeight, UserFactKind } from "./types";

/** 연결표와 비중 기준의 버전. 표를 바꾸면 올린다. */
export const MUJIN_PERSONALIZE_VERSION = "mujin-personalize-1.0.0";

/** 생성 입력으로 넘기는 범위 안 질문 하나. 질문 분류(question-analysis) 결과를 서버가 검증한 값이다. */
export interface MujinQuestionInput {
  /** 질문 ref (예: q1). 재료 ref(m…)와 겹치지 않아야 한다. */
  readonly ref: string;
  /** 서버가 정리한 질문 문장. 사용자 원문 전체가 아니다. */
  readonly summary: string;
  readonly domain: QuestionDomain;
  readonly topicDomain: InquiryDomain | null;
  readonly intent: QuestionIntent;
  readonly answerability: "full" | "limited";
  readonly missingInfo: readonly string[];
  readonly timingSupported: boolean;
}

/** 진짜 궁금한 점에서 정리한 사용자 사실 하나. kind로 현재·과거·계획·가정·타인에 대한 관찰을 구분한다. */
export interface MujinConcernFact {
  readonly text: string;
  readonly domain: string;
  readonly kind: UserFactKind;
}

/**
 * 질문 재료. 사용자 사실(user-fact)과 섞이지 않도록 MujinMaterial과 다른 형식으로 둔다
 * (MaterialKind에는 질문 종류가 없다). ref는 질문 ref 그대로이며, 장의 소질문 refs가 이 ref를 가리킨다.
 */
export interface MujinQuestionMaterial {
  readonly ref: string;
  readonly kind: "question";
  readonly summary: string;
  readonly domain: QuestionDomain;
  readonly topicDomain: InquiryDomain | null;
  readonly intent: QuestionIntent;
  readonly answerability: "full" | "limited";
  readonly missingInfo: readonly string[];
  readonly timingSupported: boolean;
  /** 이 질문을 이은 장 (이번 계획에 있는 장만). 비어 있으면 마지막 정리에서만 답한다. 마지막 정리는 모든 질문을 모은다. */
  readonly sectionIds: readonly string[];
  /** 장 안에서 이 질문을 붙인 소질문 ID (예: 3-3, 10-4). */
  readonly chapterQuestionIds: readonly string[];
  /** 이 질문에 답할 때 지킬 작성 조건 (결과 확정 불가, 기간 규칙 없음, 확인할 정보 등). */
  readonly notes: readonly string[];
}

// ─── 연결표 ───────────────────────────────────────────────────────────────

/** 10장 월운 분야. 재사용하는 기간 판단 규칙(first-overview.timing)의 네 분야와 같다. 건강·가족 월운은 없다. */
export const MONTH_DOMAINS: readonly MonthDomain[] = ["career", "wealth", "romance", "social"];
export const MONTH_DOMAIN_LABEL: Readonly<Record<MonthDomain, string>> = { career: "직업", wealth: "재물", romance: "연애", social: "인간관계" };

/** 질문 분야가 바로 이어지는 장. 건강은 8장(생활 리듬), 투자는 4장(돈 관리 습관), 학업은 2장(배우는 방식)으로 답한다. */
const DOMAIN_CHAPTER: Readonly<Partial<Record<QuestionDomain, string>>> = {
  temperament: "ch1",
  strengths: "ch2",
  study: "ch2",
  career: "ch3",
  wealth: "ch4",
  investment: "ch4",
  romance: "ch5",
  social: "ch6",
  friends: "ch6",
  family: "ch7",
  health: "ch8",
};

/** 시기 질문을 10장 월운 분야로 읽는 질문 분야. 투자는 재물 월운, 친구는 인간관계 월운으로 본다. */
const TIMING_MONTH_DOMAIN: Readonly<Partial<Record<QuestionDomain, MonthDomain>>> = {
  career: "career",
  wealth: "wealth",
  investment: "wealth",
  romance: "romance",
  social: "social",
  friends: "social",
};

type QuestionRoute = Pick<MujinQuestionInput, "domain" | "topicDomain" | "intent">;

function homeChapter(question: Pick<MujinQuestionInput, "domain" | "topicDomain">): string | null {
  return DOMAIN_CHAPTER[question.domain] ?? (question.topicDomain ? (DOMAIN_CHAPTER[question.topicDomain] ?? null) : null);
}

/** 시기 질문이 10장의 어느 월운 분야에 닿는지. 네 분야가 아니면 null. */
export function monthDomainOfQuestion(question: Pick<MujinQuestionInput, "domain" | "topicDomain">): MonthDomain | null {
  return TIMING_MONTH_DOMAIN[question.domain] ?? (question.topicDomain ? (TIMING_MONTH_DOMAIN[question.topicDomain] ?? null) : null);
}

/**
 * 질문이 연결될 장 ID (결정적 순수 함수). 마지막 정리는 모든 질문을 모으므로 여기에 넣지 않는다.
 * - 분야의 장: 성향 1장, 강점·학업 2장, 직업 3장, 재물·투자 4장, 연애 5장, 인간관계·친구 6장, 가족 7장, 건강 8장.
 * - 시기 질문(intent timing): 기간 규칙 4분야(직업·재물·연애·인간관계, 투자는 재물·친구는 인간관계로)는 10장을 더하고,
 *   그 밖의 분야는 9장(대운의 큰 흐름)을 더한다. general 분야의 시기 질문('몇 년 뒤', '인생 흐름', '전환점'처럼
 *   분류만으로 기간을 알 수 없는 질문)은 9장과 10장을 함께 잇는다.
 * - general 분야의 시기가 아닌 질문은 관련 장 없이 마지막 정리에서만 답한다.
 */
export function chaptersForQuestion(question: QuestionRoute): readonly string[] {
  const home = homeChapter(question);
  const chapters = home ? [home] : [];
  if (question.intent !== "timing") return chapters;
  if (question.domain === "general") return [...chapters, "ch9", "ch10"];
  if (monthDomainOfQuestion(question)) return [...chapters, "ch10"];
  return home ? [...chapters, "ch9"] : chapters;
}

/** 장 안에서 질문·사실을 붙일 소질문. base: 설명·넓은 질문, apply: 적용·결과·시기 질문과 사용자 사실, compare: 비교 질문. */
interface ChapterFocus {
  readonly base: string;
  readonly apply: string;
  readonly compare?: string;
}

const CHAPTER_FOCUS: Readonly<Record<string, ChapterFocus>> = {
  ch1: { base: "1-2", apply: "1-3" },
  ch2: { base: "2-1", apply: "2-3" },
  ch3: { base: "3-1", apply: "3-4", compare: "3-3" },
  ch4: { base: "4-1", apply: "4-4" },
  ch5: { base: "5-2", apply: "5-3" },
  ch6: { base: "6-1", apply: "6-3", compare: "6-2" },
  ch7: { base: "7-1", apply: "7-4" },
  ch8: { base: "8-1", apply: "8-3" },
  ch9: { base: "9-4", apply: "9-4" },
  ch10: { base: "10-4", apply: "10-4" },
};

/** 같은 장에서도 분야에 더 맞는 소질문 (친구·인복 6-4, 시험 준비 2-3·2-4, 투자 4-4, 건강 8-4·8-3). */
const DOMAIN_FOCUS: Readonly<Partial<Record<QuestionDomain, ChapterFocus>>> = {
  friends: { base: "6-4", apply: "6-4" },
  study: { base: "2-3", apply: "2-4" },
  investment: { base: "4-4", apply: "4-4" },
  health: { base: "8-4", apply: "8-3" },
};

/** 소질문 하나를 고른다. 계획에 그 소질문이 없으면 장의 첫 소질문을 쓴다. */
function focusQuestionId(section: MujinSectionPlan, domain: QuestionDomain, intent: QuestionIntent | "fact"): string | null {
  const focus = (DOMAIN_CHAPTER[domain] === section.sectionId ? DOMAIN_FOCUS[domain] : undefined) ?? CHAPTER_FOCUS[section.sectionId];
  const wanted = !focus
    ? undefined
    : intent === "compare"
      ? (focus.compare ?? focus.base)
      : intent === "explain" || intent === "general"
        ? focus.base
        : focus.apply;
  const ids = section.questions.map((question) => question.id);
  if (wanted && ids.includes(wanted)) return wanted;
  return ids[0] ?? null;
}

/** 소질문 ID(예: 3-2)가 속한 장 ID(ch3). */
export function chapterOfQuestionId(questionId: string): string | null {
  const match = /^(\d+)-\d+$/.exec(questionId);
  return match ? `ch${match[1]}` : null;
}

/**
 * 대운 활동 주제(대운 천간 십성 계열)와 닿는 원국 질문 (우선순위 순). 9-4가 원국의 채택 강점·약점과
 * 사용자 사실을 잇는 기준이다. 서비스 편집 기준이며 사람 검토를 받지 않았다 (mujin-overview.luck-theme).
 */
export const LUCK_THEME_LINKS: Readonly<Record<Family, readonly string[]>> = {
  peer: ["3-2", "6-2", "6-1", "4-3"],
  output: ["2-1", "2-2", "3-1", "5-1"],
  wealth: ["4-1", "4-2", "4-4", "4-3"],
  authority: ["3-1", "3-2", "7-2", "1-3"],
  resource: ["2-3", "2-4", "6-4", "7-3"],
};

/**
 * 대운 활동 주제와 닿는 의미 태그 (src/domain/mujin/tags.ts 카탈로그의 ID, 우선순위 순). 질문으로 고른 판단 다음에
 * 이 태그가 붙은 채택 판단을 잇는다. 태그는 규칙 작성자가 채택 판단에 붙인 것이며 문장에서 찾은 단어가 아니다.
 */
export const LUCK_THEME_TAGS: Readonly<Record<Family, readonly string[]>> = {
  peer: ["autonomy-need", "collaboration", "over-comparison", "ability.month-prosperity", "ability.month-robbery"],
  output: ["output-expression", "ability.eating-god", "ability.hurting-officer"],
  wealth: ["over-expansion", "relational-spending", "money-talk-avoid", "ability.direct-wealth", "ability.indirect-wealth"],
  authority: ["role-clarity", "responsibility-burden", "refusal-difficulty", "all-urgent", "hidden-opinion", "ability.direct-officer", "ability.seven-killings", "env.jangseong"],
  resource: ["finish-delay", "solo-solving", "ability.direct-resource", "ability.indirect-resource", "env.munchang", "env.hakdang"],
};

/** 10-4: 월운 분야의 기간 활동을 이을 원국 장과 질문 (우선순위 순). 질문 활동이 같은 분야일 때만 쓴다. */
export const MONTH_DOMAIN_NATAL: Readonly<Record<MonthDomain, { readonly sectionId: string; readonly questionIds: readonly string[] }>> = {
  career: { sectionId: "ch3", questionIds: ["3-1", "3-4", "3-2"] },
  wealth: { sectionId: "ch4", questionIds: ["4-4", "4-2", "4-1"] },
  romance: { sectionId: "ch5", questionIds: ["5-1", "5-2", "5-3"] },
  social: { sectionId: "ch6", questionIds: ["6-2", "6-3", "6-1"] },
};

// 9·10장 재료의 variant. 규칙이 고른 변형(대운 계열, 월운 분야)이며, 개인화가 이 값으로 재료를 찾는다.
const LUCK_THEME_VARIANT = "luck-theme:";
const MONTH_ACTIVITY_VARIANT = "month-activity:";
export const luckThemeVariant = (family: Family) => `${LUCK_THEME_VARIANT}${family}`;
export const monthActivityVariant = (domain: MonthDomain) => `${MONTH_ACTIVITY_VARIANT}${domain}`;

export function luckThemeOf(material: Pick<MujinMaterial, "variant">): Family | null {
  const value = material.variant?.startsWith(LUCK_THEME_VARIANT) ? material.variant.slice(LUCK_THEME_VARIANT.length) : null;
  return value && (FAMILIES as readonly string[]).includes(value) ? (value as Family) : null;
}

export function monthActivityOf(material: Pick<MujinMaterial, "variant">): MonthDomain | null {
  const value = material.variant?.startsWith(MONTH_ACTIVITY_VARIANT) ? material.variant.slice(MONTH_ACTIVITY_VARIANT.length) : null;
  return value && (MONTH_DOMAINS as readonly string[]).includes(value) ? (value as MonthDomain) : null;
}

/**
 * 원국 장의 채택 판단(엔진 결론 candidate이며 강점이나 약점이 있는 것)을 최대 max개 고른다. 질문 우선순위로 먼저 고르고,
 * 남으면 의미 태그 우선순위로 고른다. 같은 결론은 한 번만 쓴다(같은 원인 중복 집계 방지).
 * 9-4와 10-4가 원국 판단과 이을 재료를 고를 때 쓴다.
 */
export function adoptedJudgments(
  sections: readonly MujinSectionPlan[],
  questionIds: readonly string[],
  max: number,
  tags: readonly string[] = [],
): MujinMaterial[] {
  const picked: MujinMaterial[] = [];
  const seen = new Set<string>();
  const usable = (material: MujinMaterial) =>
    material.kind === "judgment" && material.scope === "natal" && material.status === "candidate" && Boolean(material.upside || material.weakness);
  const take = (matches: (material: MujinMaterial) => boolean) => {
    for (const section of sections) {
      for (const material of section.materials) {
        if (picked.length >= max) return;
        if (!usable(material) || !matches(material)) continue;
        const key = material.conclusionId ?? material.ref;
        if (seen.has(key) || seen.has(material.ref)) continue;
        seen.add(key);
        seen.add(material.ref);
        picked.push(material);
      }
    }
  };
  for (const questionId of questionIds) take((material) => material.questionIds.includes(questionId));
  for (const tag of tags) take((material) => material.tags?.includes(tag) ?? false);
  return picked;
}

/** 원국 판단과 기간 활동을 잇는 설명 연결(derived)의 공통 조건. */
export const LINK_CAVEATS: readonly string[] = [
  "원국 판단과 기간의 활동을 잇는 설명 연결이며 새 판단이 아니다.",
  "원국 판단 자체는 해당 장에서 설명하므로 여기서는 기간과 잇는 부분만 짧게 쓴다.",
  "이 기간에 그 강점·약점이 반드시 드러난다는 뜻이 아니다.",
];

// ─── 공통 도우미 ─────────────────────────────────────────────────────────

/** 작성용 참조 번호표. 계획 안에서 고유한 m1, m2 … 를 이어서 낸다. */
export function refCounter(startRef: number) {
  if (!Number.isInteger(startRef) || startRef < 1) throw new Error(`startRef must be a positive integer: ${startRef}`);
  let next = startRef;
  return {
    take: (): string => `m${next++}`,
    get next(): number {
      return next;
    },
  };
}

export const uniqueList = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** 상품 범위 안의 질문 분야인지. general은 항상 범위 안이다. */
export function inProductScope(product: Pick<ProductBase, "scope">, domain: QuestionDomain): boolean {
  return domain === "general" || (product.scope.domains as readonly string[]).includes(domain);
}

function asQuestionDomain(value: string): QuestionDomain {
  return (QUESTION_DOMAINS as readonly string[]).includes(value) ? (value as QuestionDomain) : "general";
}

const TARGET_STRETCH: Readonly<Record<SectionWeight, { readonly floor: number; readonly ceiling: number }>> = {
  question: { floor: 0.5, ceiling: 0.2 },
  interest: { floor: 0.25, ceiling: 0.1 },
  standard: { floor: 0, ceiling: 0 },
};

/**
 * 비중을 반영한 편집 목표. 질문 장은 하한을 범위의 절반만큼, 상한을 20%까지, 관심 장은 하한 25%·상한 10%까지 올린다.
 * 다른 장은 줄이지 않는다. 강제 최소 글자 수가 아니며, 글이 없는 칸(원국표)은 그대로 둔다.
 */
export function weightedTarget(base: { readonly min: number; readonly max: number }, weight: SectionWeight): { readonly min: number; readonly max: number } {
  if (base.max <= 0) return { min: base.min, max: base.max };
  const { floor, ceiling } = TARGET_STRETCH[weight];
  return { min: base.min + Math.round((base.max - base.min) * floor), max: Math.round(base.max * (1 + ceiling)) };
}

// ─── 작성 조건 문장 ──────────────────────────────────────────────────────

const NOTE = {
  closingOnly: "특정 장과 바로 이어지지 않는 넓은 질문이라 마지막 정리에서 앞 장의 답을 모아 답한다.",
  outcome: "사건 결과(합격·결혼·재회·수익 등)나 다른 사람의 마음을 확정하지 않고, 판단할 수 있는 성향·조건·활동 구간만 답한다.",
  health: "진단·병명·치료 없이 기운을 쓰는 생활 리듬과 일정 조절로만 답한다.",
  investment: "특정 종목·사고팔 시점·수익률 대신 돈을 움직이는 습관과 관리 방식으로 답한다.",
  study: "합격 여부 대신 배우고 준비하는 방식과 조건으로 답한다.",
  compare: "선택지 중 정답을 정하지 않고 각 선택에 맞는 조건과 확인할 점을 비교한다. 자금·경험·고객처럼 사용자가 말하지 않은 조건은 확인할 항목으로 남긴다.",
  timingFlow: "큰 흐름은 9장의 대운 구간, 가까운 시기는 10장의 실제 분석 기간(12개월) 안에서만 답한다. 날짜를 새로 만들지 않고 사건이 생기는 날로 바꾸지 않는다.",
  timingLuck: "시기를 묻지만 이 분야는 월별 판단 규칙이 없어 날짜·달을 고르지 않는다. 대운의 큰 흐름(9장)과 원국 성향으로 답한다.",
} as const;

const timingMonthNote = (domain: MonthDomain) =>
  `앞으로 12개월(10장)의 실제 분석 기간 안에서 ${MONTH_DOMAIN_LABEL[domain]} 분야의 주목·주의 구간과 활동으로만 답한다. 그 밖의 날짜를 만들지 않고, 활동 구간을 취업·합격·만남이 정해진 날로 바꾸지 않는다.`;

const STATUS_NOTE: Readonly<Partial<Record<MujinQuestionPlan["status"], string>>> = {
  general: "채택 판단이 없어, 사주 판단이 아닌 일반 상황 제안으로 구분해 답한다.",
  deferred: "판단이 보류되어 있어 단정하지 않고 보류 이유를 함께 말한다.",
  unavailable: "계산 자료가 없어 그 한계를 말하고 판단을 만들지 않는다.",
};

const FACT_NOTE: Readonly<Record<UserFactKind, string>> = {
  current: "사용자가 직접 말한 지금의 사실이다.",
  past: "사용자가 직접 말한 지난 일이다. 지금도 그렇다고 단정하지 않는다.",
  plan: "사용자의 계획·희망이며 아직 일어난 사실이 아니다. 현재 사실처럼 쓰지 않는다.",
  hypothetical: "사용자가 가정해 본 상황이며 사실이 아니다. 현재 사실처럼 쓰지 않는다.",
  "about-others": "사용자가 다른 사람에 대해 관찰하거나 걱정한 내용이다. 그 사람의 속마음이나 사정을 아는 사실처럼 쓰지 않는다.",
};
const FACT_SOURCE_NOTE = "사용자가 직접 알려 준 내용이며 사주로 계산한 사실이 아니다. 사주를 이유로 부정하지 않는다.";

function questionNotes(question: MujinQuestionInput, chapters: readonly string[], links: readonly FocusLink[], present: ReadonlyMap<string, MujinSectionPlan>): string[] {
  const notes: string[] = [];
  if (!chapters.length) notes.push(NOTE.closingOnly);
  if (question.domain === "health") notes.push(NOTE.health);
  else if (question.answerability === "limited" || question.intent === "outcome") notes.push(NOTE.outcome);
  if (question.domain === "investment") notes.push(NOTE.investment);
  if (question.domain === "study") notes.push(NOTE.study);
  if (question.intent === "compare") notes.push(NOTE.compare);
  if (question.intent === "timing") {
    const monthDomain = monthDomainOfQuestion(question);
    if (question.domain === "general") notes.push(NOTE.timingFlow);
    else if (monthDomain) notes.push(timingMonthNote(monthDomain));
    else if (chapters.includes("ch9")) notes.push(NOTE.timingLuck);
  }
  if (question.missingInfo.length) {
    notes.push(`사주로 알 수 없어 확인해야 할 정보: ${question.missingInfo.join(", ")}. 모르는 조건을 사실처럼 채우지 않는다.`);
  }
  for (const link of links) {
    const status = present.get(link.sectionId)?.questions.find((entry) => entry.id === link.questionId)?.status;
    const note = status ? STATUS_NOTE[status] : undefined;
    if (note) notes.push(`${link.questionId}: ${note}`);
  }
  return uniqueList(notes);
}

/** '지금의 나'에서 같은 영역을 고른 항목. 사용자 사실과 시간 구분 없이 충돌할 수 있는 부분을 알린다. */
function selectionOverlap(domain: QuestionDomain, now: MujinNow): string | null {
  if (domain === "career" || domain === "study") {
    const labels = now.work.flatMap((id): string[] => {
      const label = WORK_OPTIONS.find((option) => option.id === id)?.label;
      return label ? [label] : [];
    });
    return labels.length ? labels.join(", ") : null;
  }
  if (domain === "romance" && now.relationship !== null && now.relationship !== "private") {
    return RELATIONSHIP_OPTIONS.find((option) => option.id === now.relationship)?.label ?? null;
  }
  return null;
}

function factCaveats(kind: UserFactKind, domain: QuestionDomain, now: MujinNow): string[] {
  const caveats = [FACT_NOTE[kind], FACT_SOURCE_NOTE];
  const overlap = kind === "current" || kind === "past" ? selectionOverlap(domain, now) : null;
  if (overlap) {
    caveats.push(
      `'지금의 나'에서 고른 항목(${overlap})과 같은 영역의 사실이다. 이 사실이 최근 변화(예: 최근 퇴사)를 분명히 말하면 이 최근 사실을 지금 상황으로 쓰고, 시간 구분 없이 서로 맞지 않으면 맞지 않는 부분만 단정하지 않고 중립으로 다룬다.`,
    );
  }
  return caveats;
}

// ─── 개인화 ──────────────────────────────────────────────────────────────

interface FocusLink {
  readonly sectionId: string;
  readonly questionId: string;
}

/** 장·소질문별로 앞에 붙일 ref. 넣은 순서가 설명 우선순위다. */
class RefAdditions {
  private readonly bySection = new Map<string, Map<string, string[]>>();

  add(link: FocusLink, ref: string): void {
    let byQuestion = this.bySection.get(link.sectionId);
    if (!byQuestion) this.bySection.set(link.sectionId, (byQuestion = new Map()));
    const list = byQuestion.get(link.questionId) ?? [];
    if (!list.includes(ref)) list.push(ref);
    byQuestion.set(link.questionId, list);
  }

  apply(section: MujinSectionPlan): MujinQuestionPlan[] {
    const byQuestion = this.bySection.get(section.sectionId);
    return section.questions.map((question) => {
      const lead = byQuestion?.get(question.id);
      return lead?.length ? { ...question, refs: uniqueList([...lead, ...question.refs]) } : question;
    });
  }
}

/**
 * 질문·관심·상황을 장별 계획에 반영한다.
 *
 * - weight: 질문과 직접 이어진 장 question, 관심 주제로 고른 장(최대 2) interest, 그 밖 standard.
 *   targetChars는 상품 목표(이미 줄여 둔 장은 그 값)를 기준으로 weightedTarget을 적용한다.
 * - 질문: questionMaterials(질문 재료)로 돌려주고, 이어진 장의 소질문 refs 앞에 질문 ref를 붙인다.
 *   같은 질문이 여러 장에 이어지면 각 장에 붙이고, 마지막 정리(buildClosingSection)가 모두 모은다.
 * - 10-4: 시기 질문의 분야와 같은 월운 활동 재료가 있을 때만 그 분야의 원국 채택 판단(최대 2)과 잇는 설명 연결을 만든다.
 * - 사용자 사실: user-fact(source concern, factKind 그대로)로 분야의 장에 붙인다. 현재·지난·계획 사실이 현재 대운
 *   활동 주제와 닿으면 9-4에도, 시기 질문과 같은 월운 분야면 10-4에도 붙인다(장마다 따로 ref를 둔다).
 *   가정·타인에 대한 관찰은 분야의 장에만 붙인다. 분야가 없는(general) 사실은 질문이 이어진 장에만 붙인다.
 * - 범위 밖 분야(사주와 무관한 요청 등)는 분류 단계에서 빠진다고 보되, 들어와도 쓰지 않는다.
 * - 기존 재료와 소질문의 status·note·문장은 바꾸지 않는다. 바뀌는 것은 weight, targetChars, refs(앞에 더함·10-4 활동 순서), 새 재료뿐이다.
 * - 소질문 refs가 가리키는 곳: 그 장의 materials, 계획 공용 재료(plan.facts·plan.nowFacts), 이 함수가 돌려주는 질문 재료(질문 ref).
 * - 마지막 정리 칸이 들어오면 그대로 돌려준다 (마지막 정리는 buildClosingSection이 만든다).
 */
export function personalizeSections(input: {
  readonly sections: readonly MujinSectionPlan[];
  readonly product: ScrollProductDefinition;
  readonly now: MujinNow;
  readonly questions: readonly MujinQuestionInput[];
  readonly concernFacts: readonly MujinConcernFact[];
  readonly startRef: number;
}): { readonly sections: readonly MujinSectionPlan[]; readonly questionMaterials: readonly MujinQuestionMaterial[]; readonly nextRef: number } {
  const { sections, product, now } = input;
  const refs = refCounter(input.startRef);
  const present = new Map(sections.map((section) => [section.sectionId, section] as const));
  const additions = new RefAdditions();
  const added = new Map<string, MujinMaterial[]>();
  const addMaterial = (sectionId: string, material: Omit<MujinMaterial, "ref">): string => {
    const ref = refs.take();
    added.set(sectionId, [...(added.get(sectionId) ?? []), { ref, ...material }]);
    return ref;
  };

  const questions = input.questions.filter((question) => inProductScope(product, question.domain));
  const knownRefs = new Set(sections.flatMap((section) => section.materials.map((material) => material.ref)));
  const questionRefs = new Set<string>();
  for (const question of questions) {
    if (!question.ref || knownRefs.has(question.ref) || questionRefs.has(question.ref)) {
      throw new Error(`personalizeSections: question ref "${question.ref}" is empty or duplicated`);
    }
    questionRefs.add(question.ref);
  }

  // 1. 질문 연결: 이어지는 장의 소질문 refs 앞에 질문 ref를 붙인다.
  const linkedSections = new Set<string>();
  const questionMaterials: MujinQuestionMaterial[] = questions.map((question) => {
    const chapters = chaptersForQuestion(question);
    const links: FocusLink[] = [];
    for (const sectionId of chapters) {
      const section = present.get(sectionId);
      const questionId = section ? focusQuestionId(section, question.domain, question.intent) : null;
      if (!section || !questionId) continue;
      links.push({ sectionId, questionId });
      linkedSections.add(sectionId);
      additions.add({ sectionId, questionId }, question.ref);
    }
    return {
      ref: question.ref,
      kind: "question",
      summary: question.summary,
      domain: question.domain,
      topicDomain: question.topicDomain,
      intent: question.intent,
      answerability: question.answerability,
      missingInfo: question.missingInfo,
      timingSupported: question.timingSupported,
      sectionIds: uniqueList(links.map((link) => link.sectionId)),
      chapterQuestionIds: uniqueList(links.map((link) => link.questionId)),
      notes: questionNotes(question, chapters, links, present),
    };
  });

  // 2. 10-4: 시기 질문의 분야와 기간 활동이 같을 때만 원국 판단과 잇는다.
  const ch10 = present.get("ch10");
  const timingDomains = new Set<MonthDomain>();
  if (ch10 && ch10.questions.some((question) => question.id === "10-4")) {
    const toCh10 = questions.filter((question) => question.intent === "timing" && chaptersForQuestion(question).includes("ch10"));
    const generalTiming = toCh10.some((question) => question.domain === "general");
    for (const question of toCh10) {
      const domain = monthDomainOfQuestion(question);
      if (domain) timingDomains.add(domain);
    }
    const activities = ch10.materials.filter((material) => monthActivityOf(material) !== null);
    for (const domain of MONTH_DOMAINS) {
      const activity = activities.find((material) => monthActivityOf(material) === domain);
      if (!activity) continue;
      if (generalTiming || timingDomains.has(domain)) additions.add({ sectionId: "ch10", questionId: "10-4" }, activity.ref);
      if (!timingDomains.has(domain)) continue;
      const natal = MONTH_DOMAIN_NATAL[domain];
      const natalSection = present.get(natal.sectionId);
      for (const parent of natalSection ? adoptedJudgments([natalSection], natal.questionIds, 2) : []) {
        const ref = addMaterial("ch10", {
          kind: "derived",
          questionIds: ["10-4"],
          text: `${MONTH_DOMAIN_LABEL[domain]} 분야의 기간 활동을 질문과 같은 활동의 원국 판단과 잇는다: ${parent.text}`,
          scope: "period",
          ...(parent.aspect ? { aspect: parent.aspect } : {}),
          ...(parent.upside ? { upside: parent.upside } : {}),
          ...(parent.weakness ? { weakness: parent.weakness } : {}),
          parentRefs: [activity.ref, parent.ref],
          caveats: [...LINK_CAVEATS, "지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다."],
        });
        additions.add({ sectionId: "ch10", questionId: "10-4" }, ref);
      }
    }
  }

  // 3. 사용자 사실: 분야의 장에 붙이고, 현재 대운 활동 주제·시기 질문과 닿으면 9-4·10-4에도 붙인다.
  const ch9 = present.get("ch9");
  const theme = ch9?.materials.map(luckThemeOf).find((family): family is Family => family !== null) ?? null;
  const themeChapters = new Set(theme ? LUCK_THEME_LINKS[theme].map(chapterOfQuestionId) : []);
  const seenFacts = new Set<string>();
  for (const fact of input.concernFacts) {
    const text = fact.text.trim();
    const domain = asQuestionDomain(fact.domain);
    const key = `${fact.kind}|${domain}|${text}`;
    if (!text || seenFacts.has(key) || !inProductScope(product, domain)) continue;
    seenFacts.add(key);

    const targets: FocusLink[] = [];
    const home = DOMAIN_CHAPTER[domain];
    const homeSection = home ? present.get(home) : undefined;
    if (homeSection) {
      const questionId = focusQuestionId(homeSection, domain, "fact");
      if (questionId) targets.push({ sectionId: homeSection.sectionId, questionId });
    } else if (!home) {
      for (const sectionId of linkedSections) {
        const section = present.get(sectionId)!;
        const questionId = focusQuestionId(section, domain, "fact");
        if (questionId) targets.push({ sectionId, questionId });
      }
    }
    const situational = fact.kind === "current" || fact.kind === "past" || fact.kind === "plan";
    if (situational && home && themeChapters.has(home) && ch9?.questions.some((question) => question.id === "9-4")) {
      targets.push({ sectionId: "ch9", questionId: "9-4" });
    }
    const factMonth = TIMING_MONTH_DOMAIN[domain];
    if (situational && factMonth && timingDomains.has(factMonth) && !targets.some((target) => target.sectionId === "ch10")) {
      targets.push({ sectionId: "ch10", questionId: "10-4" });
    }

    const distinct = targets.filter(
      (target, index) => targets.findIndex((entry) => entry.sectionId === target.sectionId && entry.questionId === target.questionId) === index,
    );
    for (const { sectionId, questionId } of distinct) {
      const ref = addMaterial(sectionId, {
        kind: "user-fact",
        questionIds: [questionId],
        text,
        scope: "user",
        source: "concern",
        factKind: fact.kind,
        caveats: factCaveats(fact.kind, domain, now),
      });
      additions.add({ sectionId, questionId }, ref);
    }
  }

  // 4. 비중: 질문 → 관심 주제 → 그 밖. 관심 주제는 최대 2개만 본다.
  // 마지막 정리는 buildClosingSection이 질문으로 비중을 정하므로 들어와도 그대로 둔다.
  const interests = new Set<string>(now.interests.slice(0, NOW_LIMITS.interests));
  const personalized = sections.map((section): MujinSectionPlan => {
    const spec = product.scroll.sections.find((entry) => entry.id === section.sectionId);
    if (spec?.kind === "closing") return section;
    const weight: SectionWeight = linkedSections.has(section.sectionId) ? "question" : interests.has(section.sectionId) ? "interest" : "standard";
    // 상품 목표를 기준으로 삼되, 자료가 없어 줄여 둔 장은 줄인 값을 쓴다. 이미 비중을 올린 계획을 다시 넣어도 커지지 않는다.
    const base = spec
      ? { min: Math.min(section.targetChars.min, spec.targetChars.min), max: Math.min(section.targetChars.max, spec.targetChars.max) }
      : section.targetChars;
    return {
      ...section,
      weight,
      targetChars: weightedTarget(base, weight),
      questions: additions.apply(section),
      materials: [...section.materials, ...(added.get(section.sectionId) ?? [])],
    };
  });

  return { sections: personalized, questionMaterials, nextRef: refs.next };
}
