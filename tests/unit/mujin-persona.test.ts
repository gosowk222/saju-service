import { describe, expect, it } from "vitest";
import { MUJIN, MYOMYO, addressFor, faceOf, findPersona, withSubject, type PersonaIntakeLines } from "@/domain/personas";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { termsIn } from "@/domain/reading/lore";
import { characterBlock } from "@/server/llm/prompts";

/**
 * 무진 도사 페르소나 (mujin 1.0.0). 등록, 호칭, 모델 없이 보내는 문장, 생성 지시로 옮기는 칸이 맞게 이어졌는지 본다.
 * 말투를 판정하는 검사가 아니다. 실제 문체 품질은 docs/personas/mujin-evaluation.md의 절차로 사람이 읽고 판단한다 (LIVE_NOT_RUN).
 */

const INTAKE_KEYS: readonly (keyof PersonaIntakeLines)[] = [
  "greet",
  "askGender",
  "askBirthDate",
  "askPlace",
  "askTime",
  "askNow",
  "askConcern",
  "review",
  "computing",
  "writingFree",
  "freeDone",
  "writingPaid",
  "paidDone",
  "sectionFailed",
  "locked",
];

/** 묘묘의 반말 고정 문장과 1.x 말버릇에 있던 표현. 무진의 문장에 섞이면 안 된다 (말투 판정이 아니라 섞임 확인). */
const MYOMYO_PHRASES = /안 뺐어|셌어|봐줄게|해 줄게|물어봐\.|흐응|어라~|으이구|허접|바보야|흥,/;
const EMOJI = /\p{Extended_Pictographic}/u;

describe("무진 도사 등록", () => {
  it("현재 설정은 mujin 1.0.0 '무진 도사'이고, 무진 상품이 이 캐릭터를 쓴다", () => {
    expect(findPersona("mujin")).toBe(MUJIN);
    expect(findPersona("mujin", "1.0.0")).toBe(MUJIN);
    // 따로 남긴 이전 설정이 없으면 현재 설정을 준다. 묘묘의 버전 번호로 찾아도 묘묘 설정이 섞이지 않는다.
    expect(findPersona("mujin", "2.1.0")).toBe(MUJIN);
    expect([MUJIN.id, MUJIN.version, MUJIN.name, MUJIN.speech, MUJIN.avatarGlyph]).toEqual(["mujin", "1.0.0", "무진 도사", "polite", "무"]);
    expect(MUJIN_OVERVIEW.personaId).toBe(MUJIN.id);
    expect(withSubject(MUJIN.name)).toBe("무진 도사가");
  });

  it("묘묘는 그대로다 (2.1.0, 반말, 입력 안내 없음)", () => {
    expect(findPersona("myomyo")).toBe(MYOMYO);
    expect([MYOMYO.version, MYOMYO.speech]).toEqual(["2.1.0", "casual"]);
    expect(MYOMYO.lines.intake).toBeUndefined();
    expect(MYOMYO.lines.notCharged).toBe("이번 질문은 횟수에서 안 뺐어.");
    expect(addressFor(MYOMYO, "달빛").call).toBe("달빛아");
  });

  it("판단·주제에 묶인 예시, 말버릇 목록과 횟수, 말투 견본, 시범, 이모티콘 개수를 두지 않는다", () => {
    expect(MUJIN.examples).toEqual([]);
    expect(MUJIN.catchphrases).toEqual([]);
    expect(MUJIN.emojiLimit).toBeUndefined();
    expect(MUJIN.delivery).toBeUndefined();
    expect(MUJIN.demonstrations).toBeUndefined();
    expect(MUJIN.voiceSamples).toBeUndefined();
  });

  it("정체성·관계·말씨의 핵심이 설정에 있다", () => {
    expect(MUJIN.role).toContain("무당");
    expect(MUJIN.role).toContain("영적인 힘으로 알아냈다고 말하지 않는다");
    expect(MUJIN.relationship).toContain("상담 상대");
    expect(MUJIN.speaking!.join(" ")).toContain("사극 말투를 쓰지 않는다");
    expect(MUJIN.moments.join(" ")).toContain("기록에 없는 일을 기억하는 척하지 않는다");
    expect(MUJIN.teasing!.join(" ")).toContain("상황의 모순에만 쓴다");
  });

  it("아바타는 캐릭터 설정화 왼쪽 위 얼굴 칸의 정사각 크롭이다 (B05를 받기 전 임시)", () => {
    const avatar = MUJIN.avatar!;
    expect(avatar.src).toBe("/images/personas/mujin-character-sheet.png");
    expect([avatar.width, avatar.height, avatar.alt]).toEqual([1536, 1024, ""]);
    const { x, y, size } = avatar.square!;
    // 정사각 영역이 왼쪽 위 얼굴 칸(원본 약 가로 344px, 세로 420px) 안에 있어 옆 칸의 그림·글자가 끼지 않는다.
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect((x + size) * avatar.width).toBeLessThanOrEqual(344);
    expect(y * avatar.height + size * avatar.width).toBeLessThanOrEqual(420);
    expect(faceOf(MUJIN)).toEqual({ avatarGlyph: "무", avatar });
  });
});

