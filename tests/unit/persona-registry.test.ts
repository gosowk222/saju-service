import { describe, expect, it } from "vitest";
import { MUJIN, MYOMYO, MYOMYO_1_0_0, createPersonaRegistry, findPersona, type Persona, type PersonaLines } from "@/domain/personas";
import { EXAMPLE_POLICY_VERSION, findExampleCatalog, findExamplePolicy, type ExampleCatalog } from "@/domain/personas/examples";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { PRODUCTS, isMessengerProduct, type ProductDefinition } from "@/domain/products";
import { buildQuestionAnalysis } from "@/domain/reading/question";
import { MESSENGER_BUNDLES, findMessengerBundle, messengerFollowupFor, type MessengerBundle } from "@/server/generation/bundles";
import { buildExampleBlockFor, EXAMPLE_GUIDE_1_1_0, type ExampleSources } from "@/server/llm/example-block";
import { hasMessengerPrompts } from "@/server/llm/messenger-prompts";
import { findMujinBundle } from "@/server/llm/mujin-prompts";
import { buildFollowupPrompt } from "@/server/llm/prompts";
import { routeWithoutItems } from "@/server/readings/followup-core";
import { casePlan, EVALUATION_CASES } from "../../scripts/llm-cases";
import { fakeModel, fakeStore, newRun } from "../support/messenger-fakes";

/**
 * 캐릭터 레지스트리와 상품·생성 묶음 연결. 테스트용 세 번째 캐릭터(선배, sunbae)를 등록해 공통 생성기(MessengerRun),
 * 예시 블록 조립, 후속 답변 지시, 모델 없이 보내는 고정 안내가 코드를 고치지 않고 그 캐릭터로 연결되는지 본다.
 * 이 캐릭터와 상품은 테스트 안에만 있다 (서비스 레지스트리·상품 목록에 등록하지 않는다).
 */

const SUNBAE_LINES: PersonaLines = {
  outOfScope: (topics) => `[선배] 그건 범위 밖이에요. ${topics}까지 봐 드려요.`,
  partialScope: (excluded) => `[선배] ${excluded}은(는) 빼고 답했어요.`,
  notCharged: "[선배] 이번 질문은 세지 않았어요.",
  clarify: "[선배] 조금 더 구체적으로 물어봐 주세요.",
  previewDayMaster: (call, dayMaster) => `[선배] ${call}, 일간은 ${dayMaster}예요.`,
  previewLead: (text) => `[선배] ${text}`,
  previewNone: "[선배] 근거가 부족해요.",
  reaction: () => "[선배] 고마워요.",
  reactionFree: "[선배] 이번 건 세지 않았어요.",
  reactionCharged: "[선배] 이번 건 질문 1회로 셌어요.",
};

const SUNBAE: Persona = {
  id: "sunbae",
  version: "1.0.0",
  name: "선배",
  avatarGlyph: "선",
  role: "테스트용 가상 캐릭터. 차분하게 핵심부터 짚는 선배.",
  intro: "테스트용 캐릭터",
  signatureLine: "테스트용 대사",
  speech: "polite",
  relationship: "사용자를 아끼는 선배.",
  tone: ["차분하고 다정하다."],
  speaking: ["존댓말로 핵심을 먼저 말한다."],
  moments: ["사용자가 힘들다고 하면 차분히 받아 준다."],
  teasing: ["놀리지 않는다."],
  sceneStyle: ["장면은 가정하는 말로 짧게 그린다."],
  examples: [],
  catchphrases: [],
  lines: SUNBAE_LINES,
};

const SUNBAE_CATALOG: ExampleCatalog = {
  version: "sunbae-examples-test-1.0.0",
  personaId: "sunbae",
  examples: [
    {
      id: "sunbae-01",
      personaId: "sunbae",
      version: "1.0.0",
      setId: "test",
      routes: ["voice", "followup"],
      topics: ["general"],
      purposes: ["explain"],
      length: "medium",
      serious: false,
      premise: [],
      question: "가상 질문",
      answer: "가상 선배 답변이에요.",
      source: { kind: "authored", basis: "테스트용" },
    },
    {
      id: "sunbae-02",
      personaId: "sunbae",
      version: "1.0.0",
      setId: "test",
      routes: ["voice", "followup"],
      topics: ["career"],
      purposes: ["apply"],
      length: "medium",
      serious: false,
      premise: [],
      question: "가상 질문 둘",
      answer: "가상 선배 두 번째 답변이에요.",
      source: { kind: "authored", basis: "테스트용" },
    },
  ],
  rewrites: [
    {
      id: "sunbae-rw-01",
      personaId: "sunbae",
      version: "1.0.0",
      setId: "rewrite",
      routes: ["voice"],
      topics: ["general"],
      sourceExampleId: "sunbae-01",
      neutralDraft: ["가상 중립 초안이다."],
      preserve: ["가상 판단"],
    },
  ],
};

