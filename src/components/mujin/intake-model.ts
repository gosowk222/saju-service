/**
 * 무진 대화형 입력의 화면 규칙. 화면 컴포넌트(intake.tsx)와 단위 테스트가 함께 쓰는 순수 함수만 둔다.
 * 선택 제한과 배타 규칙은 서버 검증(src/domain/mujin/now.ts의 MujinNowSchema)과 같은 기준이다.
 * 화면이 고를 수 없게 막을 뿐이고, 최종 검증은 서버가 다시 한다.
 */

import { NicknameSchema } from "@/domain/birth/input";
import {
  FAMILY_OPTIONS,
  NOW_LIMITS,
  RELATIONSHIP_OPTIONS,
  WORK_OPTIONS,
  type FamilyId,
  type InterestChapterId,
  type MujinNow,
  type RelationshipId,
  type WorkId,
} from "@/domain/mujin/now";
import type { PersonaIntakeLines } from "@/domain/personas";

/** 입력 순서. 출생지역을 출생시각보다 먼저 받는다 (시진의 실제 시각 범위가 지역으로 정해진다, 00_START_HERE 결정 8). */
export const INTAKE_STEPS = ["nickname", "gender", "birthDate", "place", "time", "now", "concern", "review"] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

/** 확인 단계의 번호. 초안(Draft.step, 0~8)에 이 번호까지만 저장한다. */
export const REVIEW_STEP = INTAKE_STEPS.indexOf("review");

/** 단계 제목. 입력칸의 라벨과 진행 표시에 쓴다 (화면 문구). */
export const STEP_TITLES: Readonly<Record<IntakeStep, string>> = {
  nickname: "별명",
  gender: "성별",
  birthDate: "생년월일",
  place: "출생지역",
  time: "출생시각",
  now: "지금의 나",
  concern: "진짜 궁금한 점",
  review: "입력 확인",
};

/** 단계마다 무진이 하는 말. 문장은 캐릭터 설정(personas의 lines.intake)에 있고 화면은 고르기만 한다. */
export const STEP_LINE: Readonly<Record<IntakeStep, keyof PersonaIntakeLines>> = {
  nickname: "greet",
  gender: "askGender",
  birthDate: "askBirthDate",
  place: "askPlace",
  time: "askTime",
  now: "askNow",
  concern: "askConcern",
  review: "review",
};

export function stepAt(step: number): IntakeStep {
  return INTAKE_STEPS[Math.min(Math.max(Math.trunc(step), 0), REVIEW_STEP)]!;
}

/** 별명 호칭. 무진은 존댓말로 '별명 님'이라고 부른다. 별명이 아직 없거나 쓸 수 없으면 '손님'이라고 부른다. */
export function addressName(nickname: string): string {
  const parsed = NicknameSchema.safeParse(nickname);
  return parsed.success ? `${parsed.data} 님` : "손님";
}

/** 캐릭터 문장의 {name} 자리를 별명 호칭으로 바꾼다. */
export function fillName(line: string, nickname: string): string {
  return line.includes("{name}") ? line.replaceAll("{name}", addressName(nickname)) : line;
}

/** 단계를 넘어갈 수 있는가. 날짜는 서버가 해석한 결과(resolvedOk)로 판단한다. 지금의 나는 모두 선택이다. */
export function stepValid(
  step: IntakeStep,
  input: {
    readonly nickname: string;
    readonly gender: "male" | "female" | null;
    readonly resolvedOk: boolean;
    readonly hasPlace: boolean;
    readonly hasTime: boolean;
    readonly concern: string;
    readonly concernRequired: boolean;
  },
): boolean {
  switch (step) {
    case "nickname":
      return NicknameSchema.safeParse(input.nickname).success;
    case "gender":
      return input.gender !== null;
    case "birthDate":
      return input.resolvedOk;
    case "place":
      return input.hasPlace;
    case "time":
      return input.hasTime;
    case "now":
      return true;
    case "concern":
      return !input.concernRequired || input.concern.trim().length > 0;
    case "review":
      return INTAKE_STEPS.filter((key) => key !== "review").every((key) => stepValid(key, input));
  }
}

/** 개수 제한이 있는 여러 개 고르기. 이미 고른 것은 해제하고, 제한에 닿았으면 그대로 둔다. 고른 순서는 뜻이 없다. */
export function toggleLimited<T>(current: readonly T[], id: T, max: number): T[] {
  if (current.includes(id)) return current.filter((value) => value !== id);
  if (current.length >= max) return [...current];
  return [...current, id];
}

/** 제한에 닿아 지금은 더 고를 수 없는 선택지인가. 이미 고른 것은 해제할 수 있으므로 막지 않는다. */
export function limitedDisabled<T>(current: readonly T[], id: T, max: number): boolean {
  return !current.includes(id) && current.length >= max;
}

export function toggleWork(current: readonly WorkId[], id: WorkId): WorkId[] {
  return toggleLimited(current, id, NOW_LIMITS.work);
}

export function toggleInterest(current: readonly InterestChapterId[], id: InterestChapterId): InterestChapterId[] {
  return toggleLimited(current, id, NOW_LIMITS.interests);
}

