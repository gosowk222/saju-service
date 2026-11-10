import { describe, expect, it } from "vitest";
import { MYOMYO, addressFor, findPersona, toCasual, withSubject } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { catchphraseCounter, checkFollowupV2 } from "@/domain/reading/check";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { emptyAnalysis } from "@/domain/reading/question";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { CURRENT_FOLLOWUP_PROMPT, CURRENT_READING_PROMPT, buildFollowupPrompt, getReadingPrompt } from "@/server/llm/prompts";
import { withoutEmoji } from "@/server/pdf/render";

/** 캐릭터 묘묘 (persona myomyo 1.0.0). 설정은 src/domain/personas 한곳에서 읽는다. */

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

describe("캐릭터 등록", () => {
  it("첫 상품의 캐릭터는 묘묘 하나이고, 여울은 없다", () => {
    expect(FIRST_OVERVIEW.personaId).toBe("myomyo");
    expect(findPersona("myomyo")).toBe(MYOMYO);
    expect(findPersona("yeoul")).toBeUndefined();
  });

  it("새 풀이 기록에 캐릭터 ID와 버전이 남는다", () => {
    const { plan, persona } = analyze();
    expect([plan.personaId, plan.personaVersion]).toEqual(["myomyo", MYOMYO.version]);
    expect(persona.id).toBe("myomyo");
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

  it("상품 화면 예시 대화도 묘묘 말투다", () => {
    for (const bubble of FIRST_OVERVIEW.sampleBubbles) expect(bubble.text).not.toMatch(/(?:에요|해요|어요|세요)[.!?]|여울/);
  });
});

describe("프롬프트에 캐릭터 설정을 한 번에 넣는다", () => {
  const { plan: basePlan } = analyze();
  const plan = buildNarrationPlan({ base: basePlan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });

  it("최초 풀이: 말씨, 상황별 반응, 말버릇 횟수, 말투 예시가 들어가고 판단은 재료를 따르게 한다", () => {
    const { instructions, input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });
    expect(CURRENT_READING_PROMPT).toBe("reading-2.5.0");
    for (const text of [
      "캐릭터 이름: 묘묘",
      MYOMYO.intro,
      "말씨: 반말",
      "장난칠 얘기가 아니네",
      "잘못 짚었네",
      "허접~.(1/1)",
      "그림 이모티콘: 3개 / 1개까지",
      "[캐릭터와 판단]",
      "놀림이나 장난 뒤에는 반드시 설명과 해결 방법이 이어진다",
    ]) {
      expect(instructions).toContain(text);
    }
    // 존댓말과 '님' 호칭을 가정한 문구가 규칙에 남아 있지 않고, 상품 표현 강도가 캐릭터의 약한 놀림을 막지 않는다.
    expect(instructions).not.toMatch(/nickname 님|○○ 님/);
    expect(instructions).not.toContain("사용자를 놀리지는 않는다");
    expect(JSON.parse(input).address).toEqual({ call: "달빛아", name: "달빛" });
  });

  it("후속 답변: 같은 캐릭터와 호칭, 진지한 순간과 오류 정정 규칙이 들어간다", () => {
    expect(CURRENT_FOLLOWUP_PROMPT).toBe("followup-2.4.0");
    const prompt = buildFollowupPrompt({
      persona: MYOMYO,
      nickname: "하나",
      hourKnown: true,
      expression: FIRST_OVERVIEW.expression,
      situation: null,
      facts: [],
      userContext: [{ ref: "u1", kind: "user-context", text: "사용자가 직접 알려 준 상황: 요즘 많이 지쳐 있다고 말함", source: "fact" }],
      questions: [],
      statements: [],
      timing: [],
      delivered: [],
      lastTurn: null,
      previousIssues: [],
    });
    expect(prompt.instructions).toContain("최초 풀이와 같은 캐릭터로");
    expect(prompt.instructions).toContain("실제로 어긋났으면 캐릭터 설정대로 짧게 인정하고 바로잡는다");
    expect(prompt.instructions).toContain("진지하게 지쳤다·힘들다·불안하다");
    expect(JSON.parse(prompt.input).address.call).toBe("하나야");
  });
});

describe("묘묘 말투 검사", () => {
  it("가끔 쓰는 놀림과 이모티콘이 횟수를 넘으면 다시 쓰게 하고, 약한 놀림 한 번은 통과한다", () => {
    const reading = catchphraseCounter(MYOMYO, "reading");
    expect(reading.count("바보야. 그건 아니지.")).toEqual([]);
    expect(reading.count("허접~. 또 미뤘어?")).toEqual([]);
    expect(reading.count("허접~. 이번에도?").join()).toContain("허접");
    const emoji = catchphraseCounter(MYOMYO, "reading");
    expect(emoji.count("😏 😏 😏")).toEqual([]);
    expect(emoji.count("😏").join()).toContain("이모티콘");
  });

  it("후속 답변 하나에서는 말버릇을 질문 수만큼만 허용하고, 강한 욕설은 거부한다", () => {
    const context = { questionRefs: ["q1"], knownRefs: new Set<string>(), timing: [], percentSources: [], excluded: [], persona: MYOMYO };
    const answer = (text: string) => ({ mode: "answer" as const, clarifyQuestion: "", sections: [{ questionRef: "q1", text, refs: [] }] });
    const { chart } = analyze();
    expect(checkFollowupV2(answer("어라~? 그건 아니지. 이렇게 바꿔 봐."), context, chart)).toEqual([]);
    expect(checkFollowupV2(answer("어라~? 진짜? 어라~? 또?"), context, chart).join()).toContain("어라");
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
