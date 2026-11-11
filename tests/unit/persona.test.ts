import { describe, expect, it } from "vitest";
import { MYOMYO, addressFor, findPersona, toCasual, withSubject } from "@/domain/personas";
import { findLegacyPersona } from "@/domain/personas/legacy";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { checkFollowupV2 } from "@/domain/reading/check";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { emptyAnalysis } from "@/domain/reading/question";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { CURRENT_FOLLOWUP_PROMPT, CURRENT_READING_PROMPT, buildFollowupPrompt, characterBlock, getReadingPrompt, promptPersona } from "@/server/llm/prompts";
import { withoutEmoji } from "@/server/pdf/render";

/**
 * 캐릭터 묘묘 2.0.0과 현재 지시(reading-3.0.0, followup-3.0.0). 이전 설정 1.x와 이전 지시는 이어 쓰는 작업에만 쓴다.
 * 실제 지시 문자열과 입력으로 확인한다. 실제 모델의 문장 품질은 확인하지 않는다 (LIVE_NOT_RUN, docs/personas/myomyo-evaluation.md).
 */

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const base: AnalyzeInput = {
  birthDate: "1998-09-19",
  calendar: "solar",
  isLeapMonth: false,
  gender: "female",
  birthTime: { status: "branch", branch: "신" },
  birthPlace: place,
};
const analyze = (input: AnalyzeInput = base, nickname = "달빛") =>
  analyzeBirth({ birth: toPublicBirthInput(input), product: FIRST_OVERVIEW, nickname, situationId: null });

/** 이전 설정에만 있던 말버릇·완성 대사·견본. 현재 설정과 현재 지시에는 없어야 한다. */
const OLD_PHRASES = ["어라~?", "흐응", "으이구", "그럴 줄 알았지", "흥, 그건 인정", "바보야", "허접", "쫄았", "풉", "흐, 흐응", "뭐, 뭐야. 허세 아니거든?", "봐, 맞지?", "내 눈은 못 속여"];
/** 이전 지시의 구성 요소. 현재 지시에는 없어야 한다. */
const OLD_SECTIONS = ["말버릇 (", "자주 쓰는 말:", "가끔 쓰는 놀림:", "그림 이모티콘:", "말투 견본", "같은 판단, 다른 말", "밋밋한 말", "시범", "묘묘다운 순간", "1층. 사실과 판단", "상황에 따라 달라지는 반응"];

