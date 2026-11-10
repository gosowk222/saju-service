import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { createPreview, freeTickets, gatewaySql, login, redeemFreeTicket, setControl } from "./helpers";

/**
 * 회원 역할(user/admin), 관리자 화면의 풀이 상품 이용 범위 설정, 관리자 무료 이용권 지급.
 * 역할은 DB에서만 바꾼다 (여기서는 gatewaySql로 set_user_role을 부른다).
 */
const CLOSED = "지금은 운영자가 허용한 계정만 풀이를 이용할 수 있어요.";

async function setOpenToAll(request: APIRequestContext, open: boolean) {
  await gatewaySql(request, "update public.app_settings set value = $1::jsonb where key = 'readings_open_to_all'", [JSON.stringify(open)]);
}

async function openToAll(request: APIRequestContext): Promise<boolean> {
  const [row] = await gatewaySql<{ value: boolean }>(request, "select value from public.app_settings where key = 'readings_open_to_all'");
  return row!.value;
}

async function adminPage(browser: Browser, request: APIRequestContext): Promise<{ page: Page; id: string; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const id = await login(page, request);
  await gatewaySql(request, "select public.set_user_role($1, 'admin', '테스트 운영자')", [id]);
  page.on("dialog", (dialog) => void dialog.accept());
  return { page, id, close: () => context.close() };
}

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10 });
});

test.afterEach(async ({ request }) => {
  // 다른 테스트 파일은 '모든 회원' 상태를 기준으로 한다.
  await setOpenToAll(request, true);
});

test("관리자가 아니면 관리자 화면과 API가 없는 것처럼 보인다", async ({ page, request }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  await login(page, request, { next: "/admin" });
  await expect(page.getByText("찾을 수 없는 화면이에요")).toBeVisible();
  await page.goto("/my");
  await expect(page.getByRole("link", { name: "관리자 화면" })).toHaveCount(0);
  expect((await page.request.post("/api/admin/settings", { data: { readingsOpenToAll: false } })).status()).toBe(404);
  expect((await page.request.post("/api/admin/tickets", { data: { userId: randomUUID(), requestId: randomUUID() } })).status()).toBe(404);
  expect(await openToAll(request)).toBe(true);
});

test("관리자가 끄면 관리자만, 켜면 모든 회원이 풀이 상품을 이용한다", async ({ browser, page, request }) => {
  // 일반 회원은 열려 있을 때 맛보기를 하나 만들어 둔다.
  const memberId = await login(page, request);
  const readingId = await createPreview(page);

  const admin = await adminPage(browser, request);
  await admin.page.goto("/my");
  await admin.page.getByRole("link", { name: "관리자 화면" }).click();
  await admin.page.waitForURL("**/admin");
  await expect(admin.page.getByRole("radio", { name: "모든 회원" })).toHaveAttribute("aria-checked", "true");
  await admin.page.getByRole("radio", { name: "관리자만" }).click();
  await expect(admin.page.getByRole("radio", { name: "관리자만" })).toHaveAttribute("aria-checked", "true");
  await expect(admin.page.getByText("지금: 관리자만 이용할 수 있어요")).toBeVisible();
  expect(await openToAll(request)).toBe(false);

  // 일반 회원: 새 입력, 맛보기의 이용권 사용, 서버 API가 모두 막힌다. 이용권은 그대로다.
  await page.goto("/readings/new?product=first-overview");
  await expect(page.getByText(CLOSED)).toBeVisible();
  await expect(page.getByLabel("별명")).toHaveCount(0);
  await page.goto(`/readings/${readingId}/preview`);
  await expect(page.getByText(CLOSED)).toBeVisible();
  await expect(page.getByRole("button", { name: /무료 이용권/ })).toHaveCount(0);
  for (const [method, path, data] of [
    ["post", "/api/readings", { productId: "first-overview" }],
    ["put", "/api/drafts", { productId: "first-overview" }],
    ["post", `/api/readings/${readingId}/redeem`, { requestId: randomUUID() }],
    ["post", `/api/readings/${readingId}/generate`, { retry: true }],
    ["post", `/api/readings/${readingId}/orders`, {}],
  ] as const) {
    const response = await page.request.fetch(path, { method, data });
    expect(response.status(), path).toBe(403);
    expect((await response.json()).error.code, path).toBe("readings_closed");
  }
  expect(await freeTickets(request, memberId)).toMatchObject([{ status: "available" }]);
  await page.goto("/home");
  await expect(page.getByText(CLOSED)).toBeVisible();
  await expect(page.getByRole("link", { name: "무료 이용권으로 시작하기" })).toHaveCount(0);
  // 보관함은 그대로 열린다.
  await page.goto("/library");
  await expect(page.getByRole("banner")).toHaveText("내 풀이 보관함");

  // 관리자는 닫혀 있어도 이용한다.
  await createPreview(admin.page);
  await redeemFreeTicket(admin.page);

  // 다시 켜면 일반 회원도 이용한다.
  await admin.page.goto("/admin");
  await admin.page.getByRole("radio", { name: "모든 회원" }).click();
  await expect(admin.page.getByRole("radio", { name: "모든 회원" })).toHaveAttribute("aria-checked", "true");
  expect(await openToAll(request)).toBe(true);
  await page.goto(`/readings/${readingId}/preview`);
  await redeemFreeTicket(page);
  expect(await freeTickets(request, memberId)).toMatchObject([{ status: "redeemed", reading_id: readingId }]);

  const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.admin_actions where admin_id = $1 and action = 'set_setting'", [admin.id]);
  expect(n).toBe(2);
  await admin.close();
});

test("관리자가 고른 회원에게 무료 이용권을 한 장씩 주고, 회원은 그 이용권으로 풀이를 하나 더 받는다", async ({ browser, page, request }) => {
  const memberId = await login(page, request);
  expect(await freeTickets(request, memberId)).toHaveLength(1);

  const admin = await adminPage(browser, request);
  await admin.page.goto(`/admin?q=${memberId.slice(0, 8)}`);
  const card = admin.page.getByRole("listitem").filter({ hasText: memberId });
  await expect(card.getByText("사용 가능 1장 · 사용 0장")).toBeVisible();
  await card.getByRole("button", { name: "무료 이용권 1장 주기" }).click();
  await expect(card.getByText("무료 이용권 1장을 줬어요.")).toBeVisible();
  await expect(card.getByText("사용 가능 2장 · 사용 0장")).toBeVisible();
  const tickets = await gatewaySql<{ source: string; status: string }>(request, "select source, status from public.free_tickets where user_id = $1 order by granted_at", [memberId]);
  expect(tickets).toEqual([
    { source: "campaign", status: "available" },
    { source: "admin", status: "available" },
  ]);

  // 회원: 이용권 2장으로 풀이 두 건을 받고, 세 번째는 이미 썼다고 안내받는다.
  await page.goto("/home");
  await expect(page.getByText("무료 이용권 2장", { exact: true })).toBeVisible();
  await createPreview(page, { nickname: "첫째" });
  await redeemFreeTicket(page);
  await createPreview(page, { nickname: "둘째" });
  await expect(page.getByText("무료 이용권 1장", { exact: true })).toBeVisible();
  await redeemFreeTicket(page);
  await createPreview(page, { nickname: "셋째" });
  await expect(page.getByText("무료 이용권은 다른 풀이에 이미 썼어요")).toBeVisible();
  const used = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.free_tickets where user_id = $1 and status <> 'available'", [memberId]);
  expect(used[0]!.n).toBe(2);
  await admin.close();
});
