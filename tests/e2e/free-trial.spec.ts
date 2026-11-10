import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createPreview,
  freeTickets,
  gatewaySql,
  gatewayStats,
  injectSession,
  login,
  redeemFreeTicket,
  setControl,
  waitForCompletedReading,
} from "./helpers";

/**
 * 무료 테스트 모드(CHECKOUT_MODE 미설정 = free_trial)와 카카오 단일 로그인.
 * 로그인·결제·답변은 가짜 서버의 고정 값이다. 실제 카카오 OAuth와 실제 모델 품질을 검증하지 않는다.
 */
test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10 });
});

async function redeemApi(page: Page, readingId: string, requestId = randomUUID(), extra: Record<string, unknown> = {}) {
  const response = await page.request.post(`/api/readings/${readingId}/redeem`, { data: { requestId, ...extra } });
  return { status: response.status(), body: (await response.json()) as { outcome?: string; readingId?: string; error?: { code: string } } };
}

async function logout(page: Page) {
  await page.goto("/my");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await page.waitForURL("**/login*");
}

test.describe("지급", () => {
  test("카카오 첫 로그인에 한 장을 받고, 재로그인·새로고침·다른 기기에서도 다시 받지 않는다", async ({ browser, page, request }) => {
    const id = await login(page, request);
    expect(await freeTickets(request, id)).toMatchObject([{ status: "available" }]);
    await expect(page.getByText("무료 이용권 1장")).toBeVisible();
    await expect(page.getByRole("link", { name: "무료 이용권으로 시작하기" })).toBeVisible();

    await page.reload();
    await logout(page);
    await login(page, request, { id });
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await login(otherPage, request, { id });
    await other.close();

    const tickets = await freeTickets(request, id);
    expect(tickets).toHaveLength(1);
    const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'granted'", [id]);
    expect(n).toBe(1);
  });

  test("이메일을 주지 않은 카카오 회원도 지급받고 끝까지 이용한다", async ({ page, request }) => {
    const id = await login(page, request, { email: null });
    expect(await freeTickets(request, id)).toHaveLength(1);
    await createPreview(page);
    await redeemFreeTicket(page);
    await waitForCompletedReading(page);
  });

  test("가입 때 지급이 빠졌으면 다음 조회에서 한 장을 채운다", async ({ page, request }) => {
    const id = await login(page, request);
    // 일시적인 오류로 지급이 빠진 상황을 만든다 (테스트 준비. 앱에는 이용권을 지우는 경로가 없다).
    await gatewaySql(request, "delete from public.free_ticket_events where user_id = $1", [id]);
    await gatewaySql(request, "delete from public.free_tickets where user_id = $1", [id]);
    await page.goto("/my");
    await expect(page.getByText("무료 이용권 1장")).toBeVisible();
    expect(await freeTickets(request, id)).toHaveLength(1);
  });
});

