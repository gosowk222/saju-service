import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createPreview, freeTickets, gatewayStats, login, redeemFreeTicket, setControl, waitForCompletedReading } from "./helpers";

/**
 * 결제 모드(CHECKOUT_MODE=payment)로 돌아간 앱 (포트 3101). 무료 테스트 모드 앱(포트 3100)과 같은 데이터베이스를 쓴다.
 * 모드를 바꿔도 로그인은 카카오만이고, 새 지급만 멈추며, 이미 받은 이용권과 풀이 권한은 그대로다.
 */
const FREE_TRIAL_APP = "http://127.0.0.1:3100";

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10 });
});

/** 무료 테스트 모드 앱에서 로그인한다. 쿠키는 호스트 단위라 같은 브라우저의 결제 모드 앱에도 이어진다. */
async function loginOnFreeTrialApp(page: Page, request: APIRequestContext, id = randomUUID()) {
  await setControl(request, { loginUser: { id, email: null, provider: "kakao" }, loginError: null });
  await page.goto(`${FREE_TRIAL_APP}/login`);
  await page.getByRole("button", { name: "카카오로 시작하기" }).click();
  await page.waitForURL(`${FREE_TRIAL_APP}/home`);
  return id;
}

test("결제 모드에서도 로그인 화면과 로그인 시작 경로는 카카오만 허용한다", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "카카오로 시작하기" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.getByText(/Google|구글|이메일/)).toHaveCount(0);
  await expect(page.getByText(/무료 테스트 기간/)).toHaveCount(0);
  const response = await page.request.post("/auth/login", {
    form: { provider: "google", next: "/home" },
    headers: { Origin: new URL(page.url()).origin },
    maxRedirects: 0,
  });
  expect(response.headers().location).toContain("/login?error=unsupported_provider");
});

test("결제 모드에서는 새 회원에게 이용권을 지급하지 않고 결제로 받는다", async ({ page, request }) => {
  const id = await login(page, request);
  expect(await freeTickets(request, id)).toHaveLength(0);
  await expect(page.getByText("무료 이용권")).toHaveCount(0);
  const readingId = await createPreview(page);
  await expect(page.getByRole("button", { name: "결제하고 풀이 받기" })).toBeVisible();
  await expect(page.getByRole("button", { name: /무료 이용권/ })).toHaveCount(0);
  const redeem = await page.request.post(`/api/readings/${readingId}/redeem`, { data: { requestId: randomUUID() } });
  expect(redeem.status()).toBe(409);
  expect((await redeem.json()).error.code).toBe("no_ticket");
  expect(await freeTickets(request, id)).toHaveLength(0);
});

test("무료 모드에서 받은 미사용 이용권은 결제 모드에서도 쓰고, 모드를 오가도 다시 지급하지 않는다", async ({ page, request }) => {
  const id = await loginOnFreeTrialApp(page, request);
  expect(await freeTickets(request, id)).toMatchObject([{ status: "available" }]);

  // 결제 모드 앱: 같은 이용권이 보이고, 결제 대신 이용권으로 받는다.
  await page.goto("/my");
  await expect(page.getByText("무료 이용권 1장")).toBeVisible();
  const readingId = await createPreview(page);
  await expect(page.getByRole("button", { name: "결제하고 풀이 받기" })).toHaveCount(0);
  const confirmsBefore = (await gatewayStats(request)).tossConfirms;
  await redeemFreeTicket(page);
  await waitForCompletedReading(page);
  expect((await gatewayStats(request)).tossConfirms).toBe(confirmsBefore);
  expect(await freeTickets(request, id)).toMatchObject([{ status: "completed", reading_id: readingId }]);

  // 이용권으로 받은 풀이 권한(본문, 후속 질문 횟수, PDF)은 결제 모드에서도 그대로다.
  await expect(page.getByText(/남은 질문 3회/)).toBeVisible();
  const pdf = await page.request.get(`/api/readings/${readingId}/pdf`);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  // 다른 맛보기는 결제로 받는다 (이용권은 이미 썼다).
  await createPreview(page, { nickname: "두번째" });
  await expect(page.getByText("무료 이용권은 다른 풀이에 이미 썼어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "결제하고 풀이 받기" })).toBeVisible();

  // 무료 모드 앱으로 다시 로그인해도 새로 지급하지 않는다.
  await page.context().clearCookies();
  await loginOnFreeTrialApp(page, request, id);
  await page.goto(`${FREE_TRIAL_APP}/my`);
  await expect(page.getByText("무료 이용권으로 받은 풀이가 있어요")).toBeVisible();
  expect(await freeTickets(request, id)).toHaveLength(1);
});
