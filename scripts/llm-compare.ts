/**
 * 풀이 품질 확인과 출시 전 모델 비교. 운영과 같은 계산·규칙·프롬프트·검사 경로를 데이터베이스 없이 실행한다.
 *
 *   npm run llm:compare                                         gpt-5.6-luna와 gpt-6-luna 비교 (사례 전체)
 *   npm run llm:compare -- --models=gpt-5.6-luna --cases=career-jobseeker,romance-mixed
 *   npm run llm:compare -- --date=2026-11-10 --out=docs/model-comparison
 *
 * 실제 API를 호출해 비용이 발생한다. 키가 없으면 LIVE_NOT_RUN을 출력하고 끝낸다.
 * 모든 입력은 가상의 정보다. 자동 집계 외의 품질 평가는 사람이 본문을 읽고 채운다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findPersona } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkNarrationV2 } from "@/domain/reading/check";
import { buildNarrationPlan, requestedTimingKey } from "@/domain/reading/focus";
import { emptyAnalysis, excludedItems, inScopeItems, itemDomain, seoulDate, type QuestionAnalysis } from "@/domain/reading/question";
import type { NarrationOutputV2 } from "@/domain/reading/types";
import type { TimingDomain } from "@/domain/rules/timing";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeTiming } from "@/server/engine/timing";
import { LlmError, type LlmUsage } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { classifyQuestion, mergeUsage, narrateReading, toStoredMessages } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";
import { answerAnalyzedFollowup, routeWithoutItems } from "@/server/readings/followup-core";

const SEOUL = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const BUSAN = { timezoneId: "Asia/Seoul", longitudeDeg: 129.03004, latitudeDeg: 35.10168, label: "부산광역시", source: "geonames:1838524" };

interface QualityCase {
  readonly id: string;
  readonly note: string;
  readonly nickname: string;
  readonly situationId: string | null;
  readonly concern: string;
  readonly birth: AnalyzeInput;
  readonly followups: readonly { readonly kind: string; readonly question: string; readonly expected: "answered" | "off_topic" | "clarify" }[];
}

/** 모두 가상의 입력이다. 실제 사용자 자료를 넣지 않는다. */
export const QUALITY_CASES: readonly QualityCase[] = [
  {
    id: "career-jobseeker",
    note: "일과 직업 · 취업 준비 · 시기와 비교가 섞인 질문 (문제 사례)",
    nickname: "가람",
    situationId: "job-seeking",
    concern: "언제 취업할까요? 취업보다 창업이 맞을까요?",
    birth: { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: SEOUL },
    followups: [
      { kind: "시기+비교 복합", question: "그러면 언제쯤 취업할 수 있을까요? 취업이 아니라 창업이나 개인 사업을 해야 할까요?", expected: "answered" },
      { kind: "짧은 문맥 질문", question: "그게 무슨 뜻이에요?", expected: "answered" },
    ],
  },
  {
    id: "career-employee-nofocus",
    note: "같은 사주 · 직장인 · 궁금한 점 없음 (상황 변경 비교용)",
    nickname: "가람",
    situationId: "employee",
    concern: "",
    birth: { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: SEOUL },
    followups: [{ kind: "강점 적용", question: "제 강점을 회사에서 인정받는 데 어떻게 쓰면 좋을까요?", expected: "answered" }],
  },
  {
    id: "temperament-student",
    note: "기본 성향 · 학생 · 같은 사주에서 질문만 다름",
    nickname: "가람",
    situationId: "student",
    concern: "제가 너무 성격이 급한 것 같은데 왜 그런 걸까요?",
    birth: { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: SEOUL },
    followups: [{ kind: "다른 주제로 이동", question: "그럼 연애할 때도 그 성격이 문제가 되나요?", expected: "answered" }],
  },
  {
    id: "wealth-selfemployed",
    note: "돈 · 자영업 · 명시 기간(내년 상반기)",
    nickname: "하늘",
    situationId: "self-employed",
    concern: "돈이 모이질 않아요. 내년 상반기 돈 흐름은 어떤가요?",
    birth: { birthDate: "1994-05-12", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "오" }, birthPlace: SEOUL },
    followups: [{ kind: "금전 관계 판단", question: "친구가 같이 가게를 하자는데 동업해도 될까요?", expected: "answered" }],
  },
  {
    id: "romance-mixed",
    note: "연애 · 시간 모름 · 관련 질문과 범위 밖(건강) 질문 혼합",
    nickname: "바람",
    situationId: "student",
    concern: "언제 새로운 인연을 만날까요? 그리고 요즘 건강이 안 좋은데 괜찮을까요?",
    birth: { birthDate: "2001-11-03", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" }, birthPlace: BUSAN },
    followups: [
      { kind: "돈 단어가 있는 연애 질문", question: "여자친구랑 데이트 비용 때문에 자꾸 싸워요. 어떻게 해야 할까요?", expected: "answered" },
      { kind: "결과 확정 질문", question: "그 사람이 저를 진짜 좋아하는지 알 수 있을까요?", expected: "answered" },
    ],
  },
  {
    id: "social-homemaker",
    note: "인간관계 · 가사·육아 · 시간 모름",
    nickname: "노을",
    situationId: "homemaker",
    concern: "사람 관계가 늘 어려워요. 왜 그런지 알고 싶어요.",
    birth: { birthDate: "1966-12-30", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" }, birthPlace: BUSAN },
    followups: [
      { kind: "범위 밖", question: "파이썬으로 정렬 코드 짜 줘", expected: "off_topic" },
      { kind: "범위 밖(투자)", question: "요즘 어떤 주식 사면 좋을까요?", expected: "off_topic" },
    ],
  },
  {
    id: "strengths-resting",
    note: "강점 · 쉬는 중 · 궁금한 점 없음",
    nickname: "이슬",
    situationId: "resting",
    concern: "",
    birth: { birthDate: "1979-08-21", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "자-새벽" }, birthPlace: SEOUL },
    followups: [{ kind: "강점 적용", question: "다시 일을 시작할 때 제 강점을 어떻게 내세우면 좋을까요?", expected: "answered" }],
  },
];