const SOURCES: ExampleSources = {
  findCatalog: (version) => (version === SUNBAE_CATALOG.version ? SUNBAE_CATALOG : findExampleCatalog(version)),
  findPolicy: findExamplePolicy,
};

const binding = (route: "voice" | "followup") => ({
  personaId: "sunbae",
  catalogVersion: SUNBAE_CATALOG.version,
  policyVersion: EXAMPLE_POLICY_VERSION,
  route,
  guideVersion: EXAMPLE_GUIDE_1_1_0,
});

/** 묘묘 묶음과 같은 생성 정책(지시·형식·설정)을 쓰고 캐릭터와 예시 연결만 다른 테스트 묶음. */
const SUNBAE_BUNDLE: MessengerBundle = {
  ...MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!,
  id: "sunbae-2pass-test",
  personaId: "sunbae",
  personaVersion: "1.0.0",
  examples: binding("voice"),
  followup: { ...MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!.followup, examples: binding("followup") },
};

const REGISTRY = createPersonaRegistry([
  { current: MYOMYO, earlier: [MYOMYO_1_0_0] },
  { current: MUJIN, earlier: [] },
  { current: SUNBAE, earlier: [] },
]);

const TEST_PRODUCT: ProductDefinition = { ...FIRST_OVERVIEW, id: "test-product", personaId: "sunbae", generation: { bundle: SUNBAE_BUNDLE.id } };
const bundles = (id: string) => (id === SUNBAE_BUNDLE.id ? SUNBAE_BUNDLE : findMessengerBundle(id));
const exampleIds = (instructions: string) => [...instructions.matchAll(/<(?:rewrite-)?example id="([^"]+)"/g)].map((match) => match[1]!);

describe("캐릭터 레지스트리", () => {
  it("모르는 캐릭터·버전은 undefined다 (묘묘나 현재 설정으로 바꾸지 않는다)", () => {
    expect(findPersona("unknown")).toBeUndefined();
    expect(findPersona("unknown", "1.0.0")).toBeUndefined();
    expect(findPersona("myomyo", "9.9.9")).toBeUndefined();
    expect(findPersona("mujin", MYOMYO.version)).toBeUndefined();
    expect(findPersona("myomyo")).toBe(MYOMYO);
    expect(REGISTRY.find("sunbae")).toBe(SUNBAE);
    expect(REGISTRY.ids()).toEqual(["myomyo", "mujin", "sunbae"]);
  });

  it("같은 ID나 같은 버전이 두 번 있거나 이전 설정의 캐릭터가 다르면 등록하지 않는다", () => {
    expect(() => createPersonaRegistry([{ current: MYOMYO, earlier: [] }, { current: MYOMYO, earlier: [] }])).toThrow(/겹칩니다/);
    expect(() => createPersonaRegistry([{ current: MYOMYO, earlier: [MYOMYO] }])).toThrow(/버전이 겹칩니다/);
    expect(() => createPersonaRegistry([{ current: MYOMYO, earlier: [MUJIN] }])).toThrow(/다른 캐릭터/);
  });

  it("상품마다 생성 묶음이 있고, 묶음의 캐릭터가 상품의 캐릭터와 같고, 그 버전의 설정과 지시가 있다", () => {
    for (const product of PRODUCTS) {
      if (isMessengerProduct(product)) {
        const bundle = findMessengerBundle(product.generation.bundle)!;
        expect(bundle, product.id).toBeDefined();
        expect(bundle.personaId).toBe(product.personaId);
        expect(findPersona(bundle.personaId, bundle.personaVersion), product.id).toBeDefined();
        expect(hasMessengerPrompts(bundle)).toBe(true);
        expect(bundle.examples.personaId).toBe(product.personaId);
        expect(bundle.followup.examples.personaId).toBe(product.personaId);
        expect(findExampleCatalog(bundle.examples.catalogVersion)?.personaId).toBe(product.personaId);
      } else {
        const bundle = findMujinBundle(product.generation.bundle)!;
        expect(bundle, product.id).toBeDefined();
        expect(findPersona(product.personaId, bundle.personaVersion), product.id).toBeDefined();
      }
    }
  });

  it("묘묘와 무진의 예시가 섞이지 않는다: 다른 캐릭터의 연결로 조립하면 오류다", () => {
    const myomyo = findMessengerBundle(FIRST_OVERVIEW.generation.bundle)!;
    const request = { topics: [], long: true, serious: false, reaction: "none" as const, intents: [], limited: false, hourUnknown: false, hasLastTurn: false, seed: "x" };
    expect(() => buildExampleBlockFor(myomyo.examples, MUJIN, request, myomyo.id)).toThrow(/examples_unavailable/);
    const built = buildExampleBlockFor(myomyo.examples, MYOMYO, request, myomyo.id);
    expect(built.record.ids.every((id) => id.startsWith("myomyo-v2-"))).toBe(true);
  });
});

