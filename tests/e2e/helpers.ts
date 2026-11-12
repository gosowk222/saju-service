import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const GATEWAY = "http://127.0.0.1:54399";

export async function setControl(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${GATEWAY}/__control`, { data });
}

/** 가짜 서버가 센 무진 호출 (tests/support/fake-gateway.ts의 stats.mujin). 누적값이라 이전 값과의 차이로 본다. */
export interface MujinGatewayStats {
  /** 스키마별 호출 수 (question = 질문 정리, pass1 = 평문 초안 묶음, pass2 = 무진 문장). 실패 주입으로 오류를 돌려준 호출도 센다. */
  calls: { question: number; pass1: number; pass2: number };
  /** 실패 주입(mujinQuestionFail)으로 서버 오류를 돌려준 질문 정리 호출 수. */
  failed: { question: number };
  /** 장별 요청 수. Pass 1은 묶음 호출 안의 장을 하나씩 센다. */
  sections: { pass1: Record<string, number>; pass2: Record<string, number> };
  last: {
    question: { items: number; facts: number; domains: string[] } | null;
    pass1: {
      sectionIds: string[];
      tiers: string[];
      questionRefs: string[];
      hasTables: boolean;
      timing: { luckStatus: string; luckReason: string | null; months: number } | null;
      retryIssues: number;
    } | null;
    pass2: { sectionId: string; draftBlocks: number; userFacts: number; retryIssues: number } | null;
    /** 기간 자료가 들어간 마지막 Pass 1 입력 (9·10장 묶음). */
    timing: { luckStatus: string; luckReason: string | null; months: number } | null;
  };
}

export async function gatewayStats(request: APIRequestContext) {
  const response = await request.get(`${GATEWAY}/__state`);
  return (await response.json()) as {
    authorizeProviders: string[];
    openaiCalls: number;
    narrationCalls: number;
    lastNarrationInput: Record<string, unknown> | null;
    tossConfirms: number;
    openaiModels: string[];
    lastOpenaiBody: Record<string, unknown>;
    mujin: MujinGatewayStats;
  };
}

/** 장별 호출 수가 before 이후 얼마나 늘었는지. 늘어난 장만 남긴다. */
export function callsSince(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(after).flatMap(([key, value]) => (value > (before[key] ?? 0) ? [[key, value - (before[key] ?? 0)]] : [])));
}

/** 토스 SDK 스크립트를 테스트용 대역으로 바꾼다. 실제 결제창이 아니다. */
export async function stubTossSdk(page: Page, mode: "success" | "fail" | "cancel" = "success") {
  await page.route("https://js.tosspayments.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        window.TossPayments = function () {
          return {
            widgets: function () {
              var amount = 0;
              return {
                setAmount: function (value) { amount = value.value; return Promise.resolve(); },
                renderPaymentMethods: function () { return Promise.resolve({}); },
                renderAgreement: function () { return Promise.resolve({}); },
                requestPayment: function (request) {
                  var mode = ${JSON.stringify(mode)};
                  if (mode === "success") {
                    location.assign(request.successUrl + "?paymentType=NORMAL&amount=" + amount + "&orderId=" + request.orderId + "&paymentKey=test_pk_" + request.orderId);
                  } else if (mode === "fail") {
                    location.assign(request.failUrl + "?code=REJECT_CARD_COMPANY&message=" + encodeURIComponent("거절"));
                  } else {
                    location.assign(request.failUrl + "?code=PAY_PROCESS_CANCELED&message=" + encodeURIComponent("취소"));
                  }
                  return new Promise(function () {});
                },
              };
            },
          };
        };
        window.TossPayments.ANONYMOUS = "@@ANONYMOUS";
      `,
    }),
  );
}

/**
 * 앱의 실제 로그인 버튼(카카오로 시작하기)과 서버의 로그인 시작·콜백을 지나가되, OAuth 제공자는 가짜 서버가 대신한다.
 * providers는 그 계정에 연결된 로그인 수단이다 (기본은 카카오 하나). 실제 카카오 로그인 검증이 아니다.
 */
export async function login(
  page: Page,
  request: APIRequestContext,
  options: { id?: string; email?: string | null; providers?: string[]; next?: string } = {},
) {
  const id = options.id ?? randomUUID();
  const providers = options.providers ?? ["kakao"];
  await setControl(request, { loginUser: { id, email: options.email ?? null, provider: providers[0], providers }, loginError: null });
  await page.goto(options.next ? `/login?next=${encodeURIComponent(options.next)}` : "/login");
  await page.getByRole("button", { name: "카카오로 시작하기" }).click();
  await page.waitForURL(options.next ? `**${options.next.split("?")[0]}*` : "**/home");
  return id;
}