function readArg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
}

interface FollowupResult {
  readonly kind: string;
  readonly question: string;
  readonly expected: string;
  readonly status: string;
  readonly items: string;
  readonly answer: string;
  readonly calls: number;
}

interface CaseResult {
  readonly caseId: string;
  readonly note: string;
  readonly model: string;
  readonly status: "ok" | "failed";
  readonly errorCode?: string;
  readonly analysis?: string;
  readonly topicOrder?: string;
  readonly timing?: string;
  readonly bubbles?: number;
  readonly totalChars?: number;
  readonly checkIssues?: readonly string[];
  readonly calls?: number;
  readonly durationMs?: number;
  readonly usage?: LlmUsage;
  readonly text?: string;
  readonly followups?: readonly FollowupResult[];
}

const describeAnalysis = (analysis: QuestionAnalysis) =>
  analysis.items.length
    ? analysis.items.map((item) => `${item.id}:${item.domain}/${item.intent}/${item.scope}${item.period ? `(${item.period.startMonth}~${item.period.endMonth})` : ""} "${item.summary}"`).join("; ")
    : "(질문 없음)";

function timingFor(analysis: QuestionAnalysis, birth: ReturnType<typeof toPublicBirthInput>, referenceDate: string) {
  const requests = new Map<string, { domain: TimingDomain; period: NonNullable<ReturnType<typeof inScopeItems>[number]["period"]> }>();
  for (const item of inScopeItems(analysis)) {
    const key = requestedTimingKey(item);
    const domain = itemDomain(item);
    if (key && domain && item.period && !requests.has(key)) requests.set(key, { domain: domain as TimingDomain, period: item.period });
  }
  const entries = [...requests.entries()];
  const analyses = analyzeTiming({ birth, referenceDate, requests: entries.map(([, request]) => request) });
  return entries.map(([requestKey], index) => ({ requestKey, analysis: analyses[index]! }));
}

