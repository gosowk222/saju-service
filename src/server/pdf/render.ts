import "server-only";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  byPosition,
  formatFullDate,
  formatMonthDay,
  formatYearMonth,
  luckRows,
  luckUnavailableText,
  MONTH_DOMAIN_LABEL,
  MONTH_DOMAINS,
  MONTH_TONE_LABEL,
  monthFlags,
  POSITION_LABEL,
  POSITION_ORDER,
  sectionEyebrow,
  STAGE_BASIS_LABEL,
} from "@/components/mujin/scroll-model";
import type { MujinLuck, MujinMonths, MujinTables, NatalStageCell, ScrollBlockType, ScrollSectionView, ScrollStateView } from "@/domain/mujin/types";
import type { ScrollTable } from "@/domain/products/types";
import { ELEMENT_HANJA } from "@/domain/reading/chart";
import { splitEmphasis } from "@/domain/reading/emphasis";
import type { ChartElement, ChartView, StoredMessage } from "@/domain/reading/types";
import { FAMILIES, FAMILY_LABEL, FAMILY_MEANING } from "@/domain/rules/materials";

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
        // 장면은 제목 없이 왼쪽 선과 들여쓰기로만 구분한다.
        const top = doc.y;
        const page = doc.page;
        writeRich(doc, message.text, { x: PAGE_MARGIN + 12, width: contentWidth - 12, color: COLOR.text });
        // 쪽이 넘어가면 선 위치를 맞출 수 없으므로 같은 쪽에 끝난 장면에만 선을 긋는다.
        if (doc.page === page && doc.y > top + 6) doc.save().rect(PAGE_MARGIN, top, 2.5, doc.y - top - 6).fill(COLOR.line).restore();
        doc.x = PAGE_MARGIN;
      } else {
        writeRich(doc, message.text, { x: PAGE_MARGIN, width: contentWidth, color: COLOR.text });
      }
    }

    if (input.followups.length) {
      doc.addPage();
      doc.font("bold").fontSize(15).fillColor(COLOR.accent).text("후속 질문과 답변", { width: contentWidth });
      doc.moveDown(0.6);
      for (const item of input.followups) {
        ensureSpace(doc, 70);
        doc.font("bold").fontSize(11.5).fillColor(COLOR.text).text(`Q. ${item.question}`, { width: contentWidth, lineGap: 3 });
        doc.moveDown(0.2);
        writeRich(doc, item.answer, { x: PAGE_MARGIN, width: contentWidth, color: COLOR.text });
        doc.moveDown(0.6);
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

/**
 * PDF 글꼴(Noto Sans KR)에 없는 그림 이모티콘(😏처럼 기본 문자 영역 밖의 것)은 빈 네모로 찍히므로 뺀다.
 * ♡처럼 한국어 글꼴에 있는 기호는 남긴다. 화면에서는 그대로 보인다.
 */
export function withoutEmoji(text: string): string {
  return text
    .replace(/(?=\p{Extended_Pictographic})[\u{10000}-\u{10FFFF}]️?|️/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.!?,~])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

/** 문단 하나를 쓴다. **강조** 구절은 굵게 쓴다. 문단 사이 빈 줄은 문단 간격으로 바꾼다. */
function writeRich(doc: PDFKit.PDFDocument, text: string, options: { x: number; width: number; color: string }): void {
  for (const paragraph of withoutEmoji(text).split(/\n\s*\n/).filter((part) => part.trim())) {
    const runs = splitEmphasis(paragraph.trim());
    doc.fillColor(options.color).fontSize(11.5);
    runs.forEach((run, index) => {
      const last = index === runs.length - 1;
      doc.font(run.strong ? "bold" : "regular");
      const textOptions = { width: options.width, lineGap: 4, continued: !last, ...(last ? { paragraphGap: 6 } : {}) };
      if (index === 0) doc.text(run.text, options.x, doc.y, textOptions);
      else doc.text(run.text, textOptions);
    });
  }
  doc.font("regular");
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

// ─── 족자 상품(무진의 종합 사주) PDF ─────────────────────────────────────────

/** 블록 하나. 근거 연결(refs)과 질문 ID는 담지 않는다 (PDF에 근거 ID를 넣지 않는다). */
export interface ScrollPdfBlock {
  readonly type: ScrollBlockType;
  readonly text: string;
  readonly items: readonly { readonly label: string; readonly text: string }[];
}

export interface ScrollPdfSection {
  readonly id: string;
  readonly kind: ScrollSectionView["kind"];
  readonly number: number | null;
  readonly title: string;
  readonly tables: readonly ScrollTable[];
  /** 최종문의 핵심 답. 원국표 칸은 글이 없어 null이다. */
  readonly coreAnswer: string | null;
  readonly blocks: readonly ScrollPdfBlock[];
}

/**
 * 족자 PDF의 입력. 화면 상태(ScrollStateView)에서 최종문과 실제 표 값만 옮긴다.
 * 초안, 근거 ID, 작성 중 표시, 결제·입력 화면 요소, 출생일과 지역은 담지 않는다 (메신저 PDF와 같은 정책).
 */
export interface ScrollPdfInput {
  readonly productName: string;
  readonly personaName: string;
  readonly nickname: string;
  readonly createdAt: string;
  readonly chart: ChartView;
  readonly hourKnown: boolean;
  readonly tables: MujinTables;
  /** 9장 대운, 10장 12개월. 유료 권한과 기간 재료가 있을 때만 있다. */
  readonly timing: { readonly luck: MujinLuck; readonly months: MujinMonths } | null;
  readonly referenceDate: string | null;
  readonly sections: readonly ScrollPdfSection[];
  readonly followups: readonly { readonly question: string; readonly answer: string }[];
}

/**
 * 화면 상태에서 PDF 입력을 만든다. 블록의 근거 연결(refs)과 질문 ID는 버린다.
 * 권한·완료 확인은 호출하는 쪽(PDF 라우트)이 먼저 한다. 화면 상태에는 권한이 없으면 유료 본문이 애초에 없다.
 */
export function scrollPdfInput(
  state: ScrollStateView,
  extra: { readonly createdAt: string; readonly followups: readonly { readonly question: string; readonly answer: string }[] },
): ScrollPdfInput {
  return {
    productName: state.productName,
    personaName: state.personaName,
    nickname: state.nickname,
    createdAt: extra.createdAt,
    chart: state.chart,
    hourKnown: state.hourKnown,
    tables: state.tables,
    timing: state.timing,
    referenceDate: state.paid.referenceDate,
    sections: state.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      number: section.number,
      title: section.title,
      tables: section.tables,
      coreAnswer: section.content?.coreAnswer ?? null,
      blocks: (section.content?.blocks ?? []).map(({ type, text, items }) => ({
        type,
        text,
        items: items.map(({ label, text: itemText }) => ({ label, text: itemText })),
      })),
    })),
    followups: extra.followups,
  };
}

