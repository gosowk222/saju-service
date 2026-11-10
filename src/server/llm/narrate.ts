import "server-only";
import type { Persona } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { z } from "zod";
import {
  checkFollowupV2,
  checkNarration,
  checkNarrationV2,
  narrationChecker,
  type ExcludedQuestion,
  type FollowupCheckContext,
} from "@/domain/reading/check";
import { emphasizeGroup, tidyEmphasis } from "@/domain/reading/emphasis";
import { buildQuestionAnalysis, type QuestionAnalysis } from "@/domain/reading/question";
import type {
  ChartView,
  FollowupOutputV2,
  NarrationBubble,
  NarrationOutput,
  NarrationOutputV2,
  NarrationPlanV2,
  NarrationTopic,
  ReadingPlan,
  StoredMessage,
} from "@/domain/reading/types";
import { callStructured, callStructuredStream, isRetryableTransport, LlmError, type LlmUsage, type StreamedResult } from "./client";
import { LLM_SETTINGS } from "./config";
import { buildFollowupPrompt, buildQuestionPrompt, getNarrationSchema, getReadingPrompt, type FollowupPromptArgs } from "./prompts";
import { completedParts, type StreamedParts } from "./stream-parts";

export interface GenerationConfig {
  readonly modelId: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly reasoningEffort: string;
}

export interface GenerationMeta {
  readonly actualModel: string | null;
  readonly usage: LlmUsage;
  readonly durationMs: number;
  readonly llmCalls: number;
  readonly issueCount: number;
}

export function mergeUsage(total: LlmUsage | null, next: LlmUsage): LlmUsage {
  if (!total) return next;
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: add(total.inputTokens, next.inputTokens),
    outputTokens: add(total.outputTokens, next.outputTokens),
    totalTokens: add(total.totalTokens, next.totalTokens),
    reasoningTokens: add(total.reasoningTokens, next.reasoningTokens),
    cachedInputTokens: add(total.cachedInputTokens, next.cachedInputTokens),
  };
}

export type NarrationInput =
  | { readonly version: "1.0.0"; readonly plan: ReadingPlan }
  | { readonly version: "2.0.0"; readonly plan: NarrationPlanV2; readonly excluded: readonly ExcludedQuestion[] };

/**
 * 말풍선 하나마다 호출하지 않고, 한 번에 전체 구조를 받아 검사한다.
 * 검사에 실패하면 문제 목록을 붙여 설정한 횟수까지만 다시 생성한다.
 */
export async function narrateReading(input: {
  readonly narration: NarrationInput;
  readonly chart: ChartView;
  readonly persona: Persona;
  readonly config: GenerationConfig;
  readonly deadlineAt?: number;
}): Promise<{ readonly output: NarrationOutput | NarrationOutputV2; readonly meta: GenerationMeta }> {
  const { narration, chart, persona, config, deadlineAt } = input;
  const prompt = getReadingPrompt(config.promptVersion);
  const schema = getNarrationSchema(config.schemaVersion);
  const task = LLM_SETTINGS.tasks.reading;
  const startedAt = Date.now();
  let previousIssues: string[] = [];
  let usage: LlmUsage | null = null;
  let calls = 0;
  let issueCount = 0;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    if (round > 0 && deadlineAt !== undefined && Date.now() + task.timeoutMs > deadlineAt) break;
    const { instructions, input: promptInput } = prompt({ plan: narration.plan as never, persona, previousIssues });
    let result;
    try {
      result = await callStructured({
        model: config.modelId,
        instructions,
        input: promptInput,
        schemaName: schema.name,
        jsonSchema: schema.jsonSchema,
        parser: schema.parser,
        maxOutputTokens: task.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: task.timeoutMs,
        deadlineAt,
      });
    } catch (error) {
      if (error instanceof LlmError) throw new LlmError(error.code, error.message, calls + error.calls, error.details);
      throw error;
    }
    calls += result.meta.calls;
    usage = mergeUsage(usage, result.meta.usage);

    const issues =
      narration.version === "2.0.0"
        ? checkNarrationV2(result.parsed as NarrationOutputV2, narration.plan, chart, narration.excluded)
        : checkNarration(result.parsed as NarrationOutput, narration.plan, chart);
    issueCount += issues.length;
    if (issues.length === 0) {
      return {
        output: result.parsed,
        meta: { actualModel: result.meta.actualModel, usage, durationMs: Date.now() - startedAt, llmCalls: calls, issueCount },
      };
    }
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", `검사를 통과하지 못했습니다 (${previousIssues.length}건).`, calls, previousIssues);
}

export type NewMessage = Omit<StoredMessage, "seq">;

export const openingMessage = (text: string): NewMessage => ({ topicId: null, kind: "transition", text: tidyEmphasis(text), refs: [] });
export const closingMessage = openingMessage;

