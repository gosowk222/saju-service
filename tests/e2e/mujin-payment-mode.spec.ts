import { expect, test } from "@playwright/test";
import {
  MUJIN_CONTROL_RESET,
  MUJIN_PAID_SECTIONS,
  callsSince,
  createMujinReadingApi,
  freeTickets,
  gatewaySql,
  gatewayStats,
  login,
  mujinSection,
  setControl,
  stubTossSdk,
  waitForMujinComplete,
  waitForMujinFree,
} from "./helpers";

/**
 * 결제 모드(CHECKOUT_MODE=payment, 포트 3101)의 무진의 종합 사주. 파일 이름이 playwright.config.ts의 PAYMENT_SPECS(…payment-mode.spec.ts)에 맞아
 * 결제 모드 앱에서 돈다. 결제창은 토스 SDK 대역, 승인은 가짜 서버다. 실제 결제와 실제 모델을 검증하지 않는다.
 * 가격 990원은 상품 설정의 임시값이다 (출시 가격 아님).
 */

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10, ...MUJIN_CONTROL_RESET });
});

test.afterEach(async ({ request }) => {
  await setControl(request, MUJIN_CONTROL_RESET);
});

test("결제 모드: 무료 부분 뒤 무진 결제 버튼으로 결제하면 같은 풀이에 유료 장이 완성된다 (임시 가격)", async ({ page, request }) => {
  test.setTimeout(180_000);
  const userId = await login(page, request);
  // 결제 모드는 새 이용권을 주지 않는다.
  expect(await freeTickets(request, userId)).toHaveLength(0);

  await page.goto("/products/mujin-overview");
  await expect(page.getByText("990원 (출시 전 임시 가격)")).toBeVisible();
  await expect(page.getByText("유료 부분은 결제 후 받아요. 표시된 가격은 출시 전 임시 가격이에요.")).toBeVisible();
  await expect(page.getByText("임시 가격", { exact: true })).toBeVisible();

  const readingId = await createMujinReadingApi(page, { nickname: "결제" });
  await page.goto(`/readings/${readingId}`);
  await waitForMujinFree(page);
  for (const id of MUJIN_PAID_SECTIONS) await expect(mujinSection(page, id).getByText("잠김", { exact: true })).toBeVisible();

  const unlock = page.getByRole("region", { name: "이어지는 장 받기" });
  await expect(unlock.getByText("990원")).toBeVisible();
  await expect(unlock.getByText("출시 전 임시 가격")).toBeVisible();
  await expect(unlock.getByRole("button", { name: /무료 이용권/ })).toHaveCount(0);

  await stubTossSdk(page);
  const before = await gatewayStats(request);
  await unlock.getByRole("button", { name: "결제하고 이어서 받기" }).click();
  await page.waitForURL("**/checkout/*");
  // 주소는 화면 이동(pushState) 때 먼저 바뀌므로, 결제 화면에만 있는 결제 버튼이 그려진 뒤에 내용을 본다.
  const pay = page.getByRole("button", { name: "990원 결제하기" });
  await expect(pay).toBeVisible();
  await expect(page.getByRole("main")).toContainText("무진의 종합 사주");
  await pay.click();
  await page.waitForURL(new RegExp(`/readings/${readingId}$`));
  await waitForMujinComplete(page);

  const after = await gatewayStats(request);
  expect(after.tossConfirms).toBe(before.tossConfirms + 1);
  expect(Object.keys(callsSince(after.mujin.sections.pass1, before.mujin.sections.pass1)).filter((id) => (MUJIN_PAID_SECTIONS as readonly string[]).includes(id)).sort()).toEqual(
    [...MUJIN_PAID_SECTIONS].sort(),
  );
  const [order] = await gatewaySql<{ status: string; amount: number; product_id: string }>(request, "select status, amount, product_id from public.orders where reading_id = $1", [
    readingId,
  ]);
  expect(order).toEqual({ status: "paid", amount: 990, product_id: "mujin-overview" });
  const [entitlement] = await gatewaySql<{ source: string }>(request, "select source from public.entitlements where reading_id = $1", [readingId]);
  expect(entitlement?.source).toBe("payment");
  const [job] = await gatewaySql<{ status: string; order_id: string | null; ticket_id: string | null }>(
    request,
    "select status, order_id::text, ticket_id::text from public.generation_jobs where reading_id = $1",
    [readingId],
  );
  expect(job).toMatchObject({ status: "completed", ticket_id: null });
  expect(job?.order_id).toBeTruthy();
  await expect(page.getByText(/남은 질문 3회/)).toBeVisible();

  // 결제를 마친 풀이는 다시 결제하지 않는다 (같은 풀이로 돌아온다).
  const again = await page.request.post(`/api/readings/${readingId}/orders`);
  expect(again.status()).toBe(409);
  expect((await again.json()).error.code).toBe("already_paid");
});
