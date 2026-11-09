import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildChartView, type ChartFacts } from "@/domain/reading/chart";
import type { StoredMessage } from "@/domain/reading/types";
import { renderReadingPdf, type PdfInput } from "@/server/pdf/render";

const stem = (s: string, element: string) => ({ stem: s, element, tenGod: "식신" });
const branch = (b: string, element: string) => ({ branch: b, element, tenGod: "정관" });
const facts: ChartFacts = {
  dayMaster: "기",
  status: "complete",
  positions: {
    year: { stem: stem("무", "토"), branch: branch("인", "목") },
    month: { stem: stem("신", "금"), branch: branch("유", "금") },
    day: { stem: stem("기", "토"), branch: branch("사", "화") },
    hour: null,
  },
};

const LONG = "타고난 기운을 일상에서 어떻게 쓰면 좋은지 차근차근 설명해 드릴게요. 긴 문장이 페이지 끝에서 자연스럽게 줄바꿈되는지 확인합니다. ";

function input(count: number, overrides: Partial<PdfInput> = {}): PdfInput {
  const messages: StoredMessage[] = Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    topicId: index % 5 === 0 ? `topic-${index}` : `topic-${index - (index % 5)}`,
    kind: index % 7 === 3 ? "creative-scene" : "explanation",
    text: LONG.repeat(2),
    refs: ["s1", "f1"],
  }));
  return {
    productName: "나를 읽는 짧은 사주",
    nickname: "달빛",
    createdAt: "2026년 11월 9일",
    personaName: "여울",
    chart: buildChartView(facts, null),
    topicTitles: Object.fromEntries(messages.map((message) => [message.topicId!, `주제 ${message.topicId}`])),
    messages,
    followups: [],
    ...overrides,
  };
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
}

describe("PDF", () => {
  it("글꼴을 포함한 실제 PDF 파일을 만든다", async () => {
    const pdf = await renderReadingPdf(input(5));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("NotoSansKR");
    expect(pageCount(pdf)).toBe(1);
  }, 30_000);

  it("긴 풀이는 여러 쪽으로 나뉘고 후속 질문을 넣으면 쪽이 늘어난다", async () => {
    const without = await renderReadingPdf(input(40));
    const withFollowups = await renderReadingPdf(input(40, { followups: [{ question: "그게 무슨 뜻이에요?", answer: LONG.repeat(3) }] }));
    expect(pageCount(without)).toBeGreaterThan(1);
    expect(pageCount(withFollowups)).toBeGreaterThan(pageCount(without));
    if (process.env.PDF_OUT) writeFileSync(process.env.PDF_OUT, withFollowups);
  }, 30_000);
});
