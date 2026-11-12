import type { Persona } from "@/domain/personas";
import { MYOMYO } from "@/domain/personas";
import type { MessengerDraftUnit, MessengerFinalUnit } from "@/domain/reading/two-pass";
import type { NarrationPlanV2, StoredMessage } from "@/domain/reading/types";
import { MESSENGER_BUNDLES, type MessengerBundle } from "@/server/generation/bundles";
import { MessengerRun } from "@/server/generation/messenger-run";
import type { MessengerStore } from "@/server/generation/messenger-store";
import type { UnitRecord } from "@/server/generation/two-pass";
import type { LlmCallRow } from "@/server/llm/call-log";
import type { LlmCallLog, callStructured, callStructuredStream } from "@/server/llm/client";
import type { UsageMeter, LlmUsage } from "@/server/llm/usage";
import type { casePlan } from "../../scripts/llm-cases";

/**
 * 메신저 2-pass 실행기 테스트용 가짜 저장소와 가짜 모델 (tests/unit/messenger-two-pass.test.ts, persona-registry.test.ts).
 * 저장소는 DB 저장 함수와 같은 규칙(점유한 시도만 저장, 최종 단위는 덮어쓰지 않음, 같은 순번 거부)을 흉내 낸다. 네트워크와 DB를 쓰지 않는다.
 */

export const BUNDLE = MESSENGER_BUNDLES["myomyo-2pass-1.0.0"]!;
export const READING = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const USAGE: LlmUsage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, reasoningTokens: 50, cachedInputTokens: 600 };

// ─── 가짜 저장소 (DB 저장 함수와 같은 규칙: 점유한 시도만 저장, 최종 단위는 덮어쓰지 않음, 같은 순번은 거부) ─────────

export interface FakeStore extends MessengerStore {
  readonly unitRows: Map<string, UnitRecord<MessengerDraftUnit>>;
  readonly finalRows: Map<string, MessengerFinalUnit>;
  readonly messageRows: StoredMessage[];
  readonly callRows: LlmCallRow[];
  owner: number;
}

