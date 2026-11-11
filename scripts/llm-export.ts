/**
 * 실제 모델 비교용 지시·입력·출력 형식을 파일로 만든다. 모델을 부르지 않고 API 키도 읽지 않는다.
 *
 *   npm run llm:export -- --case=job-seeking                          운영과 같은 지시 (reading-3.0.0)
 *   npm run llm:export -- --case=job-seeking --rules=minimal          짧은 성격 설정과 판단만
 *   npm run llm:export -- --case=job-seeking --material=consult       상담 문장 묶음 재료 (2.7.0~2.9.0 방식)
 *   npm run llm:export -- --case=job-seeking --topics=first           첫 주제와 질문 답만
 *   npm run llm:export -- --case=job-seeking --prompt=reading-2.9.0   이전 지시 (이전 캐릭터 설정과 함께)
 *   --date=2026-11-11 (기준일, 기본 오늘) --out=<폴더> (기본 docs/model-comparison/prompts)
 *
 * 사례는 scripts/llm-cases.ts (docs/personas/myomyo-evaluation.md 2절). 만든 파일을 OpenAI 플레이그라운드에 붙여
 * 같은 입력에서 조건만 바꿔 실행하고, 결과는 npm run llm:render로 읽는다. 스크립트의 실제 호출은 막혀 있으므로
 * (src/server/llm/config.ts의 liveCallBlockReason) 실제 실행은 사용자가 플레이그라운드에서 직접 한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seoulDate } from "@/domain/reading/question";
import {
  buildReadingExperiment,
  CURRENT_READING_PROMPT,
  DEFAULT_EXPERIMENT,
  getNarrationSchema,
  getReadingPrompt,
  isPlanV2Prompt,
  NARRATION_SCHEMA_VERSION,
  promptPersona,
  type ReadingExperiment,
} from "@/server/llm/prompts";
import { casePlan, EVALUATION_CASES, readArg } from "./llm-cases";

export function experimentFromArgs(): ReadingExperiment {
  return {
    rules: readArg("rules") === "minimal" ? "minimal" : DEFAULT_EXPERIMENT.rules,
    material: readArg("material") === "consult" ? "consult" : DEFAULT_EXPERIMENT.material,
    topics: readArg("topics") === "first" ? "first" : DEFAULT_EXPERIMENT.topics,
  };
}

export const tagOf = (promptVersion: string, experiment: ReadingExperiment) =>
  promptVersion !== CURRENT_READING_PROMPT ? promptVersion : `${promptVersion}_rules-${experiment.rules}_material-${experiment.material}_topics-${experiment.topics}`;

function main() {
  const caseId = readArg("case");
  const entry = EVALUATION_CASES.find((item) => item.id === caseId);
  if (!entry) {
    console.log(`사례를 고르세요: --case=${EVALUATION_CASES.map((item) => item.id).join("|")}`);
    return;
  }
  const referenceDate = readArg("date") ?? seoulDate();
  const promptVersion = readArg("prompt") ?? CURRENT_READING_PROMPT;
  const experiment = experimentFromArgs();
  const persona = promptPersona("myomyo", promptVersion);
  if (!isPlanV2Prompt(promptVersion) || !persona) {
    console.log(`알 수 없는 프롬프트: ${promptVersion}`);
    return;
  }
  const changed = experiment.rules !== DEFAULT_EXPERIMENT.rules || experiment.material !== DEFAULT_EXPERIMENT.material || experiment.topics !== DEFAULT_EXPERIMENT.topics;
  if (promptVersion !== CURRENT_READING_PROMPT && changed) {
    console.log("--prompt는 조건 옵션(--rules, --material, --topics)과 함께 쓰지 않는다.");
    return;
  }

  const { plan } = casePlan(entry, referenceDate);
  const args = { plan, persona, previousIssues: [] };
  const { instructions, input } = promptVersion === CURRENT_READING_PROMPT ? buildReadingExperiment(args, experiment) : getReadingPrompt(promptVersion)(args);
  const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);

  const dir = path.resolve(readArg("out") ?? "docs/model-comparison/prompts");
  mkdirSync(dir, { recursive: true });
  const stem = path.join(dir, `${referenceDate}_${entry.id}_${tagOf(promptVersion, experiment)}`);
  writeFileSync(`${stem}.instructions.txt`, instructions);
  writeFileSync(`${stem}.input.json`, JSON.stringify(JSON.parse(input), null, 2));
  writeFileSync(`${stem}.schema.json`, JSON.stringify({ name: schema.name, strict: true, schema: schema.jsonSchema }, null, 2));
  // 직접 요청을 보내는 도구를 쓸 때의 Responses API 본문. model은 비교할 모델로 바꾼다. 추론 설정은 운영과 같은 low.
  writeFileSync(
    `${stem}.request.json`,
    JSON.stringify(
      {
        model: "<비교할 모델>",
        instructions,
        input,
        reasoning: { effort: "low" },
        max_output_tokens: 24000,
        text: { format: { type: "json_schema", name: schema.name, strict: true, schema: schema.jsonSchema } },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      case: entry.id,
      note: entry.note,
      prompt: promptVersion,
      experiment: promptVersion === CURRENT_READING_PROMPT ? experiment : null,
      referenceDate,
      instructionsChars: instructions.length,
      inputChars: input.length,
      topics: (promptVersion === CURRENT_READING_PROMPT && experiment.topics === "first" ? plan.topics.slice(0, 1) : plan.topics).map((topic) => topic.topicId),
      files: [`${stem}.instructions.txt`, `${stem}.input.json`, `${stem}.schema.json`, `${stem}.request.json`],
    }),
  );
}

if (process.argv[1]?.endsWith("llm-export.ts")) main();
