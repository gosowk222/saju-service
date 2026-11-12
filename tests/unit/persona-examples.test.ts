import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MUJIN, MYOMYO } from "@/domain/personas";
import {
  allExampleCatalogs,
  EXAMPLE_LIMITS,
  EXAMPLE_POLICY_VERSION,
  findExampleCatalog,
  rewriteView,
  seriousSignal,
  topicsOfSection,
  type CharacterExample,
  type ExampleCatalog,
  type ExampleReaction,
  type ExampleRequest,
  type ExampleRoute,
  type ExampleTopic,
} from "@/domain/personas/examples";
import { MUJIN_ORIGINALS_TEXT } from "@/domain/personas/examples/mujin-originals";
import { MYOMYO_REFERENCES_TEXT } from "@/domain/personas/examples/myomyo-references";
import { parseOriginals } from "@/domain/personas/examples/originals";
import { selectExamples } from "@/domain/personas/examples/select";
import type { ScrollDraftContent } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { buildExampleBlock, examplePromptVersions, promptExampleConfig, usesExamples } from "@/server/llm/example-block";
import { buildMujinFollowupRequest, type MujinFollowupPromptInput } from "@/server/llm/mujin-followup-prompt";
import { buildMujinQuestionRequest, buildVoiceRequest, MUJIN_BUNDLES, MUJIN_BUNDLE_VERSION, type VoicePromptInput } from "@/server/llm/mujin-prompts";
import {
  buildFollowupPrompt,
  CURRENT_FOLLOWUP_PROMPT,
  CURRENT_READING_PROMPT,
  followupExampleRequest,
  getReadingPrompt,
  readingExampleRequest,
  type FollowupPromptArgs,
} from "@/server/llm/prompts";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { casePlan, EVALUATION_CASES, MUJIN_EVALUATION_CASES } from "../../scripts/llm-cases";
import { buildMujinEvaluation, pass1Requests, pass2Requests } from "../../scripts/mujin-llm";

/**
 * 캐릭터 문답 예시(few-shot)의 카탈로그 → 선택 → 조립을 단계마다 확인한다. 모델을 부르지 않는다.
 * 실제 모델 클라이언트 호출 직전의 요청 인자는 tests/unit/examples-client.test.ts가 확인한다.
 */