describe("캐릭터 등록과 버전", () => {
  it("첫 상품의 캐릭터는 묘묘 하나이고, 새 풀이 기록에 현재 설정 버전(2.0.0)이 남는다", () => {
    expect(FIRST_OVERVIEW.personaId).toBe("myomyo");
    expect(findPersona("myomyo")).toBe(MYOMYO);
    expect(findPersona("yeoul")).toBeUndefined();
    expect(MYOMYO.version).toBe("2.0.0");
    const { plan } = analyze();
    expect([plan.personaId, plan.personaVersion]).toEqual(["myomyo", "2.0.0"]);
  });

  it("현재 설정은 성격과 행동 원칙만 갖고, 예시 문장·말버릇 목록·횟수 제한 칸이 없다", () => {
    expect(Object.keys(MYOMYO).sort()).toEqual(["avatar", "avatarGlyph", "character", "id", "intro", "lines", "name", "signatureLine", "speech", "version"]);
    expect(Object.keys(MYOMYO.character).sort()).toEqual(["behaviors", "identity", "limits", "traits"]);
    const character = JSON.stringify(MYOMYO.character);
    for (const phrase of OLD_PHRASES) expect(character).not.toContain(phrase);
    // 이전 설정에서 성격을 끄던 말이 없다.
    for (const text of ["설명하는 부분은 장난을 줄이고", "놀림은 약하게만"]) expect(character).not.toContain(text);
  });

  it("성격과 대화 행동: 여성 캐릭터, 자칭 천재, 빈틈·강점·이유·조언·칭찬·허세 지적·실제 오류·진지한 고통에서의 행동", () => {
    expect(MYOMYO.character.identity).toContain("여성 캐릭터");
    expect(MYOMYO.character.identity).toContain("자칭 천재 사주 풀이꾼");
    const situations = MYOMYO.character.behaviors.map((behavior) => behavior.when);
    for (const word of ["약점이나 모순", "강점", "이유", "조언", "칭찬", "허세", "틀린 것이 확인", "고통"]) {
      expect(situations.some((when) => when.includes(word)), word).toBe(true);
    }
    const all = JSON.stringify(MYOMYO.character);
    expect(all).toContain("반말은 말씨일 뿐이다");
    expect(all).toContain("이름·감탄사·이모티콘을 지워도 묘묘가 한 말로 읽혀야 한다");
    expect(all).toContain("자존심보다 정확성이 먼저다");
    expect(all).toContain("사용자가 하지 않은 말·행동이나 알려 주지 않은 과거를 지어내지 않는다");
    expect(all).toContain("건방짐·장난기·직설성은 줄이지 않는다");
  });

  it("작업에 고정된 프롬프트 버전이 캐릭터 설정을 정한다: 새 지시는 현재 설정, 이전 지시는 그때의 이전 설정", () => {
    expect(CURRENT_READING_PROMPT).toBe("reading-3.0.0");
    expect(CURRENT_FOLLOWUP_PROMPT).toBe("followup-3.0.0");
    expect(promptPersona("myomyo", CURRENT_READING_PROMPT)).toBe(MYOMYO);
    expect(promptPersona("myomyo", CURRENT_FOLLOWUP_PROMPT)).toBe(MYOMYO);
    const legacy = (version: string) => promptPersona("myomyo", version)?.version;
    expect(legacy("reading-2.9.0")).toBe("1.4.0");
    expect(legacy("reading-2.8.0")).toBe("1.3.0");
    expect(legacy("reading-2.7.0")).toBe("1.2.0");
    expect(legacy("reading-2.6.0")).toBe("1.1.0");
    expect(legacy("reading-2.5.0")).toBe("1.0.0");
    expect(legacy("reading-1.0.0")).toBe("1.0.0");
    // 이전 설정은 이전 모양 그대로이고 현재 설정의 칸을 갖지 않는다. 고정 문장은 갖지 않는다 (요청할 때 현재 문장을 쓴다).
    const old = findLegacyPersona("myomyo", "1.4.0")!;
    expect("character" in old).toBe(false);
    expect("lines" in old).toBe(false);
    expect(old.catchphrases.length).toBeGreaterThan(0);
  });

  it("현재 지시에 이전 설정을, 이전 지시에 현재 설정을 넣으면 섞지 않고 멈춘다", () => {
    const { plan: basePlan } = analyze();
    const plan = buildNarrationPlan({ base: basePlan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
    expect(() => getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: findLegacyPersona("myomyo", "1.4.0")!, previousIssues: [] })).toThrow("persona_version_mismatch");
    expect(() => getReadingPrompt("reading-2.9.0")({ plan, persona: MYOMYO, previousIssues: [] })).toThrow("persona_version_mismatch");
    expect(() => getReadingPrompt("reading-2.9.0")({ plan, persona: findLegacyPersona("myomyo", "1.4.0")!, previousIssues: [] })).not.toThrow();
  });
});

describe("호칭과 조사", () => {
  it("반말 캐릭터는 받침에 맞춰 '아/야'를 붙이고, 한글로 끝나지 않으면 그대로 부른다", () => {
    expect(addressFor(MYOMYO, "달빛").call).toBe("달빛아");
    expect(addressFor(MYOMYO, "하나").call).toBe("하나야");
    expect(addressFor(MYOMYO, " 소금 ").call).toBe("소금아");
    expect(addressFor(MYOMYO, "Mia").call).toBe("Mia");
    expect(addressFor({ speech: "polite" }, "달빛").call).toBe("달빛 님");
  });

  it("안내 문구의 이름 조사를 받침에 맞춘다", () => {
    expect(withSubject("묘묘")).toBe("묘묘가");
    expect(withSubject("여름")).toBe("여름이");
  });
});