test.describe("사용", () => {
  test("맛보기까지는 쓰지 않고, 사용하면 풀이 한 건에 연결되며 다시 열어도 추가로 쓰지 않는다", async ({ page, request }) => {
    const id = await login(page, request);
    const readingId = await createPreview(page);
    expect(await freeTickets(request, id)).toMatchObject([{ status: "available", reading_id: null }]);

    await redeemFreeTicket(page);
    expect(page.url()).toContain(`/readings/${readingId}`);
    expect((await freeTickets(request, id))[0]).toMatchObject({ reading_id: readingId });
    await waitForCompletedReading(page);
    expect((await freeTickets(request, id))[0]).toMatchObject({ status: "completed", reading_id: readingId });

    // 맛보기 주소로 다시 들어와도 본문으로 보내고, 다시 써도 같은 풀이를 돌려준다.
    await page.goto(`/readings/${readingId}/preview`);
    await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
    expect((await redeemApi(page, readingId)).body).toMatchObject({ outcome: "already_redeemed", readingId });

    await page.goto("/home");
    await expect(page.getByRole("link", { name: "내 풀이 보기" })).toHaveAttribute("href", `/readings/${readingId}`);
    await page.goto("/my");
    await expect(page.getByText("무료 이용권으로 받은 풀이가 있어요")).toBeVisible();
  });

  test("같은 요청 재전송과 여러 탭의 동시 사용에도 한 건만 쓰인다", async ({ browser, page, request }) => {
    const id = await login(page, request);
    const first = await createPreview(page, { nickname: "첫째" });
    const second = await createPreview(page, { nickname: "둘째" });
    const tab = await page.context().newPage();
    await tab.goto(`/readings/${second}/preview`);

    const sameRequest = randomUUID();
    const results = await Promise.all([
      redeemApi(page, first, sameRequest),
      redeemApi(page, first, sameRequest),
      redeemApi(tab, second),
      redeemApi(tab, second),
    ]);
    const outcomes = results.map((result) => result.body.outcome);
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(1);
    expect(outcomes.every((outcome) => ["redeemed", "already_redeemed", "ticket_used"].includes(outcome ?? ""))).toBe(true);

    const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.entitlements where user_id = $1", [id]);
    expect(n).toBe(1);
    expect(await freeTickets(request, id)).toHaveLength(1);
    void browser;
  });

  test("다 쓴 회원은 새 맛보기에서 기존 풀이와 보관함으로 안내받는다", async ({ page, request }) => {
    await login(page, request);
    const used = await createPreview(page, { nickname: "처음" });
    await redeemFreeTicket(page);
    await waitForCompletedReading(page);

    const next = await createPreview(page, { nickname: "두번째" });
    await expect(page.getByText("무료 이용권은 다른 풀이에 이미 썼어요")).toBeVisible();
    await expect(page.getByRole("link", { name: "내 풀이 보기" })).toHaveAttribute("href", `/readings/${used}`);
    await expect(page.getByRole("link", { name: "보관함" })).toBeVisible();
    await expect(page.getByRole("button", { name: /결제|이용권 1장으로/ })).toHaveCount(0);
    expect((await redeemApi(page, next)).body).toMatchObject({ outcome: "ticket_used", readingId: used });
  });

  test("다른 사람의 맛보기와 이용권은 쓸 수 없고, 무료·결제 플래그를 보내도 권한이 생기지 않는다", async ({ browser, page, request }) => {
    await login(page, request);
    const ownersReading = await createPreview(page);

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const otherId = await login(otherPage, request);
    const result = await redeemApi(otherPage, ownersReading, randomUUID(), { isFree: true, amount: 0, userId: randomUUID() });
    expect(result.status).toBe(404);
    expect(await freeTickets(request, otherId)).toMatchObject([{ status: "available" }]);

    for (const [path, data] of [
      [`/api/readings/${ownersReading}/generate`, { retry: true, isFree: true, paid: true }],
      [`/api/readings/${ownersReading}/orders`, { amount: 0, isPaid: true }],
    ] as const) {
      expect((await otherPage.request.post(path, { data })).status(), path).toBeGreaterThanOrEqual(403);
    }
    // 주인도 이용권을 쓰기 전에는 본문을 받을 수 없다.
    for (const path of ["state", "pdf"]) {
      expect((await page.request.get(`/api/readings/${ownersReading}/${path}`)).status()).toBe(403);
    }
    expect((await page.request.post(`/api/readings/${ownersReading}/generate`, { data: { retry: true, isFree: true } })).status()).toBe(403);
    await other.close();
  });
});

