/**
 * 플레이그라운드에서 받은 최초 풀이 결과(JSON)를 앱과 같은 순서의 말풍선으로 읽고, 운영과 같은 검사를 돌린다.
 * 모델을 부르지 않는다. 결과를 만들 때 쓴 사례·기준일·프롬프트를 그대로 준다.
 *
 *   npm run llm:render -- --case=job-seeking --date=2026-11-12 --file=결과.json [--prompt=reading-2.9.0]
 *   PowerShell에서는 -- 를 따옴표로 감싼다: npm run llm:render '--' --case=job-seeking --file=결과.json
 *
 * 결과 파일과 같은 이름의 .md를 만든다 (말풍선, 검사 문제, 말풍선 수와 길이). 검사를 통과했다고 문장 품질이 좋다는 뜻은 아니다.
 * 품질은 docs/personas/myomyo-evaluation.md의 기준으로 사람이 읽고 판단한다.
 *
 * 묘묘 2-pass의 예시 사용·미사용 비교는 --task=two-pass를 준다 (scripts/myomyo-two-pass.ts, comparison.md를 쓴다).
 *   npm run llm:render '--' --case=job-seeking --task=two-pass [--date=<기준일>]
 *
 * 무진의 종합 사주는 --product=mujin-overview를 준다 (scripts/mujin-llm.ts, docs/personas/mujin-evaluation.md 3절).
 *   npm run llm:render '--' --product=mujin-overview --case=side-job-money [--reference=2026-11-12] [--dir=<사례 폴더>] [--draft=<경로>] [--voice=<경로>] [--out=<파일.md>]
 *   Pass 1·Pass 2 결과를 운영 검사(checkDraftSection, checkVoiceSection)로 읽고, 장마다 초안과 최종문을 나란히 놓은 comparison.md를 만든다.
 * --product를 주지 않으면(또는 first-overview) 아래 묘묘 읽기를 그대로 한다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { findPersona } from "@/domain/personas";
import { echoLines, exampleEchoes, findExampleCatalog, MYOMYO_EXAMPLE_CATALOG_VERSION } from "@/domain/personas/examples";
import { topicTitlesOf } from "@/domain/products";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { checkNarrationV2 } from "@/domain/reading/check";
import { seoulDate } from "@/domain/reading/question";
import type { NarrationOutputV2 } from "@/domain/reading/types";
import { toStoredMessages } from "@/server/llm/narrate";
import { CURRENT_READING_PROMPT, getNarrationSchema, NARRATION_SCHEMA_VERSION, personaVersionFor } from "@/server/llm/prompts";
import { casePlan, EVALUATION_CASES, readArg, readOption } from "./llm-cases";

function extractText(response: unknown): string | null {
  const output = (response as { output?: { content?: { type?: string; text?: string }[] }[] }).output ?? [];
  for (const item of output) for (const part of item.content ?? []) if (part.type === "output_text" && part.text) return part.text;
  return null;
}

/** 묘묘의 사주 참견(first-overview) 결과 읽기. 무진을 더하기 전과 같다. */
function renderMyomyo() {
  const entry = EVALUATION_CASES.find((item) => item.id === readArg("case"));
  if (entry && readArg("task") === "two-pass") {
    void import("./myomyo-two-pass").then((module) => module.renderMyomyoTwoPass(entry, readArg("date") ?? seoulDate()));
    return;
  }
  const file = readArg("file");
  if (!entry || !file) {
    console.log(`사용법: --case=${EVALUATION_CASES.map((item) => item.id).join("|")} --date=<기준일> --file=<결과 JSON> [--prompt=<버전>]`);
    return;
  }
  const referenceDate = readArg("date") ?? seoulDate();
  const promptVersion = readArg("prompt") ?? CURRENT_READING_PROMPT;
  const { plan, chart } = casePlan(entry, referenceDate);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  // 플레이그라운드 응답 전체를 붙여 넣었으면 output_text를 꺼낸다.
  const text = typeof raw === "object" && raw && "output" in raw ? extractText(raw) : null;
  const parsed = getNarrationSchema(NARRATION_SCHEMA_VERSION).parser.safeParse(text ? JSON.parse(text) : raw);
  if (!parsed.success) {
    console.log(`출력 형식이 ${NARRATION_SCHEMA_VERSION}과 맞지 않습니다:`, parsed.error.issues.slice(0, 5));
    return;
  }
  const output = parsed.data as NarrationOutputV2;
  // 운영과 같이 그 프롬프트 버전의 캐릭터 설정으로 검사한다 (2.9.0 이전은 말버릇 횟수도 센다).
  const persona = findPersona("myomyo", personaVersionFor(promptVersion));
  const issues = checkNarrationV2(output, plan, chart, [], persona);
  const messages = toStoredMessages(output, plan.focusSection.id);
  const titles = { ...topicTitlesOf(FIRST_OVERVIEW), [plan.focusSection.id]: plan.focusSection.title } as Record<string, string>;
  const lengths = messages.map((message) => message.text.length);
  const lines = [
    `# ${entry.id} (${entry.note})`,
    "",
    `프롬프트 ${promptVersion} · 기준일 ${referenceDate} · 말풍선 ${messages.length}개 · 글자 ${lengths.reduce((sum, value) => sum + value, 0)} · 40자 미만 ${lengths.filter((value) => value < 40).length}개 · 150자 이상 ${lengths.filter((value) => value >= 150).length}개`,
    "",
    `검사 문제 ${issues.length}건${issues.length ? `: ${issues.join(" / ")}` : ""}`,
    "",
  ];
  let current: string | null | undefined;
  for (const message of messages) {
    if (message.topicId !== current) {
      current = message.topicId;
      lines.push("", `## ${current ? (titles[current] ?? current) : "시작·마무리"}`, "");
    }
    lines.push(`- (${message.kind}, ${message.text.length}자) ${message.text}`);
  }
  // 예시 사용·미사용 버전을 같은 기준으로 비교하도록, 프롬프트 버전과 관계없이 현재 묘묘 카탈로그 전체와 견준다.
  const catalog = findExampleCatalog(MYOMYO_EXAMPLE_CATALOG_VERSION)!;
  lines.push("", "## 예시 문장 겹침 (참고)", "", ...echoLines(exampleEchoes(messages.map((message) => message.text), catalog.examples), catalog.version));
  const report = `${lines.join("\n")}\n`;
  const target = `${file.replace(/\.json$/i, "")}.md`;
  writeFileSync(target, report);
  console.log(report);
  console.log(`저장: ${target}`);
}

function main() {
  const product = readOption("product");
  if (product === MUJIN_OVERVIEW.id) {
    // 무진 작성 계획·검사 모듈(scripts/mujin-llm.ts)은 무진을 고를 때만 불러온다.
    import("./mujin-llm")
      .then((mujin) => mujin.renderMujinCli())
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
  renderMyomyo();
}

main();
