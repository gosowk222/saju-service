import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createPreview, gatewayStats, login, purchase, setControl, stubTossSdk, waitForCompletedReading, fillWizard, GATEWAY } from "./helpers";

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null });
});

test("새 사용자가 로그인부터 PDF까지 끝까지 이용한다", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /나를 읽는 시간/ })).toBeVisible();
  await page.getByRole("link", { name: "시작하기" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, request);

  await expect(page.getByRole("heading", { name: /나를 읽어 볼까요/ })).toBeVisible();
  await page.getByRole("link", { name: /묘묘의 사주 참견/ }).first().click();
  await expect(page.getByText("실제 개인 풀이가 아닌 예시예요")).toBeVisible();
  await expect(page.getByText("990원").first()).toBeVisible();
  await expect(page.getByText("3회 포함")).toBeVisible();
  await expect(page.getByText(/후기|만족도|구매 \d/)).toHaveCount(0);
  await expect(page.locator("strong", { hasText: "결론부터 들이미는 게 문제야" })).toBeVisible();
  await expect(page.getByText("입은 얄밉고, 풀이는 집요한 자칭 천재 사주꾼.")).toBeVisible();

  await page.getByRole("link", { name: "내 사주 입력하기" }).click();
  await page.waitForURL("**/readings/new*");
  await fillWizard(page, { concern: "이직이 고민이에요" });
  await expect(page.getByText("1998년 9월 19일")).toBeVisible();
  await page.getByRole("button", { name: "내 사주 보기" }).click();
  await page.waitForURL("**/preview");

  await expect(page.getByLabel("사주원국")).toBeVisible();
  await expect(page.getByRole("heading", { name: /달빛 님의 사주/ })).toBeVisible();
  await expect(page.getByText("일간은")).toBeVisible();
  const previewBody = await page.locator("body").innerText();
  expect(previewBody).not.toContain("테스트 응답");

  await purchase(page);
  await waitForCompletedReading(page);
  const bubbles = page.getByText(/\[테스트 응답\]/);
  expect(await bubbles.count()).toBeGreaterThanOrEqual(20);
  await expect(page.locator("strong", { hasText: "강조 확인 문구" }).first()).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain("**");
  await expect(page.getByText(/남은 질문 3회/)).toBeVisible();

  await page.getByRole("textbox", { name: "후속 질문" }).fill("강점을 일할 때는 어떻게 써?");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText(/강점을 일할 때는 어떻게 써\?"에 대한 답변/)).toBeVisible();
  await expect(page.locator("strong", { hasText: "두 번째 문단" })).toBeVisible();
  await expect(page.getByText(/남은 질문 2회/)).toBeVisible();

  const readingUrl = page.url();
  await page.goto("/library");
  await expect(page.getByText("완료")).toBeVisible();
  await expect(page.getByText(/달빛 님/)).toBeVisible();
  await page.getByRole("link", { name: /묘묘의 사주 참견/ }).click();
  await expect(page).toHaveURL(readingUrl);
  await expect(page.getByText("풀이 완료")).toBeVisible();
  expect(await page.getByText(/\[테스트 응답\]/).count()).toBeGreaterThanOrEqual(21);
  await expect(page.getByText("강점을 일할 때는 어떻게 써?", { exact: true })).toBeVisible();

  const statsBefore = await gatewayStats(request);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "PDF 내려받기" }).click()]);
  const path = await download.path();
  expect(readFileSync(path).subarray(0, 4).toString()).toBe("%PDF");
  await page.getByLabel("후속 질문과 답변도 포함하기").check();
  const withFollowups = await page.getByRole("link", { name: "PDF 내려받기" }).getAttribute("href");
  expect(withFollowups).toContain("followups=1");
  const pdfWithFollowups = await page.request.get(withFollowups!);
  expect(pdfWithFollowups.headers()["content-type"]).toBe("application/pdf");
  expect((await pdfWithFollowups.body()).length).toBeGreaterThan(readFileSync(path).length);

  const statsAfter = await gatewayStats(request);
  expect(statsAfter.openaiCalls).toBe(statsBefore.openaiCalls);
});

