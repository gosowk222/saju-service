import { z } from "zod";

/**
 * 무진 상품의 '지금의 나' 입력 (docs/implementation/mujin/03_INPUT_AND_PERSONALIZATION.md 2~5절).
 * 모두 선택 입력이다. 고르지 않아도 10개 장을 모두 제공한다.
 *
 * 선택지는 사용자가 알려 준 '상황·관심'이다. 선택만으로 나이, 소득, 가족 구성, 건강 상태 같은 사실을 추정하지 않는다.
 * 응답 상태를 구분한다: 미응답(unanswered), 비공개(private), 특별한 관심 없음(none), 응답 있음(answered).
 */

export const NOW_VERSION = "mujin-now-1.0.0";

export const WORK_OPTIONS = [
  {
    id: "student",
    label: "학생",
    context: "학습·과제·팀 활동·진로 탐색",
    avoid: "나이나 용돈 액수를 추정하지 않는다",
  },
  {
    id: "job-seeking",
    label: "취업 준비 중",
    context: "공고·지원 자료·포트폴리오·면접",
    avoid: "무직이나 무소득이라고 추정하지 않는다",
  },
  {
    id: "employed",
    label: "직장에 다니는 중",
    context: "업무 범위·역할·평가·협업·보수 협의",
    avoid: "안정된 월급을 받는다고 추정하지 않는다",
  },
  {
    id: "freelancer",
    label: "프리랜서로 활동 중",
    context: "견적·계약·수정·납품·정산",
    avoid: "수입이 불안정하거나 분쟁이 있다고 추정하지 않는다",
  },
  {
    id: "business",
    label: "사업을 운영하는 중",
    context: "고객·가격·제공 범위·비용·운영",
    avoid: "직원이 있거나 자금난이 있다고 추정하지 않는다",
  },
  {
    id: "resting",
    label: "쉬거나 다음 활동을 준비하는 중",
    context: "생활 일정·목표·활동 탐색",
    avoid: "질병이나 번아웃이 있다고 추정하지 않는다",
  },
  {
    id: "other",
    label: "위 항목과 다른 상황",
    context: "특정 직업을 전제하지 않는 활동",
    avoid: "특정 직업이나 소속을 추정하지 않는다",
  },
] as const;

export const RELATIONSHIP_OPTIONS = [
  { id: "single", label: "현재 연애하지 않음", avoid: "연애를 원한다고 추정하지 않는다" },
  { id: "seeing", label: "알아가는 사람이 있음", avoid: "상대의 마음이나 관계의 결과를 아는 것처럼 말하지 않는다" },
  { id: "dating", label: "연애 중", avoid: "결혼 계획이나 갈등이 있다고 추정하지 않는다" },
  { id: "partnered", label: "결혼·동반생활 중", avoid: "자녀, 공동재산, 부양 의무가 있다고 추정하지 않는다" },
  { id: "private", label: "답하고 싶지 않음", avoid: "관계 상태를 추정하지 않는다" },
] as const;

/** 앞의 5개는 최대 2개, 뒤의 2개(none, private)는 다른 항목과 함께 고를 수 없다. */
export const FAMILY_OPTIONS = [
  { id: "expectations", label: "가족의 기대와 내 선택", exclusive: false },
  { id: "distance", label: "내 시간과 관계의 거리", exclusive: false },
  { id: "independence", label: "독립이나 생활 변화", exclusive: false },
  { id: "care", label: "돌봄과 역할 분담", exclusive: false },
  { id: "money", label: "돈과 지원에 관한 이야기", exclusive: false },
  { id: "none", label: "특별히 다루고 싶은 내용 없음", exclusive: true },
  { id: "private", label: "답하고 싶지 않음", exclusive: true },
] as const;

/** 관심 주제는 10개 장 이름 그대로 고른다 (상품 정의의 장 ID). 관심은 설명 비중만 바꾸고 판단을 바꾸지 않는다. */
export const INTEREST_CHAPTER_IDS = ["ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10"] as const;

export const NOW_LIMITS = { work: 2, interests: 2, family: 2 } as const;

export type WorkId = (typeof WORK_OPTIONS)[number]["id"];
export type RelationshipId = (typeof RELATIONSHIP_OPTIONS)[number]["id"];
export type FamilyId = (typeof FAMILY_OPTIONS)[number]["id"];
export type InterestChapterId = (typeof INTEREST_CHAPTER_IDS)[number];

const WORK_IDS = WORK_OPTIONS.map((option) => option.id) as [WorkId, ...WorkId[]];
const RELATIONSHIP_IDS = RELATIONSHIP_OPTIONS.map((option) => option.id) as [RelationshipId, ...RelationshipId[]];
const FAMILY_IDS = FAMILY_OPTIONS.map((option) => option.id) as [FamilyId, ...FamilyId[]];
const EXCLUSIVE_FAMILY: ReadonlySet<string> = new Set(FAMILY_OPTIONS.filter((option) => option.exclusive).map((option) => option.id));

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/**
 * 저장·전송 형식. 빈 배열과 null은 '미응답'이다. 선택 순서는 주업 순서가 아니다.
 * 같은 값을 두 번 고르거나, 가족 관심에서 '특별히 없음'·'답하고 싶지 않음'을 다른 항목과 함께 고르면 거부한다.
 */
export const MujinNowSchema = z
  .object({
    work: z.array(z.enum(WORK_IDS)).max(NOW_LIMITS.work).default([]),
    interests: z.array(z.enum(INTEREST_CHAPTER_IDS)).max(NOW_LIMITS.interests).default([]),
    relationship: z.enum(RELATIONSHIP_IDS).nullable().default(null),
    family: z.array(z.enum(FAMILY_IDS)).max(NOW_LIMITS.family).default([]),
  })
  .refine((now) => unique(now.work) && unique(now.interests) && unique(now.family), { message: "같은 항목을 두 번 고를 수 없어요." })
  .refine((now) => !now.family.some((id) => EXCLUSIVE_FAMILY.has(id)) || now.family.length === 1, {
    message: "'특별히 다루고 싶은 내용 없음'과 '답하고 싶지 않음'은 다른 항목과 함께 고를 수 없어요.",
  });

export type MujinNow = z.infer<typeof MujinNowSchema>;

export const EMPTY_NOW: MujinNow = { work: [], interests: [], relationship: null, family: [] };

export type AnswerStatus = "unanswered" | "private" | "none" | "answered";

/** 항목별 응답 상태. 생성 재료는 이 상태로 '모름'과 '말하고 싶지 않음'과 '관심 없음'을 구분한다. */
export function nowStatus(now: MujinNow): {
  readonly work: AnswerStatus;
  readonly interests: AnswerStatus;
  readonly relationship: AnswerStatus;
  readonly family: AnswerStatus;
} {
  return {
    work: now.work.length ? "answered" : "unanswered",
    interests: now.interests.length ? "answered" : "unanswered",
    relationship: now.relationship === null ? "unanswered" : now.relationship === "private" ? "private" : "answered",
    family: !now.family.length ? "unanswered" : now.family[0] === "private" ? "private" : now.family[0] === "none" ? "none" : "answered",
  };
}

export const workLabel = (id: WorkId) => WORK_OPTIONS.find((option) => option.id === id)?.label ?? id;
export const relationshipLabel = (id: RelationshipId) => RELATIONSHIP_OPTIONS.find((option) => option.id === id)?.label ?? id;
export const familyLabel = (id: FamilyId) => FAMILY_OPTIONS.find((option) => option.id === id)?.label ?? id;