const ELEMENTS: readonly ChartElement[] = ["목", "화", "토", "금", "수"];
const TABLE_FONT_SIZE = 9.5;
const NOTE_FONT_SIZE = 9;

/** 화면(blocks.tsx)과 같은 블록 이름표. 문단과 비교, 장면에는 이름표가 없다. */
const BLOCK_LABEL: Partial<Readonly<Record<ScrollBlockType, string>>> = {
  basis: "이렇게 읽은 근거",
  condition: "조건과 한계",
  apply: "생활에 적용하기",
  checklist: "점검해 볼 것",
};

interface PdfTable {
  readonly columns: readonly string[];
  /** 열 너비 비율 (합 1). */
  readonly widths: readonly number[];
  readonly rows: readonly (readonly string[])[];
  /** 첫 열을 굵게 (행 이름). */
  readonly rowHeader?: boolean;
}

const bottomOf = (doc: PDFKit.PDFDocument) => doc.page.height - doc.page.margins.bottom;

/** 표 하나. 행이 쪽을 넘으면 새 쪽에 머리 줄을 다시 그린다. 칸 글은 줄바꿈하고 행 높이는 가장 긴 칸에 맞춘다. */
function drawTable(doc: PDFKit.PDFDocument, table: PdfTable, width: number): void {
  const widths = table.widths.map((ratio) => ratio * width);
  const padX = 5;
  const padY = 4;
  const options = (index: number) => ({ width: widths[index]! - padX * 2, lineGap: 1 });
  const heightOf = (cells: readonly string[], fonts: (index: number) => string) =>
    Math.max(
      ...cells.map((cell, index) => {
        doc.font(fonts(index)).fontSize(TABLE_FONT_SIZE);
        return doc.heightOfString(cell || " ", options(index));
      }),
    ) +
    padY * 2;
  const paint = (cells: readonly string[], fonts: (index: number) => string, color: string, fill: string | null) => {
    const top = doc.y;
    const height = heightOf(cells, fonts);
    if (fill) doc.save().rect(PAGE_MARGIN, top, width, height).fill(fill).restore();
    let x = PAGE_MARGIN;
    cells.forEach((cell, index) => {
      doc.font(fonts(index)).fontSize(TABLE_FONT_SIZE).fillColor(color).text(withoutEmoji(cell), x + padX, top + padY, options(index));
      x += widths[index]!;
    });
    doc.save().moveTo(PAGE_MARGIN, top + height).lineTo(PAGE_MARGIN + width, top + height).lineWidth(0.5).strokeColor(COLOR.line).stroke().restore();
    doc.x = PAGE_MARGIN;
    doc.y = top + height;
  };
  const headerFonts = () => "bold";
  const rowFonts = (index: number) => (table.rowHeader && index === 0 ? "bold" : "regular");
  const header = () => paint(table.columns, headerFonts, COLOR.muted, COLOR.tint);

  // 머리 줄만 쪽 끝에 남지 않게 첫 행까지 들어갈 자리를 먼저 본다.
  ensureSpace(doc, heightOf(table.columns, headerFonts) + (table.rows[0] ? heightOf(table.rows[0], rowFonts) : 0));
  header();
  for (const row of table.rows) {
    if (doc.y + heightOf(row, rowFonts) > bottomOf(doc)) {
      doc.addPage();
      header();
    }
    paint(row, rowFonts, COLOR.text, null);
  }
  doc.moveDown(0.4);
}

