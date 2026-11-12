/**
 * 실제 모델 비교용 지시·입력·출력 형식을 파일로 만든다. 모델을 부르지 않고 API 키도 읽지 않는다.
 *
 *   npm run llm:export -- --case=job-seeking                          현재 지시 (reading-3.2.0, 묘묘 문답 예시 포함)
 *   npm run llm:export -- --case=job-seeking --prompt=reading-3.1.0   예시 없는 비교용 지시 (그 버전의 캐릭터 설정과 함께)
 *   npm run llm:export -- --case=job-seeking --task=followup [--reaction=praise|tease|doubt] [--prompt=followup-3.1.0]
 *                                                                       후속 답변 요청 (사례의 질문을 후속 질문으로 쓴다)
 *   --date=2026-11-12 (기준일, 기본 오늘) --out=<폴더> (기본 docs/model-comparison/prompts)
 *   PowerShell에서는 -- 를 따옴표로 감싼다: npm run llm:export '--' --case=job-seeking
 *
 * 예시를 쓰는 버전은 `<파일>.examples.md`에 넣은 예시 ID, 고른 조건, 지시 파일 안의 위치를 적는다. 예시는 지시(instructions) 맨 끝의
 * [캐릭터 문답 예시] 블록에만 있고 입력(input)에는 없다. 예시를 고르는 순서 값은 사례 ID(llm-export:<사례>)다 (운영은 풀이·후속 질문 ID).
 *
 * 사례는 scripts/llm-cases.ts (docs/personas/myomyo-evaluation.md 2절). 만든 파일을 OpenAI 플레이그라운드에 붙여
 * 같은 입력에서 버전만 바꿔 실행하고, 결과는 npm run llm:render로 읽는다. 스크립트의 실제 호출은 막혀 있으므로
 * (src/server/llm/config.ts의 liveCallBlockReason) 실제 실행은 사용자가 플레이그라운드에서 직접 한다.
 *
 * 묘묘 2-pass(myomyo-2pass-1.0.0)의 예시 사용·미사용 비교는 --task=two-pass를 준다 (scripts/myomyo-two-pass.ts).
 *   npm run llm:export '--' --case=job-seeking --task=two-pass [--draft=<Pass 1 결과>]
 *   Pass 1 묶음 요청을 쓰고, 사례 폴더의 Pass 1 결과가 있으면 단위마다 같은 초안의 Pass 2 요청을 예시 사용·미사용 두 벌 쓴다.
 *
 * 무진의 종합 사주는 --product=mujin-overview를 준다 (scripts/mujin-llm.ts, docs/personas/mujin-evaluation.md 3절).
 *   npm run llm:export '--' --product=mujin-overview --case=side-job-money [--reference=2026-11-12] [--bundle=mujin-1.0.0] [--dir=<사례 폴더>] [--draft=<Pass 1 결과>]
 *   Pass 1 묶음별 요청을 쓰고, 사례 폴더에 저장한 Pass 1 결과(또는 --draft)가 있으면 장별 Pass 2 요청과 마지막 정리 요청을 쓴다.
 * --product를 주지 않으면(또는 first-overview) 아래 묘묘 내보내기를 한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findExampleCatalog, type CharacterExample, type ExampleRequest } from "@/domain/personas/examples";
import { findPersona } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { REACTIONS, seoulDate, type Reaction } from "@/domain/reading/question";
import type { NarrationPlanV2 } from "@/domain/reading/types";
import { LLM_SETTINGS } from "@/server/llm/config";
import { promptExampleConfig, type ExampleRecord } from "@/server/llm/example-block";
import {
  CURRENT_FOLLOWUP_PROMPT,
  CURRENT_READING_PROMPT,
  buildFollowupPrompt,
  followupExampleRequest,
  getNarrationSchema,
  getReadingPrompt,
  hasReadingPrompt,
  isPlanV2Prompt,
  NARRATION_SCHEMA_VERSION,
  personaVersionFor,
  readingExampleRequest,
  type FollowupPromptArgs,
} from "@/server/llm/prompts";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { casePlan, EVALUATION_CASES, readArg, readOption, type EvaluationCase } from "./llm-cases";

const yesNo = (value: boolean) => (value ? "예" : "아니오");

/**
 * 사람이 읽는 예시 보고서. 어떤 예시가 어느 위치에 들어갔는지, 왜 골랐는지(선택 조건)를 적는다. 예시 문장은 지시 파일에 있다.
 */