async function runCase(entry: QualityCase, model: string, referenceDate: string): Promise<CaseResult> {
  const persona = findPersona(FIRST_OVERVIEW.personaId)!;
  const product = FIRST_OVERVIEW;
  const birth = toPublicBirthInput(entry.birth);
  const base = analyzeBirth({ birth, product, nickname: entry.nickname, situationId: entry.situationId });
  const startedAt = Date.now();
  let usage: LlmUsage | null = null;
  let calls = 0;
  try {
    let analysis = emptyAnalysis(referenceDate);
    if (entry.concern.trim()) {
      const classified = await classifyQuestion({ product, referenceDate, mode: "initial", text: entry.concern, lastTurn: null, modelId: model });
      analysis = classified.analysis;
      usage = mergeUsage(usage, classified.meta.usage);
      calls += classified.meta.llmCalls;
    }
    const timing = timingFor(analysis, birth, referenceDate);
    const plan = buildNarrationPlan({ base: base.plan, product, analysis, timing });
    const excluded = excludedItems(analysis).map(({ summary, domain }) => ({ summary, domain }));
    const { output, meta } = await narrateReading({
      narration: { version: "2.0.0", plan, excluded },
      chart: base.chart,
      persona,
      config: { modelId: model, promptVersion: CURRENT_READING_PROMPT, schemaVersion: NARRATION_SCHEMA_VERSION, reasoningEffort: LLM_SETTINGS.tasks.reading.reasoningEffort },
    });
    usage = mergeUsage(usage, meta.usage);
    calls += meta.llmCalls;
    const messages = toStoredMessages(output, product.focusSection.id);

    const followups: FollowupResult[] = [];
    let lastTurn: { question: string; answer: string } | null = null;
    for (const followup of entry.followups) {
      const classified = await classifyQuestion({ product, referenceDate, mode: "followup", text: followup.question, lastTurn, modelId: model });
      usage = mergeUsage(usage, classified.meta.usage);
      let followupCalls = classified.meta.llmCalls;
      let status: string;
      let answer: string;
      if (!inScopeItems(classified.analysis).length) {
        ({ status, answer } = routeWithoutItems(product, classified.analysis));
      } else {
        const answered = await answerAnalyzedFollowup({
          plan: base.plan,
          product,
          persona,
          chart: base.chart,
          analysis: classified.analysis,
          initialAnalysis: analysis,
          timing: timingFor(classified.analysis, birth, referenceDate),
          messages,
          lastTurn,
          modelId: model,
        });
        usage = mergeUsage(usage, answered.meta.usage);
        followupCalls += answered.meta.llmCalls;
        status = answered.status;
        answer = answered.answer;
        if (status === "answered") lastTurn = { question: followup.question, answer: answer.slice(0, 600) };
      }
      calls += followupCalls;
      followups.push({ kind: followup.kind, question: followup.question, expected: followup.expected, status, items: describeAnalysis(classified.analysis), answer, calls: followupCalls });
    }

    return {
      caseId: entry.id,
      note: entry.note,
      model,
      status: "ok",
      analysis: describeAnalysis(analysis),
      topicOrder: plan.topics.map((topic) => `${topic.topicId}(${topic.weight}/${topic.target})`).join(" → "),
      timing: plan.timing
        .map((item) => `${item.domain} ${item.windowLabel} ${item.status} 주목:${item.notableRefs.map((ref) => item.months.find((month) => month.ref === ref)?.label).join(",")} 조심:${item.carefulRefs.map((ref) => item.months.find((month) => month.ref === ref)?.label).join(",")}`)
        .join(" / "),
      bubbles: messages.length,
      totalChars: messages.reduce((sum, message) => sum + message.text.length, 0),
      checkIssues: checkNarrationV2(output as NarrationOutputV2, plan, base.chart, excluded),
      calls,
      durationMs: Date.now() - startedAt,
      usage: usage ?? undefined,
      text: messages.map((message) => `- (${message.kind}${message.topicId ? `/${message.topicId}` : ""}) ${message.text}`).join("\n"),
      followups,
    };
  } catch (error) {
    return { caseId: entry.id, note: entry.note, model, status: "failed", errorCode: error instanceof LlmError ? `${error.code}: ${error.message}` : String(error), calls, durationMs: Date.now() - startedAt };
  }
}