function drawNotes(doc: PDFKit.PDFDocument, notes: readonly string[], width: number): void {
  for (const note of notes) {
    doc.font("regular").fontSize(NOTE_FONT_SIZE).fillColor(COLOR.muted).text(withoutEmoji(note), PAGE_MARGIN, doc.y, { width, lineGap: 2 });
  }
  if (notes.length) doc.moveDown(0.6);
}

const POSITION_COLUMNS = ["", ...POSITION_ORDER.map((position) => POSITION_LABEL[position])];
const POSITION_WIDTHS = [0.2, 0.2, 0.2, 0.2, 0.2];

/** 원국표: 기둥 칸(메신저 PDF와 같은 그림)과 자리별 천간·지지 십성, 지장간 십성. */
function drawPillars(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  ensureSpace(doc, 160);
  drawChart(doc, input.chart, width);
  doc.moveDown(0.6);
  const cells = byPosition(input.tables.tenGods.cells);
  const pick = (value: (cell: NonNullable<(typeof cells)[number]>) => string) => cells.map((cell) => (cell ? value(cell) : "모름"));
  drawTable(
    doc,
    {
      columns: POSITION_COLUMNS,
      widths: POSITION_WIDTHS,
      rowHeader: true,
      rows: [
        ["천간 십성", ...pick((cell) => cell.stem ?? "없음")],
        ["지지 십성", ...pick((cell) => cell.branch ?? "없음")],
        ["지장간", ...pick((cell) => cell.hidden.join(" · ") || "없음")],
      ],
    },
    width,
  );
  drawNotes(doc, ["지장간 칸은 지지 속에 든 천간의 십성을 본기부터 적은 것이에요."], width);
}

/** 오행: 겉글자의 단순 개수와 엔진의 가중 비율을 다른 이름으로 나눠 적는다. */
function drawElements(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  const { counts, percents } = input.tables.elements;
  drawTable(
    doc,
    {
      columns: ["오행", ...ELEMENTS.map((element) => `${element}(${ELEMENT_HANJA[element]})`)],
      widths: [0.2, 0.16, 0.16, 0.16, 0.16, 0.16],
      rowHeader: true,
      rows: [
        ["글자 수", ...ELEMENTS.map((element) => `${counts[element]}개`)],
        ["세력 비율", ...ELEMENTS.map((element) => (percents ? `${percents[element]}%` : "–"))],
      ],
    },
    width,
  );
  drawNotes(
    doc,
    [
      `글자 수: 천간과 지지의 겉글자 ${input.hourKnown ? "여덟" : "여섯(태어난 시간을 몰라 시주 제외)"} 자를 오행별로 센 수예요.`,
      percents
        ? "세력 비율: 지지 속 천간(지장간)과 태어난 달의 힘까지 넣어 계산한 비율이에요. 글자 수와 다를 수 있어요."
        : "세력 비율은 이 원국에서 계산되지 않았어요.",
    ],
    width,
  );
}

