/**
 * 출시 전 모델 비교. 같은 가상 입력과 판단 재료로 두 모델의 풀이를 만들어 기록한다.
 *
 *   npm run llm:compare                                       gpt-5.6-luna와 gpt-6-luna 비교
 *   npm run llm:compare -- --models=gpt-5.6-luna,gpt-6-luna --cases=3
 *
 * 실제 API를 호출해 비용이 발생한다. 결과는 docs/model-comparison/에 저장하며,
 * 자동 항목 외의 품질 평가는 사람이 결과를 읽고 채운다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findPersona } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkFollowup, checkNarration } from "@/domain/reading/check";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import { answerFollowup, narrateReading, toStoredMessages, type GenerationMeta } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";

const SEOUL = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const BUSAN = { timezoneId: "Asia/Seoul", longitudeDeg: 129.03004, latitudeDeg: 35.10168, label: "부산광역시", source: "geonames:1838524" };

/** 모두 가상의 입력이다. 실제 사용자 자료를 넣지 않는다. */
const CASES: readonly { id: string; note: string; nickname: string; situationId: string | null; concern: string; birth: AnalyzeInput }[] = [
  { id: "case-1", note: "시진 입력, 상황과 고민 있음", nickname: "하늘", situationId: "employee", concern: "지금 하는 일을 계속해도 될지 고민이에요", birth: { birthDate: "1994-05-12", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "오" }, birthPlace: SEOUL } },
  { id: "case-2", note: "시간 모름", nickname: "바람", situationId: "student", concern: "", birth: { birthDate: "2001-11-03", calendar: "solar", isLeapMonth: false, gender: "male", birthTime: { status: "unknown" }, birthPlace: BUSAN } },
  { id: "case-3", note: "음력 입력", nickname: "구름", situationId: null, concern: "", birth: { birthDate: "1988-03-15", calendar: "lunar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "인" }, birthPlace: SEOUL } },
  { id: "case-4", note: "윤달 입력", nickname: "서리", situationId: "job-seeking", concern: "취업이 언제 될까요", birth: { birthDate: "2023-02-15", calendar: "lunar", isLeapMonth: true, gender: "male", birthTime: { status: "branch", branch: "자-밤" }, birthPlace: BUSAN } },
  { id: "case-5", note: "새벽 자시", nickname: "이슬", situationId: "self-employed", concern: "", birth: { birthDate: "1979-08-21", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "자-새벽" }, birthPlace: SEOUL } },
  { id: "case-6", note: "시간 모름, 고민 있음", nickname: "노을", situationId: "homemaker", concern: "사람 관계가 늘 어려워요", birth: { birthDate: "1966-12-30", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "unknown" }, birthPlace: BUSAN } },
];

const FOLLOWUPS = [
  { kind: "관련 질문", question: "제 강점을 일할 때는 어떻게 쓰면 좋을까요?", expected: "related" },
  { kind: "짧은 문맥 질문", question: "그게 무슨 뜻이에요?", expected: "related" },
  { kind: "관련 없는 질문", question: "파이썬으로 정렬 코드 짜 줘", expected: "unrelated" },
] as const;

function readArg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
}

type CaseResult = {
  caseId: string;
  model: string;
  status: "ok" | "failed";
  errorCode?: string;
  meta?: GenerationMeta;
  bubbles?: number;
  checkIssues?: string[];
  text?: string;
  followups?: { kind: string; expected: string; relevance: string; matched: boolean; issues: string[]; answer: string }[];
};

