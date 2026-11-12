import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  MUJIN_CONTROL_RESET,
  MUJIN_FREE_SECTIONS,
  MUJIN_PAID_SECTIONS,
  MUJIN_TOC,
  callsSince,
  createMujinReading,
  createMujinReadingApi,
  createPreview,
  freeTickets,
  gatewaySql,
  gatewayStats,
  login,
  mujinScene,
  mujinSection,
  mujinSectionOrder,
  setControl,
  waitForMujinComplete,
  waitForMujinFree,
} from "./helpers";

/**
 * 무진의 종합 사주(족자 상품) 브라우저 테스트. 무료 테스트 모드 앱(포트 3100)에서 돈다. 결제 모드는 mujin-payment-mode.spec.ts.
 * 로그인·이용권·모델 답변은 가짜 서버(tests/support/fake-gateway.ts)의 고정 값이다.
 * 실제 카카오 OAuth, 실제 결제, 실제 모델의 문장 품질을 검증하지 않는다 (가짜 서버 통과일 뿐이다).
 */

const CONCERN = "취업 준비 중인데 프리랜서가 나을까요? 돈 관리도 같이 봐 주세요.";
const CLOSED = "지금은 운영자가 허용한 계정만 풀이를 이용할 수 있어요.";
const REDEEM = "무료 이용권 1장으로 풀이받기";
const PAID_CHAPTERS = MUJIN_PAID_SECTIONS.filter((id) => id !== "closing");

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10, ...MUJIN_CONTROL_RESET });
});

test.afterEach(async ({ request }) => {
  // 다른 테스트 파일은 무진 조절 값을 모르고, '모든 회원' 이용 상태를 기준으로 한다.
  await setControl(request, MUJIN_CONTROL_RESET);
  await setOpenToAll(request, true);
});

async function setOpenToAll(request: APIRequestContext, open: boolean) {
  await gatewaySql(request, "update public.app_settings set value = $1::jsonb where key = 'readings_open_to_all'", [JSON.stringify(open)]);
}

async function redeemApi(page: Page, readingId: string, requestId = randomUUID()) {
  const response = await page.request.post(`/api/readings/${readingId}/redeem`, { data: { requestId } });
  return { status: response.status(), body: (await response.json()) as { outcome?: string; readingId?: string; error?: { code: string } } };
}

/** 장별 호출 수 차이 가운데 ids에 든 장만 본다 (다른 테스트가 남긴 호출과 섞이지 않게). */
function only(counts: Record<string, number>, ids: readonly string[]): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([key]) => ids.includes(key)));
}

const each = <T,>(ids: readonly string[], value: T): Record<string, T> => Object.fromEntries(ids.map((id) => [id, value]));

/** 그 영역 안에서 실제로 그려진 글자. 화면 읽기용으로 1px로 숨긴 글자(sr-only)는 빼고 센다. */
async function paintedTexts(box: Locator): Promise<string[]> {
  return box.evaluate((root) => {
    const hidden = (start: Element | null) => {
      for (let element = start; element && element !== root.parentElement; element = element.parentElement) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 1 || rect.height <= 1 || style.visibility === "hidden" || style.display === "none") return true;
      }
      return false;
    };
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text && !hidden(node.parentElement)) found.push(text);
    }
    return found;
  });
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/** 이 영역이 화면 폭과 앱 영역(최대 600px) 안에 있는지. */
async function expectInsideApp(page: Page, box: Locator, label: string) {
  const viewport = page.viewportSize()!;
  const rect = (await box.boundingBox())!;
  expect(rect.x, label).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, label).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(rect.width, label).toBeLessThanOrEqual(600.5);
}