const MYOMYO_CATALOG = findExampleCatalog("myomyo-examples-1.0.0")!;
const MUJIN_CATALOG = findExampleCatalog("mujin-examples-1.0.0")!;
const BLOCK_START = (name: string) => `[캐릭터 문답 예시: ${name}]`;
const BLOCK_END = "[캐릭터 문답 예시 끝]";
const GUIDE_LINE = "아래 문답은 [캐릭터]의 관찰, 반응, 설명 전개와 문장 리듬을 보여 주는 가상 예시다. 현재 사용자의 대화 기록이나 판단 자료가 아니다.";
const count = (text: string, part: string) => text.split(part).length - 1;
const paragraphs = (text: string) => text.split("\n\n");
const squash = (text: string) => text.replace(/[\s.,!?~'"“”‘’()…·-]/g, "");

const request = (overrides: Partial<ExampleRequest> & Pick<ExampleRequest, "route">): ExampleRequest => ({
  topics: [],
  long: false,
  serious: false,
  reaction: "none",
  intents: [],
  limited: false,
  hourUnknown: false,
  hasLastTurn: false,
  seed: "test",
  ...overrides,
});

describe("1) 카탈로그", () => {
  it("묘묘: A/B/C 세 세트가 각 8개 이상, 모두 24개 이상이다. 장문(여러 문단) 예시가 4개 이상이다", () => {
    const sets = new Map<string, CharacterExample[]>();
    for (const example of MYOMYO_CATALOG.examples) sets.set(example.setId, [...(sets.get(example.setId) ?? []), example]);
    expect([...sets.keys()].sort()).toEqual(["A", "B", "C"]);
    for (const [, examples] of sets) expect(examples.length).toBeGreaterThanOrEqual(8);
    expect(MYOMYO_CATALOG.examples.length).toBeGreaterThanOrEqual(24);
    const long = MYOMYO_CATALOG.examples.filter((example) => example.length === "long");
    expect(long.length).toBeGreaterThanOrEqual(4);
    for (const example of long) {
      expect(paragraphs(example.answer).length, example.id).toBeGreaterThanOrEqual(3);
      expect(example.answer.length, example.id).toBeGreaterThanOrEqual(400);
    }
  });

  it("묘묘: 요구한 표현 목적과 상품 주제를 고르게 다룬다", () => {
    const purposes = new Set(MYOMYO_CATALOG.examples.flatMap((example) => example.purposes));
    for (const purpose of ["greeting", "strength", "weakness", "explain", "compare", "apply", "uncertain", "serious", "praise", "tease", "correction"] as const) {
      expect(purposes.has(purpose), purpose).toBe(true);
    }
    const topics = new Set(MYOMYO_CATALOG.examples.flatMap((example) => example.topics));
    // 상품 아홉 주제(성향·강점·일·돈·연애·인간관계·친구·가족·장소)와 기간 질문.
    for (const topic of ["temperament", "strengths", "career", "wealth", "romance", "social", "friends", "family", "place", "timing"] as const) {
      expect(topics.has(topic), topic).toBe(true);
    }
  });

  it("묘묘: B·C 세트는 A 세트 답의 단어 치환이 아니다 (질문이 다르고, 긴 문장 조각을 공유하지 않는다)", () => {
    const a = MYOMYO_CATALOG.examples.filter((example) => example.setId === "A");
    const others = MYOMYO_CATALOG.examples.filter((example) => example.setId !== "A");
    const questions = new Set(MYOMYO_CATALOG.examples.map((example) => squash(example.question)));
    expect(questions.size).toBe(MYOMYO_CATALOG.examples.length);
    const fragments = (text: string, size = 16) => {
      const plain = squash(text);
      return Array.from({ length: Math.max(0, plain.length - size + 1) }, (_, index) => plain.slice(index, index + size));
    };
    for (const example of others) {
      const mine = squash(example.answer);
      for (const reference of a) {
        const shared = fragments(reference.answer).filter((fragment) => mine.includes(fragment));
        expect(shared, `${example.id} ↔ ${reference.id}`).toEqual([]);
      }
    }
  });

  it("묘묘 A 세트는 사용자가 준 참고 문답 8개 그대로다", () => {
    const references = parseOriginals(MYOMYO_REFERENCES_TEXT, "묘묘 참고", "묘묘");
    expect(references.map((entry) => entry.number)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    const a = MYOMYO_CATALOG.examples.filter((example) => example.setId === "A");
    expect(a.map((example) => [example.question, example.answer, example.premise.map((line) => line.text)])).toEqual(
      references.map((entry) => [entry.question, entry.answer, entry.premise]),
    );
    expect(a.every((example) => example.source.kind === "user-reference")).toBe(true);
    expect(a.find((example) => example.id === "myomyo-a-04")!.answer).toContain("이름에 자유가 붙었다고 내용까지 확인 안 하면, 그건 좀 성급하지.");
  });

  it("무진: 사용자가 준 원문 21개와 입력 전제를 받은 그대로 보존한다", () => {
    // 원문 텍스트의 지문. 원문을 고치면 이 값이 바뀐다 (고치지 말고 원문 ID를 참조하는 별도 예시를 만든다).
    const normalized = MUJIN_ORIGINALS_TEXT.replace(/\r\n/g, "\n").trim();
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(ORIGINALS_FINGERPRINT);
    const originals = parseOriginals(MUJIN_ORIGINALS_TEXT, "무진", "무진");
    expect(originals.map((entry) => entry.number)).toEqual(Array.from({ length: 21 }, (_, index) => String(index + 1).padStart(2, "0")));
    expect(MUJIN_CATALOG.examples.map((example) => example.id)).toEqual(originals.map((entry) => `mujin-${entry.number}`));
    for (const [index, example] of MUJIN_CATALOG.examples.entries()) {
      const original = originals[index]!;
      expect([example.question, example.answer, example.premise.map((line) => line.text)]).toEqual([original.question, original.answer, original.premise]);
      expect(example.source).toEqual({ kind: "user-original", ref: `무진 ${original.number} — ${original.title}` });
    }
    // 입력 전제가 있는 원문과 줄 수.
    expect(Object.fromEntries(MUJIN_CATALOG.examples.filter((example) => example.premise.length).map((example) => [example.id, example.premise.length]))).toEqual({
      "mujin-05": 2,
      "mujin-07": 2,
      "mujin-09": 4,
      "mujin-10": 2,
      "mujin-15": 2,
      "mujin-20": 1,
    });
    const byId = (id: string) => MUJIN_CATALOG.examples.find((example) => example.id === id)!;
    expect(paragraphs(byId("mujin-09").answer)).toHaveLength(4);
    expect(byId("mujin-09").answer.endsWith("그 빈칸을 자신감으로 메우진 않겠습니다.")).toBe(true);
    expect(byId("mujin-21").answer).toBe("차를 마십니다. 보통은 식은 걸로요. 남의 사정을 듣다 보면 제 찻잔은 늘 순서가 밀리더군요. 오늘은 따뜻할 때 마셔보려고 합니다. 계획은 그렇습니다.");
    expect(byId("mujin-10").premise.map((line) => line.text)).toEqual(["기간 자료가 2027년 3월을 대외 활동에 힘을 실어볼 시기로 제시한다.", "연애 성사나 특정한 만남을 보장하지 않는다."]);
  });

  it("무진: Pass 2 재작성 예시가 3개 이상이고, 원문을 고치지 않고 참조한다 (재작성 결과 = 원문 답변, 문단 수가 초안과 같다)", () => {
    expect(MUJIN_CATALOG.rewrites.length).toBeGreaterThanOrEqual(3);
    expect(MUJIN_CATALOG.rewrites.map((rewrite) => rewrite.sourceExampleId)).toEqual(expect.arrayContaining(["mujin-05", "mujin-07", "mujin-09"]));
    for (const rewrite of MUJIN_CATALOG.rewrites) {
      const view = rewriteView(MUJIN_CATALOG, rewrite);
      const source = MUJIN_CATALOG.examples.find((example) => example.id === rewrite.sourceExampleId)!;
      expect(view.rewritten).toBe(source.answer);
      expect(view.question).toBe(source.question);
      expect(view.premise).toBe(source.premise);
      expect(source.premise.length, rewrite.id).toBeGreaterThan(0);
      expect(rewrite.neutralDraft.length, rewrite.id).toBe(paragraphs(source.answer).length);
      expect(rewrite.preserve.length, rewrite.id).toBeGreaterThanOrEqual(3);
      expect(rewrite.routes).toEqual(["voice"]);
      // 중립 초안은 새 날짜·수치를 더하지 않는다.
      const digits = (text: string) => text.match(/\d+/g) ?? [];
      for (const digit of rewrite.neutralDraft.flatMap(digits)) expect(`${source.question} ${source.answer} ${source.premise.map((line) => line.text).join(" ")}`).toContain(digit);
      // 중립 초안은 캐릭터 말투가 아닌 평서문이다 (무진의 존댓말 어미가 없다).
      expect(rewrite.neutralDraft.join(" ")).not.toMatch(/습니다|세요|어요|죠\./);
    }
  });

  it("모든 카탈로그: ID가 겹치지 않고, 캐릭터·버전·출처가 있으며, 예시에 현재 풀이의 근거 ref처럼 보이는 ID가 없다", () => {
    const ids = allExampleCatalogs().flatMap((catalog) => [...catalog.examples.map((example) => example.id), ...catalog.rewrites.map((rewrite) => rewrite.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const catalog of allExampleCatalogs()) {
      for (const example of catalog.examples) {
        expect(example.personaId).toBe(catalog.personaId);
        expect(example.id.startsWith(`${catalog.personaId}-`)).toBe(true);
        expect(example.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(example.question.trim() && example.answer.trim()).toBeTruthy();
        if (example.source.kind === "authored") expect(example.source.basis).toBeTruthy();
        const text = `${example.question} ${example.answer} ${example.premise.map((line) => line.text).join(" ")}`;
        expect(text, example.id).not.toMatch(/\b[sqtfmu]\d+\b/);
      }
      for (const rewrite of catalog.rewrites) expect(rewrite.personaId).toBe(catalog.personaId);
    }
  });

  it("작성 예시의 답에는 행동 숫자를 넣지 않는다 (날짜는 기간 예시의 예시용 날짜만)", () => {
    for (const example of MYOMYO_CATALOG.examples.filter((entry) => entry.source.kind === "authored")) {
      const digits = example.answer.match(/\d+/g) ?? [];
      if (example.topics.includes("timing")) expect(digits.every((digit) => example.premise.some((line) => line.text.includes(digit))), example.id).toBe(true);
      else expect(digits, example.id).toEqual([]);
    }
  });

  it("경로: 무진 01(첫 상담)·18(자기 사연)·21(일상)은 어떤 생성 요청에도 넣지 않고, 반응 예시는 후속 답변에만 쓴다", () => {
    const byId = (id: string) => MUJIN_CATALOG.examples.find((example) => example.id === id)!;
    for (const id of ["mujin-01", "mujin-18", "mujin-21"]) expect(byId(id).routes).toEqual([]);
    for (const catalog of allExampleCatalogs()) {
      for (const example of catalog.examples.filter((entry) => entry.reaction)) expect(example.routes, example.id).toEqual(["followup"]);
    }
  });
});

// ─── 2) 선택 ─────────────────────────────────────────────

const ROUTES_OF: Readonly<Record<string, readonly ExampleRoute[]>> = { myomyo: ["reading", "followup"], mujin: ["voice", "followup"] };
const TOPICS: readonly ExampleTopic[] = ["temperament", "strengths", "career", "wealth", "romance", "social", "friends", "family", "place", "health", "timing", "chart", "general"];
const REACTIONS: readonly ("none" | ExampleReaction)[] = ["none", "praise", "tease", "doubt"];

/** 경로 × 주제 × 반응 × 진지함 × 조건을 모두 훑는다. */
function* sweep(catalog: ExampleCatalog) {
  for (const route of ROUTES_OF[catalog.personaId]!) {
    for (const topic of TOPICS) {
      for (const reaction of route === "followup" ? REACTIONS : (["none"] as const)) {
        for (const serious of [false, true]) {
          for (const flags of [{}, { hourUnknown: true }, { hasLastTurn: true }, { limited: true, intents: ["outcome"] }, { intents: ["compare"] }, { intents: ["timing"] }]) {
            const input = request({ route, topics: [topic], long: route !== "followup", serious, reaction, seed: `${route}:${topic}:${reaction}:${serious}`, ...flags });
            yield { input, selection: selectExamples(catalog, input) };
          }
        }
      }
    }
  }
}

describe("2) 선택", () => {
  it("어떤 조건에서도 예시가 0개가 되지 않고 정책의 수를 넘지 않는다. Pass 2는 재작성 예시 하나와 문답 하나다", () => {
    for (const catalog of [MYOMYO_CATALOG, MUJIN_CATALOG]) {
      for (const { input, selection } of sweep(catalog)) {
        const limit = EXAMPLE_LIMITS[input.route];
        expect(selection.examples.length + selection.rewrites.length, input.seed).toBeGreaterThan(0);
        expect(selection.examples.length).toBeLessThanOrEqual(limit.examples);
        expect(selection.rewrites.length).toBe(limit.rewrites);
        if (input.route === "voice") expect(selection.examples).toHaveLength(1);
        // 같은 예시가 두 번 들어가지 않는다. 재작성 예시의 원문은 문답 자리에 다시 넣지 않는다.
        const ids = [...selection.rewrites.map((rewrite) => rewrite.sourceExampleId), ...selection.examples.map((example) => example.id)];
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("경로와 조건이 맞지 않는 예시는 들어가지 않는다: 잡담 원문, 다른 반응, 진지하지 않은 상황의 진지한 예시, 조건 예시", () => {
    for (const catalog of [MYOMYO_CATALOG, MUJIN_CATALOG]) {
      for (const { input, selection } of sweep(catalog)) {
        for (const example of selection.examples) {
          expect(example.routes, `${example.id} @ ${input.seed}`).toContain(input.route);
          expect(["mujin-01", "mujin-18", "mujin-21"]).not.toContain(example.id);
          if (example.reaction) expect(example.reaction).toBe(input.reaction);
          if (example.serious) expect(input.serious).toBe(true);
          if (example.needs?.hourUnknown) expect(input.hourUnknown).toBe(true);
          if (example.needs?.lastTurn) expect(input.hasLastTurn).toBe(true);
        }
      }
    }
  });

  it("긴 설명이 필요한 작성(묘묘 최초 풀이)에는 긴 예시가 들어가고 짧은 반응 예시만 들어가지 않는다", () => {
    for (const { input, selection } of sweep(MYOMYO_CATALOG)) {
      if (input.route !== "reading") continue;
      expect(selection.examples.some((example) => example.length === "long"), input.seed).toBe(true);
      expect(selection.examples.every((example) => example.length !== "short"), input.seed).toBe(true);
    }
  });

  it("작성 용도에 맞는 예시를 고른다: 반응, 진지함, 비교·기간·확정 불가 질문, 시각 미상, 직전 대화", () => {
    const pick = (catalog: ExampleCatalog, overrides: Partial<ExampleRequest> & Pick<ExampleRequest, "route">) => selectExamples(catalog, request(overrides)).examples;
    for (const reaction of ["praise", "tease", "doubt"] as const) {
      for (const catalog of [MYOMYO_CATALOG, MUJIN_CATALOG]) expect(pick(catalog, { route: "followup", reaction }).some((example) => example.reaction === reaction)).toBe(true);
    }
    expect(pick(MYOMYO_CATALOG, { route: "reading", long: true, serious: true }).some((example) => example.serious)).toBe(true);
    expect(pick(MUJIN_CATALOG, { route: "followup", serious: true }).some((example) => example.serious)).toBe(true);
    expect(pick(MYOMYO_CATALOG, { route: "reading", long: true, topics: ["career"], intents: ["compare"] }).some((example) => example.purposes.includes("compare"))).toBe(true);
    expect(pick(MYOMYO_CATALOG, { route: "reading", long: true, topics: ["career", "timing"], intents: ["timing"] }).some((example) => example.topics.includes("timing"))).toBe(true);
    expect(pick(MYOMYO_CATALOG, { route: "followup", topics: ["career"], limited: true, intents: ["outcome"] }).some((example) => example.purposes.includes("uncertain"))).toBe(true);
    expect(pick(MUJIN_CATALOG, { route: "followup", topics: ["chart"], hourUnknown: true }).map((example) => example.id)).toContain("mujin-16");
    expect(pick(MUJIN_CATALOG, { route: "followup", topics: ["social"], hasLastTurn: true }).map((example) => example.id)).toContain("mujin-20");
    // 칭찬이 없는 메시지에는 칭찬 반응 예시를, 힘들다는 말이 없으면 진지한 예시를 넣지 않는다.
    expect(pick(MUJIN_CATALOG, { route: "followup", topics: ["general"] }).some((example) => example.reaction || example.serious)).toBe(false);
  });

  it("무진 Pass 2: 장 주제에 맞는 재작성 예시를 고르고, 장마다 같은 문답 하나만 붙지 않는다", () => {
    const sections = MUJIN_OVERVIEW.scroll.sections.filter((section) => section.kind !== "chart").map((section) => section.id);
    const chosen = sections.map((sectionId) =>
      selectExamples(MUJIN_CATALOG, request({ route: "voice", topics: topicsOfSection(sectionId), long: true, seed: `11111111-1111-4111-8111-111111111111:${sectionId}` })),
    );
    const rewriteOf = (sectionId: string) => chosen[sections.indexOf(sectionId)]!.rewrites[0]!.id;
    expect(rewriteOf("ch1")).toBe("mujin-rw-05");
    expect(rewriteOf("ch3")).toBe("mujin-rw-09");
    expect(rewriteOf("ch5")).toBe("mujin-rw-07");
    expect([rewriteOf("ch9"), rewriteOf("ch10")]).toEqual(["mujin-rw-10", "mujin-rw-10"]);
    const qa = new Set(chosen.map((selection) => selection.examples[0]!.id));
    expect(qa.size).toBeGreaterThanOrEqual(4);
    const rewrites = new Set(chosen.map((selection) => selection.rewrites[0]!.id));
    expect(rewrites.size).toBe(MUJIN_CATALOG.rewrites.length);
  });

  it("쏠림: 서로 다른 평가 사례의 최초 풀이에 같은 예시가 몰리지 않고, 무진 한 풀이의 장들에 같은 문답·재작성 예시가 몰리지 않는다", () => {
    const used = new Map<string, number>();
    for (const entry of EVALUATION_CASES) {
      const { examples } = getReadingPrompt("reading-3.2.0")(readingArgs(entry.id, `llm-export:${entry.id}`));
      for (const id of examples!.ids) used.set(id, (used.get(id) ?? 0) + 1);
    }
    expect(Math.max(...used.values())).toBeLessThanOrEqual(4);
    expect(used.size).toBeGreaterThanOrEqual(12);

    const sections = MUJIN_OVERVIEW.scroll.sections.filter((section) => section.kind !== "chart").map((section) => section.id);
    for (const readingSeed of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "llm-export:side-job-money"]) {
      const counts = new Map<string, number>();
      for (const sectionId of sections) {
        const built = buildVoiceRequest({
          bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!,
          persona: MUJIN,
          nickname: "가람",
          section: { sectionId, title: sectionId, questions: [], targetChars: { min: 600, max: 1200 } },
          draft: { sectionId, coreAnswer: "핵심", blocks: [{ type: "paragraph", questionIds: [], refs: [], text: "초안", items: [] }], scenes: [] },
          userFacts: [],
          hourKnown: true,
          exampleSeed: readingSeed,
        });
        for (const id of built.examples!.ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const rewrites = [...counts].filter(([id]) => id.startsWith("mujin-rw-"));
      expect(rewrites, readingSeed).toHaveLength(4);
      expect(Math.max(...rewrites.map(([, n]) => n)), readingSeed).toBeLessThanOrEqual(6);
      expect(Math.max(...[...counts].filter(([id]) => !id.startsWith("mujin-rw-")).map(([, n]) => n)), readingSeed).toBeLessThanOrEqual(5);
    }
  });

  it("재현성: 같은 조건과 순서 값이면 늘 같은 예시다 (재시도·서버 재시작). 무작위를 쓰지 않는다", () => {
    for (const catalog of [MYOMYO_CATALOG, MUJIN_CATALOG]) {
      const first = [...sweep(catalog)].map(({ selection }) => [...selection.rewrites, ...selection.examples].map((item) => item.id).join(","));
      const again = [...sweep(catalog)].map(({ selection }) => [...selection.rewrites, ...selection.examples].map((item) => item.id).join(","));
      expect(again).toEqual(first);
    }
  });

  it("진지함은 사용자가 지금 힘들다고 직접 쓴 말로만 본다", () => {
    expect(seriousSignal(["요즘 너무 지쳐서 아무것도 못 하겠어요"])).toBe(true);
    expect(seriousSignal(["엄마가 아프셔서 걱정이에요"])).toBe(true);
    expect(seriousSignal(["언제 이직하면 좋을까요?", "취업과 창업 중 무엇이 맞는지"])).toBe(false);
  });
});

// ─── 3) 조립 ─────────────────────────────────────────────

function readingArgs(caseId: string, seed = "reading-test") {
  const entry = EVALUATION_CASES.find((item) => item.id === caseId)!;
  const { plan } = casePlan(entry, "2026-11-12");
  return { plan, persona: MYOMYO, previousIssues: [] as string[], exampleSeed: seed };
}

function followupArgs(overrides: Partial<FollowupPromptArgs> = {}): FollowupPromptArgs {
  const { plan } = readingArgs("employee");
  return {
    persona: MYOMYO,
    nickname: "도토리",
    hourKnown: true,
    expression: FIRST_OVERVIEW.expression,
    situation: null,
    facts: plan.base.facts.map(({ ref, text }) => ({ ref, text })),
    userContext: [],
    questions: plan.questions,
    statements: plan.topics.filter((topic) => topic.topicId === "work").flatMap((topic) => topic.statements),
    timing: plan.timing,
    delivered: [],
    lastTurn: null,
    reaction: "none",
    previousIssues: [],
    exampleSeed: "followup-test",
    ...overrides,
  };
}

/** 예시 블록이 지시 끝에 한 번만 있고, 고른 ID가 모두 블록 안에 있으며 입력에는 예시가 없는지. */
function expectBlock(instructions: string, input: string, personaName: string, ids: readonly string[], catalog: ExampleCatalog) {
  expect(count(instructions, BLOCK_START(personaName))).toBe(1);
  expect(count(instructions, GUIDE_LINE)).toBe(1);
  expect(instructions.endsWith(BLOCK_END)).toBe(true);
  const block = instructions.slice(instructions.indexOf(BLOCK_START(personaName)));
  for (const id of ids) {
    expect(count(block, `id="${id}"`), id).toBe(1);
    expect(input).not.toContain(id);
    const example = catalog.examples.find((entry) => entry.id === id);
    const rewrite = catalog.rewrites.find((entry) => entry.id === id);
    if (example) {
      expect(block).toContain(example.answer);
      expect(block).toContain(`예시 질문: ${example.question}`);
      for (const line of example.premise) expect(block).toContain(line.text);
      // 예시의 답과 전제 문장은 사용자 메시지(현재 재료)에 섞이지 않는다.
      expect(input).not.toContain(example.answer.slice(0, 30));
    }
    if (rewrite) {
      for (const paragraph of rewrite.neutralDraft) expect(block).toContain(paragraph);
      for (const line of rewrite.preserve) expect(block).toContain(line);
    }
  }
}

describe("3) 조립", () => {
  it("예시를 쓰는 프롬프트 버전은 묘묘 최초 풀이·후속, 무진 Pass 2·후속뿐이다 (Pass 1·질문 정리·이전 버전은 예시 없음)", () => {
    expect([...examplePromptVersions()].sort()).toEqual(["followup-3.2.0", "mujin-followup-1.1.0", "mujin-voice-1.1.0", "reading-3.2.0"]);
    for (const version of ["reading-3.1.0", "followup-3.1.0", "mujin-voice-1.0.0", "mujin-followup-1.0.0", "mujin-draft-1.0.0", "mujin-question-1.0.0", "question-1.3.0"]) {
      expect(usesExamples(version), version).toBe(false);
    }
    expect(promptExampleConfig("reading-3.2.0")).toEqual({ personaId: "myomyo", catalogVersion: "myomyo-examples-1.0.0", policyVersion: EXAMPLE_POLICY_VERSION, route: "reading" });
    expect(promptExampleConfig("mujin-voice-1.1.0")).toEqual({ personaId: "mujin", catalogVersion: "mujin-examples-1.0.0", policyVersion: EXAMPLE_POLICY_VERSION, route: "voice" });
    expect(CURRENT_READING_PROMPT).toBe("reading-3.2.0");
    expect(CURRENT_FOLLOWUP_PROMPT).toBe("followup-3.2.0");
    expect(MUJIN_BUNDLE_VERSION).toBe("mujin-1.1.0");
  });

  it("캐릭터가 섞이지 않는다: 묘묘 버전에 무진을 넣거나 그 반대면 오류다", () => {
    expect(() => buildExampleBlock("reading-3.2.0", MUJIN, request({ route: "reading" }))).toThrow("examples_unavailable");
    expect(() => buildExampleBlock("mujin-voice-1.1.0", MYOMYO, request({ route: "voice" }))).toThrow("examples_unavailable");
    expect(() => buildExampleBlock("reading-3.1.0", MYOMYO, request({ route: "reading" }))).toThrow("examples_unavailable");
    for (const version of examplePromptVersions()) {
      const config = promptExampleConfig(version)!;
      const persona = config.personaId === "myomyo" ? MYOMYO : MUJIN;
      const { record } = buildExampleBlock(version, persona, request({ route: config.route, topics: ["career"] }));
      expect(record.ids.every((id) => id.startsWith(`${persona.id}-`)), version).toBe(true);
    }
  });

  it("묘묘 최초 풀이(reading-3.2.0): 3.1.0과 같은 지시 끝에 예시 블록만 더하고, 입력과 출력 형식은 같다", () => {
    for (const caseId of EVALUATION_CASES.map((entry) => entry.id)) {
      const args = readingArgs(caseId);
      const current = getReadingPrompt("reading-3.2.0")(args);
      const before = getReadingPrompt("reading-3.1.0")(args);
      expect(before.examples).toBeUndefined();
      expect(current.examples).toMatchObject({ catalogVersion: "myomyo-examples-1.0.0", policyVersion: EXAMPLE_POLICY_VERSION, route: "reading" });
      expect(current.instructions.startsWith(`${before.instructions}\n\n${BLOCK_START("묘묘")}`)).toBe(true);
      expect(current.input).toBe(before.input);
      expectBlock(current.instructions, current.input, "묘묘", current.examples!.ids, MYOMYO_CATALOG);
      // 고른 조건은 저장된 작성 재료에서만 만든다.
      expect(readingExampleRequest(args).seed).toBe("reading-test");
    }
  });

  it("묘묘 최초 풀이: 재시도·이어 쓰기(문제 목록, 이미 보낸 부분)에서도 같은 예시를 같은 자리에 넣는다", () => {
    const args = readingArgs("job-seeking", "11111111-1111-4111-8111-111111111111");
    const first = getReadingPrompt("reading-3.2.0")(args);
    const retry = getReadingPrompt("reading-3.2.0")({
      ...args,
      previousIssues: ["s3의 근거가 맞지 않습니다."],
      alreadySent: { opening: "안녕", focus: [], topics: [{ topicId: "temperament", texts: ["보낸 말"] }] },
    } as never);
    expect(retry.examples).toEqual(first.examples);
    const block = (text: string) => text.slice(text.indexOf(BLOCK_START("묘묘")));
    expect(block(retry.instructions)).toBe(block(first.instructions));
  });

  it("묘묘 후속 답변(followup-3.2.0): 3.1.0 지시 끝에 예시를 더하고, 반응이 있으면 그 반응 예시를 넣는다. 재작성에서도 같다", () => {
    const before = buildFollowupPrompt(followupArgs({ promptVersion: "followup-3.1.0" }));
    const current = buildFollowupPrompt(followupArgs());
    expect(before.examples).toBeNull();
    expect(current.instructions.startsWith(`${before.instructions}\n\n${BLOCK_START("묘묘")}`)).toBe(true);
    expect(current.input).toBe(before.input);
    expect([current.schemaName, current.jsonSchema]).toEqual([before.schemaName, before.jsonSchema]);
    expectBlock(current.instructions, current.input, "묘묘", current.examples!.ids, MYOMYO_CATALOG);
    const praised = buildFollowupPrompt(followupArgs({ reaction: "praise" }));
    expect(praised.examples!.ids.some((id) => MYOMYO_CATALOG.examples.find((example) => example.id === id)?.reaction === "praise")).toBe(true);
    const rewrite = buildFollowupPrompt(followupArgs({ previousIssues: ["질문(q1)에 대한 답이 없습니다."], alreadySent: [{ questionRef: "q1", paragraphs: ["보낸 문단"] }] }));
    expect(rewrite.examples).toEqual(current.examples);
    expect(followupExampleRequest(followupArgs()).hasLastTurn).toBe(false);
    expect(() => buildFollowupPrompt(followupArgs({ promptVersion: "followup-2.9.0" }))).toThrow("prompt_version_unavailable");
  });

  it("무진 Pass 2(mujin-voice-1.1.0): 1.0.0 지시 끝에 재작성 예시(초안 → 무진의 글)와 문답을 넣고, Pass 1·질문 정리에는 넣지 않는다", async () => {
    const evaluation = await buildMujinEvaluation(MUJIN_EVALUATION_CASES.find((entry) => entry.id === "side-job-money")!);
    const before = await buildMujinEvaluation(MUJIN_EVALUATION_CASES.find((entry) => entry.id === "side-job-money")!, undefined, { bundleId: "mujin-1.0.0" });
    // Pass 1은 두 묶음이 글자까지 같고 예시가 없다.
    const drafts1 = pass1Requests(evaluation).requests;
    const drafts0 = pass1Requests(before).requests;
    expect(drafts1.map((entry) => entry.request.instructions)).toEqual(drafts0.map((entry) => entry.request.instructions));
    for (const { request: built } of drafts1) {
      expect(built.examples).toBeNull();
      expect(built.instructions).not.toContain("[캐릭터 문답 예시");
      expect(built.instructions).not.toContain("[캐릭터: 무진 도사]");
    }
    const question = buildMujinQuestionRequest({ product: MUJIN_OVERVIEW, concern: "언제 이직할까요?", referenceDate: "2026-11-12" });
    expect(question.examples).toBeNull();
    expect(question.instructions).not.toContain("[캐릭터 문답 예시");

    const drafts = new Map<string, ScrollDraftContent>();
    for (const section of MUJIN_OVERVIEW.scroll.sections.filter((entry) => entry.kind === "chapter" || entry.kind === "basics")) {
      drafts.set(section.id, { sectionId: section.id, coreAnswer: "핵심 답", blocks: [{ type: "paragraph", questionIds: [], refs: [], text: "초안 문단", items: [] }], scenes: [] });
    }
    const voices = pass2Requests(evaluation, { drafts, finals: new Map() });
    const voices0 = new Map(pass2Requests(before, { drafts, finals: new Map() }).map((entry) => [entry.sectionId, entry.request] as const));
    expect(voices.length).toBeGreaterThan(10);
    for (const { sectionId, request: built } of voices) {
      const old = voices0.get(sectionId)!;
      expect(old.examples).toBeNull();
      expect(built.instructions.startsWith(`${old.instructions}\n\n${BLOCK_START("무진 도사")}`), sectionId).toBe(true);
      expect(built.input).toBe(old.input);
      expect(built.examples!.ids).toHaveLength(2);
      expect(built.examples!.ids[0]).toMatch(/^mujin-rw-/);
      expectBlock(built.instructions, built.input, "무진 도사", built.examples!.ids, MUJIN_CATALOG);
      expect(built.instructions).toContain("<rewrite-example ");
      expect(built.instructions).toContain("다시 쓰기 예시(rewrite-example)는 중립 초안이 같은 뜻의 [캐릭터] 설명으로 바뀌는 모습이다");
    }
  });

  it("무진 Pass 2: 같은 장의 재시도(문제 목록)는 같은 예시이고, 출력 형식은 1.0.0과 같다", () => {
    const bundle = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;
    const input: VoicePromptInput = {
      bundle,
      persona: MUJIN,
      nickname: "가람",
      section: { sectionId: "ch4", title: "재물과 돈 관리", questions: [], targetChars: { min: 900, max: 1500 } },
      draft: { sectionId: "ch4", coreAnswer: "핵심", blocks: [{ type: "paragraph", questionIds: [], refs: ["m1"], text: "초안", items: [] }], scenes: [] },
      userFacts: [],
      hourKnown: false,
      exampleSeed: "11111111-1111-4111-8111-111111111111",
    };
    const first = buildVoiceRequest(input);
    const retry = buildVoiceRequest({ ...input, previousIssues: ["ch4 블록 1: 초안에 없던 숫자를 썼습니다 (20)."] });
    expect(retry.examples).toEqual(first.examples);
    const old = buildVoiceRequest({ ...input, bundle: MUJIN_BUNDLES["mujin-1.0.0"]! });
    expect([first.schemaName, first.jsonSchema]).toEqual([old.schemaName, old.jsonSchema]);
  });

  it("무진 후속 답변(mujin-followup-1.1.0): 1.0.0 지시 끝에 예시를 더하고 입력은 같다", () => {
    const base: MujinFollowupPromptInput = {
      bundle: MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!,
      persona: MUJIN,
      nickname: "가람",
      hourKnown: true,
      coverageNotes: [],
      referenceDate: null,
      today: "2026-11-13",
      questions: [{ ref: "q1", summary: "언제 이직을 준비하면 좋을지", domain: "career", intent: "timing", answerability: "full", missingInfo: [], timingSupported: true, period: null, sectionIds: ["ch3", "ch10"] }],
      facts: [],
      nowFacts: [],
      userContext: [],
      chapters: [],
      overview: [],
      timing: null,
      lastTurn: null,
      reaction: "tease",
      exampleSeed: "22222222-2222-4222-8222-222222222222",
    };
    const current = buildMujinFollowupRequest(base);
    const before = buildMujinFollowupRequest({ ...base, bundle: MUJIN_BUNDLES["mujin-1.0.0"]! });
    expect(before.examples).toBeNull();
    expect(current.instructions.startsWith(`${before.instructions}\n\n${BLOCK_START("무진 도사")}`)).toBe(true);
    expect(current.input).toBe(before.input);
    expectBlock(current.instructions, current.input, "무진 도사", current.examples!.ids, MUJIN_CATALOG);
    expect(current.examples!.ids.some((id) => ["mujin-03", "mujin-14"].includes(id))).toBe(true);
    expect(buildMujinFollowupRequest({ ...base, previousIssues: ["질문(q1)에 대한 답이 없습니다."] }).examples).toEqual(current.examples);
  });

  it("캐릭터 설정의 examples 칸은 쓰지 않는다: 예시는 카탈로그에서 오고 설정은 그대로다", () => {
    expect(MYOMYO.examples).toEqual([]);
    expect(MUJIN.examples).toEqual([]);
    const { instructions, examples } = getReadingPrompt("reading-3.2.0")(readingArgs("romance-light"));
    expect(examples!.ids.length).toBeGreaterThanOrEqual(2);
    for (const id of examples!.ids) expect(instructions).toContain(MYOMYO_CATALOG.examples.find((example) => example.id === id)!.answer);
  });
});

/** 무진 원문 텍스트의 지문 (2026-11-13에 받은 원문). */
const ORIGINALS_FINGERPRINT = "10f0946d1709a6f8daa44d8cf9ac8926548d82ebfe34fe9d33533dee0371d41c";
