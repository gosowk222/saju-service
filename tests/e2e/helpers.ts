import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const GATEWAY = "http://127.0.0.1:54399";

export async function setControl(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${GATEWAY}/__control`, { data });
}

export async function gatewayStats(request: APIRequestContext) {
  const response = await request.get(`${GATEWAY}/__state`);
  return (await response.json()) as {
    openaiCalls: number;
    narrationCalls: number;
    lastNarrationInput: Record<string, unknown> | null;
    tossConfirms: number;
    openaiModels: string[];
    lastOpenaiBody: Record<string, unknown>;
  };
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

/** 앱의 실제 로그인 버튼과 콜백을 지나가되, OAuth 제공자는 가짜 서버가 대신한다. */
export async function login(page: Page, request: APIRequestContext, options: { id?: string; email?: string | null; provider?: "카카오" | "Google"; next?: string } = {}) {
  const id = options.id ?? randomUUID();
  await setControl(request, { loginUser: { id, email: options.email ?? null, provider: "kakao" }, loginError: null });
  await page.goto(options.next ? `/login?next=${encodeURIComponent(options.next)}` : "/login");
  await page.getByRole("button", { name: options.provider === "Google" ? /Google/ : /카카오/ }).click();
  await page.waitForURL(options.next ? `**${options.next.split("?")[0]}*` : "**/home");
  return id;
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