/** 완성된 족자의 배치: 가로 스크롤 없음, 족자·표가 앱 영역 안, 목차 시트가 화면 안에 들어오고 고른 칸으로 이동. */
async function expectScrollLayout(page: Page, label: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoHorizontalScroll(page, label);
  const article = page.getByRole("article");
  await expectInsideApp(page, article, `${label} 족자`);
  // 넓은 표는 자기 영역 안에서만 가로로 밀린다 (페이지 전체가 넓어지지 않는다).
  for (const region of await article.getByRole("region").all()) {
    const rect = (await region.boundingBox())!;
    const frame = (await article.boundingBox())!;
    expect(rect.x, `${label} 표 영역`).toBeGreaterThanOrEqual(frame.x - 0.5);
    expect(rect.x + rect.width, `${label} 표 영역`).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  }

  await page.getByRole("button", { name: "목차", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "목차" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link")).toHaveCount(MUJIN_TOC.length);
  // 시트가 열리는 움직임(최대 300ms)이 끝난 뒤 크기를 잰다.
  await page.waitForTimeout(400);
  const viewport = page.viewportSize()!;
  const rect = (await sheet.boundingBox())!;
  expect(rect.x, `${label} 목차`).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, `${label} 목차`).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(rect.width, `${label} 목차`).toBeLessThanOrEqual(600.5);
  expect(rect.y, `${label} 목차`).toBeGreaterThanOrEqual(-0.5);
  expect(rect.y + rect.height, `${label} 목차`).toBeLessThanOrEqual(viewport.height + 0.5);
  await sheet.getByRole("link", { name: /마지막 정리/ }).click();
  await expect(sheet).toBeHidden();
  await expect(mujinSection(page, "closing").getByRole("heading", { level: 2, name: "마지막 정리" })).toBeInViewport();
  await expectNoHorizontalScroll(page, `${label} 이동 뒤`);
}

test("상품 목록·상세: 무진 포스터와 배너는 그림 그대로 보이고, 그림 위에 화면 글자를 겹치지 않으며 읽기용 제목이 있다", async ({ page }) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/products");
    const card = page.getByRole("link", { name: /무진의 종합 사주/ });
    await expect(card).toBeVisible();
    const poster = card.locator("div").first();
    // 그림 속에 상품 이름과 문구가 있으므로 그 위에는 화면 읽기용 제목만 둔다.
    await expect(poster.getByRole("heading", { name: "무진의 종합 사주" })).toBeAttached();
    expect(await paintedTexts(poster), `포스터 ${width}px`).toEqual([]);
    await expect(poster.locator("img")).toHaveAttribute("alt", /무진/);
    // 묘묘 포스터는 그대로 그림 위에 부설명과 제목을 쓴다.
    const myomyoPoster = page.getByRole("link", { name: /묘묘의 사주 참견/ }).locator("div").first();
    expect((await paintedTexts(myomyoPoster)).join(" "), `묘묘 포스터 ${width}px`).toContain("묘묘의 사주 참견");

    await page.goto("/products/mujin-overview");
    const title = page.getByRole("heading", { level: 1, name: "무진의 종합 사주" });
    await expect(title).toBeAttached();
    const hero = title.locator("xpath=..");
    expect(await paintedTexts(hero), `배너 ${width}px`).toEqual([]);
    const banner = hero.locator("img");
    await expect(banner).toHaveAttribute("alt", /무진/);
    await expect.poll(() => banner.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // 배너는 그림 속 글자가 잘리지 않게 원본 비율(1672×941) 그대로, 화면 폭에 맞춰 보인다.
    const drawn = await banner.evaluate((img) => {
      const rect = img.getBoundingClientRect();
      return { ratio: rect.width / rect.height, fit: getComputedStyle(img).objectFit };
    });
    expect(Math.abs(drawn.ratio - 1672 / 941) / (1672 / 941), `배너 비율 ${width}px`).toBeLessThan(0.01);
    expect(drawn.fit).not.toBe("cover");
    await expectInsideApp(page, hero, `배너 ${width}px`);
    await expectNoHorizontalScroll(page, `상세 ${width}px`);

    await expect(page.getByRole("heading", { name: "무료로 바로 보는 부분" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "이어서 받는 부분" })).toBeVisible();
    await expect(page.getByText("990원 (출시 전 임시 가격)")).toBeVisible();
    await expect(page.getByText(/결제 없이 무료 이용권 1장으로 받을 수 있어요/)).toBeVisible();
    await expect(page.getByRole("link", { name: "내 사주 입력하기" })).toHaveAttribute("href", "/readings/new?product=mujin-overview");
  }

  // 묘묘 상세는 그대로: 16:10 배너 위에 제목과 부설명이 보인다 (자세한 배치는 visual.spec.ts가 본다).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/products/first-overview");
  const myomyoTitle = page.getByRole("heading", { level: 1, name: "묘묘의 사주 참견" });
  await expect(myomyoTitle).toBeVisible();
  const myomyoHero = myomyoTitle.locator("xpath=../..");
  await expect(myomyoHero.getByText("칭찬만 들을 줄 알았어? 성향부터 행운까지, 다 짚어줄게.")).toBeVisible();
  const ratio = await myomyoHero.evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
  expect(Math.abs(ratio - 1.6)).toBeLessThan(0.02);
});