export function examplesReport(input: {
  readonly title: string;
  readonly stem: string;
  readonly instructions: string;
  readonly record: ExampleRecord;
  readonly request: Omit<ExampleRequest, "route">;
  readonly baseline: string;
}): string {
  const { record, request } = input;
  const catalog = findExampleCatalog(record.catalogVersion);
  const lines = input.instructions.split("\n");
  const start = lines.findIndex((line) => line.startsWith("[캐릭터 문답 예시:"));
  const end = lines.findIndex((line) => line === "[캐릭터 문답 예시 끝]");
  const describe = (id: string) => {
    const example = catalog?.examples.find((entry: CharacterExample) => entry.id === id);
    const rewrite = catalog?.rewrites.find((entry) => entry.id === id);
    if (rewrite) return `| ${id} | 재작성 (원문 ${rewrite.sourceExampleId}) | ${rewrite.topics.join(", ")} | 중립 초안 → 같은 뜻의 캐릭터 글 | - |`;
    if (!example) return `| ${id} | ? | ? | ? | ? |`;
    return `| ${id} | ${example.setId} (${example.source.kind}) | ${example.topics.join(", ")} | ${example.purposes.join(", ")} · ${example.length} | ${example.question.replace(/\|/g, "\\|")} |`;
  };
  return [
    `# 문답 예시: ${input.title}`,
    "",
    `- 카탈로그 \`${record.catalogVersion}\` · 선택 정책 \`${record.policyVersion}\` · 경로 \`${record.route}\` · 순서 값 \`${request.seed}\``,
    `- 선택 조건: 주제 [${request.topics.join(", ")}] · 긴 설명 ${yesNo(request.long)} · 진지한 상황 ${yesNo(request.serious)} · 반응 ${request.reaction} · 질문 의도 [${request.intents.join(", ")}] · 확정할 수 없는 질문 ${yesNo(request.limited)} · 출생 시각 모름 ${yesNo(request.hourUnknown)} · 직전 대화 ${yesNo(request.hasLastTurn)}`,
    `- 위치: \`${input.stem}.instructions.txt\`의 ${start + 1}번째 줄부터 ${end + 1}번째 줄까지 (지시 맨 끝, \`[캐릭터 문답 예시: …]\` ~ \`[캐릭터 문답 예시 끝]\`). 사용자 메시지(\`${input.stem}.input.json\`)에는 예시가 없다.`,
    `- 예시 없는 비교: ${input.baseline}. 지시 앞부분은 글자까지 같고 끝의 예시 블록만 다르다.`,
    "",
    "| 예시 ID | 세트 (출처) | 주제 | 표현 목적 · 길이 | 예시 질문 |",
    "| --- | --- | --- | --- | --- |",
    ...record.ids.map(describe),
    "",
    "예시 문장은 표현 참고이며 현재 사용자의 사실·판단이 아니다. 결과에서 예시 문장·장면·날짜가 그대로 나오면 비교 기록에 적는다 (docs/personas/examples.md 8절, llm:render의 '예시 문장 겹침' 표).",
    "",
  ].join("\n");
}

function writeFiles(dir: string, stem: string, files: readonly (readonly [string, string])[]): string[] {
  mkdirSync(dir, { recursive: true });
  return files.map(([suffix, content]) => {
    const file = path.join(dir, `${stem}${suffix}`);
    writeFileSync(file, content);
    return file;
  });
}

function requestJson(instructions: string, input: string, schemaName: string, jsonSchema: Record<string, unknown>, task: { readonly reasoningEffort: string; readonly maxOutputTokens: number }) {
  // 직접 요청을 보내는 도구를 쓸 때의 Responses API 본문. 모델과 추론 설정은 운영과 같게 둔다 (모델은 비교할 것으로 바꾼다).
  return JSON.stringify(
    {
      model: "<OPENAI_MODEL과 같은 모델>",
      instructions,
      input,
      reasoning: { effort: task.reasoningEffort },
      max_output_tokens: task.maxOutputTokens,
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema: jsonSchema } },
    },
    null,
    2,
  );
}

const exampleSeedOf = (entry: EvaluationCase) => `llm-export:${entry.id}`;

