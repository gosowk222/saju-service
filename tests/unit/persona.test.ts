import { describe, expect, it } from "vitest";
import { MYOMYO, MYOMYO_1_0_0, MYOMYO_1_1_0, MYOMYO_1_2_0, addressFor, findPersona, toCasual, withSubject } from "@/domain/personas";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { catchphraseCounter, checkFollowupV2 } from "@/domain/reading/check";
import { buildNarrationPlan } from "@/domain/reading/focus";
import { emptyAnalysis } from "@/domain/reading/question";
import { analyzeBirth, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { CURRENT_FOLLOWUP_PROMPT, CURRENT_READING_PROMPT, buildFollowupPrompt, getReadingPrompt, personaVersionFor } from "@/server/llm/prompts";
import { withoutEmoji } from "@/server/pdf/render";

/** 캐릭터 묘묘 (persona myomyo 1.1.0, 이전 설정 1.0.0은 그 프롬프트로 시작한 작업용). 설정은 src/domain/personas 한곳에서 읽는다. */

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

  it("작업에 고정된 프롬프트 버전에 맞는 캐릭터 설정을 고른다 (이어 쓰는 작업에 새 설정이 섞이지 않게)", () => {
    expect(MYOMYO.version).toBe("1.3.0");
    expect(personaVersionFor(CURRENT_READING_PROMPT)).toBe(MYOMYO.version);
    expect(personaVersionFor(CURRENT_FOLLOWUP_PROMPT)).toBe(MYOMYO.version);
    expect(findPersona("myomyo", personaVersionFor("reading-2.7.0"))).toBe(MYOMYO_1_2_0);
    expect(findPersona("myomyo", personaVersionFor("reading-2.6.0"))).toBe(MYOMYO_1_1_0);
    expect(findPersona("myomyo", personaVersionFor("reading-2.5.0"))).toBe(MYOMYO_1_0_0);
    expect(findPersona("myomyo", personaVersionFor("reading-2.4.0"))).toBe(MYOMYO_1_0_0);
    expect(findPersona("myomyo", "1.3.0")).toBe(MYOMYO);
    // 1.1.0에는 시범이 없고, 1.2.0은 시범만 더했다. 1.3.0은 '묘묘다운 순간'과 그 순간이 들어간 시범을 더했다. 성격·예시·말버릇 상한은 같다.
    expect(MYOMYO_1_1_0.demonstrations).toBeUndefined();
    expect(MYOMYO_1_2_0.demonstrations?.map((item) => item.use)).toEqual(["reading", "followup"]);
    for (const persona of [MYOMYO_1_2_0, MYOMYO]) {
      expect(persona.tone).toBe(MYOMYO_1_1_0.tone);
      expect(persona.examples).toBe(MYOMYO_1_1_0.examples);
      expect(persona.catchphrases).toBe(MYOMYO_1_1_0.catchphrases);
    }
    expect(MYOMYO_1_2_0.delivery?.map((item) => item.what)).not.toContain("묘묘다운 순간");
    expect(MYOMYO.delivery?.map((item) => item.what)).toContain("묘묘다운 순간");
    expect(MYOMYO.demonstrations?.map((item) => item.use)).toEqual(["reading", "followup"]);
    expect(MYOMYO.demonstrations![0]!.lines.join(" ")).toContain("봐, 맞지?");
    // 따로 남긴 설정이 없는 버전이면 현재 설정을 준다.
    expect(findPersona("myomyo", "9.9.9")).toBe(MYOMYO);
    // 이전 설정은 그대로다 (설명에서 장난을 줄이라던 문구도 그 버전에는 남아 있다).
    expect(MYOMYO_1_0_0.tone.join()).toContain("설명하는 부분은 장난을 줄이고");
    expect(MYOMYO_1_0_0.catchphrases.find((phrase) => phrase.pattern === "허접")?.maxPerReading).toBe(1);
    // 모델 없이 보내는 문장은 두 설정이 같다.
    expect(MYOMYO_1_0_0.lines).toBe(MYOMYO.lines);
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

  it("질문 없이 칭찬·허세 지적·의심만 보내면 묘묘가 받아치고, 같은 말에는 같은 문장을 고른다", () => {
    const praise = MYOMYO.lines.reaction("praise", "소름 돋게 맞췄네");
    expect(praise).toBe(MYOMYO.lines.reaction("praise", "소름 돋게 맞췄네"));
    expect(praise).toMatch(/흐|어라|흥/);
    expect(MYOMYO.lines.reaction("tease", "허세 좀 그만 부려")).toMatch(/허세/);
    expect(MYOMYO.lines.reaction("doubt", "틀린 것 같은데")).toMatch(/정정|근거/);
    expect(MYOMYO.lines.reactionFree).toContain("횟수에서 안 뺐어");
    expect(MYOMYO.lines.reactionCharged).toContain("질문 1회로 셌어");
  });

  it("상품 화면 예시 대화도 묘묘 말투다", () => {
    for (const bubble of FIRST_OVERVIEW.sampleBubbles) expect(bubble.text).not.toMatch(/(?:에요|해요|어요|세요)[.!?]|여울/);
  });
});

describe("프롬프트에 캐릭터 설정을 한 번에 넣는다", () => {
  const { plan: basePlan } = analyze();
  const plan = buildNarrationPlan({ base: basePlan, product: FIRST_OVERVIEW, analysis: emptyAnalysis("2026-11-11"), timing: [] });

  it("최초 풀이(reading-2.6.0, 그 버전으로 시작한 작업): 캐릭터 설정이 지시 맨 앞에 오고, 설명 본문에서 성격을 드러내는 방식과 비교 예시가 들어간다", () => {
    const { instructions, input } = getReadingPrompt("reading-2.6.0")({ plan, persona: MYOMYO_1_1_0, previousIssues: [] });
    expect(instructions.startsWith("[캐릭터]\n캐릭터 이름: 묘묘")).toBe(true);
    // 2.7.0에서 더한 시범과 메모 칸은 2.6.0 작업에 섞이지 않는다.
    expect(instructions).not.toContain("재료를 묘묘의 말로 바꾸는 시범");
    expect(instructions).not.toContain("angle: bubbles를 쓰기 전에");
    expect(JSON.parse(input)).not.toHaveProperty("commonCaveats");
    for (const text of [
      MYOMYO.intro,
      "말씨: 반말",
      "내용을 전달하는 방식",
      "주제 넘기기:",
      "밋밋한 말 (이렇게 쓰지 않는다)",
      "일 얘기할 땐 그렇게 신나더니",
      "흥, 하나 붙잡으면 끝장 볼 때까지 안 놓는 건 인정",
      "잘못 짚었네",
      "허접~.(2)",
      "그림 이모티콘: 3개까지",
      "1층. 사실과 판단",
      "2층. 답할 내용",
      "3층. 전달 방식",
      "설명하는 동안 캐릭터를 끄고 앞뒤에만 농담을 붙이지 않는다",
      "이름, 감탄사, 이모티콘, 말버릇을 지워도 캐릭터가 한 말처럼 읽혀야 한다",
    ]) {
      expect(instructions).toContain(text);
    }
    // 1.0.0·2.5.0에서 성격을 약하게 만들던 지시와, 주제마다 정해진 횟수를 채우게 하던 할당이 없다.
    for (const text of [
      "설명하는 부분은 장난을 줄이고",
      "놀림은 약하게만",
      "캐릭터는 말씨, 호칭, 어미, 비유, 반응, 설명의 리듬만 정한다",
      "주제마다 한두 번, 판단의 이유를",
      "과거를 짐작해 맞히는 말을 주제마다 한 번",
      "넘기면 검사에서 다시 쓰게 된다",
    ]) {
      expect(instructions).not.toContain(text);
    }
    // 후속 답변 전용 예시와 방식은 최초 풀이에 넣지 않는다 (입력을 늘리지 않게 대표 예시만).
    expect(instructions).not.toContain("후속 답변:");
    expect(instructions).not.toContain("휴대폰만 들었다 놨다");
    expect(instructions).not.toMatch(/nickname 님|○○ 님/);
    expect(JSON.parse(input).address).toEqual({ call: "달빛아", name: "달빛" });
  });

  it("이전 프롬프트(reading-2.5.0)는 이전 설정과 함께 예전 지시 그대로 만든다", () => {
    const { instructions, input } = getReadingPrompt("reading-2.5.0")({ plan, persona: MYOMYO_1_0_0, previousIssues: [] });
    expect(instructions.startsWith("당신은 사주 상담 메신저에서")).toBe(true);
    for (const text of ["[캐릭터와 판단]", "허접~.(1/1)", "그림 이모티콘: 3개 / 1개까지", "장난칠 얘기가 아니네"]) expect(instructions).toContain(text);
    // 입력도 예전 모양 그대로다 (출처 칸 없음).
    expect(JSON.parse(input).userContext.every((item: Record<string, unknown>) => !("from" in item))).toBe(true);
  });

  it("최초 풀이(reading-2.7.0, 그 버전으로 시작한 작업): 재료를 옮겨 적지 않기와 시범, 주제마다 먼저 짚을 장면 메모, light 주제의 선택, 약점은 하나 이상", () => {
    const { instructions, input } = getReadingPrompt("reading-2.7.0")({ plan, persona: MYOMYO_1_2_0, previousIssues: [] });
    expect(instructions.startsWith("[캐릭터]\n캐릭터 이름: 묘묘")).toBe(true);
    // 2.8.0에서 바꾼 문구는 2.7.0 작업에 섞이지 않는다.
    expect(instructions).not.toContain("묘묘다운 순간");
    expect(instructions).toContain("말버릇을 넣으려고 문장을 만들지 않는다");
    for (const text of [
      "재료를 묘묘의 말로 바꾸는 시범",
      "그대로 옮겨 적은 말 (이렇게 쓰지 않는다)",
      "할 일 쌓인 날, 너 메일 답장이랑 자잘한 정리부터 싹 해치우지?",
      "[재료를 옮겨 적지 않는다]",
      "말풍선을 쓴 뒤 재료 문장에서 어미만 바꾼 문장이면 다시 쓴다",
      "angle: bubbles를 쓰기 전에",
      "focusAngle: questions가 있으면 focus를 쓰기 전에",
      "light는 이 사람의 질문·상황에 가장 걸리는 해석 한두 개를 골라",
      "weakness가 있는 해석이 있으면 주제마다 약점을 하나 이상 다룬다",
      "말풍선 하나에는 한두 문장만 담고",
      "예시나 시범과 같은 주제에서만 캐릭터가 나오고 다른 주제에서 꺼지면 실패다",
    ]) {
      expect(instructions).toContain(text);
    }
    // 2.6.0에서 의무를 늘렸던 문구와, 말풍선을 길게 채우게 하던 문구가 없다.
    expect(instructions).not.toContain("weakness가 있는 해석은 주제마다 빠뜨리지 않는다");
    expect(instructions).not.toContain("설명 말풍선은 bubbleChars자 안팎으로 쓰고");
    // 후속 답변용 시범은 넣지 않는다.
    expect(instructions).not.toContain("돈 관리 물어볼 줄 알았어");
    const parsed = JSON.parse(input) as { commonCaveats: string[]; address: unknown };
    expect(parsed.address).toEqual({ call: "달빛아", name: "달빛" });
    expect(parsed.commonCaveats.length).toBeGreaterThan(0);
  });

  it("최초 풀이(reading-2.8.0): 중심 주제와 질문 답은 깊게, 설명 말풍선은 세네 문장까지, 반응 말풍선은 목표와 따로, 주제마다 묘묘다운 순간", () => {
    const { instructions, input } = getReadingPrompt(CURRENT_READING_PROMPT)({ plan, persona: MYOMYO, previousIssues: [] });
    expect(CURRENT_READING_PROMPT).toBe("reading-2.8.0");
    expect(instructions.startsWith("[캐릭터]\n캐릭터 이름: 묘묘")).toBe(true);
    for (const text of [
      // 2.7.0에서 이어받은 것
      "[재료를 옮겨 적지 않는다]",
      "재료를 묘묘의 말로 바꾸는 시범",
      "angle: bubbles를 쓰기 전에",
      // 2.8.0에서 바꾼 것
      "묘묘다운 순간: 설명 사이사이에",
      "봐, 맞지? 이런 건 원국 한 번 보면 바로 나와.",
      "주제마다 [캐릭터]의 '묘묘다운 순간'",
      "weight가 focus·lead인 주제는 풀이의 중심이다",
      "target은 설명 말풍선 수의 목표다. 짧은 반응·전환 말풍선은 target과 따로 더한다",
      "focus는 풀이에서 가장 중요한 부분이다",
      "이유와 방법을 푸는 설명은 세네 문장(bubbleChars자 안팎)까지 쓴다",
      "말버릇과 이모티콘도 묘묘의 일부다",
      "묘묘답게 자신만만하게 시작하며",
    ]) {
      expect(instructions).toContain(text);
    }
    for (const text of ["말풍선 하나에는 한두 문장만 담고", "설명 말풍선은 한두 문장으로 쓰고", "말버릇을 넣으려고 문장을 만들지 않는다"]) {
      expect(instructions).not.toContain(text);
    }
    expect(JSON.parse(input)).toHaveProperty("commonCaveats");
  });

  it("후속 답변(followup-2.8.0): 같은 캐릭터와 호칭, 먼저 반응하기, 지금의 마음은 이번 메시지로 판단하기, 재료를 옮겨 적지 않기, 묘묘다운 순간", () => {
    expect(CURRENT_FOLLOWUP_PROMPT).toBe("followup-2.8.0");
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
      statements: [],
      timing: [],
      delivered: [],
      lastTurn: { question: "요즘 취업 너무 힘들어", answer: "속상하지." },
      previousIssues: [],
    });
    expect(prompt.instructions.startsWith("[캐릭터]")).toBe(true);
    for (const text of [
      "최초 풀이와 같은 캐릭터로",
      "[먼저 반응하고 답하기]",
      "후속 답변:",
      "지금의 마음은 이번 메시지로 판단한다",
      "lastTurn.answer의 말투를 따라 하지 않는다",
      "흐, 흐응. 이제 알아봤어?",
      "매번 면접까지 갔다가 떨어지면 속상하지.",
      "으…… 그 부분은 내가 잘못 짚었네.",
      "[재료를 옮겨 적지 않는다]",
      "돈 관리 물어볼 줄 알았어",
      "sections[].angle: 답을 쓰기 전에",
      "답마다 [캐릭터]의 '묘묘다운 순간'",
      "이유와 방법을 푸는 문단은 두세 문장까지 쓴다",
      "말버릇과 이모티콘도 묘묘의 일부다",
    ]) {
      expect(prompt.instructions).toContain(text);
    }
    // 2.5.0의 "lastTurn에 힘들다는 말이 있으면 놀림을 멈춘다"가 없다.
    expect(prompt.instructions).not.toContain("question 요약, userContext, lastTurn에 사용자가 진지하게");
    const input = JSON.parse(prompt.input);
    expect(input.address.call).toBe("하나야");
    expect(input.userContext.map((item: { from: string }) => item.from)).toEqual(["situation", "concern", "message"]);
    expect(input.lastTurn).toEqual({ question: "요즘 취업 너무 힘들어", answer: "속상하지." });
  });
});