test.describe("생성 실패와 재시도", () => {
  test("생성이 실패해도 이용권은 그 풀이에 남고, 추가 차감 없이 다시 시도한다", async ({ page, request }) => {
    const id = await login(page, request);
    const readingId = await createPreview(page);
    await setControl(request, { openai: "error" });
    await redeemFreeTicket(page);
    await expect(page.getByText("풀이를 만들지 못했어요")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/추가로 차감되지 않아요/)).toBeVisible();
    expect((await freeTickets(request, id))[0]).toMatchObject({ status: "redeemed", reading_id: readingId });

    // 새로고침·홈·보관함에서 실패한 풀이로 돌아갈 수 있다. '이용권 0장'에 가두지 않는다.
    await page.goto("/home");
    await expect(page.getByText("다시 시도 필요")).toBeVisible();
    await page.getByRole("link", { name: "다시 시도하러 가기" }).click();
    await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));

    await setControl(request, { openai: "ok" });
    await page.getByRole("button", { name: "추가 차감 없이 다시 시도하기" }).click();
    await waitForCompletedReading(page);
    await expect(page.getByText(/남은 질문 3회/)).toBeVisible();
    expect(await freeTickets(request, id)).toMatchObject([{ status: "completed", reading_id: readingId }]);
    const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'redeemed'", [id]);
    expect(n).toBe(1);
  });

  test("서버 관리용 반환 뒤에는 닫힌 풀이 대신 새로 만들도록 안내하고, 돌려받은 이용권을 쓸 수 있다", async ({ page, request }) => {
    const id = await login(page, request);
    const readingId = await createPreview(page);
    await setControl(request, { openai: "error" });
    await redeemFreeTicket(page);
    await expect(page.getByText("풀이를 만들지 못했어요")).toBeVisible({ timeout: 30_000 });

    const [ticket] = await freeTickets(request, id);
    const [{ r }] = await gatewaySql<{ r: { outcome: string } }>(request, "select restore_free_ticket($1, '테스트: 복구 불가 실패') as r", [ticket!.id]);
    expect(r.outcome).toBe("restored");

    await setControl(request, { openai: "ok" });
    await page.goto(`/readings/${readingId}`);
    await expect(page).toHaveURL(/\/preview$/);
    await expect(page.getByText(/무료 이용권은 돌려드렸어요/)).toBeVisible();
    await page.getByRole("link", { name: "새로 만들기" }).click();
    await page.waitForURL("**/readings/new**");
    // 입력 수정은 같은 정보가 채워진 확인 단계에서 시작하고, 제출하면 새 기록을 만든다.
    await page.getByRole("button", { name: "내 사주 보기" }).click();
    await page.waitForURL((url) => url.pathname.endsWith("/preview") && !url.pathname.includes(readingId));
    await redeemFreeTicket(page);
    await waitForCompletedReading(page);
    expect(await freeTickets(request, id)).toMatchObject([{ status: "completed", restore_count: 1 }]);
  });
});

test.describe("무료 모드의 결제 차단", () => {
  async function pendingOrder(request: APIRequestContext, userId: string, readingId: string) {
    const [order] = await gatewaySql<{ id: string }>(
      request,
      "insert into public.orders (user_id, reading_id, product_id, product_version, amount, provider, binding) values ($1, $2, 'first-overview', '3.2.1', 990, 'toss', '{}') returning id",
      [userId, readingId],
    );
    return order!.id;
  }

  test("결제 API, 예전 결제 주소, 결제 완료 주소로 새 결제를 시작할 수 없다", async ({ page, request }) => {
    const sdkRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("tosspayments")) sdkRequests.push(req.url());
    });
    const id = await login(page, request);
    const readingId = await createPreview(page);
    await expect(page.getByRole("button", { name: "결제하고 풀이 받기" })).toHaveCount(0);

    const orders = await page.request.post(`/api/readings/${readingId}/orders`);
    expect(orders.status()).toBe(403);
    expect((await orders.json()).error.code).toBe("payments_disabled");

    // 결제 모드였을 때 만들어 둔 대기 주문으로 들어오는 경우
    const orderId = await pendingOrder(request, id, readingId);
    await page.goto(`/checkout/${orderId}`);
    await expect(page.getByText(/결제를 받지 않아요/)).toBeVisible();
    await expect(page.getByRole("button", { name: /원 결제하기/ })).toHaveCount(0);

    const confirmsBefore = (await gatewayStats(request)).tossConfirms;
    await page.goto(`/checkout/${orderId}/complete?paymentKey=pk_free&orderId=${orderId}&amount=990`);
    await expect(page).toHaveURL(/result=disabled/);
    await expect(page.getByText(/청구되지 않아요/)).toBeVisible();
    expect((await gatewayStats(request)).tossConfirms).toBe(confirmsBefore);
    const [order] = await gatewaySql<{ status: string; payment_key: string | null }>(request, "select status, payment_key from public.orders where id = $1", [orderId]);
    expect(order).toEqual({ status: "cancelled", payment_key: null });
    expect((await page.request.get(`/api/readings/${readingId}/state`)).status()).toBe(403);
    expect(sdkRequests).toEqual([]);

    // 이용권은 그대로라 결제 대신 이용권으로 받는다.
    await page.goto(`/readings/${readingId}/preview`);
    await redeemFreeTicket(page);
    await waitForCompletedReading(page);
  });
});

