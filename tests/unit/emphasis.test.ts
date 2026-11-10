import { describe, expect, it } from "vitest";
import { applyHighlight, emphasizeGroup, splitEmphasis, tidyEmphasis } from "@/domain/reading/emphasis";
import { toStoredMessages } from "@/server/llm/narrate";

describe("강조 표시", () => {
  it("**구절**만 굵게 나누고 나머지는 그대로 둔다", () => {
    expect(splitEmphasis("솔직히 **이게 약점이에요.** 바꾸면 돼요.")).toEqual([
      { text: "솔직히 ", strong: false },
      { text: "이게 약점이에요.", strong: true },
      { text: " 바꾸면 돼요.", strong: false },
    ]);
    expect(splitEmphasis("표시 없는 이전 풀이")).toEqual([{ text: "표시 없는 이전 풀이", strong: false }]);
  });

  it("짝이 맞지 않거나 빈 표시는 저장 전에 지워 별표가 화면에 보이지 않게 한다", () => {
    expect(tidyEmphasis("  **먼저 말하기**가 답이에요.  ")).toBe("**먼저 말하기**가 답이에요.");
    expect(tidyEmphasis("**먼저 말하기가 답이에요.")).toBe("먼저 말하기가 답이에요.");
    expect(tidyEmphasis("빈 표시****는 지워요.")).toBe("빈 표시는 지워요.");
  });

  it("따로 받은 강조 구절(highlight)을 문장 안의 표시로 바꾸고, 맞지 않으면 문장을 그대로 둔다", () => {
    expect(applyHighlight("마음을 숨기는 게 약점이에요. 한 번은 말로 하세요.", "마음을 숨기는 게 약점")).toBe("**마음을 숨기는 게 약점**이에요. 한 번은 말로 하세요.");
    expect(applyHighlight("문장에 없는 구절", "다른 구절")).toBe("문장에 없는 구절");
    expect(applyHighlight("이미 **표시**가 있는 문장", "있는 문장")).toBe("이미 **표시**가 있는 문장");
    expect(applyHighlight("빈 구절", "  ")).toBe("빈 구절");
    expect(applyHighlight("별표가 섞인 구절도 찾는다", "**섞인 구절**")).toBe("별표가 **섞인 구절**도 찾는다");
  });

  it("모델이 구절을 요약해서 적으면 같은 말풍선에서 가장 비슷한 문장 하나를 굵게 만든다", () => {
    // 2026-11-10 실제 출력에서 가져온 형태: 구절이 문장을 그대로 옮기지 않고 요약했다.
    const text = "상대가 애매하게 반응하면 마음을 지키려고 따지게 돼요. 내 잘못이 일부 섞였는데도 옳고 그름부터 따지면 작은 일이 자존심 싸움으로 커져요.";
    expect(applyHighlight(text, "옳고 그름보다 사과를 먼저")).toBe(
      "상대가 애매하게 반응하면 마음을 지키려고 따지게 돼요. **내 잘못이 일부 섞였는데도 옳고 그름부터 따지면 작은 일이 자존심 싸움으로 커져요.**",
    );
    expect(applyHighlight(text, "전혀 관계없는 회사 이야기")).toBe(text);
  });

  it("강조는 설명 말풍선에만, 묶음마다 정한 개수까지만 적용한다", () => {
    const bubbles = [
      { kind: "creative-scene", text: "퇴근길에 먼저 말을 거는 장면이에요.", highlight: "먼저 말을 거는" },
      { kind: "explanation", text: "마음을 숨기는 게 약점이에요.", highlight: "마음을 숨기는 게 약점" },
      { kind: "explanation", text: "**이미 표시한** 문장이에요.", highlight: "" },
      { kind: "explanation", text: "세 번째는 넘쳐요.", highlight: "세 번째는" },
    ];
    expect(emphasizeGroup(bubbles, 2)).toEqual(["퇴근길에 먼저 말을 거는 장면이에요.", "**마음을 숨기는 게 약점**이에요.", "**이미 표시한** 문장이에요.", "세 번째는 넘쳐요."]);
  });

  it("풀이를 저장할 때 모든 말풍선에 같은 정리를 적용한다", () => {
    const messages = toStoredMessages(
      {
        opening: "안녕하세요 **달빛 님",
        focus: [{ kind: "explanation", refs: ["q1"], text: "**결론**부터 말할게요." }],
        topics: [
          {
            topicId: "romance",
            bubbles: [
              { kind: "explanation", refs: ["s1"], text: "짝이 안 맞는 ** 표시" },
              { kind: "explanation", refs: ["s1"], text: "먼저 연락하는 게 답이에요.", highlight: "먼저 연락하는 게 답" },
            ],
          },
        ],
        closing: "또 물어봐 주세요.",
      },
      "focus",
    );
    expect(messages.map((message) => message.text)).toEqual(["안녕하세요 달빛 님", "**결론**부터 말할게요.", "짝이 안 맞는  표시", "**먼저 연락하는 게 답**이에요.", "또 물어봐 주세요."]);
  });
});