/** 굵게 보이는 구절은 답변 영역에서 질문 수에 맞춰(말풍선 세 개에 하나 정도) 둔다. */
export function focusMessages(bubbles: readonly NarrationBubble[], focusSectionId: string): NewMessage[] {
  const texts = emphasizeGroup(bubbles, Math.max(2, Math.ceil(bubbles.length / 3)));
  return bubbles.map((bubble, index) => ({ topicId: focusSectionId, kind: bubble.kind, text: texts[index]!, refs: bubble.refs }));
}

/** 주제마다 굵게 보이는 구절은 2개까지. */
export function topicMessages(topic: NarrationTopic): NewMessage[] {
  const texts = emphasizeGroup(topic.bubbles, 2);
  return topic.bubbles.map((bubble, index) => ({ topicId: topic.topicId, kind: bubble.kind, text: texts[index]!, refs: bubble.refs }));
}

/** 저장할 메시지 순서: 시작 → 궁금한 점에 대한 답 → 주제별 설명 → 마무리. */
export function toStoredMessages(output: NarrationOutput | NarrationOutputV2, focusSectionId = "focus"): StoredMessage[] {
  const messages: NewMessage[] = [
    openingMessage(output.opening),
    ...("focus" in output ? focusMessages(output.focus, focusSectionId) : []),
    ...output.topics.flatMap(topicMessages),
    closingMessage(output.closing),
  ];
  return messages.map((message, index) => ({ ...message, seq: index + 1 }));
}

// ─── 주제가 완성될 때마다 먼저 보여 주는 생성 (reading-2.4.0) ─────────────────

/** 이미 화면에 보낸 부분. 저장된 메시지에서 다시 만들고, 굵게 표시는 뺀다. */
export interface SentParts {
  readonly opening: string | null;
  readonly focus: readonly string[];
  readonly topics: readonly { readonly topicId: string; readonly texts: readonly string[] }[];
}

const plain = (text: string) => text.replace(/\*\*/g, "");

export function sentPartsFrom(messages: readonly Pick<StoredMessage, "topicId" | "text">[], focusSectionId: string): SentParts {
  const topics: { topicId: string; texts: string[] }[] = [];
  let opening: string | null = null;
  const focus: string[] = [];
  for (const message of messages) {
    if (message.topicId === null) opening ??= plain(message.text);
    else if (message.topicId === focusSectionId) focus.push(plain(message.text));
    else {
      const last = topics.find((topic) => topic.topicId === message.topicId);
      if (last) last.texts.push(plain(message.text));
      else topics.push({ topicId: message.topicId, texts: [plain(message.text)] });
    }
  }
  return { opening, focus, topics };
}

const PartBubble = z.object({
  kind: z.enum(["explanation", "creative-scene", "transition"]),
  refs: z.array(z.string()),
  text: z.string(),
  highlight: z.string().default(""),
});
const PartTopic = z.object({ topicId: z.string(), bubbles: z.array(PartBubble) });

/**
 * 한 번의 호출을 스트리밍으로 받으며, 인사 → 궁금한 점에 대한 답 → 주제 순서로 완성된 부분을 검사해 바로 저장한다(commit).
 * 검사에 걸리면 그 자리에서 생성을 끊고, 이미 보낸 부분은 그대로 둔 채 나머지만 이어 쓰게 다시 요청한다.
 * 호출 수와 재시도 횟수는 한 번에 받는 방식과 같다. 마무리 말풍선은 완료 저장 때 함께 저장하도록 돌려준다.
 */
