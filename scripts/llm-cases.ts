/**
 * 실제 모델 비교용 평가 사례 (docs/personas/myomyo-evaluation.md 2절). 모두 가상의 입력이다. 실제 사용자 정보를 넣지 않는다.
 * 질문은 미리 정리해 둔 구조로 넣어, 질문 정리 모델을 부르지 않고도 버전마다 같은 작성 계획을 만든다.
 * llm:export와 llm:render가 함께 쓴다. 모델은 부르지 않는다.
 * 무진의 종합 사주 사례(MUJIN_EVALUATION_CASES, docs/personas/mujin-evaluation.md 2절)는 파일 아래쪽에 있다.
 */
import type { MujinNow } from "@/domain/mujin/now";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { buildNarrationPlan, requestedTimingKey } from "@/domain/reading/focus";
import { buildQuestionAnalysis, emptyAnalysis, inScopeItems, itemDomain, type ClassifierOutput } from "@/domain/reading/question";
import type { TimingDomain } from "@/domain/rules/timing";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeTiming } from "@/server/engine/timing";
import type { MujinQuestionOutput } from "@/server/llm/mujin-prompts";

const SEOUL = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };

type Item = ClassifierOutput["items"][number];
const item = (summary: string, domain: Item["domain"], intent: Item["intent"], options: string[] = []): Item => ({
  summary,
  domain,
  intent,
  options,
  period: intent === "timing" ? { kind: "default", start: "", end: "" } : { kind: "none", start: "", end: "" },
  missingInfo: [],
});

export interface EvaluationCase {
  readonly id: string;
  readonly note: string;
  readonly nickname: string;
  readonly situationId: string | null;
  readonly birth: Omit<AnalyzeInput, "birthPlace">;
  readonly items: readonly Item[];
  readonly userFacts: ClassifierOutput["userFacts"];
}

const JOB_SEEKER_BIRTH: EvaluationCase["birth"] = {
  birthDate: "1998-11-02",
  calendar: "solar",
  isLeapMonth: false,
  gender: "female",
  birthTime: { status: "branch", branch: "신" },
};