describe("호칭", () => {
  it("별명에 '님'을 붙여 부른다", () => {
    expect(addressFor(MUJIN, "달빛").call).toBe("달빛 님");
    expect(addressFor(MUJIN, " 소금 ").call).toBe("소금 님");
    expect(addressFor(MUJIN, "Mia").call).toBe("Mia 님");
  });
});

describe("모델 없이 보내는 무진의 문장 (lines)", () => {
  const { lines } = MUJIN;
  const seeds = ["소름 돋게 맞췄네", "허세 좀 그만 부려", "틀린 것 같은데", "와", "음", "흠"];
  const all = [
    lines.outOfScope(MUJIN_OVERVIEW.scope.topicsLabel),
    lines.partialScope("시험·학업 결과"),
    lines.notCharged,
    lines.clarify,
    lines.previewDayMaster(addressFor(MUJIN, "달빛").call, "기(己), 토(土)"),
    lines.previewLead("생각을 밖으로 꺼내야 정리가 되는 사람이에요.", false),
    lines.previewLead("생각을 밖으로 꺼내야 정리가 되는 사람이에요.", true),
    lines.previewNone,
    ...(["praise", "tease", "doubt"] as const).flatMap((kind) => seeds.map((seed) => lines.reaction(kind, seed))),
    lines.reactionFree,
    lines.reactionCharged,
  ];

  it("열 칸 모두 문장을 만들고, 묘묘의 반말 표현과 이모티콘이 없다", () => {
    for (const line of all) {
      expect(typeof line).toBe("string");
      expect(line.trim().length).toBeGreaterThan(5);
      expect(line).not.toMatch(MYOMYO_PHRASES);
      expect(line).not.toMatch(EMOJI);
    }
    expect(lines.outOfScope(MUJIN_OVERVIEW.scope.topicsLabel)).toContain(`${MUJIN_OVERVIEW.scope.topicsLabel}까지`);
    expect(lines.partialScope("시험·학업 결과")).toBe("시험·학업 결과 이야기는 이 풀이의 범위 밖이라 빼고 답했어요.");
    expect(lines.previewDayMaster("달빛 님", "기(己), 토(土)")).toMatch(/^달빛 님, 일간은 기\(己\), 토\(土\) 기운입니다\./);
    // 규칙이 쓴 존댓말 문장은 바꾸지 않고 잇는다.
    expect(lines.previewLead("정리가 되는 사람이에요.", false)).toContain("정리가 되는 사람이에요.");
    expect(lines.previewLead("정리가 되는 사람이에요.", true)).toContain("단정하기는 이르지만");
  });

  it("차감 안내는 묘묘 문장과 같은 뜻이다 (범위 밖·되묻기·첫 반응은 차감하지 않고, 넘으면 질문 1회로 센다)", () => {
    for (const line of [lines.outOfScope("성향"), lines.clarify, lines.notCharged, lines.reactionFree]) expect(line).toContain("횟수에서 빼지 않았어요");
    expect(lines.reactionFree).toContain("다음부터 이런 말씀은 질문 1회로 셉니다");
    expect(lines.reactionCharged).toContain("한 번만");
    expect(lines.reactionCharged).toContain("질문 1회로 셌습니다");
  });

  it("같은 말에는 같은 반응 문장을 고른다", () => {
    for (const kind of ["praise", "tease", "doubt"] as const) {
      expect(lines.reaction(kind, "소름 돋게 맞췄네")).toBe(lines.reaction(kind, "소름 돋게 맞췄네"));
    }
    expect(lines.reaction("doubt", "틀린 것 같은데")).toContain("근거");
  });
});