/** 원국 12운성. 일간 기준과 그 기둥의 천간 기준을 따로 적고, 기간(대운·올해)의 단계는 섞지 않는다. */
function drawStages(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  const stages = input.tables.stages;
  const bases = (["day-master", "self"] as const).filter((basis) => stages.some((cell) => cell.basis === basis));
  const at = (position: NatalStageCell["position"], basis?: NatalStageCell["basis"]) =>
    stages.find((cell) => cell.position === position && (basis === undefined || cell.basis === basis)) ?? null;
  const pillar = (position: NatalStageCell["position"]) => {
    const cell = at(position);
    return cell ? `${cell.stem}${cell.branch}` : "모름";
  };
  drawTable(
    doc,
    {
      columns: POSITION_COLUMNS,
      widths: POSITION_WIDTHS,
      rowHeader: true,
      rows: [
        ["기둥", ...POSITION_ORDER.map(pillar)],
        ...bases.map((basis) => [`12운성\n(${STAGE_BASIS_LABEL[basis]})`, ...POSITION_ORDER.map((position) => at(position, basis)?.stage ?? "–")]),
      ],
    },
    width,
  );
  drawNotes(
    doc,
    ["원국 자리의 단계만 적었어요. 대운이나 올해처럼 기간에 따라 달라지는 단계와는 다른 표예요.", "병·사·절 같은 단계 이름은 질병이나 불운을 뜻하지 않아요."],
    width,
  );
}

/** 십성: 자리별 십성과 다섯 계열의 비율. */
function drawTenGods(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  const cells = byPosition(input.tables.tenGods.cells);
  drawTable(
    doc,
    {
      columns: ["자리", "천간", "지지(본기)", "지장간"],
      widths: [0.16, 0.22, 0.22, 0.4],
      rowHeader: true,
      rows: cells.map((cell, index) => [
        POSITION_LABEL[POSITION_ORDER[index]!],
        cell ? (cell.stem ?? "없음") : "모름",
        cell ? (cell.branch ?? "없음") : "모름",
        cell ? cell.hidden.join(" · ") || "없음" : "모름",
      ]),
    },
    width,
  );
  const families = input.tables.tenGods.families;
  if (!families) {
    drawNotes(doc, ["다섯 계열의 비율은 이 원국에서 계산되지 않았어요."], width);
    return;
  }
  drawTable(
    doc,
    {
      columns: ["계열", "뜻", "비율"],
      widths: [0.2, 0.6, 0.2],
      rowHeader: true,
      rows: FAMILIES.map((family) => [FAMILY_LABEL[family], FAMILY_MEANING[family], `${families[family]}%`]),
    },
    width,
  );
}

/** 9장 대운: 직전·현재·다음 구간. 경계는 근사값이라 '무렵'을 붙인다. 계산하지 못했으면 이유만 적는다. */
function drawLuck(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  const luck = input.timing?.luck;
  if (!luck) return;
  if (luck.status === "unavailable" || !luck.current) {
    drawNotes(doc, [luckUnavailableText(luck.reason)], width);
    return;
  }
  drawTable(
    doc,
    {
      columns: ["구간", "간지", "시작", "기간(근사)", "천간 십성"],
      widths: [0.16, 0.12, 0.22, 0.3, 0.2],
      rowHeader: true,
      rows: luckRows(luck).map((row) => {
        const period = row.period;
        return [
          row.key === "current" ? `${row.label}\n(지금)` : row.label,
          period?.ganzhi ?? "없음",
          period?.label ?? "–",
          period ? `${formatYearMonth(period.startsAt)} ~ ${formatYearMonth(period.endsAt)}${period.approximate ? " 무렵" : ""}` : "–",
          period?.stemTenGod ? `${period.stemTenGod}${period.stemFamily ? ` (${FAMILY_LABEL[period.stemFamily]})` : ""}` : "–",
        ];
      }),
    },
    width,
  );
  drawNotes(
    doc,
    [
      "대운이 바뀌는 시점은 계산 정책상 근사값이라 앞뒤로 조금 차이가 날 수 있어요.",
      ...(input.referenceDate ? [`현재 대운은 기준일 ${formatFullDate(input.referenceDate)}로 골랐어요.`] : []),
    ],
    width,
  );
}

