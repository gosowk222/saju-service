import { NextRequest } from "next/server";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_NOW } from "@/domain/mujin/now";
import type { ScrollBlock, ScrollSectionContent, ScrollSectionView, ScrollStateView } from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import { toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";
import { analyzeMujinBirth, computeMujinTiming } from "@/server/engine/mujin";
import { renderScrollPdf, scrollPdfInput } from "@/server/pdf/render";
import { loadScrollState } from "@/server/scroll/state";
import { GET } from "@/app/api/readings/[readingId]/pdf/route";

/**
 * 무진의 종합 사주 PDF. 렌더 입력과 PDF에 쓴 글자(pdfkit text 호출)를 확인하고, 라우트의 권한·완료 조건을 가짜 클라이언트로 확인한다.
 * 출생 정보는 가상 값이고 표는 실제 엔진으로 계산한다. LLM은 부르지 않는다.
 */

const clients = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => clients.server,
  createSupabaseAdminClient: () => {
    throw new Error("admin client is not used in this test");
  },
}));
vi.mock("@/server/scroll/state", () => ({ loadScrollState: vi.fn() }));

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };
const known: AnalyzeInput = { birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, gender: "female", birthTime: { status: "branch", branch: "신" }, birthPlace: place };
const birth = toPublicBirthInput(known);
const analyzed = analyzeMujinBirth({ birth, product: MUJIN_OVERVIEW, nickname: "가람", now: EMPTY_NOW });
const REFERENCE_DATE = "2026-11-12";
const timing = computeMujinTiming({ birth, referenceDate: REFERENCE_DATE, gender: "female" });

const USER_ID = "11111111-1111-4111-8111-111111111111";
const READING_ID = "22222222-2222-4222-8222-222222222222";

/** 장마다 일곱 종류 블록을 모두 담은 최종문. 블록에는 서버 안에서만 쓰는 근거 연결과 질문 ID가 붙어 있다. */
function contentOf(id: string): ScrollSectionContent {
  const block = (type: ScrollBlock["type"], text: string, items: ScrollBlock["items"] = []): ScrollBlock => ({ type, questionIds: ["1-1"], refs: ["m12", "q1"], text, items });
  return {
    sectionId: id,
    coreAnswer: `${id} 핵심 답 표지예요. **굵게 볼 결론**이에요.`,
    blocks: [
      block("paragraph", `${id} 설명 문단 표지예요.`),
      block("basis", `${id} 근거 설명 표지예요.`),
      block("condition", `${id} 조건 표지예요.`),
      block("compare", `${id} 비교 기준 표지예요.`, [
        { label: "조직에서 일하기", text: `${id} 조직 쪽 설명` },
        { label: "스스로 일 꾸리기", text: `${id} 자율 쪽 설명` },
      ]),
      block("apply", `${id} 생활 적용 표지예요.`),
      block("checklist", "", [{ label: "", text: `${id} 점검 항목 표지` }]),
      block("scene", `${id} 가정 장면 표지예요. 이런 날이 있다고 해 볼게요.`),
    ],
  };
}

function stateOf(overrides: Partial<ScrollStateView> = {}, contentFor: (id: string) => ScrollSectionContent | null = contentOf): ScrollStateView {
  const sections: ScrollSectionView[] = MUJIN_OVERVIEW.scroll.sections.map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    number: spec.number,
    title: spec.title,
    tier: spec.tier,
    summary: spec.summary,
    questions: spec.questions.map(({ id, title }) => ({ id, title })),
    tables: spec.tables,
    state: "done",
    content: spec.kind === "chart" ? null : contentFor(spec.id),
  }));
  return {
    readingId: READING_ID,
    productId: MUJIN_OVERVIEW.id,
    productName: MUJIN_OVERVIEW.name,
    personaId: "mujin",
    personaName: "무진 도사",
    nickname: "가람",
    createdAt: "2026-11-12T03:00:00Z",
    hourKnown: analyzed.chart.hourKnown,
    chart: analyzed.chart,
    tables: analyzed.tables,
    entitled: true,
    free: { status: "completed", canRetry: false, errorCode: null },
    paid: { status: "completed", canRetry: false, errorCode: null, referenceDate: REFERENCE_DATE },
    sections,
    timing: { luck: timing.luck, months: timing.months },
    ...overrides,
  };
}

const FOLLOWUPS = [{ question: "이직은 언제 준비할까요?", answer: "**먼저 정리할 것**부터 말씀드리죠.\n\n두 번째 문단이에요." }];

