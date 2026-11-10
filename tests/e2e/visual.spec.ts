import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createPreview, login, purchase, setControl, waitForCompletedReading } from "./helpers";

/**
 * 상품 그림과 캐릭터 프로필이 실제 화면에서 제대로 보이는지 확인한다.
 * 그림 요청 실패, 늘어나거나 찌그러짐, 글자가 얼굴·소품을 가리는지, 로딩 중 화면 흔들림, 투명 배경을 본다.
 * 확인용 스크린샷은 test-results/visual/에 남는다.
 */

const SHOTS = path.join("test-results", "visual");
mkdirSync(SHOTS, { recursive: true });

/** 그림 안에서 글자가 덮으면 안 되는 곳 (그림 크기에 대한 비율, 실제 위치보다 조금 넉넉하게). */
type Zone = { name: string; x0: number; x1: number; y0: number; y1: number };
const BANNER_ZONES: Zone[] = [
  { name: "얼굴", x0: 0.62, x1: 0.88, y0: 0.1, y1: 0.5 },
  { name: "부채", x0: 0.46, x1: 0.66, y0: 0.42, y1: 0.62 },
  { name: "벽걸이", x0: 0.37, x1: 0.55, y0: 0.06, y1: 0.43 },
  { name: "책", x0: 0.34, x1: 0.53, y0: 0.88, y1: 0.96 },
];
const POSTER_ZONES: Zone[] = [
  { name: "얼굴과 머리핀", x0: 0.38, x1: 0.75, y0: 0.08, y1: 0.34 },
  { name: "부채", x0: 0.13, x1: 0.45, y0: 0.29, y1: 0.42 },
];

function watchImages(page: Page) {
  const failures: string[] = [];
  const formats = new Map<string, string>();
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/_next/image") && !/\.(png|webp|jpe?g)(\?|$)/.test(url)) return;
    if (response.status() >= 400) failures.push(`${response.status()} ${url}`);
    formats.set(url, response.headers()["content-type"] ?? "");
  });
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "image") failures.push(`failed ${request.url()}`);
  });
  return { failures, formats };
}

async function trackLayoutShift(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

/** 화면의 모든 그림이 다 불러와졌고, 비율을 지킨 채 그려졌는지 확인한다. */
async function expectImagesIntact(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(
    () => document.images.length > 0 && [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    null,
    { timeout: 15_000 },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  const images = await page.locator("img").evaluateAll((elements) =>
    elements.map((element) => {
      const img = element as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      return { src: img.currentSrc, natural: img.naturalWidth / img.naturalHeight, drawn: rect.width / rect.height, fit: getComputedStyle(img).objectFit };
    }),
  );
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    // object-fit: cover는 잘라서 채울 뿐 늘리지 않는다. 그 밖에는 그려진 비율이 원본 비율과 같아야 한다.
    if (image.fit !== "cover") expect(Math.abs(image.drawn - image.natural) / image.natural, image.src).toBeLessThan(0.01);
  }
  return images;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 글자 줄마다의 사각형을 그림 상자에 대한 비율로 구해, 막아 둔 영역과 겹치지 않는지 본다. */
async function expectTextClear(box: Locator, zones: Zone[], label: string) {
  const lines = await box.evaluate((root) => {
    const frame = root.getBoundingClientRect();
    const result: { text: string; x0: number; x1: number; y0: number; y1: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1) continue;
        result.push({
          text: node.textContent.trim(),
          x0: (rect.left - frame.left) / frame.width,
          x1: (rect.right - frame.left) / frame.width,
          y0: (rect.top - frame.top) / frame.height,
          y1: (rect.bottom - frame.top) / frame.height,
        });
      }
    }
    return result;
  });
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.x0, `${label}: ${line.text}`).toBeGreaterThanOrEqual(0);
    expect(line.x1, `${label}: ${line.text}`).toBeLessThanOrEqual(1);
    for (const zone of zones) {
      const overlaps = line.x0 < zone.x1 && line.x1 > zone.x0 && line.y0 < zone.y1 && line.y1 > zone.y0;
      expect(overlaps, `${label}: "${line.text}" 줄이 ${zone.name}을 가린다 (${JSON.stringify(line)})`).toBe(false);
    }
  }
}

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null });
});

/** 얼굴과 부채는 모든 폭에서, 벽걸이와 책은 360px 이상(디자인 기준 375px 근처)에서 가리지 않는다. */
const HERO_WIDTHS = [320, 360, 375, 390, 430, 479, 600, 768, 1280];
const CHARACTER_ZONES = BANNER_ZONES.filter((zone) => zone.name === "얼굴" || zone.name === "부채");