describe("모델 없이 보내는 묘묘의 문장", () => {
  it("규칙 문장의 존댓말 끝맺음을 반말로 바꾼다", () => {
    expect(toCasual("생각을 밖으로 꺼내야 정리가 되는 사람이에요. 말하고, 쓰고, 만들어 보면서 머릿속이 정리돼요.")).toBe(
      "생각을 밖으로 꺼내야 정리가 되는 사람이야. 말하고, 쓰고, 만들어 보면서 머릿속이 정리돼.",
    );
    expect(toCasual("쓸 힘보다 해야 할 것이 많은 구조라 충전이 먼저예요.")).toBe("쓸 힘보다 해야 할 것이 많은 구조라 충전이 먼저야.");
    expect(toCasual("단정할 수는 없어요. 그건 아니에요. 그렇죠?")).toBe("단정할 수는 없어. 그건 아니야. 그렇지?");
    expect(toCasual("요즘 필요한 건 쉬는 거예요.")).toBe("요즘 필요한 건 쉬는 거야.");
  });

  it("맛보기는 별명을 반말로 부르고, 첫 해석도 반말로 옮긴다", () => {
    for (const [input, nickname, call] of [
      [base, "달빛", "달빛아"],
      [{ ...base, birthDate: "1990-02-03", gender: "male" as const, birthTime: { status: "branch" as const, branch: "오" as const } }, "하나", "하나야"],
      [{ ...base, birthTime: { status: "unknown" as const } }, "소금", "소금아"],
    ] as const) {
      const { preview } = analyze(input, nickname);
      expect(preview.bubbles[0]).toMatch(new RegExp(`^${call}, 네 일간은 .+ 기운이야\\.`));
      const lead = preview.bubbles[1]!;
      expect(lead).not.toMatch(/요[.!?]|요$|님/);
      expect(lead.length).toBeGreaterThan(20);
    }
  });

  it("범위 밖 답, 일부 제외, 되묻기 안내도 묘묘 말투이고 차감하지 않았다고 알린다", () => {
    expect(MYOMYO.lines.outOfScope(FIRST_OVERVIEW.scope.topicsLabel)).toContain("여기서는 성향, 강점, 일, 돈");
    for (const line of [MYOMYO.lines.outOfScope("성향"), MYOMYO.lines.clarify, MYOMYO.lines.notCharged]) {
      expect(line).toContain("횟수에서 안 뺐어");
      expect(line).not.toMatch(/요[.!?]|님/);
    }
    expect(MYOMYO.lines.partialScope("시험·학업 결과")).toBe("시험·학업 결과 얘기는 이 풀이 범위 밖이라 빼고 답했어.");
  });

  it("칭찬·허세 지적·의심에만 반응하고, 정해 둔 말버릇으로 시작하지 않으며, 같은 말에는 같은 문장을 고른다", () => {
    const praise = MYOMYO.lines.reaction("praise", "소름 돋게 맞췄네");
    expect(praise).toBe(MYOMYO.lines.reaction("praise", "소름 돋게 맞췄네"));
    expect(MYOMYO.lines.reaction("tease", "허세 좀 그만 부려")).toMatch(/허세/);
    expect(MYOMYO.lines.reaction("doubt", "틀린 것 같은데")).toMatch(/정정|고칠/);
    for (const seed of ["대박", "소름", "허세 그만", "틀렸어", "와 맞췄네", "a", "b", "c", "d"]) {
      for (const kind of ["praise", "tease", "doubt"] as const) {
        const line = MYOMYO.lines.reaction(kind, seed);
        for (const phrase of ["어라", "흐응", "흐, 흐응", "풉", "허접"]) expect(line.startsWith(phrase), `${kind}/${seed}`).toBe(false);
      }
    }
    expect(MYOMYO.lines.reactionFree).toContain("횟수에서 안 뺐어");
    expect(MYOMYO.lines.reactionCharged).toContain("질문 1회로 셌어");
  });

  it("상품 화면 예시 대화는 화면 표시용이며 지시에 들어가지 않는다", () => {
    for (const bubble of FIRST_OVERVIEW.sampleBubbles) expect(bubble.text).not.toMatch(/(?:에요|해요|어요|세요)[.!?]|여울/);
    const { plan: basePlan } = analyze();
    const plan = buildNarrationPlan({ base: basePlan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
    const { instructions, input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });
    for (const bubble of FIRST_OVERVIEW.sampleBubbles) {
      expect(instructions).not.toContain(bubble.text.slice(0, 20));
      expect(input).not.toContain(bubble.text.slice(0, 20));
    }
    expect(instructions).not.toContain(MYOMYO.signatureLine);
  });
});

describe("현재 최초 풀이 지시 (reading-3.0.0)", () => {
  const { plan: basePlan } = analyze();
  const plan = buildNarrationPlan({ base: basePlan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });
  const { instructions, input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });

  it("캐릭터 블록이 맨 앞에 한 번만 들어가고, 작업 지시는 캐릭터를 다시 적지 않는다", () => {
    const block = characterBlock(MYOMYO);
    expect(instructions.startsWith(`${block}\n\n[작업]`)).toBe(true);
    expect(block.startsWith(`[캐릭터: 묘묘]\n${MYOMYO.character.identity}\n말씨: 반말`)).toBe(true);
    for (const line of [...MYOMYO.character.traits, ...MYOMYO.character.behaviors.map((behavior) => behavior.does), ...MYOMYO.character.limits]) {
      expect(instructions.split(line).length - 1, line).toBe(1);
    }
  });

  it("예시 문장, 말투 견본, 말버릇 목록과 횟수, 이전 지시의 구성이 없다", () => {
    for (const text of [...OLD_SECTIONS, ...OLD_PHRASES]) expect(instructions, text).not.toContain(text);
    expect(instructions).not.toMatch(/\(\d\/\d\)|\(\d\)/);
  });

  it("사실·판단의 제한, 질문 중심 구성, 주제 비중, 말풍선 역할, 이어 쓰기와 다시 쓰기 규칙을 담는다", () => {
    for (const text of [
      "[지킬 것]",
      "날짜는 timing의 label('2027년 3월', '2027년')만 쓴다",
      "hourKnown이 false면 시주를 단정하지 않는다",
      "질문의 답은 풀이에서 가장 중요한 부분이다",
      "질문이 여러 개면 하나도 빠뜨리지 않고 각각 답한다",
      "weight가 focus·lead인 주제는 풀이의 중심이다",
      "place 주제의 행운 방향·색·숫자는 늘 전한다",
      "반응·장난·주제 넘기기: 한두 마디로 짧게",
      "이유: 이해에 필요한 만큼 충분히. 길어지면 나눠 보낸다.",
      "모든 말풍선을 비슷한 길이로 맞추지 않는다",
      "모든 주제를 같은 순서(놀림 → 설명 → 조언)로 쓰지 않고",
      "사용자가 하지 않은 말이나 행동을 전제하지 않는다 (예: 앞에 그런 말이 없는데 '큰소리치더니?')",
      "고른 상황과 그 상황의 흔한 걱정 때문에 풀이 전체를 진지하게 바꾸지 않는다",
      "서비스가 정한 실천 단위이지 사주가 정한 값이 아니다",
      "같은 취지의 행동(쉬기, 거절하기, 기록하기 등)은 다시 풀지 않고 짧게 이어 받는다",
      "메모를 칸 순서대로 어미만 바꿔 옮기면 실패다",
      "근거 연결, 날짜, 비율 같은 문제는 그 칸만 고치고, 문장의 장난·비유·직설적인 지적은 그대로 둔다",
      // 상품 표현 강도 (blunt, playful, rich)
      "근거 있는 약점은 돌려 말하지 않고, 그 때문에 잃는 것과 바꿀 행동까지 짚는다.",
      "장난기와 참견이 설명하는 말풍선에도 살아 있게 쓴다.",
    ]) {
      expect(instructions, text).toContain(text);
    }
  });

  it("입력은 작성 재료 3.0.0(readings, actions, commonLimits)이고, 상담 문장 묶음 칸(statements)은 없다", () => {
    const parsed = JSON.parse(input) as { address: unknown; commonLimits: string[]; topics: Record<string, unknown>[] };
    expect(parsed.address).toEqual({ call: "달빛아", name: "달빛" });
    expect(parsed.commonLimits.length).toBeGreaterThan(0);
    for (const topic of parsed.topics) {
      expect(topic).toHaveProperty("readings");
      expect(topic).toHaveProperty("actions");
      expect(topic).not.toHaveProperty("statements");
    }
  });

  it("다시 쓸 때도 같은 지시를 쓰고, 지적받은 문제만 입력에 넣는다", () => {
    const retry = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: ["temperament: 없는 근거를 참조했습니다 (s99)."] });
    expect(retry.instructions).toBe(instructions);
    expect(JSON.parse(retry.input).fixTheseProblemsFromPreviousAttempt).toEqual(["temperament: 없는 근거를 참조했습니다 (s99)."]);
  });

  it("이전 지시는 이어 쓰는 작업을 위해 그대로 남아 있다 (reading-2.5.0, reading-2.9.0)", () => {
    const old = getReadingPrompt("reading-2.5.0")({ plan, persona: findLegacyPersona("myomyo", "1.0.0")!, previousIssues: [] });
    expect(old.instructions.startsWith("당신은 사주 상담 메신저에서")).toBe(true);
    expect(old.instructions).toContain("허접~.(1/1)");
    const diet = getReadingPrompt("reading-2.9.0")({ plan, persona: findLegacyPersona("myomyo", "1.4.0")!, previousIssues: [] });
    expect(diet.instructions).toContain("말투 견본");
    expect(instructions.length).toBeLessThan(diet.instructions.length);
  });
});

