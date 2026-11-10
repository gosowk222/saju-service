import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { GATEWAY, createPreview, login, redeemFreeTicket, setControl, waitForCompletedReading } from "./helpers";

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null });
});

test("로그인 화면은 카카오로 시작하기 하나만 제공한다", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "카카오로 시작하기" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(page.locator('input[type="password"], input[type="email"], input[type="text"]')).toHaveCount(0);
  const text = await page.locator("body").innerText();
  for (const word of ["Google", "구글", "이메일", "비밀번호", "Apple", "회원가입", "계정 연결"]) expect(text).not.toContain(word);
});

test("보호된 화면은 로그인 후 원래 주소로 돌아온다", async ({ page, request }) => {
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login\?next=%2Flibrary/);
  await login(page, request, { next: "/library" });
  await expect(page).toHaveURL(/\/library$/);
});

test("로그인 없이 홈과 상품을 보고, 보관함·마이·사주 입력은 로그인 뒤 누르려던 화면으로 간다", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "시작하기" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("link", { name: /묘묘의 사주 참견/ }).first()).toBeVisible();
  const nav = page.getByRole("navigation", { name: "주요 메뉴" });
  await nav.getByRole("link", { name: "탐색" }).click();
  await expect(page).toHaveURL(/\/products$/);

  // 화면의 로그인 버튼을 그대로 눌러, 로그인 화면이 받은 복귀 주소로 돌아오는지 본다.
  const loginHere = async () => {
    await setControl(request, { loginUser: { id: randomUUID(), email: null, provider: "kakao" }, loginError: null });
    await page.getByRole("button", { name: /카카오/ }).click();
  };

  await nav.getByRole("link", { name: "보관함" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Flibrary$/);
  await loginHere();
  await page.waitForURL("**/library");
  await expect(page.getByText("아직 받은 풀이가 없어요")).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/home");
  await nav.getByRole("link", { name: "마이" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fmy$/);
  await loginHere();
  await page.waitForURL("**/my");
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/products/first-overview");
  await page.getByRole("link", { name: "내 사주 입력하기" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Freadings%2Fnew%3Fproduct%3Dfirst-overview$/);
  await loginHere();
  await page.waitForURL("**/readings/new?product=first-overview");
  await expect(page.getByLabel("별명")).toBeVisible();
});

test("외부 주소로의 복귀를 막는다", async ({ page, request }) => {
  for (const next of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
    await page.context().clearCookies();
    await setControl(request, { loginUser: { id: randomUUID(), email: null, provider: "kakao" } });
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByRole("button", { name: /카카오/ }).click();
    await page.waitForURL("**/home");
    expect(new URL(page.url()).host).toBe("127.0.0.1:3100");
  }
});

test("로그인 취소와 오류를 안내한다", async ({ page, request }) => {
  await setControl(request, { loginError: "access_denied" });
  await page.goto("/login");
  await page.getByRole("button", { name: /카카오/ }).click();
  await expect(page.getByText(/로그인을 취소했어요/)).toBeVisible();

  await setControl(request, { loginError: "server_error" });
  await page.getByRole("button", { name: "카카오로 시작하기" }).click();
  await expect(page.getByText(/로그인을 완료하지 못했어요/)).toBeVisible();
});

test("이메일이 없는 사용자도 끝까지 이용할 수 있다", async ({ page, request }) => {
  await login(page, request, { email: null });
  await createPreview(page);
  await expect(page.getByLabel("사주원국")).toBeVisible();
});

test("이미 로그인했으면 스플래시와 로그인 화면을 건너뛴다", async ({ page, request }) => {
  await login(page, request);
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/home$/);
});

test("새로고침해도 로그인이 유지되고 로그아웃하면 끝난다", async ({ page, request }) => {
  await login(page, request);
  await page.reload();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/my");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login/);
});

test("인증이 만료되면 API는 401, 화면은 로그인으로 보낸다", async ({ page, request }) => {
  await login(page, request);
  await page.context().clearCookies();
  const response = await page.request.get("/api/places/search?q=서울");
  expect(response.status()).toBe(401);
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login/);
});