/** 테스트용 데이터베이스를 관리자 권한으로 조회하거나 준비한다. */
export async function gatewaySql<T = Record<string, unknown>>(request: APIRequestContext, sql: string, params: unknown[] = []): Promise<T[]> {
  const response = await request.post(`${GATEWAY}/__sql`, { data: { sql, params } });
  const body = await response.json();
  if (!response.ok()) throw new Error(`sql failed: ${JSON.stringify(body)}`);
  return body as T[];
}

export async function freeTickets(request: APIRequestContext, userId: string) {
  return gatewaySql<{ id: string; status: string; reading_id: string | null; restore_count: number }>(
    request,
    "select id, status, reading_id, restore_count from public.free_tickets where user_id = $1",
    [userId],
  );
}

/**
 * 앱의 로그인 흐름을 거치지 않은, 이미 발급된 세션을 브라우저에 넣는다.
 * 구글 제공자를 끄기 전에 만들어진 구글 세션처럼, 콜백 확인을 지나지 않은 세션을 흉내 낸다.
 */
export async function injectSession(page: Page, request: APIRequestContext, user: { id?: string; providers: string[]; email?: string | null }) {
  const id = user.id ?? randomUUID();
  const response = await request.post(`${GATEWAY}/__session`, {
    data: { id, email: user.email ?? null, provider: user.providers[0], providers: user.providers },
  });
  const session = await response.json();
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const baseURL = new URL(page.url().startsWith("http") ? page.url() : "http://127.0.0.1:3100");
  await page.context().addCookies([{ name: "sb-127-auth-token", value, domain: baseURL.hostname, path: "/", sameSite: "Lax" }]);
  return id;
}

/** 맛보기에서 무료 이용권으로 풀이를 받는다. 결제창을 거치지 않는다. */
export async function redeemFreeTicket(page: Page) {
  await page.getByRole("button", { name: "무료 이용권 1장으로 풀이받기" }).click();
  await page.waitForURL(/\/readings\/[0-9a-f-]+$/);
}

export interface WizardInput {
  nickname?: string;
  gender?: "남성" | "여성";
  yymmdd?: string;
  calendar?: "양력" | "음력";
  leap?: boolean;
  place?: string;
  placeResultName?: string;
  time?: string;
  situation?: string | null;
  concern?: string;
}

const NEXT = () => /^(다음|건너뛰기)$/;

export async function fillWizard(page: Page, input: WizardInput = {}) {
  await page.getByLabel("별명").fill(input.nickname ?? "달빛");
  await page.getByRole("button", { name: NEXT() }).click();

  await page.getByRole("button", { name: input.gender ?? "여성" }).click();
  await page.getByRole("button", { name: NEXT() }).click();

  if (input.calendar === "음력") await page.getByRole("radio", { name: "음력" }).click();
  if (input.leap) await page.getByLabel("윤달이에요").check();
  await page.getByLabel("생년월일 여섯 자리").fill(input.yymmdd ?? "980919");
  await expect(page.locator("#date-result")).toContainText("년");
  await page.getByRole("button", { name: NEXT() }).click();

  await page.getByLabel("출생지역 검색").fill(input.place ?? "서울");
  await page.getByRole("button", { name: new RegExp(input.placeResultName ?? "서울특별시") }).first().click();
  await page.getByRole("button", { name: NEXT() }).click();

  await page.getByRole("button", { name: new RegExp(input.time ?? "^신시") }).first().click();
  await page.getByRole("button", { name: NEXT() }).click();

  if (input.situation !== null) await page.getByRole("button", { name: input.situation ?? "직장인" }).click();
  await page.getByRole("button", { name: NEXT() }).click();

  if (input.concern) await page.getByLabel("궁금한 점").fill(input.concern);
  await page.getByRole("button", { name: NEXT() }).click();
}

export async function createPreview(page: Page, input: WizardInput = {}): Promise<string> {
  await page.goto("/readings/new?product=first-overview");
  await fillWizard(page, input);
  await page.getByRole("button", { name: "내 사주 보기" }).click();
  await page.waitForURL("**/preview");
  return page.url().split("/readings/")[1]!.replace("/preview", "");
}

export async function purchase(page: Page) {
  await stubTossSdk(page);
  await page.getByRole("button", { name: "결제하고 풀이 받기" }).click();
  await page.waitForURL("**/checkout/*");
  await page.getByRole("button", { name: /원 결제하기/ }).click();
  await page.waitForURL(/\/readings\/[0-9a-f-]+$/);
}