describe("현재 후속 답변 지시 (followup-3.0.0)", () => {
  const statements = (() => {
    const { plan: basePlan } = analyze();
    return basePlan.topics.find((topic) => topic.topicId === "work")!.statements;
  })();
  const prompt = buildFollowupPrompt({
    persona: MYOMYO,
    nickname: "하나",
    hourKnown: true,
    expression: FIRST_OVERVIEW.expression,
    situation: null,
    facts: [],
    userContext: [
      { ref: "u1", kind: "user-context", text: "사용자가 고른 현재 상황: 취업 준비 중", source: "situation" },
      { ref: "u2", kind: "user-context", text: "사용자가 직접 알려 준 상황: 요즘 많이 지쳐 있다고 말함", source: "fact" },
      { ref: "u3", kind: "user-context", text: "이번 메시지에서 사용자가 알려 준 상황: 좋아하는 사람이 생김", source: "message" },
    ],
    questions: [],
    statements,
    timing: [],
    delivered: [],
    lastTurn: { question: "요즘 취업 너무 힘들어", answer: "속상하지." },
    previousIssues: [],
  });

  it("최초 풀이와 같은 캐릭터 블록으로 시작하고, 반응·지금의 마음·오류 정정 기준을 담는다", () => {
    expect(prompt.instructions.startsWith(`${characterBlock(MYOMYO)}\n\n[작업]`)).toBe(true);
    for (const text of [
      "최초 풀이와 같은 사람으로",
      "[캐릭터로 답하기]",
      "지금의 마음은 이번 메시지로 판단한다",
      "lastTurn.answer의 말투는 지금의 마음이 아니다",
      "실제로 어긋났으면 인정하고 바로잡는다",
      "반응과 결론은 한두 문장으로 짧게",
      "모든 문단을 같은 길이로 맞추지 않는다",
    ]) {
      expect(prompt.instructions, text).toContain(text);
    }
    for (const text of [...OLD_SECTIONS, ...OLD_PHRASES]) expect(prompt.instructions, text).not.toContain(text);
  });

  it("입력은 같은 작성 재료와, 상황 선택·지난 이야기·이번 메시지를 나눈 사용자 상황이다", () => {
    const input = JSON.parse(prompt.input);
    expect(input.address.call).toBe("하나야");
    expect(input.userContext.map((item: { from: string }) => item.from)).toEqual(["situation", "concern", "message"]);
    expect(input.readings.map((item: { ref: string }) => item.ref)).toEqual(statements.map((item) => item.ref));
    expect(input).not.toHaveProperty("statements");
    expect(input.lastTurn).toEqual({ question: "요즘 취업 너무 힘들어", answer: "속상하지." });
  });
});