/** 10장 12개월: 절기 기준 달마다 네 분야의 표지 구성과 주목·주의 구간. 점수나 확률이 아니다. */
function drawMonths(doc: PDFKit.PDFDocument, input: ScrollPdfInput, width: number): void {
  const months = input.timing?.months;
  if (!months) return;
  if (months.status === "insufficient" || months.months.length === 0) {
    drawNotes(doc, ["앞으로 12개월을 표로 보여 드릴 자료가 부족해요.", ...months.limitations], width);
    return;
  }
  drawNotes(doc, [`분석 기간: ${months.window.label}`], width);
  const join = (parts: readonly (string | null)[]) => parts.filter((part): part is string => Boolean(part)).join("\n");
  drawTable(
    doc,
    {
      columns: ["달", ...MONTH_DOMAINS.map((domain) => MONTH_DOMAIN_LABEL[domain])],
      widths: [0.24, 0.19, 0.19, 0.19, 0.19],
      rowHeader: true,
      rows: months.months.map((month) => [
        join([month.label, month.startsOn ? `${formatMonthDay(month.startsOn)}부터` : null, month.startedBeforeReference ? "기준일 전에 이미 시작한 달" : null]),
        ...MONTH_DOMAINS.map((domain) => {
          const tone = month.cells.find((cell) => cell.domain === domain)?.tone ?? "no-data";
          const flags = monthFlags(months, month.periodId, domain);
          return join([MONTH_TONE_LABEL[tone], flags.notable ? "주목" : null, flags.careful ? "주의" : null]);
        }),
      ]),
    },
    width,
  );
  drawNotes(
    doc,
    [
      "달은 절기로 나눈 월운이라 달력의 1일과 시작일이 달라요.",
      "주목은 분야마다 긍정 표지가 주의 표지보다 많은 달 가운데 고른 구간(최대 세 달), 주의는 주의 표지가 더 많은 달 가운데 고른 구간(최대 두 달)이에요.",
      "표지는 그 달에 들어온 근거의 구성이에요. 점수나 일이 일어날 확률이 아니에요.",
      ...months.limitations,
    ],
    width,
  );
}

function drawSectionTables(doc: PDFKit.PDFDocument, section: ScrollPdfSection, input: ScrollPdfInput, width: number): void {
  for (const table of section.tables) {
    switch (table) {
      case "pillars":
        drawPillars(doc, input, width);
        break;
      case "elements":
        drawElements(doc, input, width);
        break;
      case "stages":
        drawStages(doc, input, width);
        break;
      case "ten-gods":
        drawTenGods(doc, input, width);
        break;
      case "luck":
        drawLuck(doc, input, width);
        break;
      case "months":
        drawMonths(doc, input, width);
        break;
    }
  }
}

/** 이름표 한 줄. 이름표만 쪽 끝에 남지 않게 본문 두어 줄이 들어갈 자리를 함께 본다. */
function drawLabel(doc: PDFKit.PDFDocument, label: string, width: number): void {
  ensureSpace(doc, 48);
  doc.font("bold").fontSize(9.5).fillColor(COLOR.muted).text(label, PAGE_MARGIN, doc.y, { width });
  doc.moveDown(0.15);
}

/** 화면(blocks.tsx)과 같은 블록 구성. 장면은 제목 없이 왼쪽 선과 들여쓰기로만 구분한다 (메신저 PDF와 같은 방식). */
function drawBlock(doc: PDFKit.PDFDocument, block: ScrollPdfBlock, width: number): void {
  const label = BLOCK_LABEL[block.type];
  switch (block.type) {
    case "scene": {
      const top = doc.y;
      const page = doc.page;
      writeRich(doc, block.text, { x: PAGE_MARGIN + 12, width: width - 12, color: COLOR.text });
      // 쪽이 넘어가면 선 위치를 맞출 수 없으므로 같은 쪽에 끝난 장면에만 선을 긋는다.
      if (doc.page === page && doc.y > top + 6) doc.save().rect(PAGE_MARGIN, top, 2.5, doc.y - top - 6).fill(COLOR.line).restore();
      doc.x = PAGE_MARGIN;
      return;
    }
    case "compare": {
      if (block.text.trim()) writeRich(doc, block.text, { x: PAGE_MARGIN, width, color: COLOR.text });
      for (const item of block.items) {
        ensureSpace(doc, 48);
        doc.font("bold").fontSize(11).fillColor(COLOR.text).text(withoutEmoji(item.label), PAGE_MARGIN + 12, doc.y, { width: width - 12 });
        writeRich(doc, item.text, { x: PAGE_MARGIN + 12, width: width - 12, color: COLOR.text });
      }
      doc.x = PAGE_MARGIN;
      return;
    }
    case "checklist": {
      if (label) drawLabel(doc, label, width);
      if (block.text.trim()) writeRich(doc, block.text, { x: PAGE_MARGIN, width, color: COLOR.text });
      for (const item of block.items) {
        ensureSpace(doc, 24);
        const top = doc.y;
        // 점검 칸은 글꼴 기호 대신 선으로 그린다.
        doc.save().rect(PAGE_MARGIN + 1, top + 4, 8, 8).lineWidth(0.8).strokeColor(COLOR.muted).stroke().restore();
        const text = item.label.trim() && !item.label.includes("*") ? `**${item.label.trim()}** ${item.text}` : item.text;
        writeRich(doc, text, { x: PAGE_MARGIN + 16, width: width - 16, color: COLOR.text });
      }
      doc.x = PAGE_MARGIN;
      return;
    }
    default:
      if (label) drawLabel(doc, label, width);
      writeRich(doc, block.text, { x: PAGE_MARGIN, width, color: COLOR.text });
  }
}