/** 묘묘의 사주 참견(first-overview) 최초 풀이 내보내기. */
function exportMyomyoReading(entry: EvaluationCase, referenceDate: string) {
  const promptVersion = readArg("prompt") ?? CURRENT_READING_PROMPT;
  if (!hasReadingPrompt(promptVersion) || !isPlanV2Prompt(promptVersion)) {
    console.log(`알 수 없는 프롬프트: ${promptVersion}`);
    return;
  }
  // 운영과 같이 그 프롬프트 버전에 맞는 캐릭터 설정을 쓴다.
  const persona = findPersona("myomyo", personaVersionFor(promptVersion))!;
  const { plan } = casePlan(entry, referenceDate);
  const args = { plan, persona, previousIssues: [], exampleSeed: exampleSeedOf(entry) };
  const { instructions, input, examples } = getReadingPrompt(promptVersion)(args);
  const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);

  const dir = path.resolve(readArg("out") ?? "docs/model-comparison/prompts");
  const stem = `${referenceDate}_${entry.id}_${promptVersion}`;
  const files = writeFiles(dir, stem, [
    [".instructions.txt", instructions],
    [".input.json", JSON.stringify(JSON.parse(input), null, 2)],
    [".schema.json", JSON.stringify({ name: schema.name, strict: true, schema: schema.jsonSchema }, null, 2)],
    [".request.json", requestJson(instructions, input, schema.name, schema.jsonSchema, LLM_SETTINGS.tasks.reading)],
    ...(examples
      ? ([
          [
            ".examples.md",
            examplesReport({
              title: `${entry.id} 최초 풀이 (${promptVersion})`,
              stem,
              instructions,
              record: examples,
              request: readingExampleRequest(args),
              baseline: `\`npm run llm:export '--' --case=${entry.id} --date=${referenceDate} --prompt=reading-3.1.0\``,
            }),
          ],
        ] as const)
      : []),
  ]);
  console.log(
    JSON.stringify({
      case: entry.id,
      note: entry.note,
      prompt: promptVersion,
      personaVersion: persona.version,
      referenceDate,
      instructionsChars: instructions.length,
      inputChars: input.length,
      topics: plan.topics.map((topic) => topic.topicId),
      questions: plan.questions.map((question) => question.summary),
      examples: examples?.ids ?? [],
      files,
    }),
  );
}

/**
 * 후속 답변 요청 내보내기. 사례의 질문을 후속 질문으로 보고, 운영 answerAnalyzedFollowup처럼 그 질문 분야의 주제 해석과 기간 재료를 넣는다.
 * 운영과 다른 점: 앞서 보낸 풀이 말풍선(delivered)과 직전 대화(lastTurn)는 비워 둔다. 반응은 --reaction으로 정한다.
 */
function followupArgs(entry: EvaluationCase, plan: NarrationPlanV2, reaction: Reaction, promptVersion: string): FollowupPromptArgs {
  const persona = findPersona("myomyo", personaVersionFor(promptVersion))!;
  const topicIds = new Set(plan.questions.map((question) => question.topicId).filter((id): id is string => Boolean(id)));
  const relevant = topicIds.size ? plan.topics.filter((topic) => topicIds.has(topic.topicId)) : plan.topics;
  return {
    promptVersion,
    persona,
    nickname: plan.base.nickname,
    hourKnown: plan.base.hourKnown,
    expression: FIRST_OVERVIEW.expression,
    situation: plan.base.situation ? { label: plan.base.situation.label, context: plan.base.situation.context } : null,
    facts: plan.base.facts.map(({ ref, text }) => ({ ref, text })),
    // 사례의 사용자 사실은 이번 메시지에서 알려 준 것으로 둔다.
    userContext: plan.userContext.map((item) => (item.source === "fact" ? { ...item, source: "message" as const } : item)),
    questions: plan.questions,
    statements: topicIds.size ? relevant.flatMap((topic) => topic.statements) : plan.topics.flatMap((topic) => topic.statements.slice(0, 2)),
    timing: plan.timing,
    delivered: [],
    lastTurn: null,
    reaction,
    previousIssues: [],
    exampleSeed: exampleSeedOf(entry),
  };
}