export async function narrateReadingProgressive(input: {
  readonly plan: NarrationPlanV2;
  readonly excluded: readonly ExcludedQuestion[];
  readonly chart: ChartView;
  readonly persona: Persona;
  readonly config: GenerationConfig;
  readonly deadlineAt?: number;
  /** 이전 시도에서 이미 보낸 부분. */
  readonly sent: SentParts;
  /** 검사를 통과한 부분을 저장한다. 이 작업이 더는 이 풀이를 맡지 않으면 오류를 던진다. */
  readonly commit: (messages: readonly NewMessage[]) => Promise<void>;
  readonly stream?: typeof callStructuredStream;
}): Promise<{ readonly closing: NewMessage; readonly meta: GenerationMeta }> {
  const { plan, excluded, chart, persona, config, deadlineAt } = input;
  const callStream = input.stream ?? callStructuredStream;
  const prompt = getReadingPrompt(config.promptVersion);
  const schema = getNarrationSchema(config.schemaVersion);
  const task = LLM_SETTINGS.tasks.reading;
  const startedAt = Date.now();
  const checker = narrationChecker(plan, chart, excluded);
  const focusNeeded = plan.questions.length > 0;

  let opening = input.sent.opening;
  let focus = [...input.sent.focus];
  const topics = input.sent.topics.map((topic) => ({ topicId: topic.topicId, texts: [...topic.texts] }));
  for (const text of [opening ?? "", ...focus, ...topics.flatMap((topic) => topic.texts)]) if (text) checker.remember(text);
  const isSent = (topicId: string) => topics.some((topic) => topic.topicId === topicId);
  const nextTopic = () => plan.topics.find((topic) => !isSent(topic.topicId))?.topicId ?? null;

  let previousIssues: string[] = [];
  let usage: LlmUsage | null = null;
  let actualModel: string | null = null;
  let calls = 0;
  let issueCount = 0;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    if (round > 0 && deadlineAt !== undefined && Date.now() + task.timeoutMs > deadlineAt) break;
    const alreadySent = opening !== null || focus.length || topics.length ? { opening, focus, topics } : null;
    const { instructions, input: promptInput } = prompt({ plan, persona, previousIssues, alreadySent } as never);
    const issues: string[] = [];
    let openingSeen = false;
    let focusSeen = false;
    let topicsSeen = 0;
    let progressed = false;
    const stop = (...found: string[]): "stop" => {
      issues.push(...found);
      return "stop";
    };
    const send = async (messages: readonly NewMessage[]) => {
      await input.commit(messages);
      progressed = true;
    };

    // 화면에 보이는 순서를 지킨다. 앞 부분이 끝나기 전에는 뒤 부분을 보내지 않는다.
    const handle = async (parts: StreamedParts): Promise<"continue" | "stop"> => {
      if (!openingSeen) {
        if (parts.opening === undefined) return "continue";
        openingSeen = true;
        if (opening === null) {
          const found = [...checker.frame(parts.opening), ...checker.excluded([parts.opening])];
          if (found.length) return stop(...found);
          await send([openingMessage(parts.opening)]);
          opening = parts.opening;
        }
      }
      if (!focusSeen) {
        if (parts.focus === undefined) return "continue";
        focusSeen = true;
        // 질문이 없을 때 모델이 답변 영역을 써도 보여 주지 않는다.
        if (focusNeeded && !focus.length) {
          const parsed = z.array(PartBubble).safeParse(parts.focus);
          if (!parsed.success) return stop("궁금한 점에 대한 답의 형식이 맞지 않습니다.");
          const found = [...checker.focus(parsed.data), ...checker.excluded(parsed.data.map((bubble) => bubble.text))];
          if (found.length) return stop(...found);
          await send(focusMessages(parsed.data, plan.focusSection.id));
          focus = parsed.data.map((bubble) => bubble.text);
        }
      }
      while (topicsSeen < parts.topics.length) {
        const parsed = PartTopic.safeParse(parts.topics[topicsSeen]);
        topicsSeen += 1;
        if (!parsed.success) return stop("주제의 형식이 맞지 않습니다.");
        const topic = parsed.data;
        if (isSent(topic.topicId)) continue;
        const expected = nextTopic();
        if (topic.topicId !== expected) return stop(`주제 순서가 다릅니다: ${expected ?? "없음"} 차례에 ${topic.topicId}를 썼습니다.`);
        const found = [...checker.topic(topic), ...checker.excluded(topic.bubbles.map((bubble) => bubble.text))];
        if (found.length) return stop(...found);
        await send(topicMessages(topic));
        topics.push({ topicId: topic.topicId, texts: topic.bubbles.map((bubble) => bubble.text) });
      }
      return "continue";
    };

    let result: StreamedResult<NarrationOutputV2>;
    try {
      result = await callStream({
        model: config.modelId,
        instructions,
        input: promptInput,
        schemaName: schema.name,
        jsonSchema: schema.jsonSchema,
        parser: schema.parser as z.ZodType<NarrationOutputV2>,
        maxOutputTokens: task.maxOutputTokens,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: task.timeoutMs,
        deadlineAt,
        // 닫는 따옴표나 괄호가 들어온 때만 다시 읽는다.
        onDelta: (text, delta) => (/["}\]]/.test(delta) ? handle(completedParts(text)) : Promise.resolve("continue")),
      });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      calls += error.calls;
      // 이번 호출에서 일부를 보낸 뒤 끊긴 일시 오류만 보낸 부분을 두고 이어 쓴다. 아무것도 못 보냈으면 예전처럼 오류로 끝낸다.
      if (progressed && isRetryableTransport(error.code) && round < LLM_SETTINGS.validationRetries) continue;
      throw new LlmError(error.code, error.message, calls, error.details);
    }
    calls += result.meta.calls;
    usage = mergeUsage(usage, result.meta.usage);
    actualModel = result.meta.actualModel ?? actualModel;

    if (!result.stopped && !issues.length) await handle(completedParts(result.text));
    if (!issues.length) {
      const missing = [
        ...(opening === null ? ["시작 인사"] : []),
        ...(focusNeeded && !focus.length ? ["궁금한 점에 대한 답"] : []),
        ...plan.topics.filter((topic) => !isSent(topic.topicId)).map((topic) => topic.topicId),
      ];
      if (missing.length) issues.push(`아직 쓰지 않은 부분이 있습니다: ${missing.join(", ")}`);
    }
    if (!issues.length) {
      const closing = completedParts(result.text).closing;
      if (closing === undefined) issues.push("마무리 말풍선이 없습니다.");
      else issues.push(...checker.frame(closing), ...checker.excluded([closing]));
      if (!issues.length && closing !== undefined) {
        // 전체 말풍선 수는 이미 보낸 뒤라 고칠 수 없다. 범위를 벗어나면 기록만 한다.
        const total = 2 + focus.length + topics.reduce((sum, topic) => sum + topic.texts.length, 0);
        const outside = total < plan.length.totalBubbles.min || total > plan.length.totalBubbles.max ? 1 : 0;
        return {
          closing: closingMessage(closing),
          meta: { actualModel, usage: usage!, durationMs: Date.now() - startedAt, llmCalls: calls, issueCount: issueCount + outside },
        };
      }
    }
    issueCount += issues.length;
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", `검사를 통과하지 못했습니다 (${previousIssues.length}건).`, calls, previousIssues);
}

/**
 * 궁금한 점이나 후속 질문을 구조화한다. 비어 있는 문장은 호출하지 않는다(호출하는 쪽에서 emptyAnalysis를 쓴다).
 * 형식이 맞지 않는 출력은 한 번만 다시 받고, 그래도 실패하면 오류로 돌려준다.
 */
export async function classifyQuestion(input: {
  readonly product: ProductDefinition;
  readonly referenceDate: string;
  readonly mode: "initial" | "followup";
  readonly text: string;
  readonly lastTurn: { readonly question: string; readonly answer: string } | null;
  readonly modelId: string;
  readonly deadlineAt?: number;
}): Promise<{ readonly analysis: QuestionAnalysis; readonly meta: GenerationMeta }> {
  const startedAt = Date.now();
  const task = LLM_SETTINGS.tasks.classify;
  const prompt = buildQuestionPrompt(input);
  const result = await callStructured({
    model: input.modelId,
    instructions: prompt.instructions,
    input: prompt.input,
    schemaName: prompt.schemaName,
    jsonSchema: prompt.jsonSchema,
    parser: prompt.parser,
    maxOutputTokens: task.maxOutputTokens,
    reasoningEffort: task.reasoningEffort,
    timeoutMs: task.timeoutMs,
    deadlineAt: input.deadlineAt,
  });
  return {
    analysis: buildQuestionAnalysis(input.product, input.referenceDate, result.parsed),
    meta: { actualModel: result.meta.actualModel, usage: result.meta.usage, durationMs: Date.now() - startedAt, llmCalls: result.meta.calls, issueCount: 0 },
  };
}

export async function answerFollowup(
  input: Omit<FollowupPromptArgs, "previousIssues"> & {
    readonly chart: ChartView;
    readonly modelId: string;
    readonly check: FollowupCheckContext;
    readonly deadlineAt?: number;
  },
): Promise<{ readonly output: FollowupOutputV2; readonly meta: GenerationMeta }> {
  const startedAt = Date.now();
  const task = LLM_SETTINGS.tasks.followup;
  let previousIssues: string[] = [];
  let usage: LlmUsage | null = null;
  let calls = 0;
  let issueCount = 0;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    if (round > 0 && input.deadlineAt !== undefined && Date.now() + task.timeoutMs > input.deadlineAt) break;
    const prompt = buildFollowupPrompt({ ...input, previousIssues });
    const result = await callStructured({
      model: input.modelId,
      instructions: prompt.instructions,
      input: prompt.input,
      schemaName: prompt.schemaName,
      jsonSchema: prompt.jsonSchema,
      parser: prompt.parser,
      maxOutputTokens: task.maxOutputTokens,
      reasoningEffort: task.reasoningEffort,
      timeoutMs: task.timeoutMs,
      deadlineAt: input.deadlineAt,
    });
    calls += result.meta.calls;
    usage = mergeUsage(usage, result.meta.usage);

    const issues = checkFollowupV2(result.parsed, input.check, input.chart);
    issueCount += issues.length;
    if (issues.length === 0) {
      return {
        output: result.parsed,
        meta: { actualModel: result.meta.actualModel, usage, durationMs: Date.now() - startedAt, llmCalls: calls, issueCount },
      };
    }
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", "후속 답변이 검사를 통과하지 못했습니다.", calls, previousIssues);
}
