import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPreview, gatewayStats, login, purchase, setControl, stubTossSdk, waitForCompletedReading } from "./helpers";

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null });
});

async function openCheckout(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "결제하고 풀이 받기" }).click();
  await page.waitForURL("**/checkout/*");
  return page.url().split("/checkout/")[1]!.split("?")[0]!;
}

test("미결제 사용자는 URL과 API로 본문에 접근할 수 없다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);
  await page.goto(`/readings/${readingId}`);
  await expect(page).toHaveURL(/\/preview$/);
  for (const path of ["state", "pdf"]) {
    expect((await page.request.get(`/api/readings/${readingId}/${path}`)).status()).toBe(403);
  }
  expect((await page.request.post(`/api/readings/${readingId}/generate`, { data: {} })).status()).toBe(403);
  expect((await gatewayStats(request)).openaiCalls).toBeGreaterThanOrEqual(0);
});

test("맛보기 응답에 유료 본문이 포함되지 않는다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);
  const response = await page.request.get(`/readings/${readingId}/preview`);
  const html = await response.text();
  expect(html).not.toContain("service-interpretation");
  expect(html).not.toContain("conclusionId");
  expect(html).not.toContain("supportingEvidence");
});

test("결제 실패와 취소는 구매 권한을 주지 않고 다시 결제할 수 있다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);

  await stubTossSdk(page, "fail");
  await openCheckout(page);
  await page.getByRole("button", { name: /원 결제하기/ }).click();
  await expect(page.getByText(/결제가 완료되지 않았어요/)).toBeVisible();
  expect((await page.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
  await expect(page.getByRole("button", { name: "다시 결제하기" })).toBeVisible();

  await page.unrouteAll();
  await stubTossSdk(page, "cancel");
  await page.getByRole("button", { name: "다시 결제하기" }).click();
  await page.waitForURL((url) => !url.search.includes("result="));
  await page.getByRole("button", { name: /원 결제하기/ }).click();
  await expect(page.getByText(/결제를 취소했어요/)).toBeVisible();
  expect((await page.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
});

test("주소의 금액을 바꿔 보내면 완료되지 않는다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);
  const orderId = await openCheckout(page);
  const before = (await gatewayStats(request)).tossConfirms;
  await page.goto(`/checkout/${orderId}/complete?paymentKey=forged&orderId=${orderId}&amount=1`);
  await expect(page).toHaveURL(/result=failed/);
  expect((await gatewayStats(request)).tossConfirms).toBe(before);
  expect((await page.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
});

test("결제사가 승인을 거절하면 완료되지 않는다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);
  const orderId = await openCheckout(page);
  await setControl(request, { tossFail: "REJECT_CARD_COMPANY" });
  await page.goto(`/checkout/${orderId}/complete?paymentKey=pk_rejected&orderId=${orderId}&amount=990`);
  await expect(page).toHaveURL(/result=failed/);
  expect((await page.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
});

test("다른 사용자의 주문은 완료할 수 없다", async ({ browser, request }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await login(pageA, request);
  const readingId = await createPreview(pageA);
  const orderId = await openCheckout(pageA);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await login(pageB, request);
  const before = (await gatewayStats(request)).tossConfirms;
  await pageB.goto(`/checkout/${orderId}/complete?paymentKey=pk_b&orderId=${orderId}&amount=990`);
  await expect(pageB).toHaveURL(/\/library$/);
  expect((await gatewayStats(request)).tossConfirms).toBe(before);
  expect((await pageA.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
  await contextA.close();
  await contextB.close();
});

test("중복 콜백은 한 번만 처리되고 생성도 한 번만 일어난다", async ({ page, request }) => {
  await login(page, request);
  const readingId = await createPreview(page);
  await stubTossSdk(page);
  const orderId = await openCheckout(page);
  const beforeConfirms = (await gatewayStats(request)).tossConfirms;
  const callback = `/checkout/${orderId}/complete?paymentKey=pk_dup&orderId=${orderId}&amount=990`;

  await page.goto(callback);
  await waitForCompletedReading(page);
  const beforeLlm = (await gatewayStats(request)).openaiCalls;

  await page.goto(callback);
  await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
  await page.request.post(`/api/readings/${readingId}/generate`, { data: { retry: true } });

  const stats = await gatewayStats(request);
  expect(stats.tossConfirms).toBe(beforeConfirms + 1);
  expect(stats.openaiCalls).toBe(beforeLlm);
});

test("결제 후 생성이 실패하면 같은 주문으로 재시도한다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page);
  await setControl(request, { openai: "error" });
  await purchase(page);
  await expect(page.getByText("풀이를 만들지 못했어요")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/다시 결제할 필요가 없어요/)).toBeVisible();

  await page.goto("/library");
  await expect(page.getByText("다시 시도 필요")).toBeVisible();
  await page.getByRole("link", { name: /나를 읽는 짧은 사주/ }).click();

  await setControl(request, { openai: "ok" });
  await page.getByRole("button", { name: "다시 시도하기" }).click();
  await waitForCompletedReading(page);
  await expect(page.getByText("풀이 완료")).toBeVisible();
});

test("입력을 수정하면 새 계산으로 갱신되고 이전 주문과 섞이지 않는다", async ({ page, request }) => {
  await login(page, request);
  const firstId = await createPreview(page, { nickname: "처음" });
  const firstBubble = await page.getByText("일간은").innerText();

  await page.getByRole("link", { name: "입력 수정" }).click();
  await page.getByRole("button", { name: "생년월일 수정" }).click();
  await page.getByLabel("생년월일 여섯 자리").fill("900302");
  await expect(page.locator("#date-result")).toContainText("1990년 3월 2일");
  await page.getByRole("button", { name: /^(다음|건너뛰기)$/ }).click();
  await page.getByRole("button", { name: /^(다음|건너뛰기)$/ }).click();
  await page.getByRole("button", { name: /^(다음|건너뛰기)$/ }).click();
  await page.getByRole("button", { name: /^(다음|건너뛰기)$/ }).click();
  await page.getByRole("button", { name: /^(다음|건너뛰기)$/ }).click();
  await page.getByRole("button", { name: "내 사주 보기" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/preview") && !url.pathname.includes(firstId));

  // 화면을 오가면 이전 페이지가 숨겨진 채 남으므로 보이는 요소만 읽는다.
  const secondBubble = await page.getByText("일간은").locator("visible=true").innerText();
  expect(secondBubble).not.toBe(firstBubble);
  await expect(page.getByText(/1990년 3월 2일/).locator("visible=true")).toBeVisible();
  expect(page.url()).not.toContain(firstId);
});

test("시간 모름이면 시주를 비워 두고 안내한다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page, { time: "시간을 몰라요" });
  await expect(page.getByText("모름").first()).toBeVisible();
  await expect(page.getByText(/시주를 빼고/).first()).toBeVisible();
});

test.describe("후속 질문", () => {
  async function completed(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext) {
    await login(page, request);
    const readingId = await createPreview(page);
    await purchase(page);
    await waitForCompletedReading(page);
    return readingId;
  }

  test("관련 없는 질문은 안내만 하고 차감하지 않는다", async ({ page, request }) => {
    await completed(page, request);
    await page.getByRole("textbox", { name: "후속 질문" }).fill("내일 날씨 어때?");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText(/이 풀이에서는 성향, 강점, 일, 돈, 연애, 인간관계, 친구, 가족, 지역과 행운/)).toBeVisible();
    await expect(page.getByText(/남은 질문 3회/)).toBeVisible();
  });

  test("생성 실패는 차감하지 않고 안내한다", async ({ page, request }) => {
    await completed(page, request);
    await setControl(request, { openai: "followup-error" });
    await page.getByRole("textbox", { name: "후속 질문" }).fill("그게 무슨 뜻이야?");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText(/질문 횟수는 줄지 않았어요/)).toBeVisible();
    await expect(page.getByText(/남은 질문 3회/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "후속 질문" })).toHaveValue("그게 무슨 뜻이야?");
  });

  test("같은 요청을 다시 보내도 한 번만 차감한다", async ({ page, request }) => {
    const readingId = await completed(page, request);
    const clientRequestId = randomUUID();
    const body = { data: { clientRequestId, question: "그게 무슨 뜻이야?" } };
    const first = await page.request.post(`/api/readings/${readingId}/followups`, body);
    const second = await page.request.post(`/api/readings/${readingId}/followups`, body);
    expect((await first.json()).questionsUsed).toBe(1);
    expect(await second.json()).toMatchObject({ questionsUsed: 1, replayed: true });
  });

  test("제공 횟수를 다 쓰면 더 질문할 수 없다", async ({ page, request }) => {
    const readingId = await completed(page, request);
    for (const question of ["첫 질문이요", "두번째 질문", "세번째 질문"]) {
      expect((await page.request.post(`/api/readings/${readingId}/followups`, { data: { clientRequestId: randomUUID(), question } })).status()).toBe(200);
    }
    const fourth = await page.request.post(`/api/readings/${readingId}/followups`, { data: { clientRequestId: randomUUID(), question: "네번째" } });
    expect(fourth.status()).toBe(409);
    await page.reload();
    await expect(page.getByText("질문을 모두 사용했어요").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "후속 질문" })).toBeDisabled();
  });
});