describe("테스트용 세 번째 캐릭터 (공통 코드를 고치지 않고 연결)", () => {
  it("공통 2-pass 실행기가 그 캐릭터의 [캐릭터]와 예시로 Pass 2를 만들고, 호출 기록에 그 캐릭터와 묶음이 남는다", async () => {
    const { plan, chart } = casePlan(EVALUATION_CASES.find((entry) => entry.id === "job-seeking")!, "2026-11-12");
    const store = fakeStore();
    const model = fakeModel();
    const result = await newRun({ plan, chart, store, model, bundle: SUNBAE_BUNDLE, persona: SUNBAE, exampleSources: SOURCES, productId: TEST_PRODUCT.id }).execute();
    expect(result.kind).toBe("completed");
    for (const voice of model.voices) {
      expect(voice.instructions).toContain("[캐릭터: 선배]");
      expect(voice.instructions).not.toContain("묘묘");
      expect(voice.instructions).toContain("[캐릭터 문답 예시: 선배]");
      expect(exampleIds(voice.instructions).every((id) => id.startsWith("sunbae-"))).toBe(true);
    }
    // 중립 초안은 캐릭터와 관계없이 같은 지시다.
    for (const draft of model.drafts) expect(draft.instructions).not.toContain("선배");
    expect(store.callRows.every((row) => row.personaId === "sunbae" && row.policyVersion === SUNBAE_BUNDLE.id && row.productId === TEST_PRODUCT.id)).toBe(true);
    // 존댓말 캐릭터의 호칭 (address.call은 '님').
    const firstVoiceInput = JSON.parse(model.voices[0]!.input) as { address: { call: string } };
    expect(firstVoiceInput.address.call.endsWith(" 님")).toBe(true);
  });

  it("후속 답변: 상품의 묶음이 그 캐릭터 설정·지시·예시를 정하고, 고정 안내도 그 캐릭터의 문장이다", () => {
    const voice = messengerFollowupFor(TEST_PRODUCT, REGISTRY.find, bundles)!;
    expect(voice.persona).toBe(SUNBAE);
    expect(voice.bundle.followup.prompt).toBe("followup-3.3.0");
    const args = {
      persona: voice.persona,
      nickname: "가상별명",
      hourKnown: true,
      expression: TEST_PRODUCT.expression,
      situation: null,
      facts: [],
      userContext: [],
      questions: [],
      statements: [],
      timing: [],
      delivered: [],
      lastTurn: null,
      previousIssues: [],
      reaction: "none" as const,
      exampleSeed: "followup-test",
    };
    const prompt = buildFollowupPrompt({ ...args, promptVersion: voice.bundle.followup.prompt, examples: voice.bundle.followup.examples, exampleSources: SOURCES });
    expect(prompt.instructions).toContain("[캐릭터: 선배]");
    expect(prompt.examples?.ids.every((id) => id.startsWith("sunbae-"))).toBe(true);
    // 묶음 연결 없이 followup-3.3.0을 만들면 예시 없이 보내지 않고 오류다.
    expect(() => buildFollowupPrompt({ ...args, promptVersion: "followup-3.3.0" })).toThrow(/examples_unavailable/);

    const analysis = buildQuestionAnalysis(TEST_PRODUCT, "2026-11-12", { items: [], userFacts: [], needsClarification: true, reaction: "none" });
    expect(routeWithoutItems(TEST_PRODUCT, voice.persona, analysis).answer).toBe(SUNBAE_LINES.clarify);
  });

  it("묶음이나 캐릭터를 모르면 후속 답변 설정이 없다 (묘묘로 바꾸지 않는다)", () => {
    expect(messengerFollowupFor({ ...TEST_PRODUCT, generation: { bundle: "unknown-bundle" } }, REGISTRY.find, bundles)).toBeNull();
    // 서비스 레지스트리에는 테스트 캐릭터가 없다.
    expect(messengerFollowupFor(TEST_PRODUCT, findPersona, bundles)).toBeNull();
    // 상품의 캐릭터와 묶음의 캐릭터가 다르면 쓰지 않는다.
    expect(messengerFollowupFor({ ...TEST_PRODUCT, personaId: "myomyo" }, REGISTRY.find, bundles)).toBeNull();
    expect(messengerFollowupFor(FIRST_OVERVIEW)?.persona).toBe(MYOMYO);
  });
});
