import { writeFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import { describe, expect, it, vi } from "vitest";
import { topicTitlesOf } from "@/domain/products";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
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
    personaName: "묘묘",
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

  it("이전 형식(답변 영역 없음)과 새 형식(답변 영역 + 50여 개 말풍선)을 같은 함수로 만든다", async () => {
    const titles = topicTitlesOf(FIRST_OVERVIEW);
    const old: StoredMessage[] = [
      { seq: 1, topicId: null, kind: "transition", text: "안녕하세요.", refs: [] },
      ...FIRST_OVERVIEW.topics.flatMap((topic, index) =>
        [0, 1, 2].map((offset) => ({ seq: index * 3 + offset + 2, topicId: topic.id, kind: "explanation" as const, text: LONG, refs: ["s1"] })),
      ),
    ];
    const current: StoredMessage[] = [
      { seq: 1, topicId: null, kind: "transition", text: "안녕하세요.", refs: [] },
      ...[0, 1, 2, 3].map((offset) => ({ seq: offset + 2, topicId: "focus", kind: "explanation" as const, text: `${LONG}\n\n${LONG}`, refs: ["q1"] })),
      ...FIRST_OVERVIEW.topics.flatMap((topic, index) =>
        [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => ({
          seq: index * 8 + offset + 6,
          topicId: topic.id,
          kind: offset === 3 ? ("creative-scene" as const) : ("explanation" as const),
          text: LONG.repeat(2),
          refs: ["s1"],
        })),
      ),
    ];
    expect(titles.focus).toBe("궁금한 점에 대한 답");
    const oldPdf = await renderReadingPdf(input(0, { messages: old, topicTitles: titles }));
    const newPdf = await renderReadingPdf(input(0, { messages: current, topicTitles: titles }));
    expect(oldPdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(newPdf)).toBeGreaterThan(pageCount(oldPdf));
  }, 30_000);

  it("**강조** 구절은 굵은 글꼴로 쓰고 별표와 장면 제목은 남기지 않는다", async () => {
    const original = PDFDocument.prototype.text;
    const written: { text: string; font: string }[] = [];
    const spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
      written.push({ text: String(args[0]), font: (this as unknown as { _font?: { name?: string } })._font?.name ?? "" });
      return (original as (...rest: unknown[]) => PDFKit.PDFDocument).apply(this, args);
    });
    try {
      const messages: StoredMessage[] = [
        { seq: 1, topicId: "focus", kind: "explanation", text: "결론부터 말할게요. **지금은 먼저 다가가는 쪽이 이겨요.**\n\n두 번째 문단이에요.", refs: ["q1"] },
        { seq: 2, topicId: "focus", kind: "creative-scene", text: '달빛 님이라면 아마 "주말에 시간 돼요?" 하고 묻기 전에 열 번은 고민할 거예요.', refs: ["s1"] },
      ];
      const followups = [{ question: "어떻게 해요?", answer: "**먼저 묻는 연습**부터 해요.\n\n천천히요." }];
      await renderReadingPdf(input(0, { messages, topicTitles: { focus: "궁금한 점에 대한 답" }, followups }));
    } finally {
      spy.mockRestore();
    }
    expect(written.some((item) => item.text.includes("**"))).toBe(false);
    expect(written.some((item) => item.text.includes("예시 장면"))).toBe(false);
    expect(written.find((item) => item.text === "지금은 먼저 다가가는 쪽이 이겨요.")?.font).toMatch(/Bold/);
    expect(written.find((item) => item.text === "결론부터 말할게요. ")?.font).toMatch(/Regular/);
    expect(written.find((item) => item.text === "먼저 묻는 연습")?.font).toMatch(/Bold/);
    expect(written.some((item) => item.text === "두 번째 문단이에요.")).toBe(true);
  }, 30_000);
});
