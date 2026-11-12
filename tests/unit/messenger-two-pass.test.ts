import { describe, expect, it } from "vitest";
import { MYOMYO, findPersona } from "@/domain/personas";
import { messengerUnits } from "@/domain/reading/two-pass";
import type { NarrationPlanV2, StoredMessage } from "@/domain/reading/types";
import { attemptLimitFor, findMessengerBundle } from "@/server/generation/bundles";
import { messengerBatches, type MessengerRunResult } from "@/server/generation/messenger-run";
import { hasReadingPrompt } from "@/server/llm/prompts";
import { summarizeUsage, usageRecordOf, UsageMeter } from "@/server/llm/usage";
import { casePlan, EVALUATION_CASES } from "../../scripts/llm-cases";
import { BUNDLE, READING, fakeModel, fakeStore, newRun, type VoiceInput } from "../support/messenger-fakes";

/**
 * 묘묘 최초 풀이 2-pass 실행기 (src/server/generation/messenger-run.ts). 가짜 저장소와 가짜 모델로 순서·저장·재개·사용량을 확인한다.
 * 실제 모델·네트워크·DB를 쓰지 않는다. 문장 품질은 확인하지 않는다 (LIVE_NOT_RUN, 사용자가 실제 모델로 비교한다).
 */


function fixture(caseId: string): { plan: NarrationPlanV2; chart: ReturnType<typeof casePlan>["chart"] } {
  const entry = EVALUATION_CASES.find((item) => item.id === caseId)!;
  return casePlan(entry, "2026-11-12");
}

/** 저장된 말풍선을 화면 순서대로 읽어 단위 ID 목록으로 (시작 인사는 opening). */
const unitOrder = (messages: readonly StoredMessage[]) => {
  const seen: string[] = [];
  for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
    const key = message.topicId ?? "opening";
    if (seen.at(-1) !== key) seen.push(key);
  }
  return seen;
};

