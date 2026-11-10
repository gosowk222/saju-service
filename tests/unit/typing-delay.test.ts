import { describe, expect, it } from "vitest";
import { typingDelay } from "@/lib/typing-delay";

describe("말풍선 사이 기다리는 시간", () => {
  it("짧은 말은 빨리, 긴 말은 조금 더 기다리되 너무 길게 끌지 않는다", () => {
    expect(typingDelay("흐응.")).toBe(800);
    expect(typingDelay("가".repeat(60))).toBe(1170);
    expect(typingDelay("가".repeat(120))).toBe(1890);
    expect(typingDelay("가".repeat(400))).toBe(2600);
  });
});