/**
 * 족자 상품의 PDF. 저장된 최종문과 실제 계산 표로만 만든다. LLM을 호출하지 않는다.
 * 순서는 화면과 같다: 장마다 제목 → 핵심 답 → 표 → 블록. 그다음 고른 경우 답한 후속 질문, 맺음 문구.
 * 초안, 근거 ID, 작성 중 표시, 결제 버튼, 입력 화면 요소, 출생일과 지역은 넣지 않는다.
 * 장 제목은 핵심 답 첫 줄과 함께 들어갈 자리가 없으면 새 쪽에서 시작해 쪽 끝에 홀로 남지 않게 한다.
 */
export function renderScrollPdf(input: ScrollPdfInput): Promise<Buffer> {
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

    const width = doc.page.width - PAGE_MARGIN * 2;

    doc.font("bold").fontSize(24).fillColor(COLOR.text).text(input.productName, { width });
    doc.moveDown(0.4);
    doc.font("regular").fontSize(12).fillColor(COLOR.muted).text(`${input.nickname} 님의 풀이 · ${input.createdAt}`, { width });
    if (input.personaName) doc.fontSize(10.5).text(`풀이: ${input.personaName}`, { width });
    doc.moveDown(1);

    for (const section of input.sections) {
      ensureSpace(doc, 130);
      doc.moveDown(0.6);
      doc.font("regular").fontSize(10).fillColor(COLOR.muted).text(sectionEyebrow(section), PAGE_MARGIN, doc.y, { width });
      doc.font("bold").fontSize(16).fillColor(COLOR.accent).text(withoutEmoji(section.title), PAGE_MARGIN, doc.y, { width });
      doc.moveDown(0.4);
      if (section.coreAnswer?.trim()) {
        doc.font("bold").fontSize(9.5).fillColor(COLOR.accent).text("핵심 답", PAGE_MARGIN, doc.y, { width });
        doc.moveDown(0.15);
        writeRich(doc, section.coreAnswer, { x: PAGE_MARGIN, width, color: COLOR.text });
        doc.moveDown(0.3);
      }
      drawSectionTables(doc, section, input, width);
      for (const block of section.blocks) drawBlock(doc, block, width);
    }

    if (input.followups.length) {
      doc.addPage();
      doc.font("bold").fontSize(15).fillColor(COLOR.accent).text("후속 질문과 답변", { width });
      doc.moveDown(0.6);
      for (const item of input.followups) {
        ensureSpace(doc, 70);
        doc.font("bold").fontSize(11.5).fillColor(COLOR.text).text(`Q. ${withoutEmoji(item.question)}`, PAGE_MARGIN, doc.y, { width, lineGap: 3 });
        doc.moveDown(0.2);
        writeRich(doc, item.answer, { x: PAGE_MARGIN, width, color: COLOR.text });
        doc.moveDown(0.6);
      }
    }

    doc.moveDown(1);
    ensureSpace(doc, 40);
    doc
      .font("regular")
      .fontSize(9)
      .fillColor(COLOR.muted)
      .text("이 풀이는 전통 명리 해석을 바탕으로 한 참고용 콘텐츠이며, 실제 사건을 예측하거나 보장하지 않습니다.", PAGE_MARGIN, doc.y, { width });

    doc.end();
  });
}
