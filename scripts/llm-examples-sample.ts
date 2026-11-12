/**
 * 문답 예시가 실제 생성 요청의 어디에 들어가는지 사람이 읽을 수 있게 조립 결과를 Markdown으로 내보낸다.
 * 가상 평가 사례만 쓰고(개인정보 없음), 모델을 부르지 않으며 API 키와 환경 파일을 읽지 않는다.
 *
 *   node --conditions=react-server --import tsx scripts/llm-examples-sample.ts [--out=docs/model-comparison/few-shot-sample]
 *
 * 파일마다: 버전·넣은 예시 ID·지시 안의 위치 → 예시 없는 이전 버전과 같은 지시 부분 → 지시 끝에 붙은 예시 블록 → 사용자 메시지(현재 작성 재료).
 * 운영과 같은 함수(getReadingPrompt, buildFollowupPrompt, buildVoiceRequest, buildMujinFollowupRequest)로 만든다.
 * 순서 값은 사례 ID라 운영(풀이·후속 질문 ID)과 고른 예시가 다를 수 있다. 블록 모양과 위치는 같다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MUJIN, MYOMYO } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import type { ScrollDraftContent } from "@/domain/mujin/types";
import type { ExampleRecord } from "@/server/llm/example-block";
import { buildMujinFollowupRequest } from "@/server/llm/mujin-followup-prompt";
import { buildVoiceRequest, MUJIN_BUNDLES, MUJIN_BUNDLE_VERSION } from "@/server/llm/mujin-prompts";
import { buildFollowupPrompt, getReadingPrompt } from "@/server/llm/prompts";
import { casePlan, EVALUATION_CASES, MUJIN_EVALUATION_CASES, readOption } from "./llm-cases";
import { buildMujinEvaluation } from "./mujin-llm";

interface Sample {
  readonly file: string;
  readonly title: string;
  readonly note: string;
  readonly current: { readonly version: string; readonly instructions: string; readonly input: string; readonly examples?: ExampleRecord | null };
  readonly before: { readonly version: string; readonly instructions: string; readonly input: string };
}

const BLOCK_START = "[캐릭터 문답 예시:";

function render(sample: Sample): string {
  const { current, before } = sample;
  const start = current.instructions.indexOf(BLOCK_START);
  const head = current.instructions.slice(0, start).replace(/\n+$/, "");
  const block = current.instructions.slice(start);
  const headLines = head.split("\n").length;
  const blockLines = block.split("\n").length;
  const sameHead = head === before.instructions;
  const sameInput = current.input === before.input;
  return [
    `# ${sample.title}`,
    "",
    sample.note,
    "",
    `- 프롬프트 버전: \`${current.version}\` (예시 없는 비교 버전 \`${before.version}\`)`,
    `- 카탈로그 \`${current.examples?.catalogVersion}\` · 선택 정책 \`${current.examples?.policyVersion}\` · 경로 \`${current.examples?.route}\``,
    `- 넣은 예시: ${current.examples?.ids.map((id) => `\`${id}\``).join(", ")}`,
    `- 위치: 지시(instructions) ${headLines + blockLines + 1}줄 가운데 ${headLines + 2}~${headLines + blockLines + 1}줄 (맨 끝 블록). 사용자 메시지(input)에는 예시가 없다.`,
    `- 예시 블록 앞의 지시는 \`${before.version}\` 지시와 글자까지 같다: ${sameHead ? "예" : "아니오"}. 입력은 같다: ${sameInput ? "예" : "아니오"}. 출력 형식(JSON 스키마)도 같다.`,
    `- 글자 수: 지시 ${before.instructions.length.toLocaleString("ko-KR")}자 → ${current.instructions.length.toLocaleString("ko-KR")}자 (예시 블록 ${(current.instructions.length - before.instructions.length).toLocaleString("ko-KR")}자), 입력 ${current.input.length.toLocaleString("ko-KR")}자`,
    "",
    "## 1. 지시 끝에 붙은 예시 블록",
    "",
    "```text",
    block,
    "```",
    "",
    "## 2. 예시 블록 앞의 지시 (이전 버전과 같은 부분)",
    "",
    "```text",
    head,
    "```",
    "",
    "## 3. 사용자 메시지 (input, 현재 작성 재료)",
    "",
    "```json",
    JSON.stringify(JSON.parse(current.input), null, 2),
    "```",
    "",
  ].join("\n");
}

async function main() {
  const out = path.resolve(readOption("out") ?? "docs/model-comparison/few-shot-sample");
  mkdirSync(out, { recursive: true });
  const samples: Sample[] = [];

  // 묘묘 최초 풀이: 취업 준비 중, 질문 2개(취업 시기, 취업과 창업 비교).
  const job = EVALUATION_CASES.find((entry) => entry.id === "job-seeking")!;
  const { plan } = casePlan(job, "2026-11-12");
  const readingArgs = { plan, persona: MYOMYO, previousIssues: [], exampleSeed: `llm-export:${job.id}` };
  const reading = getReadingPrompt("reading-3.2.0")(readingArgs);
  const readingBefore = getReadingPrompt("reading-3.1.0")(readingArgs);
  samples.push({
    file: "01-myomyo-reading-job-seeking.md",
    title: "묘묘 최초 풀이 (가상 사례 job-seeking)",
    note: "가상 사례 job-seeking (1998-11-02 신시 여, 취업 준비 중, 질문: 언제쯤 취업할 수 있을지 · 취업과 창업 중 무엇이 맞는지). 기준일 2026-11-12.",
    current: { version: "reading-3.2.0", ...reading },
    before: { version: "reading-3.1.0", ...readingBefore },
  });

  // 묘묘 후속 답변: 같은 사례의 질문을 후속 질문으로, 칭찬과 함께 보낸 메시지.
  const followupArgs = {
    persona: MYOMYO,
    nickname: plan.base.nickname,
    hourKnown: plan.base.hourKnown,
    expression: FIRST_OVERVIEW.expression,
    situation: plan.base.situation ? { label: plan.base.situation.label, context: plan.base.situation.context } : null,
    facts: plan.base.facts.map(({ ref, text }) => ({ ref, text })),
    userContext: plan.userContext,
    questions: plan.questions,
    statements: plan.topics.filter((topic) => topic.topicId === "work").flatMap((topic) => topic.statements),
    timing: plan.timing,
    delivered: [],
    lastTurn: null,
    reaction: "praise" as const,
    previousIssues: [],
    exampleSeed: `llm-export:${job.id}`,
  };
  const followup = buildFollowupPrompt(followupArgs);
  const followupBefore = buildFollowupPrompt({ ...followupArgs, promptVersion: "followup-3.1.0" });
  samples.push({
    file: "02-myomyo-followup-praise.md",
    title: "묘묘 후속 답변 (칭찬과 질문이 함께 온 메시지)",
    note: "같은 사례의 질문 2개를 후속 질문으로 보고, 메시지에 칭찬(reaction praise)이 있다고 둔 요청. 앞서 보낸 풀이 말풍선과 직전 대화는 비웠다.",
    current: { version: "followup-3.2.0", ...followup },
    before: { version: "followup-3.1.0", ...followupBefore },
  });

  // 무진 Pass 2: 가상 사례 side-job-money의 3장. 초안은 형식만 맞춘 가상 초안이다 (실제 Pass 1 결과가 아니다).
  const entry = MUJIN_EVALUATION_CASES.find((item) => item.id === "side-job-money")!;
  const evaluation = await buildMujinEvaluation(entry);
  const ch3 = evaluation.stages.paid.sections.get("ch3")!;
  const draft: ScrollDraftContent = {
    sectionId: "ch3",
    coreAnswer: "(가상 초안) 3장의 핵심 답 자리다. 실제로는 Pass 1이 작성 재료로 쓴 중립 초안이 들어간다.",
    blocks: ch3.questions.map((question) => ({
      type: "paragraph" as const,
      questionIds: [question.id],
      refs: question.refs.slice(0, 2),
      text: `(가상 초안) ${question.title}에 대한 중립 설명 문단 자리다.`,
      items: [],
    })),
    scenes: [],
  };
  const voiceInput = {
    persona: MUJIN,
    nickname: evaluation.base.plan.nickname,
    section: { sectionId: ch3.sectionId, title: ch3.title, questions: ch3.questions.map(({ id, title }) => ({ id, title })), targetChars: ch3.targetChars },
    draft,
    userFacts: [...evaluation.base.plan.nowFacts, ...ch3.materials.filter((material) => material.kind === "user-fact")],
    hourKnown: evaluation.base.plan.hourKnown,
    exampleSeed: `llm-export:${entry.id}`,
  };
  const voice = buildVoiceRequest({ ...voiceInput, bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]! });
  const voiceBefore = buildVoiceRequest({ ...voiceInput, bundle: MUJIN_BUNDLES["mujin-1.0.0"]! });
  samples.push({
    file: "03-mujin-pass2-ch3.md",
    title: "무진 Pass 2 — 3장 직업과 사회생활 (가상 사례 side-job-money)",
    note: "가상 사례 side-job-money의 3장 Pass 2 요청. 입력의 draft는 형식만 맞춘 가상 초안이다 (실제 Pass 1 결과가 아니다). 같은 Pass 1 지시는 예시가 없다.",
    current: { version: "mujin-voice-1.1.0", ...voice },
    before: { version: "mujin-voice-1.0.0", ...voiceBefore },
  });

  // 무진 후속 답변: 3장과 이어지는 질문에 도발(허세 지적)이 함께 온 메시지.
  const mujinFollowup = {
    persona: MUJIN,
    nickname: evaluation.base.plan.nickname,
    hourKnown: evaluation.base.plan.hourKnown,
    coverageNotes: evaluation.base.plan.coverageNotes,
    referenceDate: null,
    today: "2026-11-13",
    questions: [
      {
        ref: "q1",
        summary: "부업을 계속 늘려도 될지",
        domain: "career",
        intent: "explain",
        answerability: "full" as const,
        missingInfo: [],
        timingSupported: false,
        period: null,
        sectionIds: ["ch3"],
      },
    ],
    facts: evaluation.base.plan.facts,
    nowFacts: evaluation.base.plan.nowFacts,
    userContext: [],
    chapters: [{ sectionId: ch3.sectionId, title: ch3.title, questions: ch3.questions, materials: ch3.materials, delivered: null }],
    overview: [],
    timing: null,
    lastTurn: null,
    reaction: "tease" as const,
    exampleSeed: `llm-export:${entry.id}:followup`,
  };
  const mujinAnswer = buildMujinFollowupRequest({ ...mujinFollowup, bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]! });
  const mujinAnswerBefore = buildMujinFollowupRequest({ ...mujinFollowup, bundle: MUJIN_BUNDLES["mujin-1.0.0"]! });
  samples.push({
    file: "04-mujin-followup-tease.md",
    title: "무진 후속 답변 (허세 지적과 질문이 함께 온 메시지)",
    note: "가상 사례 side-job-money에서 3장과 이어지는 질문('부업을 계속 늘려도 될지')에 도발(reaction tease)이 함께 왔다고 둔 요청. 앞서 보낸 최종문은 비웠다.",
    current: { version: "mujin-followup-1.1.0", ...mujinAnswer },
    before: { version: "mujin-followup-1.0.0", ...mujinAnswerBefore },
  });

  for (const sample of samples) writeFileSync(path.join(out, sample.file), render(sample));
  const index = [
    "# 문답 예시 조립 결과 (가상 사례, 모델 호출 없음)",
    "",
    "실제 생성 요청에 문답 예시가 어디에 들어가는지 보여 주는 파일이다. 운영과 같은 함수로 만들었고 개인정보가 없는 가상 평가 사례만 쓴다.",
    `다시 만들기: \`node --conditions=react-server --import tsx scripts/llm-examples-sample.ts\`. 설명은 [\`docs/personas/examples.md\`](../../personas/examples.md).`,
    "",
    "| 파일 | 요청 | 넣은 예시 |",
    "| --- | --- | --- |",
    ...samples.map((sample) => `| [${sample.file}](${sample.file}) | ${sample.title} | ${sample.current.examples?.ids.join(", ")} |`),
    "",
    "모든 파일에서 예시는 지시(instructions) 맨 끝의 `[캐릭터 문답 예시: …]` ~ `[캐릭터 문답 예시 끝]` 블록에만 있고, 사용자 메시지(input)에는 없다. 블록 앞의 지시는 예시 없는 이전 버전과 글자까지 같다.",
    "순서 값이 사례 ID라 운영(풀이·후속 질문 ID로 고름)과 고른 예시는 다를 수 있다. 블록의 모양과 위치는 같다.",
    "",
  ].join("\n");
  writeFileSync(path.join(out, "README.md"), index);
  console.log(JSON.stringify({ out, files: ["README.md", ...samples.map((sample) => sample.file)] }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