test("상품 상세 배너: 글자가 묘묘와 소품을 가리지 않고 그림이 그대로 보인다", async ({ page }) => {
  const watch = watchImages(page);
  await trackLayoutShift(page);
  for (const width of HERO_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/products/first-overview");
    const title = page.getByRole("heading", { level: 1, name: "묘묘의 사주 참견" });
    await expect(title).toBeVisible();
    const hero = title.locator("xpath=../..");
    await expect(hero.getByText("칭찬만 들을 줄 알았어? 성향부터 행운까지, 다 짚어줄게.")).toBeVisible();
    const order = await hero.evaluate((root) => {
      const text = (root as HTMLElement).innerText;
      return text.indexOf("칭찬만") < text.indexOf("묘묘의 사주 참견");
    });
    expect(order, "부설명이 제목 위에 있어야 한다").toBe(true);

    const ratio = await hero.evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
    expect(Math.abs(ratio - 1.6)).toBeLessThan(0.02);
    await expectTextClear(hero, width < 360 ? CHARACTER_ZONES : BANNER_ZONES, `배너 ${width}px`);
    await expectImagesIntact(page);
    await expectNoHorizontalScroll(page);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, `화면 흔들림 ${width}px`).toBeLessThan(0.1);
    if ([320, 375, 1280].includes(width)) {
      await page.screenshot({ path: path.join(SHOTS, `product-${width}.png`) });
      await hero.screenshot({ path: path.join(SHOTS, `product-hero-${width}.png`) });
    }
  }
  expect(watch.failures).toEqual([]);
  // 원본 PNG를 그대로 내려보내지 않고 Next 이미지 최적화(WebP)를 거친다.
  const optimized = [...watch.formats.entries()].filter(([url]) => url.includes("/_next/image"));
  expect(optimized.length).toBeGreaterThan(0);
  for (const [url, type] of optimized) expect(type, url).toBe("image/webp");
});

test("홈 포스터, 맛보기·메신저 프로필, 보관함 썸네일, PDF", async ({ page, request }) => {
  test.setTimeout(150_000);
  const watch = watchImages(page);
  await trackLayoutShift(page);
  await login(page, request);

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/home");
    await expect(page.getByText("불러오는 중이에요")).toHaveCount(0);
    const card = page.getByRole("link", { name: /묘묘의 사주 참견/ }).first();
    await expect(card).toBeVisible();
    const poster = card.locator("div").first();
    const ratio = await poster.evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
    expect(Math.abs(ratio - 0.75)).toBeLessThan(0.01);
    await expectTextClear(poster, POSTER_ZONES, `포스터 ${width}px`);
    await expectImagesIntact(page);
    await expectNoHorizontalScroll(page);
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.1);
    await page.screenshot({ path: path.join(SHOTS, `home-${width}.png`) });
    await card.screenshot({ path: path.join(SHOTS, `home-card-${width}.png`) });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/products/first-overview");
  const character = page.getByRole("region", { name: "풀이해 줄 캐릭터" });
  await character.scrollIntoViewIfNeeded();
  await expectImagesIntact(page);
  await character.screenshot({ path: path.join(SHOTS, "product-character.png") });

  await createPreview(page);
  await expect(page.getByRole("heading", { name: "맛보기" })).toBeVisible();
  await expectImagesIntact(page);
  await page.getByRole("heading", { name: "맛보기" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, "preview-390.png") });

  await purchase(page);
  await waitForCompletedReading(page);
  const avatars = await expectImagesIntact(page);
  const avatar = avatars.find((image) => image.src.includes("myomyo-profile"));
  expect(avatar, "메신저에 묘묘 프로필 그림").toBeTruthy();
  // 원형 칸과 투명 배경: 칸은 완전한 원이고, 최적화된 그림의 모서리는 투명하며 가운데는 불투명하다.
  const frame = page.locator("header img").first().locator("xpath=..");
  const radius = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { radius: parseFloat(style.borderTopLeftRadius), width: element.getBoundingClientRect().width, overflow: style.overflow };
  });
  expect(radius.radius).toBeGreaterThanOrEqual(radius.width / 2);
  expect(radius.overflow).toBe("hidden");
  const alpha = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    return { corner: context.getImageData(0, 0, 1, 1).data[3], center: context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] };
  }, avatar!.src);
  expect(alpha.corner).toBe(0);
  expect(alpha.center).toBeGreaterThan(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, "messenger-390.png") });
  await page.locator("header").screenshot({ path: path.join(SHOTS, "messenger-header.png") });
  await expectNoHorizontalScroll(page);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "PDF 내려받기" }).click()]);
  expect(download.suggestedFilename()).toBe("묘묘의 사주 참견.pdf");
  copyFileSync((await download.path())!, path.join(SHOTS, "reading.pdf"));

  await page.goto("/library");
  await expect(page.getByText("불러오는 중이에요")).toHaveCount(0);
  const item = page.getByRole("link", { name: /묘묘의 사주 참견/ });
  await expect(item).toBeVisible();
  await expectImagesIntact(page);
  await item.screenshot({ path: path.join(SHOTS, "library-item.png") });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(page.url());
  await item.click();
  await waitForCompletedReading(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, "messenger-1280.png") });

  expect(watch.failures).toEqual([]);
});
