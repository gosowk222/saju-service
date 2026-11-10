import "server-only";
import type { Persona } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { checkFollowupV2, checkNarration, checkNarrationV2, type ExcludedQuestion, type FollowupCheckContext } from "@/domain/reading/check";
import { buildQuestionAnalysis, type QuestionAnalysis } from "@/domain/reading/question";
import type {
  ChartView,
  FollowupOutputV2,
  NarrationOutput,
  NarrationOutputV2,
  NarrationPlanV2,
  ReadingPlan,
  StoredMessage,
} from "@/domain/reading/types";
import { callStructured, LlmError, type LlmUsage } from "./client";
import { LLM_SETTINGS } from "./config";
import { buildFollowupPrompt, buildQuestionPrompt, getNarrationSchema, getReadingPrompt, type FollowupPromptArgs } from "./prompts";

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

/** 저장할 메시지 순서: 시작 → 궁금한 점에 대한 답 → 주제별 설명 → 마무리. */
export function toStoredMessages(output: NarrationOutput | NarrationOutputV2, focusSectionId = "focus"): StoredMessage[] {
  const messages: StoredMessage[] = [];
  const push = (message: Omit<StoredMessage, "seq">) => messages.push({ ...message, seq: messages.length + 1 });
  push({ topicId: null, kind: "transition", text: output.opening.trim(), refs: [] });
  if ("focus" in output) {
    for (const bubble of output.focus) push({ topicId: focusSectionId, kind: bubble.kind, text: bubble.text.trim(), refs: bubble.refs });
  }
  for (const topic of output.topics) {
    for (const bubble of topic.bubbles) {
      push({ topicId: topic.topicId, kind: bubble.kind, text: bubble.text.trim(), refs: bubble.refs });
    }
  }
  push({ topicId: null, kind: "transition", text: output.closing.trim(), refs: [] });
  return messages;
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
