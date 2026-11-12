/**
 * 실제 모델 비교용 지시·입력·출력 형식을 파일로 만든다. 모델을 부르지 않고 API 키도 읽지 않는다.
 *
 *   npm run llm:export -- --case=job-seeking                          현재 지시 (reading-3.1.0)
 *   npm run llm:export -- --case=job-seeking --prompt=reading-2.9.0   이전 지시 (그 버전의 캐릭터 설정과 함께)
 *   --date=2026-11-12 (기준일, 기본 오늘) --out=<폴더> (기본 docs/model-comparison/prompts)
 *   PowerShell에서는 -- 를 따옴표로 감싼다: npm run llm:export '--' --case=job-seeking
 *
 * 사례는 scripts/llm-cases.ts (docs/personas/myomyo-evaluation.md 2절). 만든 파일을 OpenAI 플레이그라운드에 붙여
 * 같은 입력에서 버전만 바꿔 실행하고, 결과는 npm run llm:render로 읽는다. 스크립트의 실제 호출은 막혀 있으므로
 * (src/server/llm/config.ts의 liveCallBlockReason) 실제 실행은 사용자가 플레이그라운드에서 직접 한다.
 *
 * 무진의 종합 사주는 --product=mujin-overview를 준다 (scripts/mujin-llm.ts, docs/personas/mujin-evaluation.md 3절).
 *   npm run llm:export '--' --product=mujin-overview --case=side-job-money [--reference=2026-11-12] [--dir=<사례 폴더>] [--draft=<Pass 1 결과>]
 *   Pass 1 묶음별 요청을 쓰고, 사례 폴더에 저장한 Pass 1 결과(또는 --draft)가 있으면 장별 Pass 2 요청과 마지막 정리 요청을 쓴다.
 * --product를 주지 않으면(또는 first-overview) 아래 묘묘 내보내기를 그대로 한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findPersona } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { seoulDate } from "@/domain/reading/question";
import { LLM_SETTINGS } from "@/server/llm/config";
import { CURRENT_READING_PROMPT, getNarrationSchema, getReadingPrompt, hasReadingPrompt, isPlanV2Prompt, NARRATION_SCHEMA_VERSION, personaVersionFor } from "@/server/llm/prompts";
import { casePlan, EVALUATION_CASES, readArg, readOption } from "./llm-cases";

/** 묘묘의 사주 참견(first-overview) 내보내기. 무진을 더하기 전과 같다. */
function exportMyomyo() {
  const entry = EVALUATION_CASES.find((item) => item.id === readArg("case"));
  if (!entry) {
    console.log(`사례를 고르세요: --case=${EVALUATION_CASES.map((item) => item.id).join("|")}`);
    return;
  }
  const referenceDate = readArg("date") ?? seoulDate();
  const promptVersion = readArg("prompt") ?? CURRENT_READING_PROMPT;
  if (!hasReadingPrompt(promptVersion) || !isPlanV2Prompt(promptVersion)) {
    console.log(`알 수 없는 프롬프트: ${promptVersion}`);
    return;
  }
  // 운영과 같이 그 프롬프트 버전에 맞는 캐릭터 설정을 쓴다.
  const persona = findPersona("myomyo", personaVersionFor(promptVersion))!;
  const { plan } = casePlan(entry, referenceDate);
  const { instructions, input } = getReadingPrompt(promptVersion)({ plan, persona, previousIssues: [] });
  const schema = getNarrationSchema(NARRATION_SCHEMA_VERSION);

  const dir = path.resolve(readArg("out") ?? "docs/model-comparison/prompts");
  mkdirSync(dir, { recursive: true });
  const stem = path.join(dir, `${referenceDate}_${entry.id}_${promptVersion}`);
  writeFileSync(`${stem}.instructions.txt`, instructions);
  writeFileSync(`${stem}.input.json`, JSON.stringify(JSON.parse(input), null, 2));
  writeFileSync(`${stem}.schema.json`, JSON.stringify({ name: schema.name, strict: true, schema: schema.jsonSchema }, null, 2));
  // 직접 요청을 보내는 도구를 쓸 때의 Responses API 본문. 모델과 추론 설정은 운영과 같게 둔다 (모델은 비교할 것으로 바꾼다).
  writeFileSync(
    `${stem}.request.json`,
    JSON.stringify(
      {
        model: "<OPENAI_MODEL과 같은 모델>",
        instructions,
        input,
        reasoning: { effort: LLM_SETTINGS.tasks.reading.reasoningEffort },
        max_output_tokens: LLM_SETTINGS.tasks.reading.maxOutputTokens,
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
      personaVersion: persona.version,
      referenceDate,
      instructionsChars: instructions.length,
      inputChars: input.length,
      topics: plan.topics.map((topic) => topic.topicId),
      questions: plan.questions.map((question) => question.summary),
      files: [`${stem}.instructions.txt`, `${stem}.input.json`, `${stem}.schema.json`, `${stem}.request.json`],
    }),
  );
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