/** PDF에 쓴 글자와 그때의 위치를 모은다 (pdf.test.ts와 같은 방식). */
async function written<T>(task: () => Promise<T>) {
  const original = PDFDocument.prototype.text;
  const lines: { text: string; font: string; y: number; bottom: number }[] = [];
  const spy = vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    lines.push({
      text: String(args[0]),
      font: (this as unknown as { _font?: { name?: string } })._font?.name ?? "",
      y: typeof args[2] === "number" ? args[2] : this.y,
      bottom: this.page.height - this.page.margins.bottom,
    });
    return (original as (...rest: unknown[]) => PDFKit.PDFDocument).apply(this, args);
  });
  try {
    const result = await task();
    return { result, lines, texts: lines.map((line) => line.text) };
  } finally {
    spy.mockRestore();
  }
}

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("무진 PDF 렌더 입력", () => {
  it("화면 상태에서 최종문과 실제 표만 옮기고 근거 연결과 질문 ID는 버린다", () => {
    const input = scrollPdfInput(stateOf(), { createdAt: "2026년 11월 12일", followups: FOLLOWUPS });
    const json = JSON.stringify(input);
    expect(json).not.toContain("m12");
    expect(json).not.toContain('"refs"');
    expect(json).not.toContain('"questionIds"');
    expect(input.sections.map((section) => section.id)).toEqual(MUJIN_OVERVIEW.scroll.sections.map((section) => section.id));
    expect(input.sections.find((section) => section.id === "chart")).toMatchObject({ coreAnswer: null, blocks: [], tables: ["pillars"] });
    expect(input.sections.find((section) => section.id === "ch10")).toMatchObject({ coreAnswer: expect.stringContaining("ch10 핵심 답"), tables: ["months"] });
    expect(input).toMatchObject({ productName: MUJIN_OVERVIEW.name, nickname: "가람", referenceDate: REFERENCE_DATE, tables: analyzed.tables, chart: analyzed.chart });
  });
});

