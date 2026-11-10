import "server-only";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { ChartView, StoredMessage } from "@/domain/reading/types";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const REGULAR = path.join(FONT_DIR, "NotoSansKR-Regular.otf");
const BOLD = path.join(FONT_DIR, "NotoSansKR-Bold.otf");

const COLOR = { text: "#262345", muted: "#625E80", line: "#DCD9EA", accent: "#6E5CE6", tint: "#F3F1FD" };
const PAGE_MARGIN = 56;

export interface PdfInput {
  readonly productName: string;
  readonly nickname: string;
  readonly createdAt: string;
  readonly personaName: string;
  readonly chart: ChartView;
  readonly topicTitles: Readonly<Record<string, string>>;
  readonly messages: readonly StoredMessage[];
  readonly followups: readonly { readonly question: string; readonly answer: string }[];
}

/**
 * 저장된 풀이로만 PDF를 만든다. LLM을 호출하지 않고,
 * 출생일과 지역, 내부 근거 ID 같은 정보는 넣지 않는다.
 */
export function renderReadingPdf(input: PdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      font: REGULAR,
      info: { Title: input.productName, Creator: "사주풀이" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("regular", REGULAR);
    doc.registerFont("bold", BOLD);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;

    doc.font("bold").fontSize(24).fillColor(COLOR.text).text(input.productName, { width: contentWidth });
    doc.moveDown(0.4);
    doc.font("regular").fontSize(12).fillColor(COLOR.muted).text(`${input.nickname} 님의 풀이 · ${input.createdAt}`);
    doc.moveDown(1.2);

    drawChart(doc, input.chart, contentWidth);
    doc.moveDown(1);

    let currentTopic: string | null | undefined;
    for (const message of input.messages) {
      if (message.topicId !== currentTopic && message.topicId) {
        ensureSpace(doc, 80);
        doc.moveDown(0.8);
        doc.font("bold").fontSize(15).fillColor(COLOR.accent).text(input.topicTitles[message.topicId] ?? "", { width: contentWidth });
        doc.moveDown(0.3);
      }
      currentTopic = message.topicId;
      if (message.kind === "creative-scene") {
        doc.font("bold").fontSize(9.5).fillColor(COLOR.muted).text("예시 장면", { width: contentWidth });
      }
      doc
        .font("regular")
        .fontSize(11.5)
        .fillColor(COLOR.text)
        .text(message.text, { width: contentWidth, lineGap: 4, paragraphGap: 6 });
    }

    if (input.followups.length) {
      doc.addPage();
      doc.font("bold").fontSize(15).fillColor(COLOR.accent).text("후속 질문과 답변", { width: contentWidth });
      doc.moveDown(0.6);
      for (const item of input.followups) {
        ensureSpace(doc, 70);
        doc.font("bold").fontSize(11.5).fillColor(COLOR.text).text(`Q. ${item.question}`, { width: contentWidth, lineGap: 3 });
        doc.moveDown(0.2);
        doc.font("regular").fontSize(11.5).fillColor(COLOR.text).text(item.answer, { width: contentWidth, lineGap: 4 });
        doc.moveDown(0.8);
      }
    }

    doc.moveDown(1);
    ensureSpace(doc, 40);
    doc
      .font("regular")
      .fontSize(9)
      .fillColor(COLOR.muted)
      .text("이 풀이는 전통 명리 해석을 바탕으로 한 참고용 콘텐츠이며, 실제 사건을 예측하거나 보장하지 않습니다.", { width: contentWidth });

    doc.end();
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function drawChart(doc: PDFKit.PDFDocument, chart: ChartView, width: number): void {
  const columns = chart.pillars.length;
  const gap = 8;
  const cellWidth = (width - gap * (columns - 1)) / columns;
  const top = doc.y;
  const labelHeight = 18;
  const cellHeight = 44;

  chart.pillars.forEach((pillar, index) => {
    const x = PAGE_MARGIN + index * (cellWidth + gap);
    doc.font("regular").fontSize(10).fillColor(COLOR.muted).text(pillar.label, x, top, { width: cellWidth, align: "center" });
    [pillar.stem, pillar.branch].forEach((symbol, row) => {
      const y = top + labelHeight + row * (cellHeight + gap);
      doc.roundedRect(x, y, cellWidth, cellHeight, 8).fillAndStroke(COLOR.tint, COLOR.line);
      const label = symbol ? `${symbol.hanja} ${symbol.ko}` : "모름";
      doc
        .font(symbol ? "bold" : "regular")
        .fontSize(symbol ? 15 : 11)
        .fillColor(symbol ? COLOR.text : COLOR.muted)
        .text(label, x, y + (symbol ? 11 : 15), { width: cellWidth, align: "center", lineBreak: false });
    });
  });

  doc.x = PAGE_MARGIN;
  doc.y = top + labelHeight + cellHeight * 2 + gap * 2 + 10;
  for (const note of chart.notes) {
    doc.font("regular").fontSize(10).fillColor(COLOR.muted).text(note, PAGE_MARGIN, doc.y, { width });
  }
}
