/**
 * 묘묘 2-pass(myomyo-2pass-1.0.0) 실제 모델 비교 자료. 모델을 부르지 않고 API 키도 읽지 않는다. 실제 실행은 사용자가 플레이그라운드에서 한다.
 *
 * 1) 내보내기:  npm run llm:export '--' --case=job-seeking --task=two-pass [--date=2026-11-12] [--out=<폴더>] [--draft=<Pass 1 결과 파일>]
 *    - Pass 1 묶음 요청(pass1-b1 ...)을 쓴다. 이 요청을 플레이그라운드에서 실행한 결과(JSON)를 <사례 폴더>/pass1-results/에 둔다
 *      (파일 이름은 자유. 응답 JSON 전체나 { "units": [...] } 텍스트 모두 읽는다). --draft로 파일 하나를 직접 줘도 된다.
 *    - 초안이 있으면 단위마다 같은 초안·같은 입력으로 Pass 2 요청을 두 벌 쓴다:
 *      pass2-<단위>.with-examples.*  (운영과 같은 지시: 이번 묘묘 예시 myomyo-examples-2.0.0 포함)
 *      pass2-<단위>.no-examples.*    (비교용: 같은 지시에서 예시 블록만 뺐다. 운영 기본값은 바꾸지 않는다)
 * 2) 읽기:  npm run llm:render '--' --case=job-seeking --task=two-pass [--date=...] [--out=<폴더>]
 *    - <사례 폴더>/pass2-results/<단위>.with-examples.json, <단위>.no-examples.json을 읽어 운영과 같은 검사(checkMessengerVoice)를 돌리고
 *      comparison.md에 두 결과를 나란히 놓는다: 말풍선 수·글자 수(초안 대비), 검사 문제(초안에 없던 근거·숫자·장면 등),
 *      예시 답변과 겹치는 문장 조각, 응답에 있으면 토큰 사용량. 성격이 잘 드러나는지는 사람이 읽고 판단한다 (자동 점수 없음).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MYOMYO } from "@/domain/personas";
import { echoLines, exampleEchoes, findExampleCatalog } from "@/domain/personas/examples";
import { checkMessengerVoice, messengerUnits, type MessengerDraftUnit } from "@/domain/reading/two-pass";
import type { NarrationPlanV2 } from "@/domain/reading/types";
import { MESSENGER_BUNDLES } from "@/server/generation/bundles";
import { messengerBatches } from "@/server/generation/messenger-run";
import { LLM_SETTINGS } from "@/server/llm/config";
import { buildMessengerDraftRequest, buildMessengerVoiceRequest, MessengerDraftUnitParser, type MessengerRequest } from "@/server/llm/messenger-prompts";
import { casePlan, readArg, type EvaluationCase } from "./llm-cases";

const BUNDLE = MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!;
const VARIANTS = ["with-examples", "no-examples"] as const;
type Variant = (typeof VARIANTS)[number];

const caseDir = (entry: EvaluationCase, referenceDate: string) =>
  path.resolve(readArg("out") ?? "docs/model-comparison/two-pass", `${referenceDate}_${entry.id}_${BUNDLE.id}`);

function requestJson(request: MessengerRequest<unknown>, task: { readonly reasoningEffort: string; readonly maxOutputTokens: number }) {
  // 직접 요청을 보내는 도구를 쓸 때의 Responses API 본문. 추론 설정과 출력 한도는 운영과 같다 (모델은 비교할 것으로 바꾼다).
  return JSON.stringify(
    {
      model: "<OPENAI_MODEL과 같은 모델>",
      instructions: request.instructions,
      input: request.input,
      reasoning: { effort: task.reasoningEffort },
      max_output_tokens: task.maxOutputTokens,
      text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.jsonSchema } },
    },
    null,
    2,
  );
}

function writeRequest(dir: string, stem: string, request: MessengerRequest<unknown>, task: { readonly reasoningEffort: string; readonly maxOutputTokens: number }): string[] {
  const files: [string, string][] = [
    [`${stem}.instructions.txt`, request.instructions],
    [`${stem}.input.json`, JSON.stringify(JSON.parse(request.input), null, 2)],
    [`${stem}.request.json`, requestJson(request, task)],
  ];
  return files.map(([name, content]) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  });
}

/** 플레이그라운드 응답 JSON 전체나 출력 텍스트(JSON)에서 출력 객체를 꺼낸다. */
function outputOf(raw: string): unknown {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const output = (parsed.output as { content?: { type?: string; text?: string }[] }[] | undefined) ?? null;
  if (output) for (const item of output) for (const part of item.content ?? []) if (part.type === "output_text" && part.text) return JSON.parse(part.text);
  return parsed;
}