describe("묘묘 말투 검사", () => {
  it("가끔 쓰는 놀림과 이모티콘이 상한을 넘으면 다시 쓰게 하고, 상한 안에서는 통과한다", () => {
    const reading = catchphraseCounter(MYOMYO, "reading");
    expect(reading.count("바보야. 그건 아니지.")).toEqual([]);
    expect(reading.count("허접~. 또 미뤘어?")).toEqual([]);
    expect(reading.count("허접~. 이번에도?")).toEqual([]);
    const third = reading.count("허접~. 또야?").join();
    expect(third).toContain("허접");
    // 다시 쓸 때 그 말만 바꾸게 하고, 장난이나 지적까지 줄이라고 하지 않는다.
    expect(third).toContain("장난, 지적, 비유는 그대로 둔다");
    expect(third).not.toContain("놀림을 반복하지 않는다");
    const emoji = catchphraseCounter(MYOMYO, "reading");
    expect(emoji.count("😏 😏 😏")).toEqual([]);
    expect(emoji.count("😏").join()).toContain("이모티콘");
    // 이전 설정(1.0.0)으로 이어 쓰는 작업은 이전 상한을 쓴다.
    const earlier = catchphraseCounter(MYOMYO_1_0_0, "reading");
    expect(earlier.count("허접~.")).toEqual([]);
    expect(earlier.count("허접~.").join()).toContain("허접");
  });

  it("'어라'는 말버릇으로 쓸 때만 세고 '들어라', '적어라' 같은 말끝은 세지 않는다", () => {
    const answer = catchphraseCounter(MYOMYO, "answer");
    expect(answer.count("일단 적어라. 귀담아 들어라. 먹어라.")).toEqual([]);
    expect(answer.count("어라~? 또 미뤘어?")).toEqual([]);
    expect(answer.count("(어라) 이번에도?").join()).toContain("어라");
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