/** 관계 상태는 하나만 고르고, 같은 것을 다시 누르면 미응답으로 돌아간다. */
export function toggleRelationship(current: RelationshipId | null, id: RelationshipId): RelationshipId | null {
  return current === id ? null : id;
}

const EXCLUSIVE_FAMILY: ReadonlySet<FamilyId> = new Set(FAMILY_OPTIONS.filter((option) => option.exclusive).map((option) => option.id));

export function isExclusiveFamily(id: FamilyId): boolean {
  return EXCLUSIVE_FAMILY.has(id);
}

/**
 * 가족 관심. 앞의 다섯 항목은 2개까지, '특별히 다루고 싶은 내용 없음'과 '답하고 싶지 않음'은 다른 항목과 함께 고르지 않는다.
 * 배타 항목을 고르면 나머지를 비우고, 배타 항목이 있을 때 일반 항목을 고르면 배타 항목을 뺀다.
 */
export function toggleFamily(current: readonly FamilyId[], id: FamilyId): FamilyId[] {
  if (current.includes(id)) return current.filter((value) => value !== id);
  if (EXCLUSIVE_FAMILY.has(id)) return [id];
  const regular = current.filter((value) => !EXCLUSIVE_FAMILY.has(value));
  if (regular.length >= NOW_LIMITS.family) return [...current];
  return [...regular, id];
}

/** 일반 항목 2개를 이미 골랐을 때 나머지 일반 항목만 막는다. 배타 항목은 언제든 고를 수 있다(고르면 나머지가 비워진다). */
export function familyDisabled(current: readonly FamilyId[], id: FamilyId): boolean {
  if (current.includes(id) || EXCLUSIVE_FAMILY.has(id)) return false;
  return current.filter((value) => !EXCLUSIVE_FAMILY.has(value)).length >= NOW_LIMITS.family;
}

/** 개수 제한에 닿았을 때 알려 줄 이유 (화면 문구). 제한에 닿지 않았으면 null. */
export function limitNotice(group: "work" | "interests" | "family", now: MujinNow): string | null {
  const release = "다른 항목으로 바꾸려면 고른 항목을 다시 눌러 해제해 주세요.";
  if (group === "family") {
    const regular = now.family.filter((value) => !EXCLUSIVE_FAMILY.has(value)).length;
    return regular >= NOW_LIMITS.family ? `가족 이야기는 위 다섯 가지 중 ${NOW_LIMITS.family}개까지 고를 수 있어요. ${release}` : null;
  }
  if (group === "work") {
    return now.work.length >= NOW_LIMITS.work ? `일·학업 상태는 ${NOW_LIMITS.work}개까지 고를 수 있어요. ${release}` : null;
  }
  return now.interests.length >= NOW_LIMITS.interests ? `관심 있는 장은 ${NOW_LIMITS.interests}개까지 고를 수 있어요. ${release}` : null;
}

export const WORK_LABEL: Readonly<Record<WorkId, string>> = Object.fromEntries(WORK_OPTIONS.map((option) => [option.id, option.label])) as Record<WorkId, string>;
export const RELATIONSHIP_LABEL: Readonly<Record<RelationshipId, string>> = Object.fromEntries(
  RELATIONSHIP_OPTIONS.map((option) => [option.id, option.label]),
) as Record<RelationshipId, string>;
export const FAMILY_LABEL: Readonly<Record<FamilyId, string>> = Object.fromEntries(FAMILY_OPTIONS.map((option) => [option.id, option.label])) as Record<FamilyId, string>;

/**
 * 확인 화면에 보여 줄 '지금의 나' 요약. 고르지 않은 항목은 미응답이라고 쓴다.
 * 관심 장을 고르지 않으면 골고루 본다 (03_INPUT_AND_PERSONALIZATION.md 3절).
 */
export function nowSummary(
  now: MujinNow,
  chapterTitle: (id: InterestChapterId) => string,
): { readonly work: string; readonly interests: string; readonly relationship: string; readonly family: string } {
  return {
    work: now.work.length ? now.work.map((id) => WORK_LABEL[id]).join(", ") : "고르지 않음",
    interests: now.interests.length ? now.interests.map(chapterTitle).join(", ") : "고르지 않음 (모든 장을 골고루)",
    relationship: now.relationship ? RELATIONSHIP_LABEL[now.relationship] : "고르지 않음",
    family: now.family.length ? now.family.map((id) => FAMILY_LABEL[id]).join(", ") : "고르지 않음",
  };
}

/** 하나라도 골랐는가. 아무것도 고르지 않으면 다음 버튼이 '건너뛰기'가 된다. */
export function nowAnswered(now: MujinNow): boolean {
  return now.work.length > 0 || now.interests.length > 0 || now.relationship !== null || now.family.length > 0;
}

/**
 * Enter로 다음 단계에 넘어가도 되는 키 입력인가. 한글을 조합하는 중의 Enter(isComposing, keyCode 229)는
 * 글자를 끝내는 입력이라 넘어가지 않는다. Shift+Enter도 넘어가지 않는다.
 */
export function isSubmitEnter(event: {
  readonly key: string;
  readonly keyCode: number;
  readonly shiftKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
}): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !event.nativeEvent.isComposing && event.keyCode !== 229;
}