test("대화형 입력은 한 단계씩 진행하고, 제출하면 무료 부분(원국표·기초 분석·1장)만 쓰며 유료 장은 잠근다", async ({ page, request }) => {
  test.setTimeout(150_000);
  const userId = await login(page, request);
  await page.goto("/readings/new?product=mujin-overview");
  const step = (name: string) => page.getByRole("heading", { level: 1, name, exact: true });
  const next = page.getByRole("button", { name: "다음", exact: true });

  // 1 별명. 한글 조합을 끝내는 Enter(isComposing)는 다음 단계로 넘기지 않고, 조합이 끝난 뒤의 Enter는 넘긴다.
  // 두 키 입력을 같은 방법(dispatchEvent)으로 보내 조합 여부만 다르게 한다.
  await expect(step("별명")).toBeVisible();
  await expect(page.getByText("1 / 7", { exact: true })).toBeVisible();
  const nickname = page.getByLabel("별명");
  await nickname.fill("달빛");
  await nickname.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  await page.waitForTimeout(300);
  await expect(step("별명")).toBeVisible();
  await nickname.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: false });

  // 2 성별
  await expect(step("성별")).toBeVisible();
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "여성", exact: true }).click();
  await next.click();

  // 3 생년월일
  await expect(step("생년월일")).toBeVisible();
  await page.getByLabel("생년월일 여섯 자리").fill("980919");
  await expect(page.locator("#date-result")).toContainText("1998년 9월 19일");
  await next.click();

  // 4 출생지역. 시진의 실제 시계 범위가 지역으로 정해지므로 출생시각보다 먼저 받는다.
  await expect(step("출생지역")).toBeVisible();
  await page.getByLabel("출생지역 검색").fill("서울");
  await page.getByRole("button", { name: /서울특별시/ }).first().click();
  await next.click();

  // 5 출생시각: 고른 지역의 시계 범위를 보여 주고, 자시는 새벽과 밤으로 나눈다.
  await expect(step("출생시각")).toBeVisible();
  await expect(page.getByRole("button", { name: /^자시 \(새벽\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^자시 \(밤\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^시간을 몰라요/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^신시/ })).toContainText("~");
  await page.getByRole("button", { name: /^신시/ }).click();
  await next.click();

  // 6 지금의 나. 고르지 않으면 건너뛸 수 있다.
  await expect(step("지금의 나")).toBeVisible();
  await expect(page.getByRole("button", { name: "건너뛰기", exact: true })).toBeVisible();
  const work = (label: string) => page.getByRole("button", { name: label, exact: true });
  await work("취업 준비 중").click();
  await work("프리랜서로 활동 중").click();
  // 일·학업은 2개까지: 세 번째는 흐리게 막히고 눌러도 고르지 않으며 이유를 알린다.
  await expect(work("직장에 다니는 중")).toHaveAttribute("aria-disabled", "true");
  await work("직장에 다니는 중").click({ force: true });
  await expect(work("직장에 다니는 중")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#now-work-limit")).toContainText("2개까지");
  const chapter = (title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });
  await chapter("직업과 사회생활").click();
  await chapter("재물과 돈 관리").click();
  await expect(chapter("연애와 결혼")).toHaveAttribute("aria-disabled", "true");
  // 연애·결혼 상태는 펼쳐서 하나만 고른다.
  await page.locator("summary", { hasText: "지금의 연애·결혼 상태" }).click();
  const relationship = page.getByRole("group", { name: "지금의 연애·결혼 상태" });
  await relationship.getByRole("button", { name: "현재 연애하지 않음", exact: true }).click();
  await relationship.getByRole("button", { name: "연애 중", exact: true }).click();
  await expect(relationship.getByRole("button", { name: "현재 연애하지 않음", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(relationship.getByRole("button", { name: "연애 중", exact: true })).toHaveAttribute("aria-pressed", "true");
  // 가족 이야기: 앞 다섯 항목은 2개까지, '답하고 싶지 않음'은 다른 항목과 함께 고를 수 없다.
  await page.locator("summary", { hasText: "가족 이야기에서 다루고 싶은 부분이 있나요?" }).click();
  const family = page.getByRole("group", { name: "가족 이야기에서 다루고 싶은 부분" });
  const familyOption = (label: string) => family.getByRole("button", { name: label, exact: true });
  await familyOption("가족의 기대와 내 선택").click();
  await familyOption("돌봄과 역할 분담").click();
  await expect(familyOption("독립이나 생활 변화")).toHaveAttribute("aria-disabled", "true");
  await familyOption("답하고 싶지 않음").click();
  await expect(familyOption("답하고 싶지 않음")).toHaveAttribute("aria-pressed", "true");
  for (const label of ["가족의 기대와 내 선택", "돌봄과 역할 분담"]) await expect(familyOption(label)).toHaveAttribute("aria-pressed", "false");
  await familyOption("독립이나 생활 변화").click();
  await expect(familyOption("답하고 싶지 않음")).toHaveAttribute("aria-pressed", "false");
  await expect(familyOption("독립이나 생활 변화")).toHaveAttribute("aria-pressed", "true");
  await next.click();

  // 7 진짜 궁금한 점
  await expect(step("진짜 궁금한 점")).toBeVisible();
  await page.getByLabel("진짜 궁금한 점").fill(CONCERN);
  await next.click();

  // 8 입력 확인: 변환된 날짜, 시진의 시계 범위, 지금의 나. 항목을 고치면 확인 화면으로 바로 돌아온다.
  await expect(step("입력 확인")).toBeVisible();
  const review = page.locator("section").filter({ has: page.getByRole("button", { name: "별명 수정" }) });
  for (const text of ["달빛", "여성", "1998년 9월 19일", "서울", "신시 (", "취업 준비 중, 프리랜서로 활동 중", "직업과 사회생활, 재물과 돈 관리", "연애 중", "독립이나 생활 변화", CONCERN]) {
    await expect(review, text).toContainText(text);
  }
  await page.getByRole("button", { name: "별명 수정" }).click();
  await expect(step("별명")).toBeVisible();
  await page.getByLabel("별명").fill("새벽");
  await page.getByRole("button", { name: "확인 화면으로" }).click();
  await expect(step("입력 확인")).toBeVisible();
  await expect(review).toContainText("새벽");

  const before = (await gatewayStats(request)).mujin;
  await page.getByRole("button", { name: "이 내용으로 풀이 받기" }).click();
  await page.waitForURL(/\/readings\/[0-9a-f-]+$/);
  const readingId = page.url().split("/readings/")[1]!;
  await waitForMujinFree(page);

  // 무료 부분: 원국표, 기초 분석 4개, 1장이 완성되어 보인다. 화면에는 Pass 2 최종문만 보이고 평문 초안은 보이지 않는다.
  await expect(page.getByRole("heading", { level: 1, name: "새벽 님의 사주" })).toBeVisible();
  await expect(mujinSection(page, "chart").getByLabel("사주원국")).toBeVisible();
  for (const id of MUJIN_FREE_SECTIONS) await expect(mujinSection(page, id).getByText(`${id} 장의 핵심 답이에요`)).toBeVisible();
  await expect(mujinSection(page, "ch1").locator("strong", { hasText: "강조 확인 문구" })).toBeVisible();
  const main = await page.getByRole("main").innerText();
  expect(main).not.toContain("초안");
  expect(main).not.toContain("**");

  // 유료 장은 잠금: 제목·설명·질문 목록만 보이고 작성 중처럼 보이지 않는다.
  for (const id of MUJIN_PAID_SECTIONS) {
    const section = mujinSection(page, id);
    await expect(section.getByText("잠김", { exact: true })).toBeVisible();
    await expect(section.getByText("이용권이나 결제 뒤에 쓰는 장이에요")).toBeVisible();
    await expect(section.getByText("핵심 답", { exact: true })).toHaveCount(0);
    await expect(section.locator('[aria-busy="true"]')).toHaveCount(0);
  }
  await expect(page.getByRole("link", { name: "받는 방법 보기" })).toBeVisible();
  await expect(page.getByRole("button", { name: REDEEM })).toBeVisible();

  // 페이지 HTML과 상태 API 어디에도 유료 장 본문이 없다 (무료 장 본문은 있다).
  const html = await (await page.request.get(`/readings/${readingId}`)).text();
  const scroll = await page.request.get(`/api/readings/${readingId}/scroll`);
  expect(scroll.status()).toBe(200);
  const { state } = (await scroll.json()) as {
    state: { timing: unknown; sections: { id: string; tier: string; state: string; content: { blocks: { refs: string[] }[] } | null }[] };
  };
  const serialized = JSON.stringify(state);
  expect(html).toContain("ch1 장의 핵심 답이에요");
  expect(serialized).toContain("ch1 장의 핵심 답이에요");
  for (const id of MUJIN_PAID_SECTIONS) {
    expect(html).not.toContain(`${id} 장의 핵심 답`);
    expect(serialized).not.toContain(`${id} 장의 핵심 답`);
  }
  expect(state.sections.filter((section) => section.tier === "paid").every((section) => section.state === "locked" && section.content === null)).toBe(true);
  expect(state.timing).toBeNull();
  // 화면에 보내는 블록에는 작성용 참조(ref)가 없다.
  expect(state.sections.flatMap((section) => section.content?.blocks ?? []).every((block) => block.refs.length === 0)).toBe(true);

  // 가짜 서버: 무료 장만 Pass 1·Pass 2를 불렀고 유료 장은 0번이다. 질문은 유료 장(3·4장)에 이어지므로 무료 Pass 1 입력에 넣지 않았다.
  const after = (await gatewayStats(request)).mujin;
  expect(only(callsSince(after.sections.pass1, before.sections.pass1), MUJIN_PAID_SECTIONS)).toEqual({});
  expect(only(callsSince(after.sections.pass2, before.sections.pass2), MUJIN_PAID_SECTIONS)).toEqual({});
  expect(Object.keys(callsSince(after.sections.pass1, before.sections.pass1)).sort()).toEqual([...MUJIN_FREE_SECTIONS].sort());
  expect(after.calls.question - before.calls.question).toBe(1);
  expect(after.last.question?.domains).toEqual(["career", "wealth"]);
  expect(after.last.pass1).toMatchObject({ tiers: ["free"], questionRefs: [] });
  // 앱의 호출 기록에도 유료 단계 호출이 없다.
  const calls = await gatewaySql<{ tier: string; step: string; n: number }>(
    request,
    "select tier, step, count(*)::int as n from public.llm_calls where reading_id = $1 group by tier, step order by tier, step",
    [readingId],
  );
  expect(calls).toEqual([
    { tier: "free", step: "classify", n: 1 },
    { tier: "free", step: "pass1", n: 2 },
    { tier: "free", step: "pass2", n: 5 },
  ]);
  expect(await freeTickets(request, userId)).toMatchObject([{ status: "available", reading_id: null }]);

  // 보관함: 무료 부분만 받은 무진 풀이도 보이고, 족자 화면으로 열린다. 다시 열면 생성하지 않는다.
  await page.goto("/library");
  const item = page.getByRole("link", { name: /무진의 종합 사주/ });
  await expect(item).toContainText("무료 부분");
  await expect(item).toContainText("새벽 님");
  const openaiCalls = (await gatewayStats(request)).openaiCalls;
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
  await expect(page.getByRole("heading", { level: 1, name: "새벽 님의 사주" })).toBeVisible();
  await expect(mujinSection(page, "ch1").getByText("ch1 장의 핵심 답이에요")).toBeVisible();
  await expect(mujinScene(page).getByText("무료 부분 완료", { exact: true })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect((await gatewayStats(request)).openaiCalls).toBe(openaiCalls);
});

test("이용권을 쓰면 같은 화면에서 유료 장이 목차 순서를 지키며 채워지고, 끝나면 후속 질문과 PDF가 열리며 다시 열어도 다시 만들지 않는다", async ({ browser, page, request }) => {
  test.setTimeout(240_000);
  const userId = await login(page, request);
  const readingId = await createMujinReading(page, { nickname: "가람", concern: CONCERN, work: ["취업 준비 중"], interests: ["직업과 사회생활"] });
  await waitForMujinFree(page);

  // 2장의 Pass 2만 늦춘다. 뒤 장이 먼저 끝나도 목차 순서는 그대로이고, Pass 1은 Pass 2를 기다리지 않는다.
  await setControl(request, { mujinVoiceDelayMs: 10_000, mujinVoiceDelaySections: ["ch2"] });
  const before = (await gatewayStats(request)).mujin;
  await page.getByRole("button", { name: REDEEM }).click();
  await expect(mujinSection(page, "ch10").getByText("핵심 답", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
  await expect(mujinSection(page, "ch2").getByText("작성 중", { exact: true })).toBeVisible();
  await expect(mujinSection(page, "ch2").getByText("핵심 답", { exact: true })).toHaveCount(0);
  expect(await mujinSectionOrder(page)).toEqual(MUJIN_TOC);
  // 2장의 Pass 2가 끝나기 전에 다른 모든 유료 장의 초안과 최종문이 저장되었다 (스트림 수신이 Pass 2를 기다리지 않았다).
  const unitStatus = async () =>
    Object.fromEntries(
      (
        await gatewaySql<{ unit_id: string; status: string }>(request, "select unit_id, status from public.reading_units where reading_id = $1 and tier = 'paid'", [readingId])
      ).map((unit) => [unit.unit_id, unit.status]),
    );
  await expect.poll(unitStatus, { timeout: 6_000 }).toEqual({ ...each(MUJIN_PAID_SECTIONS, "done"), ch2: "drafted" });

  await waitForMujinComplete(page);
  expect(await mujinSectionOrder(page)).toEqual(MUJIN_TOC);
  for (const label of ["잠김", "대기", "작성 중", "오류"]) await expect(page.getByRole("article").getByText(label, { exact: true })).toHaveCount(0);
  const after = (await gatewayStats(request)).mujin;
  expect(only(callsSince(after.sections.pass1, before.sections.pass1), MUJIN_PAID_SECTIONS)).toEqual(each(MUJIN_PAID_SECTIONS, 1));
  expect(only(callsSince(after.sections.pass2, before.sections.pass2), MUJIN_PAID_SECTIONS)).toEqual(each(MUJIN_PAID_SECTIONS, 1));
  // 질문 정리는 무료 단계에서 한 번만 했다. 유료 단계는 저장된 분석을 쓴다.
  expect(after.calls.question).toBe(before.calls.question);
  expect(after.last.timing).toMatchObject({ luckStatus: "available", months: 12 });

  // 9장 대운(직전·현재·다음)과 10장 12개월은 실제 계산 표로 그린다.
  const ch9 = mujinSection(page, "ch9");
  await expect(ch9.getByRole("region", { name: "직전·현재·다음 대운" })).toBeVisible();
  await expect(ch9.getByText(/현재 대운은 기준일 \d{4}년 \d{1,2}월 \d{1,2}일로 골랐어요/)).toBeVisible();
  await expect(mujinSection(page, "ch10").getByRole("region", { name: "앞으로 12개월 분야별 표지" })).toBeVisible();
  expect(await page.getByRole("main").innerText()).not.toContain("초안");
  expect(await freeTickets(request, userId)).toMatchObject([{ status: "completed", reading_id: readingId }]);
  const [job] = await gatewaySql<{ status: string; reference_date: string | null }>(request, "select status, reference_date::text from public.generation_jobs where reading_id = $1", [readingId]);
  expect(job).toMatchObject({ status: "completed" });
  expect(job?.reference_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // 후속 질문: 기존 횟수·차감 정책 (3회, 정상 답변만 한 번 차감).
  await expect(page.getByText(/남은 질문 3회/)).toBeVisible();
  const question = "제 성향을 일할 때 어떻게 쓰면 좋을까요?";
  await page.getByRole("textbox", { name: "후속 질문" }).fill(question);
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.getByText(`"${question}"에 대한 답변이에요`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("strong", { hasText: "두 번째 문단" })).toBeVisible();
  await expect(page.getByText(/남은 질문 2회/)).toBeVisible();

  // PDF: 최종문과 실제 표로 만든 파일. 후속 질문을 넣으면 더 커진다.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "PDF 내려받기" }).click()]);
  expect(download.suggestedFilename()).toBe("무진의 종합 사주.pdf");
  const pdf = readFileSync((await download.path())!);
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  await page.getByLabel("후속 질문과 답변도 포함하기").check();
  await expect(page.getByRole("link", { name: "PDF 내려받기" })).toHaveAttribute("href", `/api/readings/${readingId}/pdf?followups=1`);
  const withFollowups = await page.request.get(`/api/readings/${readingId}/pdf?followups=1`);
  expect(withFollowups.headers()["content-type"]).toBe("application/pdf");
  expect((await withFollowups.body()).length).toBeGreaterThan(pdf.length);

  // 다시 열면(새로고침, 보관함) 저장된 결과를 쓰고 생성·차감을 다시 하지 않는다.
  const openaiCalls = (await gatewayStats(request)).openaiCalls;
  await page.reload();
  await waitForMujinComplete(page);
  await page.goto("/library");
  await page.getByRole("link", { name: /무진의 종합 사주/ }).click();
  await expect(page).toHaveURL(new RegExp(`/readings/${readingId}$`));
  await waitForMujinComplete(page);
  await page.waitForTimeout(1_500);
  expect((await gatewayStats(request)).openaiCalls).toBe(openaiCalls);
  expect(await freeTickets(request, userId)).toHaveLength(1);

  // 다른 회원은 이 풀이의 화면·상태·생성·PDF·후속 질문에 접근할 수 없다.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await login(otherPage, request);
  await otherPage.goto(`/readings/${readingId}`);
  await expect(otherPage.getByText("찾을 수 없는 화면이에요")).toBeVisible();
  expect(await otherPage.locator("body").innerText()).not.toContain("가람");
  expect((await otherPage.request.get(`/api/readings/${readingId}/scroll`)).status()).toBe(404);
  for (const tier of ["free", "paid"]) {
    expect((await otherPage.request.post(`/api/readings/${readingId}/scroll/generate`, { data: { tier, retry: true } })).status(), tier).toBe(404);
  }
  for (const path of ["pdf", "pdf?followups=1", "state"]) expect((await otherPage.request.get(`/api/readings/${readingId}/${path}`)).status(), path).toBe(403);
  const otherFollowup = await otherPage.request.post(`/api/readings/${readingId}/followups`, { data: { clientRequestId: randomUUID(), question: "다른 사람 풀이도 볼 수 있어요?" } });
  expect(otherFollowup.status()).toBe(403);
  await otherPage.goto("/library");
  await expect(otherPage.getByText("아직 받은 풀이가 없어요")).toBeVisible();
  await other.close();
  expect((await gatewayStats(request)).openaiCalls).toBe(openaiCalls);

  // 모바일(390×844)과 데스크톱에서 족자·표·목차 시트가 화면 안에 들어온다.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectScrollLayout(page, "모바일 390px");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectScrollLayout(page, "데스크톱 1280px");
});

test("유료 장 하나가 실패하면 그 장만 오류와 다시 시도를 보여 주고, 다시 시도하면 그 장(과 마지막 정리)만 쓴다", async ({ page, request }) => {
  test.setTimeout(180_000);
  const userId = await login(page, request);
  const readingId = await createMujinReadingApi(page, { nickname: "다시" });
  await page.goto(`/readings/${readingId}`);
  await waitForMujinFree(page);

  // 3장 초안을 두 번(한 요청 안의 처음 시도와 재요청) 검사에 걸리게 한다.
  await setControl(request, { mujinFail: { section: "ch3", pass: "pass1", times: 2 } });
  const before = (await gatewayStats(request)).mujin;
  await page.getByRole("button", { name: REDEEM }).click();
  const ch3 = mujinSection(page, "ch3");
  await expect(ch3.getByText("오류", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(ch3.getByRole("button", { name: "다시 시도하기" })).toBeVisible();
  await expect(ch3.getByText(/다시 시도하면 마치지 못한 장만 다시 쓰고/)).toBeVisible();
  // 다른 장은 완성되어 보인다. 마지막 정리는 3장 초안이 없어 아직 쓰지 않는다. 후속 질문과 PDF는 아직 열지 않는다.
  for (const id of PAID_CHAPTERS.filter((id) => id !== "ch3")) await expect(mujinSection(page, id).getByText("핵심 답", { exact: true }), id).toBeVisible();
  await expect(mujinSection(page, "closing").getByText("대기", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "무진 도사에게 더 묻기" })).toHaveCount(0);
  await expect(mujinScene(page).getByText("다시 시도 필요", { exact: true })).toBeVisible();
  const failed = (await gatewayStats(request)).mujin;
  expect(only(callsSince(failed.sections.pass1, before.sections.pass1), MUJIN_PAID_SECTIONS)).toEqual({ ...each(PAID_CHAPTERS, 1), ch3: 2 });
  expect(only(callsSince(failed.sections.pass2, before.sections.pass2), MUJIN_PAID_SECTIONS)).toEqual(each(PAID_CHAPTERS.filter((id) => id !== "ch3"), 1));
  const [unit] = await gatewaySql<{ status: string; error_stage: string; draft_attempts: number }>(
    request,
    "select status, error_stage, draft_attempts from public.reading_units where reading_id = $1 and unit_id = 'ch3'",
    [readingId],
  );
  expect(unit).toEqual({ status: "failed", error_stage: "draft", draft_attempts: 1 });

  // 다시 시도: 3장과 (3장 초안이 생겨 쓸 수 있게 된) 마지막 정리만 쓰고, 다른 장은 다시 부르지 않는다. 이용권은 추가로 쓰지 않는다.
  await ch3.getByRole("button", { name: "다시 시도하기" }).click();
  await waitForMujinComplete(page);
  const after = (await gatewayStats(request)).mujin;
  expect(only(callsSince(after.sections.pass1, failed.sections.pass1), MUJIN_PAID_SECTIONS)).toEqual({ ch3: 1, closing: 1 });
  expect(only(callsSince(after.sections.pass2, failed.sections.pass2), MUJIN_PAID_SECTIONS)).toEqual({ ch3: 1, closing: 1 });
  await expect(ch3.getByText("ch3 장의 핵심 답이에요")).toBeVisible();
  expect(await freeTickets(request, userId)).toMatchObject([{ status: "completed", reading_id: readingId }]);
  const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.free_ticket_events where user_id = $1 and kind = 'redeemed'", [userId]);
  expect(n).toBe(1);
});

test("무료 1장의 Pass 2가 실패하면 그 장만 오류로 두고, 다시 시도하면 저장된 초안으로 Pass 2만 다시 한다", async ({ page, request }) => {
  test.setTimeout(120_000);
  await login(page, request);
  const readingId = await createMujinReadingApi(page, { nickname: "초안보존" });
  await setControl(request, { mujinFail: { section: "ch1", pass: "pass2", times: 2 } });
  const before = (await gatewayStats(request)).mujin;
  await page.goto(`/readings/${readingId}`);
  const ch1 = mujinSection(page, "ch1");
  await expect(ch1.getByText("오류", { exact: true })).toBeVisible({ timeout: 60_000 });
  // 무료 단계가 멈췄으므로 족자가 펼쳐져 있고, 완성된 기초 분석은 그대로 읽을 수 있다.
  for (const id of MUJIN_FREE_SECTIONS.filter((id) => id !== "ch1")) await expect(mujinSection(page, id).getByText("핵심 답", { exact: true }), id).toBeVisible();
  const failed = (await gatewayStats(request)).mujin;
  expect(only(callsSince(failed.sections.pass1, before.sections.pass1), MUJIN_FREE_SECTIONS)).toEqual(each(MUJIN_FREE_SECTIONS, 1));
  expect(only(callsSince(failed.sections.pass2, before.sections.pass2), ["ch1"])).toEqual({ ch1: 2 });
  const [unit] = await gatewaySql<{ status: string; error_stage: string }>(request, "select status, error_stage from public.reading_units where reading_id = $1 and unit_id = 'ch1'", [readingId]);
  expect(unit).toEqual({ status: "failed", error_stage: "voice" });

  await ch1.getByRole("button", { name: "다시 시도하기" }).click();
  await expect(ch1.getByText("ch1 장의 핵심 답이에요")).toBeVisible({ timeout: 30_000 });
  await expect(mujinScene(page).getByText("무료 부분 완료", { exact: true })).toBeVisible();
  const after = (await gatewayStats(request)).mujin;
  expect(only(callsSince(after.sections.pass1, failed.sections.pass1), MUJIN_FREE_SECTIONS)).toEqual({});
  expect(only(callsSince(after.sections.pass2, failed.sections.pass2), MUJIN_FREE_SECTIONS)).toEqual({ ch1: 1 });
});

test("태어난 시간을 모르면 9장은 대운을 계산하지 않았다고 쓰고, 임의 구간 없이 완성된다", async ({ page, request }) => {
  test.setTimeout(180_000);
  await login(page, request);
  const readingId = await createMujinReading(page, { nickname: "시간모름", time: null });
  await waitForMujinFree(page);
  await expect(page.getByRole("article").getByText(/시간 모름/)).toBeVisible();
  // 시주를 계산하지 않았다 (원국표의 시주 칸은 비어 있다).
  expect((await gatewaySql<{ hour: boolean }>(request, "select (plan->>'hourKnown')::boolean as hour from public.reading_internals where reading_id = $1", [readingId]))[0]?.hour).toBe(false);
  await page.getByRole("button", { name: REDEEM }).click();
  await waitForMujinComplete(page);

  const ch9 = mujinSection(page, "ch9");
  await expect(ch9.getByText("태어난 시간을 몰라 대운을 계산하지 않았어요", { exact: false })).toBeVisible();
  await expect(ch9.getByRole("region", { name: "직전·현재·다음 대운" })).toHaveCount(0);
  await expect(ch9.getByText("ch9 장의 핵심 답이에요")).toBeVisible();
  // 생성 입력의 기간 자료에도 대운 구간이 없고 이유만 있다.
  expect((await gatewayStats(request)).mujin.last.timing).toMatchObject({ luckStatus: "unavailable", luckReason: "태어난 시각을 몰라 대운을 계산하지 않았다." });
  const [bundle] = await gatewaySql<{ luck: { status: string; reason: string; current: unknown; previous: unknown; next: unknown } }>(
    request,
    "select payload->'luck' as luck from public.reading_analyses where reading_id = $1 and cache_key like 'mujin-timing:%'",
    [readingId],
  );
  expect(bundle?.luck).toMatchObject({ status: "unavailable", reason: "hour-unknown", current: null, previous: null, next: null });
});

test("이용권 한 장을 묘묘와 무진에 동시에 쓰면 한 풀이에만 쓰이고, 다른 풀이는 이미 썼다고 안내한다", async ({ page, request }) => {
  test.setTimeout(120_000);
  const userId = await login(page, request);
  const myomyo = await createPreview(page, { nickname: "묘묘쪽" });
  const mujin = await createMujinReadingApi(page, { nickname: "무진쪽" });
  const tab = await page.context().newPage();
  const results = await Promise.all([redeemApi(page, myomyo), redeemApi(tab, mujin)]);
  const outcomes = results.map((result) => result.body.outcome);
  expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "ticket_used")).toHaveLength(1);
  const winner = outcomes[0] === "redeemed" ? myomyo : mujin;
  const loser = winner === myomyo ? mujin : myomyo;
  expect(results.find((result) => result.body.outcome === "ticket_used")?.body.readingId).toBe(winner);
  // 이어서 다시 보내도 이미 쓴 이용권이다.
  expect((await redeemApi(page, loser)).body).toMatchObject({ outcome: "ticket_used", readingId: winner });

  const [{ n }] = await gatewaySql<{ n: number }>(request, "select count(*)::int as n from public.entitlements where user_id = $1", [userId]);
  expect(n).toBe(1);
  expect(await freeTickets(request, userId)).toMatchObject([{ status: "redeemed", reading_id: winner }]);

  // 진 쪽 화면은 결제·이용권 버튼 대신 이미 쓴 풀이로 안내한다.
  if (loser === mujin) {
    await tab.goto(`/readings/${mujin}`);
    await waitForMujinFree(tab);
    await expect(tab.getByText("무료 이용권은 다른 풀이에 이미 썼어요")).toBeVisible();
    await expect(tab.getByRole("button", { name: REDEEM })).toHaveCount(0);
  } else {
    await tab.goto(`/readings/${myomyo}/preview`);
    await expect(tab.getByText("무료 이용권은 다른 풀이에 이미 썼어요")).toBeVisible();
  }
});

test("관리자만 이용으로 닫으면 일반 회원은 무진 입력·생성 API를 쓸 수 없고, 이미 만든 풀이는 볼 수 있다", async ({ page, request }) => {
  test.setTimeout(120_000);
  await login(page, request);
  const readingId = await createMujinReadingApi(page, { nickname: "닫힘" });
  await setOpenToAll(request, false);
  try {
    await page.goto("/readings/new?product=mujin-overview");
    await expect(page.getByText(CLOSED)).toBeVisible();
    await expect(page.getByLabel("별명")).toHaveCount(0);
    for (const [method, path, data] of [
      ["post", "/api/readings", { productId: "mujin-overview", nickname: "닫힘", situationId: null, now: null }],
      ["put", "/api/drafts", { productId: "mujin-overview" }],
      ["post", `/api/readings/${readingId}/scroll/generate`, { tier: "free" }],
      ["post", `/api/readings/${readingId}/scroll/generate`, { tier: "paid", retry: true }],
      ["post", `/api/readings/${readingId}/redeem`, { requestId: randomUUID() }],
      ["post", `/api/readings/${readingId}/followups`, { clientRequestId: randomUUID(), question: "열려 있나요?" }],
    ] as const) {
      const response = await page.request.fetch(path, { method, data });
      expect(response.status(), path).toBe(403);
      expect((await response.json()).error.code, path).toBe("readings_closed");
    }
    // 이미 만든 풀이의 상태 보기는 열려 있다 (다시 보기). 화면은 열리지만 생성 요청이 막혀 무료 단계를 시작하지 않는다.
    expect((await page.request.get(`/api/readings/${readingId}/scroll`)).status()).toBe(200);
    await page.goto(`/readings/${readingId}`);
    await expect(page.getByText(CLOSED).first()).toBeVisible();
    await expect(page.getByRole("button", { name: REDEEM })).toHaveCount(0);
    await page.waitForTimeout(1_000);
    const [{ runs }] = await gatewaySql<{ runs: number }>(request, "select count(*)::int as runs from public.reading_free_runs where reading_id = $1", [readingId]);
    const [{ calls }] = await gatewaySql<{ calls: number }>(request, "select count(*)::int as calls from public.llm_calls where reading_id = $1", [readingId]);
    expect({ runs, calls }).toEqual({ runs: 0, calls: 0 });
  } finally {
    await setOpenToAll(request, true);
  }
  // 다시 열면 이어서 쓴다.
  await page.goto(`/readings/${readingId}`);
  await waitForMujinFree(page);
});

test("생성 중에 화면을 닫아도 서버가 이어서 쓰고, 다시 열면 저장된 장을 보여 주며 같은 장을 다시 만들지 않는다", async ({ page, request }) => {
  test.setTimeout(120_000);
  await login(page, request);
  const readingId = await createMujinReadingApi(page, { nickname: "닫았다열기" });
  // 스트림을 느리게 보내 기초 분석 묶음을 쓰는 도중에 화면을 닫는다.
  await setControl(request, { streamDelayMs: 250 });
  const before = (await gatewayStats(request)).mujin;
  await page.goto(`/readings/${readingId}`);
  const count = async (sql: string) => (await gatewaySql<{ n: number }>(request, sql, [readingId]))[0]!.n;
  await expect.poll(() => count("select count(*)::int as n from public.reading_units where reading_id = $1"), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await count("select count(*)::int as n from public.reading_units where reading_id = $1 and status = 'done'")).toBeLessThan(MUJIN_FREE_SECTIONS.length);
  const context = page.context();
  await page.close();

  // 화면이 없어도 서버의 생성 요청은 끝까지 간다 (점유를 잃지 않았으므로 다른 요청이 이어받을 필요가 없다).
  await expect
    .poll(async () => (await gatewaySql<{ status: string }>(request, "select status from public.reading_free_runs where reading_id = $1", [readingId]))[0]?.status, { timeout: 60_000 })
    .toBe("completed");
  const reopened = await context.newPage();
  await reopened.goto(`/readings/${readingId}`);
  await waitForMujinFree(reopened);
  // 다시 열 때는 펼쳐지는 연출 없이 저장된 족자를 바로 보여 준다.
  await expect(reopened.getByRole("article")).not.toHaveClass(/animate-scroll-unfurl/);
  const after = (await gatewayStats(request)).mujin;
  expect(only(callsSince(after.sections.pass1, before.sections.pass1), MUJIN_FREE_SECTIONS)).toEqual(each(MUJIN_FREE_SECTIONS, 1));
  expect(only(callsSince(after.sections.pass2, before.sections.pass2), MUJIN_FREE_SECTIONS)).toEqual(each(MUJIN_FREE_SECTIONS, 1));
  expect(await count("select attempts as n from public.reading_free_runs where reading_id = $1")).toBe(1);
});
