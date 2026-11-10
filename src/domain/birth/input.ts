import { z } from "zod";

/**
 * 시진 선택지. 값은 sajuengine의 공개 값과 같아야 한다(tests/unit/engine.test.ts에서 확인).
 * 자시는 입력한 날짜의 자정을 기준으로 새벽과 밤을 나눈다.
 */
export const BRANCH_OPTIONS = [
  { value: "자-새벽", label: "자시 (새벽)", hint: "입력한 날짜의 첫 시간" },
  { value: "축", label: "축시", hint: "새벽" },
  { value: "인", label: "인시", hint: "새벽" },
  { value: "묘", label: "묘시", hint: "아침" },
  { value: "진", label: "진시", hint: "아침" },
  { value: "사", label: "사시", hint: "오전" },
  { value: "오", label: "오시", hint: "한낮" },
  { value: "미", label: "미시", hint: "오후" },
  { value: "신", label: "신시", hint: "오후" },
  { value: "유", label: "유시", hint: "저녁" },
  { value: "술", label: "술시", hint: "저녁" },
  { value: "해", label: "해시", hint: "밤" },
  { value: "자-밤", label: "자시 (밤)", hint: "입력한 날짜의 마지막 시간" },
] as const;

export type BranchValue = (typeof BRANCH_OPTIONS)[number]["value"];
const BRANCH_VALUES = BRANCH_OPTIONS.map((option) => option.value) as [BranchValue, ...BranchValue[]];

export const NICKNAME_MAX = 12;
export const CONCERN_MAX = 200;

/** 줄바꿈이나 제어 문자, 꺾쇠를 제외한 별명만 받는다. 화면에는 React가 이스케이프해서 출력한다. */
export const NicknameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "별명을 입력해 주세요.")
      .max(NICKNAME_MAX, `별명은 ${NICKNAME_MAX}자까지 쓸 수 있어요.`)
      .regex(/^[^\p{Cc}<>]+$/u, "별명에 쓸 수 없는 문자가 있어요."),
  );

export const DraftPlaceSchema = z.object({
  geonameId: z.number().int().positive(),
  name: z.string().min(1).max(60),
  admin: z.string().max(60),
});

export const BirthTimeChoiceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("branch"), branch: z.enum(BRANCH_VALUES) }),
  z.object({ status: z.literal("unknown") }),
]);

/** 작성 중인 초안. 모든 값이 비어 있을 수 있다. */
export const DraftSchema = z.object({
  productId: z.string().min(1).max(60),
  step: z.number().int().min(0).max(8).default(0),
  nickname: z.string().max(40).default(""),
  gender: z.enum(["male", "female"]).nullable().default(null),
  yymmdd: z.string().max(6).default(""),
  calendar: z.enum(["solar", "lunar"]).default("solar"),
  isLeapMonth: z.boolean().default(false),
  place: DraftPlaceSchema.nullable().default(null),
  birthTime: BirthTimeChoiceSchema.nullable().default(null),
  situationId: z.string().max(40).nullable().default(null),
  concern: z.string().max(CONCERN_MAX).default(""),
});

export type Draft = z.infer<typeof DraftSchema>;

export function emptyDraft(productId: string): Draft {
  return DraftSchema.parse({ productId });
}

/** 서버가 풀이를 만들 때 받는 완성된 입력. 좌표는 받지 않고 geonameId만 받는다. */
export const CreateReadingSchema = z.object({
  productId: z.string().min(1).max(60),
  nickname: NicknameSchema,
  gender: z.enum(["male", "female"]),
  yymmdd: z.string().regex(/^\d{6}$/),
  calendar: z.enum(["solar", "lunar"]),
  isLeapMonth: z.boolean(),
  geonameId: z.number().int().positive(),
  birthTime: BirthTimeChoiceSchema,
  situationId: z.string().max(40).nullable(),
  concern: z
    .string()
    .max(CONCERN_MAX)
    .transform((value) => value.trim()),
});

export type CreateReadingInput = z.infer<typeof CreateReadingSchema>;