async function runCase(entry: (typeof CASES)[number], model: string): Promise<CaseResult> {
  const persona = findPersona(FIRST_OVERVIEW.personaId)!;
  const analysis = analyzeBirth({
    birth: toPublicBirthInput(entry.birth),
    product: FIRST_OVERVIEW,
    nickname: entry.nickname,
    situationId: entry.situationId,
    concern: entry.concern,
  });
  try {
    const { output, meta } = await narrateReading({
      plan: analysis.plan,
      chart: analysis.chart,
      persona,
      config: { modelId: model, promptVersion: CURRENT_READING_PROMPT, schemaVersion: NARRATION_SCHEMA_VERSION, reasoningEffort: LLM_SETTINGS.reasoningEffort },
    });
    const messages = toStoredMessages(output);
    const followups: NonNullable<CaseResult["followups"]> = [];
    let recentConversation: { question: string; answer: string }[] = [];
    for (const followup of FOLLOWUPS) {
      const result = await answerFollowup({ plan: analysis.plan, chart: analysis.chart, persona, messages, recentConversation, question: followup.question, modelId: model });
      followups.push({
        kind: followup.kind,
        expected: followup.expected,
        relevance: result.output.relevance,
        matched: result.output.relevance === followup.expected,
        issues: checkFollowup(result.output, analysis.plan, analysis.chart),
        answer: result.output.answer,
      });
      if (result.output.relevance === "related") recentConversation = [...recentConversation, { question: followup.question, answer: result.output.answer }];
    }
    return {
      caseId: entry.id,
      model,
      status: "ok",
      meta,
      bubbles: messages.length,
      checkIssues: checkNarration(output, analysis.plan, analysis.chart),
      text: messages.map((message) => `- (${message.kind}${message.topicId ? `/${message.topicId}` : ""}) ${message.text}`).join("\n"),
      followups,
    };
  } catch (error) {
    return { caseId: entry.id, model, status: "failed", errorCode: error instanceof LlmError ? error.code : "internal" };
  }
}

function report(results: readonly CaseResult[], models: readonly string[], date: string): string {
  const lines = [`# 모델 비교 결과 ${date}`, "", `비교 모델: ${models.join(", ")}`, "", "가상 입력으로 생성했다. 자동 항목은 실행 결과이고, 체크리스트는 사람이 본문을 읽고 채운다.", "", "## 자동 집계", "", "| 사례 | 모델 | 상태 | 말풍선 | 검사 문제 | 관련성 일치 | 지연(ms) | 입력 토큰 | 출력 토큰 | 호출 수 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const result of results) {
    const matched = result.followups ? `${result.followups.filter((item) => item.matched).length}/${result.followups.length}` : "-";
    lines.push(`| ${result.caseId} | ${result.model} | ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""} | ${result.bubbles ?? "-"} | ${result.checkIssues?.length ?? "-"} | ${matched} | ${result.meta?.durationMs ?? "-"} | ${result.meta?.usage.inputTokens ?? "-"} | ${result.meta?.usage.outputTokens ?? "-"} | ${result.meta?.llmCalls ?? "-"} |`);
  }
  lines.push("", "## 사람이 확인할 항목", "", "사례별 본문을 읽고 표시한다.", "", "- [ ] 계산·판단 근거와 설명이 일치한다", "- [ ] 근거 없는 해석이 추가되지 않았다", "- [ ] 캐릭터 말투가 유지된다", "- [ ] 반복과 불필요한 장문이 없다", "- [ ] 출생시간 미상 등 제한이 반영되었다", "- [ ] 창작 장면과 계산 정보가 구분된다", "- [ ] 후속 질문의 관련성 처리가 맞다", "", "## 본문");
  for (const result of results) {
    lines.push("", `### ${result.caseId} / ${result.model}`, "", result.text ?? `실패: ${result.errorCode}`);
    for (const followup of result.followups ?? []) {
      lines.push("", `Q (${followup.kind}, 기대 ${followup.expected}, 결과 ${followup.relevance}) A: ${followup.answer || "(답변 없음)"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const models = (readArg("models") ?? "gpt-5.6-luna,gpt-6-luna").split(",").map((model) => model.trim());
  const cases = CASES.slice(0, Number(readArg("cases") ?? CASES.length));
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log(JSON.stringify({ result: "LIVE_NOT_RUN", reason: "OPENAI_API_KEY 없음", models, cases: cases.length }));
    return;
  }
  const results: CaseResult[] = [];
  for (const entry of cases) {
    for (const model of models) {
      console.log(`실행: ${entry.id} / ${model}`);
      results.push(await runCase(entry, model));
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.resolve("docs/model-comparison");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  writeFileSync(file, report(results, models, date));
  console.log(`결과 저장: ${file}`);
}

void main();
