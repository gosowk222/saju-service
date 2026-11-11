/**
 * 플레이그라운드에서 받은 최초 풀이 결과(JSON)를 앱과 같은 순서의 말풍선으로 읽고, 운영과 같은 검사를 돌린다.
 * 모델을 부르지 않는다. 결과를 만들 때 쓴 사례·기준일·조건을 그대로 준다.
 *
 *   npm run llm:render -- --case=job-seeking --date=2026-11-11 --file=결과.json [--topics=first]
 *
 * 결과 파일과 같은 이름의 .md를 만든다 (말풍선, 검사 문제, 말풍선 수와 길이).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { topicTitlesOf } from "@/domain/products";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkNarrationV2 } from "@/domain/reading/check";
import { seoulDate } from "@/domain/reading/question";
import type { NarrationOutputV2 } from "@/domain/reading/types";
import { toStoredMessages } from "@/server/llm/narrate";
import { experimentPlan, getNarrationSchema, NARRATION_SCHEMA_VERSION } from "@/server/llm/prompts";
import { casePlan, EVALUATION_CASES, readArg } from "./llm-cases";
import { experimentFromArgs } from "./llm-export";

function main() {
  const entry = EVALUATION_CASES.find((item) => item.id === readArg("case"));
  const file = readArg("file");
  if (!entry || !file) {
    console.log(`사용법: --case=${EVALUATION_CASES.map((item) => item.id).join("|")} --date=<기준일> --file=<결과 JSON> [--topics=first]`);
    return;
  }
  const referenceDate = readArg("date") ?? seoulDate();
  const { plan: full, chart } = casePlan(entry, referenceDate);
  const plan = experimentPlan(full, experimentFromArgs());
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  // 플레이그라운드 응답 전체를 붙여 넣었으면 output_text를 꺼낸다.
  const text = typeof raw === "object" && raw && "output" in raw ? extractText(raw) : null;
  const parsed = getNarrationSchema(NARRATION_SCHEMA_VERSION).parser.safeParse(text ? JSON.parse(text) : raw);
  if (!parsed.success) {
    console.log("출력 형식이 narration-2.2.0과 맞지 않습니다:", parsed.error.issues.slice(0, 5));
    return;
  }
  const output = parsed.data as NarrationOutputV2;
  // 첫 주제만 쓰게 한 조건은 전체 말풍선 수가 상품 범위보다 적은 것이 당연하므로 그 항목은 빼고 본다.
  const firstOnly = plan.topics.length < full.topics.length;
  const issues = checkNarrationV2(output, plan, chart, []).filter((issue) => !(firstOnly && issue.startsWith("전체 말풍선 개수")));
  const messages = toStoredMessages(output, plan.focusSection.id);
  const titles = { ...topicTitlesOf(FIRST_OVERVIEW), [plan.focusSection.id]: plan.focusSection.title } as Record<string, string>;
  const lengths = messages.map((message) => message.text.length);
  const lines = [
    `# ${entry.id} (${entry.note})`,
    "",
    `기준일 ${referenceDate} · 말풍선 ${messages.length}개 · 글자 ${lengths.reduce((sum, value) => sum + value, 0)} · 짧은 말풍선(40자 미만) ${lengths.filter((value) => value < 40).length}개 · 긴 말풍선(150자 이상) ${lengths.filter((value) => value >= 150).length}개`,
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
  const report = `${lines.join("\n")}\n`;
  const target = file.replace(/\.json$/i, "") + ".md";
  writeFileSync(target, report);
  console.log(report);
  console.log(`저장: ${target}`);
}

function extractText(response: unknown): string | null {
  const output = (response as { output?: { content?: { type?: string; text?: string }[] }[] }).output ?? [];
  for (const item of output) for (const part of item.content ?? []) if (part.type === "output_text" && part.text) return part.text;
  return null;
}

main();