export function fakeStore(): FakeStore {
  const unitRows = new Map<string, UnitRecord<MessengerDraftUnit>>();
  const finalRows = new Map<string, MessengerFinalUnit>();
  const messageRows: StoredMessage[] = [];
  const callRows: LlmCallRow[] = [];
  const blank = (unitId: string): UnitRecord<MessengerDraftUnit> => ({
    unitId,
    tier: "paid",
    status: "pending",
    draft: null,
    draftAttempts: 0,
    voiceAttempts: 0,
    errorStage: null,
    errorCode: null,
    errorRetryable: null,
    updatedAt: null,
  });
  const store: FakeStore = {
    unitRows,
    finalRows,
    messageRows,
    callRows,
    owner: 1,
    loadUnits: async () => [...unitRows.values()],
    loadFinals: async () => [...finalRows.entries()].map(([unitId, content]) => ({ unitId, tier: "paid" as const, content })),
    loadMessages: async () => messageRows.map(({ seq, topicId, text }) => ({ seq, topicId, text })),
    saveDraft: async (unit) => {
      if (unit.attempt !== store.owner) return false;
      const row = unitRows.get(unit.unitId) ?? blank(unit.unitId);
      if (row.status === "done") return false;
      unitRows.set(unit.unitId, { ...row, status: "drafted", draft: unit.draft, draftAttempts: row.draftAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
      return true;
    },
    saveFinal: async (unit) => {
      if (unit.attempt !== store.owner) return false;
      const row = unitRows.get(unit.unitId) ?? blank(unit.unitId);
      if (!finalRows.has(unit.unitId)) finalRows.set(unit.unitId, unit.content);
      unitRows.set(unit.unitId, { ...row, status: "done", voiceAttempts: row.voiceAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
      return true;
    },
    failUnit: async (unit) => {
      const row = unitRows.get(unit.unitId) ?? blank(unit.unitId);
      if (unit.attempt !== store.owner || row.status === "done") return { saved: false, draftAttempts: row.draftAttempts, voiceAttempts: row.voiceAttempts };
      const next = {
        ...row,
        status: "failed" as const,
        draftAttempts: row.draftAttempts + (unit.stage === "draft" ? 1 : 0),
        voiceAttempts: row.voiceAttempts + (unit.stage === "voice" ? 1 : 0),
        errorStage: unit.stage,
        errorCode: unit.code,
        errorRetryable: unit.retryable,
      };
      unitRows.set(unit.unitId, next);
      return { saved: true, draftAttempts: next.draftAttempts, voiceAttempts: next.voiceAttempts };
    },
    writeCall: async (row) => {
      callRows.push(row);
    },
    appendMessages: async ({ attempt, messages }) => {
      if (attempt !== store.owner) return false;
      if (messages.some((message) => messageRows.some((row) => row.seq === message.seq))) return false;
      messageRows.push(...messages);
      return true;
    },
  };
  return store;
}

// ─── 가짜 모델 ─────────────────────

export interface FakeModelOptions {
  /** 이 단위의 Pass 2 응답을 검사에 걸리게 만든다 (몇 번째 요청까지). */
  readonly badVoice?: { readonly unitId: string; readonly times: number };
  /** Pass 2 응답마다 이 시간만큼 시계를 앞으로 돌린다. */
  readonly advance?: { readonly clock: { now: number }; readonly ms: number };
}

export interface DraftInput {
  readonly units: { readonly unitId: string; readonly kind: "focus" | "topic" }[];
  readonly facts: { readonly ref: string }[];
  readonly questions: { readonly ref: string; readonly summary: string; readonly timingId: string | null }[];
  readonly timing: { readonly id: string; readonly status: string; readonly months: { readonly ref: string }[] }[];
  readonly topics: { readonly topicId: string; readonly target: number; readonly statements: { readonly ref: string }[] }[];
}

export function draftFixture(input: DraftInput) {
  const firstRef = input.topics.find((topic) => topic.statements.length)?.statements[0]?.ref ?? input.facts[0]!.ref;
  return {
    units: input.units.map((unit) => {
      if (unit.kind === "focus") {
        return {
          unitId: unit.unitId,
          coreAnswer: "[초안] 궁금한 점의 핵심 답이다.",
          points: input.questions.flatMap((question) => {
            const timing = input.timing.find((entry) => entry.id === question.timingId);
            const ref = timing?.months[0]?.ref ?? firstRef;
            return ["첫째", "둘째"].map((order) => ({ kind: "explanation", refs: [question.ref, ref], text: `[초안] ${question.ref} 질문의 ${order} 답이다.` }));
          }),
          notes: ["[초안] 궁금한 점 요약"],
        };
      }
      const topic = input.topics.find((entry) => entry.topicId === unit.unitId)!;
      return {
        unitId: unit.unitId,
        coreAnswer: `[초안] ${topic.topicId} 핵심 답이다.`,
        points: Array.from({ length: Math.max(topic.target, 2) }, (_, index) => ({
          kind: "explanation",
          refs: [topic.statements[index % Math.max(topic.statements.length, 1)]?.ref ?? input.facts[0]!.ref],
          text: `[초안] ${topic.topicId} 설명 문단 ${["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"][index] ?? "끝"}이다.`,
        })),
        notes: [`[초안] ${topic.topicId} 요약`],
      };
    }),
  };
}

export interface VoiceInput {
  readonly address: { readonly call: string; readonly name: string };
  readonly unit: { readonly unitId: string; readonly kind: "focus" | "topic" };
  readonly draft: { readonly points: { readonly kind: string; readonly refs: string[]; readonly text: string }[] };
  readonly frame: { readonly opening: boolean; readonly closing: boolean };
}

export function voiceFixture(input: VoiceInput, bad: boolean) {
  return {
    opening: input.frame.opening ? `[최종] ${input.address.call}, 시작한다.` : "",
    bubbles: input.draft.points.map((point, index) => ({
      kind: point.kind,
      // 검사에 걸리게 할 때는 초안에 없던 근거를 붙인다.
      refs: bad && index === 0 ? [...point.refs, "s999"] : point.refs,
      text: point.text.replace("[초안]", "[최종]"),
      highlight: "",
    })),
    closing: input.frame.closing ? "[최종] 더 궁금한 건 물어봐." : "",
  };
}

export function fakeModel(options: FakeModelOptions = {}) {
  const drafts: { instructions: string; input: string }[] = [];
  const voices: { instructions: string; input: string }[] = [];
  const voiceRounds = new Map<string, number>();
  const report = (request: { model: string; meter?: UsageMeter; onCall?: (log: LlmCallLog) => void }) => {
    request.meter?.record({ kind: "usage", usage: USAGE });
    const at = new Date(Date.UTC(2031, 0, 1)).toISOString();
    request.onCall?.({ startedAt: at, endedAt: at, outcome: "usage", usage: USAGE, requestedModel: request.model, actualModel: "fake-model", responseId: "resp", requestId: "req", errorCode: null });
  };
  const meta = (model: string) => ({ requestedModel: model, actualModel: "fake-model", responseId: "resp", usage: USAGE, durationMs: 1, calls: 1 });

  const stream = (async (request: Parameters<typeof callStructuredStream>[0]) => {
    drafts.push({ instructions: request.instructions, input: request.input });
    const text = JSON.stringify(draftFixture(JSON.parse(request.input) as DraftInput));
    // 조금씩 흘려보낸다. 스트림 수신 루프가 Pass 2를 기다리지 않는지 같이 본다.
    for (let end = 120; end < text.length; end += 120) {
      const decision = await request.onDelta?.(text.slice(0, end), text.slice(end - 120, end));
      if (decision === "stop") {
        report(request);
        return { parsed: null, text: text.slice(0, end), stopped: true, meta: meta(request.model) };
      }
    }
    report(request);
    return { parsed: JSON.parse(text), text, stopped: false, meta: meta(request.model) };
  }) as typeof callStructuredStream;

  const structured = (async (request: Parameters<typeof callStructured>[0]) => {
    voices.push({ instructions: request.instructions, input: request.input });
    const input = JSON.parse(request.input) as VoiceInput;
    const round = (voiceRounds.get(input.unit.unitId) ?? 0) + 1;
    voiceRounds.set(input.unit.unitId, round);
    const bad = options.badVoice?.unitId === input.unit.unitId && round <= options.badVoice.times;
    if (options.advance) options.advance.clock.now += options.advance.ms;
    report(request);
    return { parsed: voiceFixture(input, bad), meta: meta(request.model) };
  }) as typeof callStructured;

  return { drafts, voices, stream, structured };
}

export function newRun(input: {
  readonly plan: NarrationPlanV2;
  readonly chart: ReturnType<typeof casePlan>["chart"];
  readonly store: FakeStore;
  readonly model: ReturnType<typeof fakeModel>;
  readonly attempt?: number;
  readonly clock?: { now: number };
  readonly bundle?: MessengerBundle;
  readonly persona?: Persona;
  readonly meter?: UsageMeter;
  readonly exampleSources?: ConstructorParameters<typeof MessengerRun>[0]["deps"]["exampleSources"];
  readonly productId?: string;
}) {
  const clock = input.clock ?? { now: 0 };
  return new MessengerRun({
    deps: { callStructured: input.model.structured, callStructuredStream: input.model.stream, now: () => clock.now, store: input.store, exampleSources: input.exampleSources },
    bundle: input.bundle ?? BUNDLE,
    persona: input.persona ?? MYOMYO,
    plan: input.plan,
    excluded: [],
    chart: input.chart,
    readingId: READING,
    userId: USER,
    productId: input.productId ?? "first-overview",
    attempt: input.attempt ?? 1,
    modelId: "fake-model",
    reasoningEffort: "medium",
    startedAt: clock.now,
    meter: input.meter,
  });
}