test("사용자 A의 기록을 사용자 B가 볼 수 없다", async ({ browser, request }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await login(pageA, request);
  const readingId = await createPreview(pageA, { nickname: "에이" });
  await redeemFreeTicket(pageA);
  await waitForCompletedReading(pageA);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await login(pageB, request);

  for (const path of [`/readings/${readingId}`, `/readings/${readingId}/preview`]) {
    await pageB.goto(path);
    await expect(pageB.getByText("찾을 수 없는 화면이에요")).toBeVisible();
    expect(await pageB.locator("body").innerText()).not.toContain("에이");
  }
  for (const path of ["state", "pdf"]) {
    expect((await pageB.request.get(`/api/readings/${readingId}/${path}`)).status()).toBe(403);
  }
  const generate = await pageB.request.post(`/api/readings/${readingId}/generate`, { data: { retry: true } });
  expect(generate.status()).toBe(403);
  const followup = await pageB.request.post(`/api/readings/${readingId}/followups`, { data: { clientRequestId: randomUUID(), question: "뭐야?" } });
  expect(followup.status()).toBe(403);
  await pageB.goto("/library");
  await expect(pageB.getByText("아직 받은 풀이가 없어요")).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test("브라우저 권한으로 데이터베이스를 직접 조작할 수 없다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page);
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name.endsWith("auth-token"))!;
  const decoded = JSON.parse(Buffer.from(session.value.replace("base64-", ""), "base64url").toString()) as { access_token: string };
  const userId = (JSON.parse(Buffer.from(decoded.access_token.split(".")[1]!, "base64url").toString()) as { sub: string }).sub;
  const headers = { apikey: "e2e-publishable-key", Authorization: `Bearer ${decoded.access_token}` };

  const direct = await request.post(`${GATEWAY}/rest/v1/rpc/mark_order_paid`, {
    headers,
    data: { p_order_id: randomUUID(), p_user_id: userId, p_payment_key: "x", p_amount: 1, p_currency: "KRW", p_method: "x", p_question_limit: 99 },
  });
  expect(direct.status()).toBe(403);

  const internals = await request.get(`${GATEWAY}/rest/v1/reading_internals?select=*`, { headers });
  expect(internals.status()).toBe(403);

  // 이용권: 본인 것은 읽기만 되고, 지급·사용·반환 함수와 직접 변경은 막힌다.
  const mine = await request.get(`${GATEWAY}/rest/v1/free_tickets?select=*`, { headers });
  expect(mine.status()).toBe(200);
  expect(((await mine.json()) as { user_id: string }[]).every((row) => row.user_id === userId)).toBe(true);
  for (const [fn, data] of [
    ["grant_free_ticket", { p_user_id: userId, p_campaign_id: "free-trial-2026-11" }],
    ["restore_free_ticket", { p_ticket_id: randomUUID(), p_reason: "x" }],
    [
      "redeem_free_ticket",
      { p_user_id: userId, p_reading_id: randomUUID(), p_request_id: randomUUID(), p_campaign_id: "free-trial-2026-11", p_product_id: "first-overview", p_product_version: "1", p_question_limit: 99, p_binding: {} },
    ],
  ] as const) {
    expect((await request.post(`${GATEWAY}/rest/v1/rpc/${fn}`, { headers, data })).status(), fn).toBe(403);
  }
  const patch = await request.patch(`${GATEWAY}/rest/v1/free_tickets?user_id=eq.${userId}`, { headers, data: { status: "available", reading_id: null } });
  expect(patch.status()).toBe(403);
});

test("초안은 새로고침 후 복구되고 다른 사용자에게 보이지 않는다", async ({ page, request }) => {
  await login(page, request);
  await page.goto("/readings/new?product=first-overview");
  await page.getByLabel("별명").fill("초안이름");
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "남성" }).click();
  await page.waitForResponse((response) => response.url().includes("/api/drafts") && response.status() === 200);
  await page.waitForTimeout(700);

  await page.reload();
  await expect(page.getByRole("button", { name: "남성" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "이전" }).click();
  await expect(page.getByLabel("별명")).toHaveValue("초안이름");

  await page.goto("/my");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await page.waitForURL("**/login*");
  await login(page, request);
  await page.goto("/readings/new?product=first-overview");
  await expect(page.getByLabel("별명")).toHaveValue("");
});
