import { describe, expect, it } from "vitest";
import { MYOMYO } from "@/domain/personas";
import {
  EXAMPLE_LIMITS,
  EXAMPLE_POLICY_VERSION,
  findExampleCatalog,
  rewriteView,
  type ExampleReaction,
  type ExampleRequest,
  type ExampleRoute,
  type ExampleTopic,
} from "@/domain/personas/examples";
import { MYOMYO_ORIGINALS_2_TEXT } from "@/domain/personas/examples/myomyo-originals-2";
import { selectExamples } from "@/domain/personas/examples/select";
import { MESSENGER_BUNDLES } from "@/server/generation/bundles";
import { buildExampleBlockFor } from "@/server/llm/example-block";

/**
 * 묘묘 예시 카탈로그 myomyo-examples-2.0.0 (사용자가 준 기준 문답 12개). 원문 보존, 재작성 예시의 의미 대응, 경로·선택 규칙, 블록 크기를 본다.
 * 모델을 부르지 않는다. 예시가 실제 문체를 좋게 하는지는 사용자가 실제 모델로 비교한다 (LIVE_NOT_RUN).
 */

const CATALOG = findExampleCatalog("myomyo-examples-2.0.0")!;
const OLD = findExampleCatalog("myomyo-examples-1.0.0")!;
const byId = (id: string) => CATALOG.examples.find((example) => example.id === id)!;
const paragraphs = (text: string) => text.split("\n\n");

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

