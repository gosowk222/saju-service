/**
 * 실제 모델 비교용 평가 사례 (docs/personas/myomyo-evaluation.md 2절). 모두 가상의 입력이다. 실제 사용자 정보를 넣지 않는다.
 * 질문은 미리 정리해 둔 구조로 넣어, 질문 정리 모델을 부르지 않고도 버전마다 같은 작성 계획을 만든다.
 * llm:export와 llm:render가 함께 쓴다. 모델은 부르지 않는다.
 */
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { buildNarrationPlan, requestedTimingKey } from "@/domain/reading/focus";
import { buildQuestionAnalysis, emptyAnalysis, inScopeItems, itemDomain, type ClassifierOutput } from "@/domain/reading/question";
import type { TimingDomain } from "@/domain/rules/timing";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeTiming } from "@/server/engine/timing";

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