function usageOf(raw: string): { input: number | null; cached: number | null; output: number | null } | null {
  const usage = (JSON.parse(raw) as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage;
  return usage ? { input: usage.input_tokens ?? null, cached: usage.input_tokens_details?.cached_tokens ?? null, output: usage.output_tokens ?? null } : null;
}

/** Pass 1 결과(여러 파일)에서 단위 초안을 모은다. 같은 단위가 두 번 있으면 처음 것을 쓴다. 형식이 맞지 않는 원소는 건너뛴다. */
function loadDrafts(dir: string): Map<string, MessengerDraftUnit> {
  const drafts = new Map<string, MessengerDraftUnit>();
  const files = [readArg("draft"), ...(existsSync(path.join(dir, "pass1-results")) ? readdirSync(path.join(dir, "pass1-results")).map((name) => path.join(dir, "pass1-results", name)) : [])];
  for (const file of files) {
    if (!file || !file.endsWith(".json")) continue;
    const output = outputOf(readFileSync(file, "utf8")) as { units?: unknown[] };
    for (const item of output.units ?? []) {
      const parsed = MessengerDraftUnitParser.safeParse(item);
      if (parsed.success && !drafts.has(parsed.data.unitId)) drafts.set(parsed.data.unitId, parsed.data);
    }
  }
  return drafts;
}

/** 운영 실행기(messenger-run.ts)와 같은 조건으로 단위 하나의 Pass 2 요청을 만든다. examples가 null이면 예시 블록만 뺀다. */
function voiceRequestFor(plan: NarrationPlanV2, drafts: ReadonlyMap<string, MessengerDraftUnit>, unitId: string, variant: Variant, seed: string) {
  const units = messengerUnits(plan);
  const index = units.findIndex((unit) => unit.unitId === unitId);
  const titleOf = (id: string) => (id === plan.focusSection.id ? plan.focusSection.title : (plan.topics.find((topic) => topic.topicId === id)?.title ?? id));
  return buildMessengerVoiceRequest(
    { prompt: BUNDLE.voicePrompt, schema: BUNDLE.voiceSchema },
    {
      plan,
      persona: MYOMYO,
      unit: units[index]!,
      unitIndex: index,
      draft: drafts.get(unitId)!,
      earlierUnits: units.slice(0, index).flatMap((unit) => (drafts.has(unit.unitId) ? [{ title: titleOf(unit.unitId), coreAnswer: drafts.get(unit.unitId)!.coreAnswer }] : [])),
      frame: { opening: index === 0, closing: index === units.length - 1 },
      examples: variant === "with-examples" ? BUNDLE.examples : null,
      exampleSeed: seed,
      label: BUNDLE.id,
    },
  );
}

const seedOf = (entry: EvaluationCase) => `llm-export:${entry.id}`;

export function exportMyomyoTwoPass(entry: EvaluationCase, referenceDate: string): void {
  const { plan } = casePlan(entry, referenceDate);
  const dir = caseDir(entry, referenceDate);
  mkdirSync(dir, { recursive: true });
  const units = messengerUnits(plan);
  const written: string[] = [];
  for (const batch of messengerBatches(units, BUNDLE.draftBatches)) {
    const request = buildMessengerDraftRequest(
      { prompt: BUNDLE.draftPrompt, schema: BUNDLE.draftSchema },
      { plan, units: units.filter((unit) => batch.unitIds.includes(unit.unitId)), usedNotes: [] },
    );
    written.push(...writeRequest(dir, `pass1-${batch.id}`, request, LLM_SETTINGS.tasks.draft));
  }
  const drafts = loadDrafts(dir);
  const examplesReport: string[] = ["# Pass 2 예시 선택", "", `묶음 ${BUNDLE.id}, 카탈로그 ${BUNDLE.examples.catalogVersion}, 정책 ${BUNDLE.examples.policyVersion}, 안내 ${BUNDLE.examples.guideVersion}`, ""];
  for (const unit of units) {
    if (!drafts.has(unit.unitId)) continue;
    for (const variant of VARIANTS) {
      const built = voiceRequestFor(plan, drafts, unit.unitId, variant, seedOf(entry));
      written.push(...writeRequest(dir, `pass2-${unit.unitId}.${variant}`, built.request, LLM_SETTINGS.tasks.voice));
      if (built.examples) examplesReport.push(`- ${unit.unitId}: ${built.examples.ids.join(", ")}`);
    }
  }
  if (drafts.size) writeFileSync(path.join(dir, "pass2-examples.md"), `${examplesReport.join("\n")}\n`);
  console.log(
    JSON.stringify({
      case: entry.id,
      bundle: BUNDLE.id,
      referenceDate,
      dir,
      units: units.map((unit) => unit.unitId),
      batches: messengerBatches(units, BUNDLE.draftBatches).map((batch) => batch.unitIds),
      draftsFound: [...drafts.keys()],
      next: drafts.size
        ? "pass2-<단위>.with-examples / .no-examples 요청을 같은 모델로 실행하고 결과를 pass2-results/<단위>.<변형>.json으로 저장한 뒤 npm run llm:render '--' --task=two-pass로 읽는다."
        : "pass1-b* 요청을 플레이그라운드에서 실행해 결과를 pass1-results/에 저장한 뒤 이 명령을 다시 실행하면 Pass 2 비교 요청이 생긴다.",
      files: written.length,
    }),
  );
}

export function renderMyomyoTwoPass(entry: EvaluationCase, referenceDate: string): void {
  const { plan, chart } = casePlan(entry, referenceDate);
  const dir = caseDir(entry, referenceDate);
  const drafts = loadDrafts(dir);
  const catalog = findExampleCatalog(BUNDLE.examples.catalogVersion)!;
  const units = messengerUnits(plan);
  const lines: string[] = [
    `# ${entry.id} 묘묘 2-pass 비교 (예시 사용 / 미사용)`,
    "",
    `- 묶음 ${BUNDLE.id}, Pass 2 ${BUNDLE.voicePrompt}, 카탈로그 ${BUNDLE.examples.catalogVersion}. 같은 초안과 같은 입력에서 예시 블록만 다르다.`,
    "- 검사 문제는 운영 검사(checkMessengerVoice)의 결과다. 문제가 없다고 문장 품질이 좋다는 뜻은 아니다.",
    "- 사람이 볼 것: 성격이 본문에서 드러나는가, 예시 문장을 옮겨 썼는가, 설명이 짧아지거나 조건이 빠졌는가, 새 사용자 사실·판단이 생겼는가.",
    "- 시간은 플레이그라운드에서 본 값을 직접 적는다 (첫 말풍선은 첫 단위의 Pass 1 + Pass 2, 전체는 모든 단위).",
    "",
  ];
  for (const unit of units) {
    const draft = drafts.get(unit.unitId);
    if (!draft) continue;
    const draftChars = [draft.coreAnswer, ...draft.points.map((point) => point.text)].join("").length;
    lines.push(`## ${unit.unitId}`, "", `초안: 문단 ${draft.points.length}개, ${draftChars}자`, "");
    for (const variant of VARIANTS) {
      const file = path.join(dir, "pass2-results", `${unit.unitId}.${variant}.json`);
      if (!existsSync(file)) {
        lines.push(`### ${variant}`, "", "(결과 파일 없음)", "");
        continue;
      }
      const raw = readFileSync(file, "utf8");
      const output = outputOf(raw) as { opening?: string; bubbles?: { kind: string; refs: string[]; text: string; highlight?: string }[]; closing?: string };
      const bubbles = (output.bubbles ?? []).map((bubble) => ({ kind: bubble.kind as "explanation", refs: bubble.refs ?? [], text: bubble.text ?? "", highlight: bubble.highlight ?? "" }));
      const final = { unitId: unit.unitId, opening: output.opening ?? "", bubbles, closing: output.closing ?? "" };
      const index = units.findIndex((entry2) => entry2.unitId === unit.unitId);
      const issues = checkMessengerVoice({
        unit,
        final,
        draft,
        plan,
        chart,
        excluded: [],
        persona: MYOMYO,
        remembered: [],
        frame: { opening: index === 0, closing: index === units.length - 1 },
      });
      const texts = [final.opening, ...bubbles.map((bubble) => bubble.text), final.closing].filter((text) => text.trim());
      const ids = variant === "with-examples" ? (voiceRequestFor(plan, drafts, unit.unitId, variant, seedOf(entry)).examples?.ids ?? []) : [];
      const examples = catalog.examples.filter((example) => ids.includes(example.id) || catalog.rewrites.some((rewrite) => rewrite.id && ids.includes(rewrite.id) && rewrite.sourceExampleId === example.id));
      // 예시를 넣지 않은 변형은 같은 단위에서 예시를 넣었을 때 고른 예시와 비교한다 (예시 없이도 우연히 겹치는지 보려고).
      const compared = variant === "with-examples" ? examples : catalog.examples.filter((example) => voiceRequestFor(plan, drafts, unit.unitId, "with-examples", seedOf(entry)).examples?.ids.includes(example.id));
      const echoes = exampleEchoes(texts, compared);
      const usage = usageOf(raw);
      lines.push(
        `### ${variant}`,
        "",
        `- 말풍선 ${bubbles.length}개, ${texts.join("").length}자 (초안 대비 ${draftChars ? Math.round((texts.join("").length / draftChars) * 100) : 0}%)`,
        `- 토큰: ${usage ? `입력 ${usage.input ?? "모름"} (캐시 ${usage.cached ?? "모름"}), 출력 ${usage.output ?? "모름"}` : "응답에 usage 없음"}`,
        `- 검사 문제: ${issues.length ? issues.join(" / ") : "없음"}`,
        "",
        ...echoLines(echoes, catalog.version),
        "",
        ...texts.map((text) => `> ${text.replace(/\n/g, " ")}`),
        "",
      );
    }
  }
  const out = path.join(dir, "comparison.md");
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(JSON.stringify({ case: entry.id, dir, draftsFound: [...drafts.keys()], comparison: out }));
}