describe("무진 PDF 렌더", () => {
  it("장 제목·핵심 답·블록·실제 표·후속 질문을 쓰고 근거 ID·초안·화면 조작 문구는 쓰지 않는다", async () => {
    const { result: pdf, lines, texts } = await written(() => renderScrollPdf(scrollPdfInput(stateOf(), { createdAt: "2026년 11월 12일", followups: FOLLOWUPS })));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("NotoSansKR");
    expect(pageCount(pdf)).toBeGreaterThan(5);
    const all = texts.join("\n");

    expect(texts[0]).toBe(MUJIN_OVERVIEW.name);
    expect(all).toContain("가람 님의 풀이 · 2026년 11월 12일");
    expect(all).toContain("풀이: 무진 도사");
    // 목차 순서대로 모든 칸의 제목과 핵심 답, 일곱 종류 블록.
    for (const spec of MUJIN_OVERVIEW.scroll.sections) {
      expect(texts).toContain(spec.title);
      if (spec.kind === "chart") continue;
      expect(all).toContain(`${spec.id} 핵심 답 표지예요.`);
      for (const marker of ["설명 문단 표지", "근거 설명 표지", "조건 표지", "비교 기준 표지", "조직 쪽 설명", "자율 쪽 설명", "생활 적용 표지", "점검 항목 표지", "가정 장면 표지"]) {
        expect(all).toContain(`${spec.id} ${marker}`);
      }
    }
    expect(texts.indexOf("성향과 내면")).toBeLessThan(texts.indexOf("앞으로 12개월"));
    for (const label of ["핵심 답", "이렇게 읽은 근거", "조건과 한계", "생활에 적용하기", "점검해 볼 것", "조직에서 일하기"]) expect(texts).toContain(label);
    // **강조**는 굵은 글꼴로 쓰고 별표는 남기지 않는다.
    expect(texts.find((text) => text === "굵게 볼 결론")).toBeTruthy();
    expect(lines.find((line) => line.text === "굵게 볼 결론")?.font).toMatch(/Bold/);

    // 실제 계산 표: 원국 기둥, 십성·지장간, 오행 글자 수와 세력 비율(다른 이름), 12운성, 다섯 계열, 대운, 12개월.
    const pillar = analyzed.chart.pillars.find((item) => item.stem && item.branch)!;
    expect(texts).toContain(`${pillar.stem!.hanja} ${pillar.stem!.ko}`);
    for (const label of ["천간 십성", "지지 십성", "지장간", "글자 수", "세력 비율", "기둥", "계열", "구간", "기간(근사)"]) expect(texts).toContain(label);
    expect(texts).toContain(`${analyzed.tables.elements.counts["목"]}개`);
    expect(texts.some((text) => text.startsWith("12운성\n("))).toBe(true);
    expect(texts).toContain(analyzed.tables.stages[0]!.stage);
    expect(timing.luck.current).not.toBeNull();
    expect(texts).toContain("현재 대운\n(지금)");
    expect(texts).toContain(timing.luck.current!.label);
    expect(texts.some((text) => text.endsWith("무렵"))).toBe(true);
    expect(all).toContain("현재 대운은 기준일 2026년 11월 12일로 골랐어요.");
    expect(all).toContain(`분석 기간: ${timing.months.window.label}`);
    for (const month of timing.months.months) expect(texts.some((text) => text.startsWith(month.label))).toBe(true);

    // 답한 후속 질문과 맺음 문구.
    expect(texts).toContain("후속 질문과 답변");
    expect(texts).toContain("Q. 이직은 언제 준비할까요?");
    expect(texts).toContain("먼저 정리할 것");
    expect(all).toContain("실제 사건을 예측하거나 보장하지 않습니다.");

    // 근거 ID, 초안, 작성 중 표시, 결제·입력 화면 요소, 출생일과 지역은 없다.
    for (const banned of ["m12", "q1", "1-1", "초안", "작성 중", "잠김", "결제", "이용권", "받는 방법", "입력", "1998", "서울특별시"]) {
      expect(texts.some((text) => text.includes(banned))).toBe(false);
    }
    expect(texts.some((text) => text.includes("**"))).toBe(false);
  }, 60_000);

  it("장 제목은 쪽 끝에 홀로 남지 않는다 (제목 아래로 핵심 답 몇 줄이 들어갈 자리를 둔다)", async () => {
    const { lines } = await written(() => renderScrollPdf(scrollPdfInput(stateOf(), { createdAt: "2026년 11월 12일", followups: [] })));
    const titles = new Set(MUJIN_OVERVIEW.scroll.sections.map((section) => section.title));
    const placed = lines.filter((line) => titles.has(line.text));
    expect(placed).toHaveLength(titles.size);
    for (const line of placed) expect(line.bottom - line.y).toBeGreaterThan(80);
  }, 60_000);

  it("시각 미상이면 대운 표 대신 이유를 쓰고, 후속 질문을 고르지 않으면 그 쪽이 없다", async () => {
    const unknownBirth = toPublicBirthInput({ ...known, birthTime: { status: "unknown" } });
    const unknown = analyzeMujinBirth({ birth: unknownBirth, product: MUJIN_OVERVIEW, nickname: "가람", now: EMPTY_NOW });
    const unknownTiming = computeMujinTiming({ birth: unknownBirth, referenceDate: REFERENCE_DATE, gender: "female" });
    const state = stateOf({ chart: unknown.chart, tables: unknown.tables, hourKnown: false, timing: { luck: unknownTiming.luck, months: unknownTiming.months } });
    const { texts } = await written(() => renderScrollPdf(scrollPdfInput(state, { createdAt: "2026년 11월 12일", followups: [] })));
    expect(texts.some((text) => text.includes("태어난 시간을 몰라 대운을 계산하지 않았어요"))).toBe(true);
    expect(texts).not.toContain("현재 대운\n(지금)");
    expect(texts.some((text) => text.includes("여섯(태어난 시간을 몰라 시주 제외)"))).toBe(true);
    expect(texts).not.toContain("후속 질문과 답변");
  }, 60_000);
});

type Row = Record<string, unknown>;

/** 사용자 권한 클라이언트 흉내. 행은 이미 이 사용자에게 보이는 것(RLS)만 넣는다. */
function userClient(tables: Record<string, Row[]>, userId = USER_ID) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const builder = {
      select: () => builder,
      eq(column: string, value: unknown) {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      order(column: string) {
        rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
        return builder;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: <T>(resolve: (value: { data: Row[]; error: null }) => T, reject?: (reason: unknown) => T) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    };
    return builder;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId, identities: [{ provider: "kakao" }] } }, error: null }) },
    from,
  };
}

const MUJIN_READING = { id: READING_ID, user_id: USER_ID, product_id: MUJIN_OVERVIEW.id, nickname: "가람", persona_id: "mujin", created_at: "2026-11-12T03:00:00Z", chart: analyzed.chart };
const ENTITLEMENT = { reading_id: READING_ID, source: "free_ticket", question_limit: 3 };
const COMPLETED_JOB = { reading_id: READING_ID, status: "completed" };
const FOLLOWUP_ROWS = [
  { id: "f1", reading_id: READING_ID, question: "이직은 언제 준비할까요?", answer: "답한 질문이에요.", status: "answered", created_at: "2027-01-01T00:00:00Z" },
  { id: "f2", reading_id: READING_ID, question: "날씨는요?", answer: "범위 밖 안내예요.", status: "off_topic", created_at: "2027-01-01T00:01:00Z" },
];