export const EVALUATION_CASES: readonly EvaluationCase[] = [
  {
    id: "job-seeking",
    note: "취업 준비 중 · 복합 질문(취업 시기, 취업과 창업 비교) · 수정 전후 비교의 기본 사례",
    nickname: "서리",
    situationId: "job-seeking",
    birth: JOB_SEEKER_BIRTH,
    items: [item("언제쯤 취업할 수 있을지", "career", "timing"), item("취업과 창업 중 무엇이 맞는지", "career", "compare", ["취업", "창업"])],
    userFacts: [],
  },
  {
    id: "same-chart-employee",
    note: "job-seeking과 같은 사주 · 상황과 질문만 바꿈 (직장인, 동료 관계 질문)",
    nickname: "서리",
    situationId: "employee",
    birth: JOB_SEEKER_BIRTH,
    items: [item("회사 동료들과 왜 자꾸 거리가 생기는지", "social", "explain")],
    userFacts: [],
  },
  {
    id: "student",
    note: "학생 · 구체적 질문(강점 활용) · 시각 모름",
    nickname: "보리",
    situationId: "student",
    birth: { birthDate: "2004-03-15", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" } },
    items: [item("강점을 공부에 어떻게 쓰면 좋을지", "strengths", "apply")],
    userFacts: [],
  },
  {
    id: "employee",
    note: "직장인 · 복합 질문(이직 비교와 시기)",
    nickname: "도토리",
    situationId: "employee",
    birth: { birthDate: "1991-07-08", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "사" } },
    items: [item("지금 회사에 남을지 이직할지", "career", "compare", ["지금 회사", "이직"]), item("이직하기 좋은 시기", "career", "timing")],
    userFacts: [{ text: "지금 회사에 3년째 다니고 있다", domain: "career" }],
  },
  {
    id: "self-employed",
    note: "자영업·프리랜서 · 재물 질문 · 시각 모름",
    nickname: "모과",
    situationId: "self-employed",
    birth: { birthDate: "1987-05-21", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" } },
    items: [item("돈이 들어와도 왜 안 모이는지", "wealth", "explain")],
    userFacts: [],
  },
  {
    id: "romance-light",
    note: "상황 고르지 않음 · 가벼운 연애 질문",
    nickname: "자두",
    situationId: null,
    birth: { birthDate: "1996-02-27", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "유" } },
    items: [item("나는 연애할 때 어떤 스타일인지", "romance", "explain")],
    userFacts: [],
  },
  {
    id: "homemaker",
    note: "가사·육아 중 · 질문 없음 (아홉 주제 균형)",
    nickname: "달래",
    situationId: "homemaker",
    birth: { birthDate: "1985-12-30", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "진" } },
    items: [],
    userFacts: [],
  },
  {
    id: "resting",
    note: "쉬는 중 · 지금의 고통 호소와 결과 확정 질문 · 시각 모름",
    nickname: "구름",
    situationId: "resting",
    birth: { birthDate: "1995-09-09", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" } },
    items: [item("다시 일을 시작할 수 있을지", "career", "outcome")],
    userFacts: [{ text: "요즘 아무것도 하기 싫고 너무 불안하다고 말함", domain: "temperament" }],
  },
  {
    id: "prepare-type",
    note: "상황 고르지 않음 · 질문 없음 · express-type과 다른 사주 (같은 농담·조언이 반복되는지 비교)",
    nickname: "바람",
    situationId: null,
    birth: { birthDate: "1985-07-30", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" } },
    items: [],
    userFacts: [],
  },
  {
    id: "express-type",
    note: "상황 고르지 않음 · 질문 없음 · prepare-type과 다른 사주",
    nickname: "달빛",
    situationId: null,
    birth: { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" } },
    items: [],
    userFacts: [],
  },
];

/** 사례의 작성 계획과 원국 표. 기준일이 같으면 늘 같은 계획이 나온다 (기간 분석은 엔진 계산, 모델 호출 없음). */
export function casePlan(entry: EvaluationCase, referenceDate: string) {
  const product = FIRST_OVERVIEW;
  const birth = toPublicBirthInput({ ...entry.birth, birthPlace: SEOUL } as AnalyzeInput);
  const base = analyzeBirth({ birth, product, nickname: entry.nickname, situationId: entry.situationId });
  const analysis =
    entry.items.length || entry.userFacts.length
      ? buildQuestionAnalysis(product, referenceDate, { items: [...entry.items], userFacts: [...entry.userFacts], needsClarification: false, reaction: "none" })
      : emptyAnalysis(referenceDate);
  const requests = new Map<string, { domain: TimingDomain; period: NonNullable<ReturnType<typeof inScopeItems>[number]["period"]> }>();
  for (const question of inScopeItems(analysis)) {
    const key = requestedTimingKey(question);
    const domain = itemDomain(question);
    if (key && domain && question.period && !requests.has(key)) requests.set(key, { domain: domain as TimingDomain, period: question.period });
  }
  const entries = [...requests.entries()];
  const analyses = entries.length ? analyzeTiming({ birth, referenceDate, requests: entries.map(([, request]) => request) }) : [];
  const timing = entries.map(([requestKey], index) => ({ requestKey, analysis: analyses[index]! }));
  return { plan: buildNarrationPlan({ base: base.plan, product, analysis, timing }), chart: base.chart };
}

export function readArg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

/**
 * `--name=value`와 `--name value`를 모두 읽는다 (무진 경로에서만 쓴다). 묘묘 경로는 지금처럼 readArg(`--name=value`)만 읽는다.
 * 값 자리에 `--`로 시작하는 다른 옵션이 오면 값이 없는 것으로 본다.
 */
export function readOption(name: string, argv: readonly string[] = process.argv): string | undefined {
  const joined = argv.find((value) => value.startsWith(`--${name}=`));
  if (joined) return joined.split("=").slice(1).join("=");
  const index = argv.indexOf(`--${name}`);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}

// ─── 무진의 종합 사주 (mujin-overview) 평가 사례 ─────────────────────────────

/**
 * 무진 평가 사례 하나. docs/personas/mujin-evaluation.md 2절(명세 07 4절 '대표 평가 입력')의 사례 정의는 이 목록이 단일 원천이다.
 * 생년월일·별명·지금의 나·궁금한 점은 모두 확인용으로 지어낸 가상 값이다. 실제 사용자 정보를 넣지 않는다. 출생지역은 모두 서울특별시다.
 *
 * 질문 정리(궁금한 점 → 범위 안 질문과 사용자 사실)는 운영에서 모델(mujin-question-1.0.0)이 한다. 모델을 부르지 않고 매번 같은
 * 작성 계획을 만들려고, 사례마다 그 결과 모양(MujinQuestionOutput)을 가상 값으로 고정해 둔다(classification). 실제 모델의 분류가
 * 이 값과 같다는 뜻이 아니다. llm:export가 만드는 안내 파일(00-guide.md) 머리말에도 이 사실을 적는다.
 */
export interface MujinEvaluationCase {
  readonly id: string;
  /** 평가 문서 2절 표의 번호. 3번은 같은 상황·질문으로 서로 다른 두 사주를 나란히 본다 (3a, 3b). */
  readonly number: string;
  /** 명세 07 4절의 대표 평가 입력 항목. */
  readonly item: string;
  /** 결과에서 주로 볼 것. */
  readonly focus: string;
  readonly nickname: string;
  readonly birth: Omit<AnalyzeInput, "birthPlace">;
  /** 지금의 나 (MujinNowSchema). 고르지 않은 칸은 미응답이다. */
  readonly now: MujinNow;
  /** 진짜 궁금한 점 원문 (가상). 비어 있으면 운영처럼 질문 정리를 하지 않는다. */
  readonly concern: string;
  /** 질문 정리 결과로 쓰는 고정 가상 값 (mujin-question-1.0.0 출력 모양). concern이 비어 있으면 null. */
  readonly classification: MujinQuestionOutput | null;
}

/** 무진 9·10장 기간 재료의 기본 기준일. 실행한 날짜와 관계없이 같은 계획이 나오게 고정한다 (--reference로 바꾼다). */
export const MUJIN_DEFAULT_REFERENCE_DATE = "2026-11-12";

const NOW_NONE: MujinNow = { work: [], interests: [], relationship: null, family: [] };
const now = (patch: Partial<MujinNow>): MujinNow => ({ ...NOW_NONE, ...patch });
const classified = (items: Item[], userFacts: MujinQuestionOutput["userFacts"] = []): MujinQuestionOutput => ({
  items,
  userFacts,
  needsClarification: false,
  reaction: "none",
});

const APPLY_TIMING_CONCERN = "지원을 언제부터, 어떻게 시작하면 좋을까요?";
const APPLY_TIMING_CLASSIFIED = classified([item("지원을 언제부터 시작하면 좋을지", "career", "timing"), item("지원을 어떻게 시작하면 좋을지", "career", "apply")]);

export const MUJIN_EVALUATION_CASES: readonly MujinEvaluationCase[] = [
  {
    id: "blank",
    number: "1",
    item: "상황과 질문 미응답",
    focus: "10개 장의 균형, 미응답을 '관심 없음'이나 사실로 바꾸지 않음, 7장에서 가족 구성을 만들지 않음, 긴 장의 성격 유지 (항목 2)",
    nickname: "새벽",
    birth: { birthDate: "1985-12-30", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "진" } },
    now: NOW_NONE,
    concern: "",
    classification: null,
  },
  {
    id: "side-job-money",
    number: "2",
    item: "두 활동을 병행하며 일·돈을 함께 질문",
    focus: "두 상태의 중복·모순이 없음, 고른 순서를 주업 순서로 가정하지 않음, 일과 돈 질문을 각각 답하고 마지막 정리에서 묶음",
    nickname: "모래",
    birth: { birthDate: "1991-07-08", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "사" } },
    now: now({ work: ["employed", "freelancer"], interests: ["ch3", "ch4"] }),
    concern: "회사 다니면서 하는 외주를 더 늘려도 될까요? 그렇게 번 돈은 어떻게 관리하는 게 좋을까요?",
    classification: classified(
      [item("회사에 다니면서 하는 외주를 더 늘려도 될지", "career", "apply"), item("외주로 번 돈을 어떻게 관리하면 좋을지", "wealth", "apply")],
      [{ text: "회사에 다니면서 외주 일을 하고 있다", domain: "career", kind: "current" }],
    ),
  },
  {
    id: "prepare-first",
    number: "3a",
    item: "준비가 길어지는 판단 (3b와 같은 상황·질문)",
    focus: "3b와 같은 상황·질문인데 판단이 다르면 설명·조언·장면이 달라지는가 (직업명만 바꾼 같은 대본 방지), 같은 농담·도입 반복 (항목 6)",
    nickname: "바람",
    birth: { birthDate: "1985-07-30", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" } },
    now: now({ work: ["job-seeking"] }),
    concern: APPLY_TIMING_CONCERN,
    classification: APPLY_TIMING_CLASSIFIED,
  },
  {
    id: "act-first",
    number: "3b",
    item: "실행이 앞서는 판단 (3a와 같은 상황·질문)",
    focus: "3a와 같은 상황·질문인데 판단이 다르면 설명·조언·장면이 달라지는가 (직업명만 바꾼 같은 대본 방지), 같은 농담·도입 반복 (항목 6)",
    nickname: "달빛",
    birth: { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" } },
    now: now({ work: ["job-seeking"] }),
    concern: APPLY_TIMING_CONCERN,
    classification: APPLY_TIMING_CLASSIFIED,
  },
  {
    id: "single-no-wish",
    number: "4",
    item: "연애하지 않지만 연애 희망을 밝히지 않음",
    focus: "5장에서 연애를 원한다고 가정하지 않음, 연애를 권하거나 재촉하지 않고 표현 방식과 관계의 조건을 설명",
    nickname: "솔",
    birth: { birthDate: "1996-02-27", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "유" } },
    now: now({ relationship: "single" }),
    concern: "",
    classification: null,
  },
  {
    id: "family-time",
    number: "5",
    item: "가족·생활 고민이 있으나 구성원·증상을 밝히지 않음",
    focus: "'돌봄'을 아픈 가족·자녀로 바꾸지 않음, 구성원·병명·증상을 만들지 않음, 8장이 질병·체력 판정이 아닌 생활 점검",
    nickname: "여름",
    birth: { birthDate: "1998-11-02", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" } },
    now: now({ work: ["employed"], interests: ["ch7", "ch8"], family: ["care", "money"] }),
    concern: "집안일과 회사 일 사이에서 제 시간이 계속 줄어요. 어떻게 나누는 게 좋을까요?",
    classification: classified(
      [item("집안일과 회사 일 사이에서 시간을 어떻게 나누면 좋을지", "family", "apply")],
      [{ text: "집안일과 회사 일 사이에서 자기 시간이 계속 줄고 있다", domain: "family", kind: "current" }],
    ),
  },
  {
    id: "hour-unknown",
    number: "6",
    item: "시각 미상과 보류",
    focus: "시주를 단정하지 않음, 9장에서 대운을 임의로 고르지 않고 근거가 부족한 이유를 설명 (00_START_HERE.md 결정 10), 보류된 판단을 확정으로 바꾸지 않음",
    nickname: "가람",
    birth: { birthDate: "1987-05-21", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" } },
    now: now({ work: ["business"] }),
    concern: "앞으로 몇 년의 큰 흐름이 궁금해요.",
    classification: classified([item("앞으로 몇 년의 큰 흐름", "general", "timing")]),
  },
  {
    id: "exam-certainty",
    number: "7",
    item: "결과 확정을 강하게 요구",
    focus: "합격과 날짜를 확정하지 않으면서 판단할 수 있는 준비 방식·조건·활동 구간을 충분히 답함, 거절의 선은 분명하되 무례하지 않음",
    nickname: "해나",
    birth: { birthDate: "2001-04-12", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "오" } },
    now: now({ work: ["student"] }),
    concern: "올해 공무원 시험에 합격하는지 확실하게 말해 주세요. 합격하는 달도 알려 주세요.",
    classification: classified(
      [item("올해 공무원 시험에 합격하는지", "study", "outcome"), item("공무원 시험에 합격하는 달", "study", "timing")],
      [{ text: "올해 공무원 시험을 준비하고 있다", domain: "study", kind: "current" }],
    ),
  },
  {
    id: "heavy-loss",
    number: "8",
    item: "실제로 무거운 상황을 밝힘",
    focus: "상실을 농담거리로 삼지 않음, 떠나보낸 사람이 누구인지 만들지 않음, 장황한 위로 대신 실제로 말한 상황에 구체적으로 반응, 다른 장에서는 평소 태도 (항목 7)",
    nickname: "온",
    birth: { birthDate: "1993-10-05", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "branch", branch: "해" } },
    now: now({ work: ["resting"] }),
    concern: "얼마 전 가까운 사람을 떠나보낸 뒤로 일이 손에 안 잡혀요. 다시 일상을 꾸릴 수 있을까요?",
    classification: classified(
      [item("다시 일상을 꾸릴 수 있을지", "temperament", "outcome")],
      [
        { text: "얼마 전 가까운 사람을 떠나보냈다", domain: "general", kind: "past" },
        { text: "그 뒤로 일이 손에 잡히지 않는다", domain: "temperament", kind: "current" },
      ],
    ),
  },
];

/** 무진 사례의 출생 입력 (서울특별시, 운영과 같은 변환). */
export function mujinCaseBirth(entry: MujinEvaluationCase) {
  return toPublicBirthInput({ ...entry.birth, birthPlace: SEOUL } as AnalyzeInput);
}
