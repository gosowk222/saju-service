import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { GATEWAY, createPreview, gatewayStats, login, redeemFreeTicket, setControl, waitForCompletedReading } from "./helpers";

/**
 * 생성 중에 사용자가 떠나거나 연결이 끊기는 경우 (주제별로 먼저 보여 주는 생성).
 * 가짜 서버가 응답을 천천히 흘려보내 생성이 끝나기 전에 상황을 만든다.
 * 새 묘묘 풀이는 2-pass(myomyo-2pass-1.0.0)다: Pass 1 중립 초안을 묶음마다 스트림으로 받고, 단위(주제)마다 Pass 2 묘묘 말풍선을 받아 순서대로 보낸다.
 * 이전 1-pass 버전(reading-3.2.0)으로 시작한 작업은 그 방식으로 이어 쓴다 (마지막 테스트, 가짜 서버의 claimPromptOverride).
 * 서버 요청이 멈추는 테스트는 멈춘 요청이 나중에 시간 초과로 한 번 더 호출할 수 있어 이 파일의 맨 끝에 둔다.
 */

const TOPICS = ["temperament", "strengths", "work", "money", "romance", "people", "friends", "family", "place"];

test.beforeEach(async ({ request }) => {
  await setControl(request, { openai: "ok", tossFail: null, loginError: null, streamDelayMs: 10, claimPromptOverride: null });
});

test.afterEach(async ({ request }) => {
  await setControl(request, { claimPromptOverride: null });
});

type MessengerStats = Awaited<ReturnType<typeof gatewayStats>>["messenger"];

/** before 이후 단위별 Pass 2 요청 수. 단위마다 한 번씩이면 이미 보낸 단위를 다시 만들지 않은 것이다. */
function voicedSince(after: MessengerStats, before: MessengerStats): Record<string, number> {
  return Object.fromEntries(TOPICS.map((topic) => [topic, (after.units.pass2[topic] ?? 0) - (before.units.pass2[topic] ?? 0)]));
}

/** 인사와 모든 주제가 한 번씩만 있는지. 이어 쓰기에서 같은 부분이 두 번 저장되지 않았는지 본다. */
async function expectEachPartOnce(page: Page) {
  await expect(page.getByText("안녕하세요, 달빛 님", { exact: false })).toHaveCount(1);
  for (const topic of TOPICS) await expect(page.getByText(`${topic} 주제의 첫 설명`, { exact: false })).toHaveCount(1);
  await expect(page.getByText("궁금한 점은 편하게 물어봐 주세요", { exact: false })).toHaveCount(1);
}

/** 응답을 천천히 흘려보내며 결제하고, 첫 주제가 화면에 보일 때까지 기다린다. */
async function startSlowGeneration(page: Page, request: APIRequestContext) {
  await login(page, request);
  await createPreview(page);
  await setControl(request, { streamDelayMs: 250 });
  const before = (await gatewayStats(request)).messenger;
  await redeemFreeTicket(page);
  const readingUrl = page.url();
  await expect(page.getByText("temperament 주제의 첫 설명", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("풀이 완료")).toHaveCount(0);
  return { readingUrl, readingId: readingUrl.split("/readings/")[1]!, before };
}

test("생성 중에 창을 닫아도 서버는 계속 만들고, 다시 열면 완성된 풀이를 받는다", async ({ page, request }) => {
  const { readingUrl, before } = await startSlowGeneration(page, request);
  const context = page.context();
  await page.close();

  // 창을 닫은 뒤 잠시 있다가 다시 연다. 서버가 멈췄다면 점유 시간(5분)이 지날 때까지 끝나지 않는다.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const again = await context.newPage();
  await again.goto(readingUrl);
  await waitForCompletedReading(again);
  await expectEachPartOnce(again);
  // 처음 요청이 끝까지 썼다. 다시 연 화면이 새로 생성하지 않았다 (주제마다 Pass 2 한 번).
  const after = (await gatewayStats(request)).messenger;
  expect(voicedSince(after, before)).toEqual(Object.fromEntries(TOPICS.map((topic) => [topic, 1])));
});

test("인터넷이 끊겨도 서버는 계속 만들고, 다시 연결되면 새로고침 없이 이어서 보여 준다", async ({ page, request }) => {
  const { before } = await startSlowGeneration(page, request);
  await page.context().setOffline(true);
  await expect(page.getByText("인터넷 연결이 끊겼어요", { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("다시 시도해 주세요", { exact: false })).toHaveCount(0);

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await page.context().setOffline(false);
  await waitForCompletedReading(page);
  await expect(page.getByText("인터넷 연결이 끊겼어요", { exact: false })).toHaveCount(0);
  await expectEachPartOnce(page);
  const after = (await gatewayStats(request)).messenger;
  expect(voicedSince(after, before)).toEqual(Object.fromEntries(TOPICS.map((topic) => [topic, 1])));
});

test("서버 요청이 중간에 멈추면, 다시 열었을 때 저장된 주제 다음부터 이어 쓴다", async ({ page, request }) => {
  const { readingUrl, readingId, before } = await startSlowGeneration(page, request);
  const context = page.context();

  // 서버 재시작이나 시간 초과로 첫 요청이 더 진행하지 못하는 상황: 응답을 멈춰 세우고, 점유 시간이 지난 것으로 바꾼다.
  await request.post(`${GATEWAY}/__freeze_streams`);
  await page.close();
  await request.post(`${GATEWAY}/__expire_generation`, { data: { readingId } });

  const again = await context.newPage();
  await again.goto(readingUrl);
  await waitForCompletedReading(again);
  await expectEachPartOnce(again);

  const after = (await gatewayStats(request)).messenger;
  // 멈추기 전에 보낸 주제(temperament)는 이어 쓴 요청이 초안도 묘묘 말풍선도 다시 만들지 않았다.
  expect((after.units.pass1.temperament ?? 0) - (before.units.pass1.temperament ?? 0)).toBe(1);
  expect(after.lastDraftUnits).not.toContain("temperament");
  // 모든 주제의 Pass 2는 한 번씩이다 (멈춘 요청이 보낸 주제는 다시 쓰지 않았다).
  expect(voicedSince(after, before)).toEqual(Object.fromEntries(TOPICS.map((topic) => [topic, 1])));
});

test("이전 1-pass 버전(reading-3.2.0)으로 시작한 작업은 배포 뒤에도 그 방식으로 끝까지 쓴다", async ({ page, request }) => {
  await login(page, request);
  await createPreview(page);
  // 배포 전에 시작한 작업처럼, 처음 시작할 때 이전 1-pass 버전을 고정한다.
  await setControl(request, { claimPromptOverride: { prompt: "reading-3.2.0", schema: "narration-2.2.0" } });
  const before = await gatewayStats(request);
  await redeemFreeTicket(page);
  await waitForCompletedReading(page);
  await expectEachPartOnce(page);
  const after = await gatewayStats(request);
  // 한 번의 1-pass 호출로 썼고, 2-pass 호출은 없다. 지시에는 그 버전의 예시(myomyo-examples-1.0.0)가 들어갔다.
  expect(after.narrationCalls - before.narrationCalls).toBe(1);
  expect(after.messenger.calls.pass1 - before.messenger.calls.pass1).toBe(0);
  expect(after.messenger.calls.pass2 - before.messenger.calls.pass2).toBe(0);
  const narration = after.openaiExamples.slice(before.openaiExamples.length).filter((call) => call.schema === "saju_narration_v2");
  expect(narration).toHaveLength(1);
  expect(narration[0]!.ids.every((id) => /^myomyo-[abc]-\d+$/.test(id))).toBe(true);
});
