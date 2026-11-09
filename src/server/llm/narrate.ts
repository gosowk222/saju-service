import "server-only";
import type { Persona } from "@/domain/personas";
import { checkFollowup, checkNarration } from "@/domain/reading/check";
import type { ChartView, FollowupOutput, NarrationOutput, ReadingPlan, StoredMessage } from "@/domain/reading/types";
import { callStructured, LlmError, type LlmUsage } from "./client";
import { LLM_SETTINGS } from "./config";
import { buildFollowupPrompt, getNarrationSchema, getReadingPrompt, type FollowupPromptArgs } from "./prompts";

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

function mergeUsage(total: LlmUsage | null, next: LlmUsage): LlmUsage {
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

/** 말풍선 하나마다 호출하지 않고, 한 번에 전체 구조를 받아 검사한다. 재시도는 설정한 횟수까지만 한다. */
export async function narrateReading(input: {
  readonly plan: ReadingPlan;
  readonly chart: ChartView;
  readonly persona: Persona;
  readonly config: GenerationConfig;
}): Promise<{ readonly output: NarrationOutput; readonly meta: GenerationMeta }> {
  const { plan, chart, persona, config } = input;
  const prompt = getReadingPrompt(config.promptVersion);
  const schema = getNarrationSchema(config.schemaVersion);
  const startedAt = Date.now();
  let previousIssues: string[] = [];
  let usage: LlmUsage | null = null;
  let calls = 0;
  let issueCount = 0;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    const { instructions, input: promptInput } = prompt({ plan, persona, previousIssues });
    let result;
    try {
      result = await callStructured({
        model: config.modelId,
        instructions,
        input: promptInput,
        schemaName: schema.name,
        jsonSchema: schema.jsonSchema,
        parser: schema.parser,
        maxOutputTokens: LLM_SETTINGS.maxOutputTokens.reading,
        reasoningEffort: config.reasoningEffort,
      });
    } catch (error) {
      if (error instanceof LlmError) throw new LlmError(error.code, error.message, calls + error.calls);
      throw error;
    }
    calls += result.meta.calls;
    usage = mergeUsage(usage, result.meta.usage);

    const issues = checkNarration(result.parsed, plan, chart);
    issueCount += issues.length;
    if (issues.length === 0) {
      return {
        output: result.parsed,
        meta: {
          actualModel: result.meta.actualModel,
          usage,
          durationMs: Date.now() - startedAt,
          llmCalls: calls,
          issueCount,
        },
      };
    }
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", `검사를 통과하지 못했습니다 (${previousIssues.length}건).`, calls);
}

export function toStoredMessages(output: NarrationOutput): StoredMessage[] {
  const messages: StoredMessage[] = [];
  const push = (message: Omit<StoredMessage, "seq">) => messages.push({ ...message, seq: messages.length + 1 });
  push({ topicId: null, kind: "transition", text: output.opening.trim(), refs: [] });
  for (const topic of output.topics) {
    for (const bubble of topic.bubbles) {
      push({ topicId: topic.topicId, kind: bubble.kind, text: bubble.text.trim(), refs: bubble.refs });
    }
  }
  push({ topicId: null, kind: "transition", text: output.closing.trim(), refs: [] });
  return messages;
}

export async function answerFollowup(
  input: Omit<FollowupPromptArgs, "previousIssues"> & {
    readonly chart: ChartView;
    readonly modelId: string;
  },
): Promise<{ readonly output: FollowupOutput; readonly meta: GenerationMeta }> {
  const startedAt = Date.now();
  let previousIssues: string[] = [];
  let usage: LlmUsage | null = null;
  let calls = 0;

  for (let round = 0; round <= LLM_SETTINGS.validationRetries; round += 1) {
    const prompt = buildFollowupPrompt({ ...input, previousIssues });
    const result = await callStructured({
      model: input.modelId,
      instructions: prompt.instructions,
      input: prompt.input,
      schemaName: prompt.schemaName,
      jsonSchema: prompt.jsonSchema,
      parser: prompt.parser,
      maxOutputTokens: LLM_SETTINGS.maxOutputTokens.followup,
      reasoningEffort: LLM_SETTINGS.reasoningEffort,
    });
    calls += result.meta.calls;
    usage = mergeUsage(usage, result.meta.usage);

    const issues = checkFollowup(result.parsed, input.plan, input.chart);
    if (issues.length === 0) {
      return {
        output: result.parsed,
        meta: { actualModel: result.meta.actualModel, usage, durationMs: Date.now() - startedAt, llmCalls: calls, issueCount: 0 },
      };
    }
    previousIssues = issues;
  }
  throw new LlmError("validation_failed", "후속 답변이 검사를 통과하지 못했습니다.", calls);
}