/** 풀이가 끝날 때까지 기다린 뒤 전달 효과를 건너뛴다. */
export async function waitForCompletedReading(page: Page) {
  const skip = page.getByRole("button", { name: "전체 바로 보기" });
  await skip.waitFor({ timeout: 40_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByText("풀이 완료")).toBeVisible({ timeout: 40_000 });
}

// ─── 무진의 종합 사주 (족자 상품) ─────────────────────────────

export const MUJIN_PRODUCT = "mujin-overview";

/** 원국표를 뺀 무료 칸 (기초 분석 4개와 1장). */
export const MUJIN_FREE_SECTIONS = ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"] as const;
/** 이용권·결제 뒤에 쓰는 칸 (2~10장과 마지막 정리). */
export const MUJIN_PAID_SECTIONS = ["ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10", "closing"] as const;
/** 화면 목차 순서 (상품 정의 src/domain/products/mujin-overview.ts의 순서). */
export const MUJIN_TOC = ["chart", ...MUJIN_FREE_SECTIONS, ...MUJIN_PAID_SECTIONS];

/** 가짜 서버의 무진 조절 값 기본값. 무진 테스트는 시작과 끝에 이 값으로 되돌린다 (다른 테스트 파일은 이 키를 모른다). */
export const MUJIN_CONTROL_RESET = { mujinFail: null, mujinQuestionFail: null, mujinVoiceDelayMs: 0, mujinVoiceDelaySections: null };

/** 무진 상담 장면 첫 인사의 일부 (캐릭터 설정 lines.intake.greet). 상품 상세와 입력 첫 단계에서 보인다. */
export const MUJIN_GREET = /이 신당을 지키는 무진입니다/;

/** 족자의 칸 하나 (data-section-id). */
export function mujinSection(page: Page, sectionId: string) {
  return page.locator(`[data-section-id="${sectionId}"]`);
}

/** 화면에 그려진 칸의 순서. */
export async function mujinSectionOrder(page: Page): Promise<string[]> {
  return page.locator("[data-section-id]").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.sectionId ?? ""));
}

export interface MujinInput {
  nickname?: string;
  gender?: "남성" | "여성";
  yymmdd?: string;
  place?: string;
  placeResultName?: string;
  /** 시진 이름(예: 신시). null이면 '시간을 몰라요'. */
  time?: string | null;
  /** 지금의 나: 일·학업 상태 선택지 이름 (최대 2개). */
  work?: string[];
  /** 지금의 나: 특히 궁금한 장 제목 (최대 2개). */
  interests?: string[];
  /** 지금의 나: 연애·결혼 상태 선택지 이름. */
  relationship?: string;
  /** 지금의 나: 가족 이야기 선택지 이름. */
  family?: string[];
  concern?: string;
}

const NEXT_OR_SKIP = /^(다음|건너뛰기)$/;

/**
 * 무진 대화형 입력을 확인 화면까지 채운다. 순서는 화면과 같다:
 * 별명 → 성별 → 생년월일 → 출생지역 → 출생시각(지역의 시계 범위) → 지금의 나(선택) → 진짜 궁금한 점 → 확인.
 */
export async function fillMujinIntake(page: Page, input: MujinInput = {}) {
  await page.getByLabel("별명").fill(input.nickname ?? "달빛");
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  await page.getByRole("button", { name: input.gender ?? "여성", exact: true }).click();
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  await page.getByLabel("생년월일 여섯 자리").fill(input.yymmdd ?? "980919");
  await expect(page.locator("#date-result")).toContainText("년");
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  await page.getByLabel("출생지역 검색").fill(input.place ?? "서울");
  await page.getByRole("button", { name: new RegExp(input.placeResultName ?? "서울특별시") }).first().click();
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  if (input.time === null) await page.getByRole("button", { name: /^시간을 몰라요/ }).click();
  else await page.getByRole("button", { name: new RegExp(`^${input.time ?? "신시"}`) }).first().click();
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  await expect(page.getByRole("heading", { level: 1, name: "지금의 나" })).toBeVisible();
  for (const label of input.work ?? []) await page.getByRole("button", { name: label, exact: true }).click();
  for (const title of input.interests ?? []) await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  if (input.relationship) {
    await page.locator("summary", { hasText: "지금의 연애·결혼 상태" }).click();
    await page.getByRole("group", { name: "지금의 연애·결혼 상태" }).getByRole("button", { name: input.relationship, exact: true }).click();
  }
  if (input.family?.length) {
    await page.locator("summary", { hasText: "가족 이야기에서 다루고 싶은 부분이 있나요?" }).click();
    const group = page.getByRole("group", { name: "가족 이야기에서 다루고 싶은 부분" });
    for (const label of input.family) await group.getByRole("button", { name: label, exact: true }).click();
  }
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();

  if (input.concern) await page.getByLabel("진짜 궁금한 점").fill(input.concern);
  await page.getByRole("button", { name: NEXT_OR_SKIP }).click();
  await expect(page.getByRole("heading", { level: 1, name: "입력 확인" })).toBeVisible();
}