describe("묘묘 최초 풀이 2-pass 실행", () => {
  it("Pass 1은 묶음마다 한 번, Pass 2는 단위마다 한 번 실행되고, 말풍선은 화면 순서대로 순번이 이어진다", async () => {
    const { plan, chart } = fixture("job-seeking");
    const store = fakeStore();
    const model = fakeModel();
    const result = await newRun({ plan, chart, store, model }).execute();

    const units = messengerUnits(plan);
    expect(plan.questions.length).toBeGreaterThan(0);
    expect(units[0]!.kind).toBe("focus");
    expect(result.kind).toBe("completed");
    expect(model.drafts).toHaveLength(messengerBatches(units, BUNDLE.draftBatches).length);
    expect(model.voices).toHaveLength(units.length);
    // 첫 묶음은 작게 (첫 말풍선을 빨리), 그 뒤는 3개씩.
    expect(messengerBatches(units, BUNDLE.draftBatches).map((batch) => batch.unitIds.length)).toEqual([2, 3, 3, 2]);
    expect(unitOrder(store.messageRows)).toEqual(["opening", ...units.map((unit) => unit.unitId)]);
    const seqs = store.messageRows.map((message) => message.seq).sort((left, right) => left - right);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const closing = (result as Extract<MessengerRunResult, { kind: "completed" }>).closing;
    expect(closing).toMatchObject({ topicId: null, kind: "transition", seq: seqs.length + 1, text: "[최종] 더 궁금한 건 물어봐." });
    // 사용자에게는 Pass 2 결과만 보인다. 초안 문장은 말풍선에 없다.
    expect(store.messageRows.some((message) => message.text.includes("[초안]"))).toBe(false);
    // 시작 인사는 첫 단위의 Pass 2가 한 번만 쓴다.
    const openings = store.messageRows.filter((message) => message.topicId === null);
    expect(openings).toHaveLength(1);
    expect(openings[0]!.text.startsWith("[최종] ") && openings[0]!.text.endsWith(", 시작한다.")).toBe(true);
  });

  it("Pass 1 요청에는 캐릭터·예시·호칭이 없고, Pass 2 요청 지시에는 [캐릭터]와 이번 묘묘 카탈로그 예시(재작성 예시 포함)가 있다", async () => {
    const { plan, chart } = fixture("job-seeking");
    const model = fakeModel();
    await newRun({ plan, chart, store: fakeStore(), model }).execute();
    for (const draft of model.drafts) {
      expect(draft.instructions).not.toContain("[캐릭터");
      expect(draft.instructions).not.toContain("묘묘");
      expect(draft.input).not.toContain("\"address\"");
      expect(draft.input).not.toContain("[캐릭터 문답 예시");
    }
    for (const voice of model.voices) {
      expect(voice.instructions).toContain(`[캐릭터: ${MYOMYO.name}]`);
      expect(voice.instructions).toContain("[의미 보존]");
      expect(voice.instructions).toContain("[캐릭터 문답 예시: 묘묘]");
      const ids = [...voice.instructions.matchAll(/<(?:rewrite-)?example id="([^"]+)"/g)].map((match) => match[1]!);
      expect(ids.length).toBe(2);
      expect(ids.every((id) => id.startsWith("myomyo-v2-"))).toBe(true);
      expect(ids.some((id) => id.startsWith("myomyo-v2-rw-"))).toBe(true);
      // 칭찬·오류 정정 예시는 본문 재작성에 넣지 않는다.
      expect(ids).not.toContain("myomyo-v2-11");
      expect(ids).not.toContain("myomyo-v2-12");
      // 예시는 지시 안에만 있고 입력(작성 재료)에는 섞이지 않는다.
      expect(voice.input).not.toContain("[캐릭터 문답 예시");
    }
  });

  it("Pass 2만 실패하면 저장된 초안으로 그 단위만 다시 시도하고(Pass 1 호출 없음), 보낸 말풍선은 다시 만들지 않는다", async () => {
    const { plan, chart } = fixture("job-seeking");
    const units = messengerUnits(plan);
    const failing = units[2]!.unitId;
    const store = fakeStore();
    // 한 요청 안의 재요청(retriesPerRun 1)까지 두 번 모두 검사에 걸린다.
    const first = fakeModel({ badVoice: { unitId: failing, times: 2 } });
    const failed = await newRun({ plan, chart, store, model: first }).execute();
    expect(failed).toMatchObject({ kind: "failed", code: "units_failed", retryable: true });
    expect(store.unitRows.get(failing)).toMatchObject({ status: "failed", errorStage: "voice", voiceAttempts: 1 });
    // 실패한 단위 앞까지만 화면에 나갔다. 뒤 단위는 검사를 통과해 저장만 됐다 (순서를 지킨다).
    expect(unitOrder(store.messageRows)).toEqual(["opening", units[0]!.unitId, units[1]!.unitId]);
    expect(store.finalRows.size).toBe(units.length - 1);
    const sentBefore = store.messageRows.length;

    // 다음 시도: 초안을 다시 만들지 않고 실패한 단위의 Pass 2만 부른다. 저장된 뒤 단위는 모델 없이 보낸다.
    store.owner = 2;
    const second = fakeModel();
    const result = await newRun({ plan, chart, store, model: second, attempt: 2 }).execute();
    expect(result.kind).toBe("completed");
    expect(second.drafts).toHaveLength(0);
    expect(second.voices.map((voice) => (JSON.parse(voice.input) as VoiceInput).unit.unitId)).toEqual([failing]);
    expect(unitOrder(store.messageRows)).toEqual(["opening", ...units.map((unit) => unit.unitId)]);
    const seqs = store.messageRows.map((message) => message.seq).sort((left, right) => left - right);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(seqs.length).toBeGreaterThan(sentBefore);
  });

  it("같은 단위의 재요청은 같은 예시를 받는다 (선택이 작업에 고정된다, 무작위 없음)", async () => {
    const { plan, chart } = fixture("job-seeking");
    const failing = messengerUnits(plan)[1]!.unitId;
    const model = fakeModel({ badVoice: { unitId: failing, times: 1 } });
    await newRun({ plan, chart, store: fakeStore(), model }).execute();
    const requests = model.voices.filter((voice) => (JSON.parse(voice.input) as VoiceInput).unit.unitId === failing);
    expect(requests).toHaveLength(2);
    const idsOf = (text: string) => [...text.matchAll(/<(?:rewrite-)?example id="([^"]+)"/g)].map((match) => match[1]);
    expect(idsOf(requests[1]!.instructions)).toEqual(idsOf(requests[0]!.instructions));
    expect(JSON.parse(requests[1]!.input)).toHaveProperty("fixTheseProblemsFromPreviousAttempt");
  });

  it("시간 예산이 끝나면 반납(release)하고, 다음 실행은 저장된 단위부터 이어 쓴다 (단위마다 Pass 2는 한 번)", async () => {
    const { plan, chart } = fixture("job-seeking");
    const units = messengerUnits(plan);
    const store = fakeStore();
    const clock = { now: 0 };
    // Pass 2 하나에 100초가 걸린다고 보면, 예산(270초) 안에서 몇 단위만 끝내고 나머지는 시작하지 않는다.
    const first = fakeModel({ advance: { clock, ms: 100_000 } });
    const released = await newRun({ plan, chart, store, model: first, clock }).execute();
    expect(released.kind).toBe("release");
    const voicedFirst = new Set(first.voices.map((voice) => (JSON.parse(voice.input) as VoiceInput).unit.unitId));
    expect(voicedFirst.size).toBeLessThan(units.length);

    store.owner = 2;
    const second = fakeModel();
    const done = await newRun({ plan, chart, store, model: second, attempt: 2, clock: { now: 0 } }).execute();
    expect(done.kind).toBe("completed");
    const voicedSecond = second.voices.map((voice) => (JSON.parse(voice.input) as VoiceInput).unit.unitId);
    // 앞 실행이 끝낸 단위는 다시 부르지 않는다: 두 실행의 Pass 2를 합치면 단위마다 정확히 한 번이다.
    expect(voicedSecond.filter((id) => voicedFirst.has(id))).toEqual([]);
    expect([...voicedFirst, ...voicedSecond].sort()).toEqual(units.map((unit) => unit.unitId).sort());
    expect(unitOrder(store.messageRows)).toEqual(["opening", ...units.map((unit) => unit.unitId)]);
  });

  it("다른 요청이 이어받으면(말풍선 저장 거부) 더 저장하지 않고 lost로 끝난다", async () => {
    const { plan, chart } = fixture("job-seeking");
    const store = fakeStore();
    store.owner = 9;
    const result = await newRun({ plan, chart, store, model: fakeModel() }).execute();
    expect(result.kind).toBe("lost");
    expect(store.messageRows).toEqual([]);
  });

  it("사용량: 호출마다 llm_calls 행이 단계·시도 번호·캐릭터·생성 묶음과 함께 남고, 그 합계가 시도 미터의 합계와 같다", async () => {
    const { plan, chart } = fixture("job-seeking");
    const store = fakeStore();
    const meter = new UsageMeter();
    const run = newRun({ plan, chart, store, model: fakeModel(), meter });
    await run.execute();
    expect(store.callRows.length).toBe(meter.calls);
    expect(new Set(store.callRows.map((row) => row.step))).toEqual(new Set(["pass1", "pass2"]));
    for (const row of store.callRows) {
      expect(row).toMatchObject({ attempt: 1, personaId: "myomyo", policyVersion: BUNDLE.id, productId: "first-overview", tier: "paid", readingId: READING });
    }
    expect(store.callRows.filter((row) => row.step === "pass2").every((row) => row.promptVersion === BUNDLE.voicePrompt && row.personaVersion === "2.1.0")).toBe(true);
    expect(store.callRows.filter((row) => row.step === "pass1").every((row) => row.promptVersion === BUNDLE.draftPrompt && row.personaVersion === null)).toBe(true);
    const fromRows = summarizeUsage(
      store.callRows.map((row) =>
        usageRecordOf({
          outcome: row.outcome as "usage",
          usage: { inputTokens: row.inputTokens as number, outputTokens: row.outputTokens as number, totalTokens: null, reasoningTokens: row.reasoningTokens as number, cachedInputTokens: row.cachedInputTokens as number },
        }),
      ),
    );
    expect([fromRows.inputTokens, fromRows.outputTokens, fromRows.cachedInputTokens]).toEqual([meter.summary().inputTokens, meter.summary().outputTokens, meter.summary().cachedInputTokens]);
    // 캐시 입력은 입력에 포함된 값이다. 합계는 입력 + 출력이다.
    expect(meter.summary().totalTokens).toBe((meter.summary().inputTokens ?? 0) + (meter.summary().outputTokens ?? 0));
    expect(run.summary().examples.ids.every((id) => id.startsWith("myomyo-v2-"))).toBe(true);
  });
});

describe("생성 방식은 고정된 버전으로 정한다 (캐릭터 이름이 아니라)", () => {
  it("2-pass 묶음, 이전 1-pass 지시, 모르는 버전을 구분하고 작업 시작 상한을 묶음에서 읽는다", () => {
    expect(findMessengerBundle("myomyo-2pass-1.0.0")?.mode).toBe("two-pass");
    expect(findMessengerBundle("reading-3.2.0")).toBeUndefined();
    expect(hasReadingPrompt("reading-3.2.0")).toBe(true);
    expect(findMessengerBundle("reading-3.0.0")).toBeUndefined();
    expect(hasReadingPrompt("reading-3.0.0")).toBe(false);
    expect(attemptLimitFor("myomyo-2pass-1.0.0")).toBe(BUNDLE.maxAttempts);
    expect(attemptLimitFor("reading-3.2.0")).toBe(4);
    expect(attemptLimitFor(null)).toBe(4);
    // 묶음이 캐릭터 설정 버전을 고정한다. 그 버전 설정이 있어야 한다.
    expect(findPersona(BUNDLE.personaId, BUNDLE.personaVersion)).toBe(MYOMYO);
  });
});