test.describe("카카오 단일 로그인", () => {
  test("로그인 시작 경로는 카카오만 허용하고 다른 제공자는 OAuth를 시작하지 않는다", async ({ page, request }) => {
    await page.goto("/login");
    const before = (await gatewayStats(request)).authorizeProviders.length;
    const origin = new URL(page.url()).origin;
    for (const provider of ["google", "email", "apple", ""]) {
      const response = await page.request.post("/auth/login", { form: { provider, next: "/library" }, headers: { Origin: origin }, maxRedirects: 0 });
      expect(response.status(), provider).toBe(303);
      expect(response.headers().location, provider).toContain("/login?error=unsupported_provider");
    }
    expect((await page.request.get("/auth/login", { maxRedirects: 0 })).status()).toBe(405);
    const kakao = await page.request.post("/auth/login", { form: { provider: "kakao", next: "/library" }, headers: { Origin: origin }, maxRedirects: 0 });
    expect(kakao.status()).toBe(303);
    expect(kakao.headers().location).toContain("/auth/v1/authorize?provider=kakao");
    // 리다이렉트를 따라가지 않았으므로 이 테스트에서 OAuth 제공자 주소에 들어간 요청은 없다.
    expect((await gatewayStats(request)).authorizeProviders.slice(before)).toEqual([]);

    await page.goto("/login?error=unsupported_provider");
    await expect(page.getByText("카카오 로그인만 지원해요")).toBeVisible();
  });

  test("OAuth 결과 계정에 카카오 연결이 없으면 콜백에서 로그인시키지 않는다", async ({ page, request }) => {
    const id = randomUUID();
    await setControl(request, { loginUser: { id, email: "old@example.com", provider: "google", providers: ["google"] }, loginError: null });
    await page.goto("/login");
    await page.getByRole("button", { name: "카카오로 시작하기" }).click();
    await page.waitForURL(/\/login\?error=kakao_required/);
    await expect(page.getByText(/카카오 계정으로 로그인한 회원만/)).toBeVisible();
    await page.goto("/library");
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(await freeTickets(request, id)).toHaveLength(0);
  });

  test("구글만 연결된 예전 세션은 지급·사용·풀이 생성·결제 경로를 쓸 수 없다", async ({ page, request }) => {
    const id = await injectSession(page, request, { providers: ["google"], email: "old@example.com" });
    await page.goto("/home");
    await expect(page.getByText("무료 이용권")).toHaveCount(0);
    expect(await freeTickets(request, id)).toHaveLength(0);

    for (const path of ["/library", "/my", "/readings/new?product=first-overview"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login\?error=kakao_required/);
    }
    await expect(page.getByText(/카카오로 다시 로그인해 주세요/)).toBeVisible();

    const randomReading = randomUUID();
    for (const [method, path, data] of [
      ["post", "/api/readings", { productId: "first-overview" }],
      ["put", "/api/drafts", { productId: "first-overview" }],
      ["post", `/api/readings/${randomReading}/redeem`, { requestId: randomUUID() }],
      ["post", `/api/readings/${randomReading}/generate`, { retry: true }],
      ["post", `/api/readings/${randomReading}/orders`, {}],
      ["get", "/api/places/search?q=서울", undefined],
    ] as const) {
      const response = await page.request.fetch(path, { method, data });
      expect(response.status(), path).toBe(403);
      expect((await response.json()).error.code, path).toBe("kakao_login_required");
    }
    expect(await freeTickets(request, id)).toHaveLength(0);

    // 같은 브라우저에서 카카오로 다시 로그인하면 정상 회원으로 이용한다.
    const kakaoId = await login(page, request);
    expect(await freeTickets(request, kakaoId)).toHaveLength(1);
  });

  test("이번 실행에서 앱이 시작한 OAuth는 모두 카카오다", async ({ page, request }) => {
    await login(page, request);
    const providers = new Set((await gatewayStats(request)).authorizeProviders);
    expect([...providers]).toEqual(["kakao"]);
  });

  test("처음 구글로 가입했어도 카카오가 연결된 회원은 그대로 이용하고, 다시 로그인해도 기록이 유지된다", async ({ page, request }) => {
    const id = await login(page, request, { providers: ["google", "kakao"] });
    expect(await freeTickets(request, id)).toHaveLength(1);
    const readingId = await createPreview(page);
    await redeemFreeTicket(page);
    await waitForCompletedReading(page);

    await logout(page);
    await login(page, request, { id, providers: ["google", "kakao"] });
    await page.goto("/library");
    await page.getByRole("link", { name: /묘묘의 사주 참견/ }).click();
    await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
    await expect(page.getByText("풀이 완료")).toBeVisible();
    await page.goto("/my");
    await expect(page.getByText("카카오 계정")).toBeVisible();
    await expect(page.getByText(/Google|구글|계정 연결/)).toHaveCount(0);
  });
});