/** 대화형 입력으로 무진 풀이를 만들고 족자 화면(/readings/{id})으로 간다. 무료 부분 생성은 화면이 바로 시작한다. */
export async function createMujinReading(page: Page, input: MujinInput = {}): Promise<string> {
  await page.goto(`/readings/new?product=${MUJIN_PRODUCT}`);
  await fillMujinIntake(page, input);
  await page.getByRole("button", { name: "이 내용으로 풀이 받기" }).click();
  await page.waitForURL(/\/readings\/[0-9a-f-]+$/);
  return page.url().split("/readings/")[1]!;
}

/**
 * 화면 입력을 거치지 않고 무진 풀이를 만든다 (입력 화면이 확인 대상이 아닌 테스트). 앱의 같은 API(POST /api/readings)를 쓴다.
 * 족자 화면을 열기 전에는 생성이 시작되지 않는다.
 */
export async function createMujinReadingApi(
  page: Page,
  input: { nickname?: string; birthTime?: { status: "unknown" } | { status: "branch"; branch: string }; concern?: string; now?: Record<string, unknown> } = {},
): Promise<string> {
  const search = await page.request.get(`/api/places/search?q=${encodeURIComponent("서울")}`);
  const { results } = (await search.json()) as { results: { geonameId: number; name: string }[] };
  const place = results.find((item) => item.name === "서울특별시") ?? results[0]!;
  const response = await page.request.post("/api/readings", {
    data: {
      productId: MUJIN_PRODUCT,
      nickname: input.nickname ?? "달빛",
      gender: "female",
      yymmdd: "980919",
      calendar: "solar",
      isLeapMonth: false,
      geonameId: place.geonameId,
      birthTime: input.birthTime ?? { status: "branch", branch: "신" },
      situationId: null,
      concern: input.concern ?? "",
      now: input.now ?? { work: [], interests: [], relationship: null, family: [] },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { readingId: string }).readingId;
}

/** 상담 장면 (족자 화면 맨 위, 무진 상품 상세의 배너 아래). 족자 화면에서는 실제 저장 상태로 정한 상태 표시(계산 중·작성 중·완료)가 있다. */
export function mujinScene(page: Page) {
  return page.getByRole("region", { name: "상담 장면" });
}

/** 족자 위의 단계 단위 실패 안내 (오류 칸 없이 단계만 실패했을 때 실패 이유와 다시 시도 버튼). */
export function mujinPhaseAlert(page: Page, tier: "free" | "paid") {
  return page.locator(`[data-phase-alert="${tier}"]`);
}

/**
 * 구매 전 무료 부분(기초 분석 4개와 1장)이 모두 완성되고 무료 단계가 끝날 때까지 기다린다.
 * 무료 단계가 끝나기 전에 이용권을 쓰면 유료 단계가 '아직 차례가 아님'으로 30초 쉬므로, 장면의 '무료 부분 완료'까지 본다.
 */
export async function waitForMujinFree(page: Page) {
  await expect(mujinScene(page).getByText("무료 부분 완료", { exact: true })).toBeVisible({ timeout: 60_000 });
  for (const sectionId of MUJIN_FREE_SECTIONS) await expect(mujinSection(page, sectionId).getByText("핵심 답", { exact: true })).toBeVisible();
}

/** 유료 장까지 모두 끝나 후속 질문 패널과 PDF 카드가 열릴 때까지 기다린다. */
export async function waitForMujinComplete(page: Page) {
  await expect(page.getByRole("heading", { name: "무진 도사에게 더 묻기" })).toBeVisible({ timeout: 90_000 });
  await expect(mujinScene(page).getByText("완료", { exact: true })).toBeVisible();
  for (const sectionId of [...MUJIN_FREE_SECTIONS, ...MUJIN_PAID_SECTIONS]) {
    await expect(mujinSection(page, sectionId).getByText("핵심 답", { exact: true })).toBeVisible();
  }
}