describe("묘묘 예시 카탈로그 2.0.0", () => {
  it("사용자가 준 12개 문답을 받은 그대로 담는다 (질문·답변·입력 전제, 문단)", () => {
    expect(CATALOG.personaId).toBe("myomyo");
    expect(CATALOG.examples.map((example) => example.id)).toEqual(Array.from({ length: 12 }, (_, index) => `myomyo-v2-${String(index + 1).padStart(2, "0")}`));
    const raw = MYOMYO_ORIGINALS_2_TEXT.replace(/\r\n/g, "\n");
    for (const example of CATALOG.examples) {
      expect(example.source.kind, example.id).toBe("user-original");
      expect(raw).toContain(`사용자:\n${example.question}\n`);
      for (const paragraph of paragraphs(example.answer)) expect(raw, example.id).toContain(paragraph);
      for (const line of example.premise) expect(raw).toContain(`- ${line.text}`);
    }
    expect(byId("myomyo-v2-04").premise.map((line) => line.kind)).toEqual(["judgment", "condition", "action", "limit"]);
    expect(byId("myomyo-v2-05").premise).toHaveLength(3);
    expect(byId("myomyo-v2-08").premise).toHaveLength(5);
    expect(byId("myomyo-v2-11").premise.map((line) => line.kind)).toEqual(["user-fact", "context"]);
    expect(paragraphs(byId("myomyo-v2-08").answer)).toHaveLength(5);
    expect(byId("myomyo-v2-10").answer.startsWith("……아, 그건 장난칠 얘기가 아니네.")).toBe(true);
  });

  it("이전 묘묘 예시 묶음(1.0.0)과 섞이지 않는다. 1.0.0은 그 버전에 고정된 작업을 위해 그대로 남는다", () => {
    expect(OLD.examples).toHaveLength(27);
    const oldIds = new Set(OLD.examples.map((example) => example.id));
    expect(CATALOG.examples.some((example) => oldIds.has(example.id))).toBe(false);
    expect(MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!.examples.catalogVersion).toBe(CATALOG.version);
    expect(MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!.followup.examples.catalogVersion).toBe(CATALOG.version);
  });

  it("본문용 04·05·08은 원문을 참조하는 재작성 예시(중립 초안 → 묘묘 답변)로도 연결되고, 원문 답변을 고치지 않는다", () => {
    expect(CATALOG.rewrites.map((rewrite) => rewrite.sourceExampleId)).toEqual(["myomyo-v2-04", "myomyo-v2-05", "myomyo-v2-08"]);
    for (const rewrite of CATALOG.rewrites) {
      const view = rewriteView(CATALOG, rewrite);
      const source = byId(rewrite.sourceExampleId);
      expect(view.rewritten).toBe(source.answer);
      expect(view.premise).toBe(source.premise);
      expect(rewrite.neutralDraft.length, rewrite.id).toBe(paragraphs(source.answer).length);
      expect(rewrite.preserve.length).toBeGreaterThan(2);
      expect(rewrite.routes).toEqual(["voice"]);
      for (const paragraph of rewrite.neutralDraft) {
        // 중립 초안은 평서문이다. 묘묘의 반말·감탄·물결표를 넣지 않는다.
        expect(paragraph.trim().endsWith("다."), paragraph).toBe(true);
        expect(paragraph).not.toMatch(/~|어라|오호|으이구|잖아|거든|인정\.|너 |네가/);
      }
    }
  });

  it("재작성 예시의 초안은 답변의 핵심 뜻을 모두 담는다 (Pass 2가 새 판단을 더하는 시범이 되지 않게)", () => {
    const draftOf = (id: string) => CATALOG.rewrites.find((rewrite) => rewrite.sourceExampleId === id)!.neutralDraft.join(" ");
    // 04: 확인이 앞서는 경향, 신중함 인정, 신호가 없으면 알 수 없음, 큰 고백이 아닌 안부·함께할 일, 확인과 표현의 시간 나누기.
    for (const meaning of ["상대를 더 살펴보는", "신중함", "신호", "큰 고백", "안부", "함께할 일", "나누어"]) expect(draftOf("myomyo-v2-04")).toContain(meaning);
    // 05: 깊이 파고드는 강점, 아무 데나 쓰지 않기, 중요한 부분 고르기, 결과가 늦어짐, 쓸 곳을 고르기.
    for (const meaning of ["깊이 파고드는", "모든 일에 똑같이", "중요한 부분", "늦어질", "어디에 쓸지"]) expect(draftOf("myomyo-v2-05")).toContain(meaning);
    // 08: 스스로 정하는 방식, 회사 싫음 → 프리랜서 정답이 아님, 재량과 책임, 일 구하기·고객·조건, 일감과 생활 조건, 다른 형태의 간섭.
    for (const meaning of ["스스로 정할 수 있는지", "프리랜서가 정답", "재량과 책임", "일을 구하고", "고객 의견", "실제 일감과 생활 조건", "다른 형태의 간섭"]) {
      expect(draftOf("myomyo-v2-08")).toContain(meaning);
    }
  });

  it("경로: 칭찬·오류 정정은 후속 답변에만, 오류 정정은 의심 반응이고 실제 직전 대화가 있을 때만, 진지한 예시는 힘들다고 말했을 때만", () => {
    expect(byId("myomyo-v2-11")).toMatchObject({ routes: ["followup"], reaction: "doubt", needs: { lastTurn: true } });
    expect(byId("myomyo-v2-12")).toMatchObject({ routes: ["followup"], reaction: "praise" });
    expect(byId("myomyo-v2-10")).toMatchObject({ serious: true });
    for (const example of CATALOG.examples.filter((entry) => !entry.reaction)) expect(example.routes).toEqual(["voice", "followup"]);
  });

  it("선택: 어떤 조건에서도 0개가 되지 않고, Pass 2는 재작성 예시 하나와 문답 하나, 후속 답변은 3개까지다", () => {
    const topics: readonly ExampleTopic[] = ["temperament", "strengths", "career", "wealth", "romance", "social", "friends", "family", "place", "timing", "general"];
    const reactions: readonly ("none" | ExampleReaction)[] = ["none", "praise", "tease", "doubt"];
    for (const route of ["voice", "followup"] as const satisfies readonly ExampleRoute[]) {
      for (const topic of topics) {
        for (const reaction of route === "followup" ? reactions : (["none"] as const)) {
          for (const serious of [false, true]) {
            for (const hasLastTurn of [false, true]) {
              const input = request({ route, topics: [topic], long: route === "voice", serious, reaction, hasLastTurn, seed: `${route}:${topic}:${reaction}:${serious}:${hasLastTurn}` });
              const selection = selectExamples(CATALOG, input);
              const ids = selection.examples.map((example) => example.id);
              expect(selection.examples.length + selection.rewrites.length, input.seed).toBeGreaterThan(0);
              expect(selection.examples.length).toBeLessThanOrEqual(EXAMPLE_LIMITS[route].examples);
              if (route === "voice") {
                expect(selection.rewrites).toHaveLength(1);
                expect(selection.examples).toHaveLength(1);
                expect(ids).not.toContain("myomyo-v2-11");
                expect(ids).not.toContain("myomyo-v2-12");
              }
              if (ids.includes("myomyo-v2-11")) expect(reaction === "doubt" && hasLastTurn).toBe(true);
              if (ids.includes("myomyo-v2-12")) expect(reaction).toBe("praise");
              if (ids.includes("myomyo-v2-10")) expect(serious).toBe(true);
              // 사용자가 지금 힘들다고 말하면 진지한 예시가 들어간다 (가벼운 놀림 예시만 고르지 않는다).
              if (serious && route === "followup" && reaction === "none") expect(ids).toContain("myomyo-v2-10");
            }
          }
        }
      }
    }
  });

  it("블록 크기: Pass 2·후속 답변 요청 하나에 붙는 예시 블록은 2~3개 예시이고 글자 수가 정해 둔 범위 안이다", () => {
    const bundle = MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!;
    const sizes: number[] = [];
    for (const topic of ["career", "romance", "strengths", "wealth", "temperament"] as const) {
      const voice = buildExampleBlockFor(bundle.examples, MYOMYO, request({ route: "voice", topics: [topic], long: true, seed: `size:${topic}` }), bundle.id);
      const followup = buildExampleBlockFor(bundle.followup.examples, MYOMYO, request({ route: "followup", topics: [topic], seed: `size:${topic}` }), bundle.id);
      expect(voice.record.ids).toHaveLength(2);
      expect(followup.record.ids.length).toBeGreaterThanOrEqual(2);
      expect(voice.record.guideVersion).toBe("example-guide-1.1.0");
      expect(voice.record.policyVersion).toBe(EXAMPLE_POLICY_VERSION);
      sizes.push(voice.text.length, followup.text.length);
    }
    // 블록은 대략 1,500~3,500자다 (한국어 1자는 토큰 1개 안팎). 크게 늘면 선택 수를 다시 본다.
    expect(Math.max(...sizes)).toBeLessThan(4500);
    expect(Math.min(...sizes)).toBeGreaterThan(800);
  });
});