function report(results: readonly CaseResult[], models: readonly string[], referenceDate: string): string {
  const lines = [
    `# 풀이 품질 확인 ${referenceDate}`,
    "",
    `모델: ${models.join(", ")} · 프롬프트 ${CURRENT_READING_PROMPT} · 출력 형식 ${NARRATION_SCHEMA_VERSION} · 기준일 ${referenceDate} (Asia/Seoul)`,
    "",
    "가상 입력으로 생성했다. 자동 항목은 실행 결과이고, 체크리스트는 사람이 본문을 읽고 채운다.",
    "",
    "## 자동 집계",
    "",
    "| 사례 | 모델 | 상태 | 말풍선 | 글자 수 | 검사 문제 | 후속 질문 기대 일치 | 호출 수 | 시간(ms) | 입력 토큰 | 출력 토큰 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const matched = result.followups ? `${result.followups.filter((item) => item.status === item.expected).length}/${result.followups.length}` : "-";
    lines.push(
      `| ${result.caseId} | ${result.model} | ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""} | ${result.bubbles ?? "-"} | ${result.totalChars ?? "-"} | ${result.checkIssues?.length ?? "-"} | ${matched} | ${result.calls ?? "-"} | ${result.durationMs ?? "-"} | ${result.usage?.inputTokens ?? "-"} | ${result.usage?.outputTokens ?? "-"} |`,
    );
  }
  lines.push(
    "",
    "## 사람이 확인할 항목",
    "",
    "- [ ] 질문에 대한 핵심 답이 앞에 분명하게 나온다",
    "- [ ] 결론마다 이유가 있다",
    "- [ ] 같은 설명이 여러 주제에서 반복되지 않는다",
    "- [ ] 구체적인 예시와 활용 방법이 있다",
    "- [ ] 근거 있는 약점이 지나치게 순화되지 않았다",
    "- [ ] 근거 없는 과거·미래를 만들지 않았다",
    "- [ ] 창작 장면이 판단 문장 바꿔 쓰기에 그치지 않는다",
    "- [ ] 캐릭터 말투가 유지된다",
    "- [ ] 시기 답변이 살펴본 기간과 근거를 밝히고 사건을 확정하지 않는다",
    "- [ ] 범위 밖 질문이 본문에 다시 나오지 않는다",
    "",
    "## 본문",
  );
  for (const result of results) {
    lines.push("", `### ${result.caseId} / ${result.model}`, "", `- 사례: ${result.note}`);
    if (result.status === "failed") {
      lines.push(`- 실패: ${result.errorCode}`);
      continue;
    }
    lines.push(`- 질문 분석: ${result.analysis}`, `- 주제 순서: ${result.topicOrder}`, `- 기간 분석: ${result.timing || "(없음)"}`, `- 검사 문제: ${result.checkIssues?.length ? result.checkIssues.join(" / ") : "없음"}`, "", result.text ?? "");
    for (const followup of result.followups ?? []) {
      lines.push("", `**Q (${followup.kind}, 기대 ${followup.expected}, 결과 ${followup.status}, 호출 ${followup.calls}회)** ${followup.question}`, "", `- 분석: ${followup.items}`, "", followup.answer);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const models = (readArg("models") ?? "gpt-5.6-luna,gpt-6-luna").split(",").map((model) => model.trim());
  const selected = readArg("cases")?.split(",");
  const cases = QUALITY_CASES.filter((entry) => !selected || selected.includes(entry.id));
  const referenceDate = readArg("date") ?? seoulDate();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log(JSON.stringify({ result: "LIVE_NOT_RUN", reason: "OPENAI_API_KEY 없음", models, cases: cases.length }));
    return;
  }
  const results: CaseResult[] = [];
  for (const entry of cases) {
    for (const model of models) {
      console.log(`실행: ${entry.id} / ${model}`);
      const result = await runCase(entry, model, referenceDate);
      console.log(`  ${result.status} 말풍선 ${result.bubbles ?? "-"} 검사 ${result.checkIssues?.length ?? "-"} 호출 ${result.calls ?? "-"} ${result.durationMs ?? "-"}ms ${result.errorCode ?? ""}`);
      results.push(result);
    }
  }
  const dir = path.resolve(readArg("out") ?? "docs/model-comparison");
  mkdirSync(dir, { recursive: true });
  const stamp = `${referenceDate}-${models.join("+")}`;
  const file = path.join(dir, `${stamp}.md`);
  writeFileSync(file, report(results, models, referenceDate));
  writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(`결과 저장: ${file}`);
}

void main();