describe("검사는 말투를 세지 않는다", () => {
  const context = { questionRefs: ["q1"], knownRefs: new Set<string>(), timing: [], percentSources: [], excluded: [] };
  const answer = (text: string) => ({ mode: "answer" as const, clarifyQuestion: "", sections: [{ questionRef: "q1", text, refs: [] }] });
  const { chart } = analyze();

  it("말버릇·감탄사·이모티콘이 많아도 통과하고, 강한 욕설만 거부한다", () => {
    expect(checkFollowupV2(answer("어라~? 진짜? 어라~? 또? 풉. 허접~. 😏😏😏 ♡♡"), context, chart)).toEqual([]);
    expect(checkFollowupV2(answer("이건 진짜 병신 같은 습관이야."), context, chart).join()).toContain("욕설");
    // '시발점'이나 '새끼손가락' 같은 일상어는 걸리지 않는다.
    expect(checkFollowupV2(answer("그게 변화의 시발점이야. 새끼손가락 걸고 약속해."), context, chart)).toEqual([]);
  });
});

describe("PDF", () => {
  it("글꼴에 없는 그림 이모티콘은 빼고 문장은 그대로 둔다", () => {
    expect(withoutEmoji("내가 좀 잘하거든. 😏")).toBe("내가 좀 잘하거든.");
    expect(withoutEmoji("흥, 그건 인정 😏 진짜야.")).toBe("흥, 그건 인정 진짜야.");
    expect(withoutEmoji("♡ 하나는 남긴다")).toBe("♡ 하나는 남긴다");
  });
});