describe("대화형 입력과 생성 상태 안내 (lines.intake)", () => {
  const intake = MUJIN.lines.intake!;

  it("열다섯 칸이 모두 비어 있지 않은 문자열이다 (브라우저 컴포넌트로 넘기므로 함수가 없다)", () => {
    expect(Object.keys(intake).sort()).toEqual([...INTAKE_KEYS].sort());
    for (const key of INTAKE_KEYS) {
      expect(typeof intake[key]).toBe("string");
      expect(intake[key].trim()).not.toBe("");
      expect(intake[key]).not.toMatch(MYOMYO_PHRASES);
      expect(intake[key]).not.toMatch(EMOJI);
    }
    expect(Object.values(intake).some((value) => typeof value === "function")).toBe(false);
    // JSON으로 옮겨도 같다 (서버 컴포넌트에서 브라우저 컴포넌트로 넘길 수 있다).
    expect(JSON.parse(JSON.stringify(intake))).toEqual(intake);
  });

  it("{name} 자리는 화면이 별명 호칭으로 바꾼다. 별명을 묻기 전에는 부르지 않고, 다른 자리 표시는 없다", () => {
    const named = INTAKE_KEYS.filter((key) => intake[key].includes("{name}"));
    expect(named.length).toBeGreaterThan(0);
    expect(intake.greet).not.toContain("{name}");
    const call = addressFor(MUJIN, "달빛").call;
    for (const key of named) expect(intake[key].replaceAll("{name}", call)).toContain("달빛 님");
    for (const key of INTAKE_KEYS) expect(intake[key].replaceAll("{name}", "")).not.toMatch(/[{}]/);
  });
});

describe("생성 지시로 옮기는 캐릭터 블록 (characterBlock)", () => {
  const block = characterBlock(MUJIN);
  const settings = [MUJIN.role, MUJIN.relationship!, ...MUJIN.tone, ...MUJIN.speaking!, ...MUJIN.moments, ...MUJIN.teasing!, ...MUJIN.sceneStyle];

  it("존댓말 말씨 줄이 있고 반말 지시가 없다", () => {
    expect(block.startsWith("[캐릭터: 무진 도사]")).toBe(true);
    expect(block).toContain("말씨: 존댓말");
    expect(block).not.toContain("말씨: 반말");
    expect(block).not.toContain("'님'을 붙이지 않는다");
  });

  it("설정 문장이 한 번씩 들어가고, 모델 없이 보내는 문장과 화면 문구는 들어가지 않는다", () => {
    for (const line of settings) expect(block.split(line).length - 1).toBe(1);
    const fixed = [MUJIN.intro, MUJIN.signatureLine, MUJIN.lines.notCharged, MUJIN.lines.clarify, MUJIN.lines.reactionFree, ...Object.values(MUJIN.lines.intake!)];
    for (const text of fixed) expect(block).not.toContain(text);
  });

  it("완성 대사나 말투 견본(따옴표로 묶은 대사)이 없고, 원국 글자·신살 이름이 없다", () => {
    expect(settings.join("\n")).not.toMatch(/'[^']{4,}'|"[^"]{4,}"|“[^”]{4,}”|‘[^’]{4,}’/);
    expect(termsIn(block)).toEqual([]);
  });
});