async function getPdf(query = "") {
  return GET(new NextRequest(`http://localhost/api/readings/${READING_ID}/pdf${query}`), { params: Promise.resolve({ readingId: READING_ID }) });
}

describe("무진 PDF 라우트의 권한과 완료 조건", () => {
  beforeEach(() => {
    vi.mocked(loadScrollState).mockReset();
  });
  afterEach(() => {
    clients.server = null;
  });

  it("소유자이고 구매 권한이 있고 유료 단계가 끝났으면 무진 PDF를 내려 준다 (후속 질문은 답한 것만)", async () => {
    clients.server = userClient({ readings: [MUJIN_READING], entitlements: [ENTITLEMENT], generation_jobs: [COMPLETED_JOB], followups: FOLLOWUP_ROWS });
    vi.mocked(loadScrollState).mockResolvedValue(stateOf());
    const { result: response, texts } = await written(() => getPdf("?followups=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(`${MUJIN_OVERVIEW.name}.pdf`)}`);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(loadScrollState).toHaveBeenCalledWith(USER_ID, READING_ID);
    expect(texts).toContain("Q. 이직은 언제 준비할까요?");
    expect(texts.some((text) => text.includes("날씨는요"))).toBe(false);
    expect(texts).toContain("가람 님의 풀이 · 2026년 11월 12일");
  }, 60_000);

  it("구매 권한이 없으면 403이고 유료 본문을 읽지 않는다", async () => {
    clients.server = userClient({ readings: [MUJIN_READING], entitlements: [], generation_jobs: [] });
    const response = await getPdf();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "not_entitled" } });
    expect(loadScrollState).not.toHaveBeenCalled();
  });

  it("다른 회원의 풀이는 행이 보이지 않아 403이다", async () => {
    clients.server = userClient({ readings: [], entitlements: [], generation_jobs: [] }, "99999999-9999-4999-8999-999999999999");
    const response = await getPdf();
    expect(response.status).toBe(403);
    expect(loadScrollState).not.toHaveBeenCalled();
  });

  it("유료 단계가 끝나지 않았으면 409다", async () => {
    clients.server = userClient({ readings: [MUJIN_READING], entitlements: [ENTITLEMENT], generation_jobs: [{ reading_id: READING_ID, status: "running" }] });
    const response = await getPdf();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "not_ready" } });
    expect(loadScrollState).not.toHaveBeenCalled();
  });

  it("화면 상태로 한 번 더 확인한다: 권한이 없으면 403, 끝나지 않은 장이 있으면 409", async () => {
    clients.server = userClient({ readings: [MUJIN_READING], entitlements: [ENTITLEMENT], generation_jobs: [COMPLETED_JOB] });
    vi.mocked(loadScrollState).mockResolvedValueOnce(stateOf({ entitled: false }));
    expect((await getPdf()).status).toBe(403);
    vi.mocked(loadScrollState).mockResolvedValueOnce(null);
    expect((await getPdf()).status).toBe(403);
    vi.mocked(loadScrollState).mockResolvedValueOnce(stateOf({ paid: { status: "running", canRetry: false, errorCode: null, referenceDate: REFERENCE_DATE } }));
    expect((await getPdf()).status).toBe(409);
    vi.mocked(loadScrollState).mockResolvedValueOnce(stateOf({}, (id) => (id === "ch7" ? null : contentOf(id))));
    expect((await getPdf()).status).toBe(409);
  });

  it("묘묘 풀이는 기존 메신저 PDF 그대로 만든다 (무진 상태를 읽지 않는다)", async () => {
    clients.server = userClient({
      readings: [{ id: READING_ID, user_id: USER_ID, product_id: "first-overview", nickname: "달빛", persona_id: "myomyo", created_at: "2026-11-09T03:00:00Z", chart: analyzed.chart }],
      entitlements: [ENTITLEMENT],
      generation_jobs: [COMPLETED_JOB],
      reading_messages: [{ reading_id: READING_ID, seq: 1, topic_id: "focus", kind: "explanation", text: "묘묘 메신저 말풍선이야.", refs: ["s1"] }],
    });
    const { result: response, texts } = await written(() => getPdf());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("묘묘의 사주 참견.pdf")}`);
    expect(texts).toContain("묘묘 메신저 말풍선이야.");
    expect(texts).toContain("달빛 님의 풀이 · 2026년 11월 9일");
    expect(loadScrollState).not.toHaveBeenCalled();
  }, 60_000);
});