function exportMyomyoFollowup(entry: EvaluationCase, referenceDate: string) {
  const promptVersion = readArg("prompt") ?? CURRENT_FOLLOWUP_PROMPT;
  const reaction = (readArg("reaction") ?? "none") as Reaction;
  if (!(REACTIONS as readonly string[]).includes(reaction)) {
    console.log(`알 수 없는 반응: ${reaction} (--reaction=${REACTIONS.join("|")})`);
    return;
  }
  const { plan } = casePlan(entry, referenceDate);
  if (!plan.questions.length) {
    console.log(`${entry.id}: 질문이 없는 사례라 후속 질문 요청을 만들 수 없습니다.`);
    return;
  }
  let prompt: ReturnType<typeof buildFollowupPrompt>;
  const args = followupArgs(entry, plan, reaction, promptVersion);
  try {
    prompt = buildFollowupPrompt(args);
  } catch {
    console.log(`알 수 없는 후속 프롬프트: ${promptVersion} (followup-3.1.0|followup-3.2.0)`);
    return;
  }
  const dir = path.resolve(readArg("out") ?? "docs/model-comparison/prompts");
  const stem = `${referenceDate}_${entry.id}_${promptVersion}${reaction === "none" ? "" : `_${reaction}`}`;
  const task = LLM_SETTINGS.tasks.followup;
  const files = writeFiles(dir, stem, [
    [".instructions.txt", prompt.instructions],
    [".input.json", JSON.stringify(JSON.parse(prompt.input), null, 2)],
    [".schema.json", JSON.stringify({ name: prompt.schemaName, strict: true, schema: prompt.jsonSchema }, null, 2)],
    [".request.json", requestJson(prompt.instructions, prompt.input, prompt.schemaName, prompt.jsonSchema, task)],
    ...(prompt.examples
      ? ([
          [
            ".examples.md",
            examplesReport({
              title: `${entry.id} 후속 답변 (${promptVersion}, 반응 ${reaction})`,
              stem,
              instructions: prompt.instructions,
              record: prompt.examples,
              request: followupExampleRequest(args),
              baseline: `\`npm run llm:export '--' --case=${entry.id} --date=${referenceDate} --task=followup --prompt=followup-3.1.0${reaction === "none" ? "" : ` --reaction=${reaction}`}\``,
            }),
          ],
        ] as const)
      : []),
  ]);
  console.log(
    JSON.stringify({
      case: entry.id,
      task: "followup",
      prompt: promptVersion,
      reaction,
      referenceDate,
      instructionsChars: prompt.instructions.length,
      inputChars: prompt.input.length,
      questions: plan.questions.map((question) => question.summary),
      examples: prompt.examples?.ids ?? [],
      exampleConfig: promptExampleConfig(promptVersion) ?? null,
      files,
    }),
  );
}

/** 묘묘의 사주 참견(first-overview) 내보내기. --task=followup이면 후속 답변 요청을 만든다. */
function exportMyomyo() {
  const entry = EVALUATION_CASES.find((item) => item.id === readArg("case"));
  if (!entry) {
    console.log(`사례를 고르세요: --case=${EVALUATION_CASES.map((item) => item.id).join("|")}`);
    return;
  }
  const referenceDate = readArg("date") ?? seoulDate();
  const task = readArg("task") ?? "reading";
  if (task === "followup") return exportMyomyoFollowup(entry, referenceDate);
  if (task === "two-pass") {
    // 2-pass 비교 모듈은 이 작업을 고를 때만 불러온다.
    void import("./myomyo-two-pass").then((module) => module.exportMyomyoTwoPass(entry, referenceDate));
    return;
  }
  if (task !== "reading") {
    console.log(`알 수 없는 작업: ${task} (--task=reading|followup|two-pass)`);
    return;
  }
  exportMyomyoReading(entry, referenceDate);
}

function main() {
  const product = readOption("product");
  if (product === MUJIN_OVERVIEW.id) {
    // 무진 작성 계획·요청 모듈(scripts/mujin-llm.ts)은 무진을 고를 때만 불러온다.
    import("./mujin-llm")
      .then((mujin) => mujin.exportMujinCli())
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    return;
  }
  if (product !== undefined && product !== FIRST_OVERVIEW.id) {
    console.log(`알 수 없는 상품: ${product} (--product=${FIRST_OVERVIEW.id}|${MUJIN_OVERVIEW.id})`);
    return;
  }
  exportMyomyo();
}

main();