test("요청 모델은 OPENAI_MODEL 설정을 따른다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page);
  await purchase(page);
  await waitForCompletedReading(page);
  const stats = await gatewayStats(request);
  expect(stats.openaiModels.at(-1)).toBe("gpt-5.6-luna");
  const body = stats.lastOpenaiBody as Record<string, unknown>;
  expect(body).not.toHaveProperty("temperature");
});

test("풀이는 다시 열어도 저장된 내용을 쓰고 다시 생성하지 않는다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page);
  await purchase(page);
  await waitForCompletedReading(page);
  const url = page.url();
  const before = (await gatewayStats(request)).openaiCalls;
  await page.reload();
  await expect(page.getByText("풀이 완료")).toBeVisible();
  await page.goto("/home");
  await page.goto(url);
  await expect(page.getByText("풀이 완료")).toBeVisible();
  expect((await gatewayStats(request)).openaiCalls).toBe(before);
});

test("클라이언트 파일에 서버 비밀과 서버 코드가 포함되지 않는다", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = `${dir}/${name}`;
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const files = walk(".next/static").filter((file) => file.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);
  const combined = files.map((file) => readFileSync(file, "utf8")).join("\n");
  for (const marker of ["e2e_openai_key_marker", "test_gsk_e2e_secret_marker", "e2e-service-key", "OPENAI_API_KEY", "SUPABASE_SECRET_KEY", "TOSS_SECRET_KEY", "manseryeok", "responses.create", "시진 대표"]) {
    expect(combined, marker).not.toContain(marker);
  }
  void GATEWAY;
});

test("작은 입력 오류와 지역 검색 동작", async ({ page, request }) => {
  await login(page, request);
  await page.goto("/readings/new?product=first-overview");
  await page.getByLabel("별명").fill("가나다라마바사아자차카타파하");
  await expect(page.getByRole("alert").filter({ hasText: "12자" })).toBeVisible();
  await page.getByLabel("별명").fill("달빛");
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByRole("button", { name: "여성" }).click();
  await page.getByRole("button", { name: "다음" }).click();

  const date = page.getByLabel("생년월일 여섯 자리");
  await expect(date).toHaveAttribute("inputmode", "numeric");
  await date.fill("250229");
  await expect(page.locator("#date-result")).toContainText("달력에 없는");
  await expect(page.getByRole("button", { name: "다음" })).toBeDisabled();
  await date.fill("010203");
  await expect(page.locator("#date-result")).toContainText("2001년 2월 3일");

  await page.getByRole("radio", { name: "음력" }).click();
  await page.getByLabel("윤달이에요").check();
  await date.fill("240215");
  await expect(page.locator("#date-result")).toContainText("윤달이 없어요");
  await date.fill("230215");
  await expect(page.locator("#date-result")).toContainText("윤달");
  await page.getByRole("button", { name: "다음" }).click();

  const search = page.getByLabel("출생지역 검색");
  await search.fill("뉴욕");
  await expect(page.getByText(/찾는 지역이 없어요/)).toBeVisible();
  await expect(page.getByRole("button", { name: "다음" })).toBeDisabled();
  await search.fill("고성군");
  await expect(page.getByRole("button", { name: /고성군\s*강원도/ })).toBeVisible();
  await page.getByRole("button", { name: /고성군\s*경상남도/ }).click();
  await expect(page.getByText("경상남도").first()).toBeVisible();
  await expect(page.getByText("GeoNames")).toBeVisible();
  await page.getByRole("button", { name: "다음" }).click();

  // 시간대에 지역 시계 범위를 보여 주고 자시를 둘로 나눈다.
  await expect(page.getByRole("button", { name: /자시 \(새벽\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /자시 \(밤\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /시간을 몰라요/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^신시/ })).toContainText("~");
});

test.describe("긴 별명과 넓은 화면", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("데스크톱에서 600px 앱 영역을 유지한다", async ({ page, request }) => {
    await login(page, request);
    await createPreview(page, { nickname: "아주아주긴별명입니다요" });
    const box = await page.locator("main").first().boundingBox();
    expect(box?.width).toBe(600);
    expect(box?.x).toBe((1280 - 600) / 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

test("모바일에서 가로 스크롤이 생기지 않는다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page, { nickname: "아주아주긴별명입니다요", concern: "아주 긴 문장을 입력해도 화면이 깨지지 않는지 확인하기 위한 내용이에요" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await stubTossSdk(page);
});
