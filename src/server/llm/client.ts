import "server-only";
import OpenAI from "openai";
import type { z } from "zod";
import { LLM_SETTINGS, LlmConfigError, liveCallBlockReason, requireApiKey } from "./config";

/** OpenAI 호출은 이 모듈만 한다. 화면, 규칙, 결제 코드는 SDK를 직접 쓰지 않는다. */

export type LlmErrorCode =
  | "model_not_configured"
  | "live_call_blocked"
  | "model_not_found"
  | "permission_denied"
  | "auth_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "connection"
  | "server_error"
  | "bad_request"
  | "refused"
  | "incomplete"
  | "empty_response"
  | "invalid_output"
  | "validation_failed";

/** 코드나 설정을 고치기 전까지 다시 시도해도 소용없는 오류. */
const CONFIGURATION_ERRORS: ReadonlySet<LlmErrorCode> = new Set([
  "model_not_configured",
  "live_call_blocked",
  "model_not_found",
  "permission_denied",
  "auth_failed",
  "bad_request",
]);

const RETRYABLE_TRANSPORT: ReadonlySet<LlmErrorCode> = new Set(["rate_limited", "timeout", "connection", "server_error"]);

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly calls = 1,
    /** 검사 실패 내용. 생성 문장 일부가 들어 있어 서버 로그에는 남기지 않는다 (개발 스크립트에서만 출력). */
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
  get isConfigurationError(): boolean {
    return CONFIGURATION_ERRORS.has(this.code);
  }
}

export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export interface StructuredResult<T> {
  readonly parsed: T;
  readonly meta: {
    readonly requestedModel: string;
    readonly actualModel: string | null;
    readonly responseId: string | null;
    readonly usage: LlmUsage;
    readonly durationMs: number;
    readonly calls: number;
  };
}

export interface StructuredRequest<T> {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly parser: z.ZodType<T>;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: string;
  /** 요청 한 번의 시간 제한. 없으면 기본값을 쓴다. */
  readonly timeoutMs?: number;
  /** 이 시각(epoch ms)을 넘길 재시도는 하지 않는다. */
  readonly deadlineAt?: number;
}

let activeCalls = 0;
const waiters: (() => void)[] = [];

async function withConcurrencyLimit<R>(task: () => Promise<R>): Promise<R> {
  if (activeCalls >= LLM_SETTINGS.concurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeCalls += 1;
  try {
    return await task();
  } finally {
    activeCalls -= 1;
    waiters.shift()?.();
  }
}

export function classifyProviderError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof LlmConfigError) return new LlmError("model_not_configured", error.message, 0);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new LlmError("timeout", "요청 시간이 초과되었습니다.");
  if (error instanceof OpenAI.APIUserAbortError) return new LlmError("timeout", "요청이 중단되었습니다.");
  if (error instanceof OpenAI.APIConnectionError) return new LlmError("connection", "OpenAI에 연결하지 못했습니다.");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401) return new LlmError("auth_failed", "OpenAI 인증에 실패했습니다.");
    if (status === 403) return new LlmError("permission_denied", "이 API 프로젝트에 모델 접근 권한이 없습니다.");
    if (status === 404) return new LlmError("model_not_found", "모델을 찾을 수 없습니다.");
    if (status === 429) {
      return error.code === "insufficient_quota"
        ? new LlmError("quota_exceeded", "OpenAI 사용 한도를 초과했습니다.")
        : new LlmError("rate_limited", "요청 한도에 걸렸습니다.");
    }
    if (status === 400 && error.code === "model_not_found") return new LlmError("model_not_found", "모델을 찾을 수 없습니다.");
    if (status !== undefined && status >= 500) return new LlmError("server_error", "OpenAI 서버 오류입니다.");
    return new LlmError("bad_request", "요청 형식이 거부되었습니다.");
  }
  return new LlmError("server_error", "알 수 없는 호출 오류입니다.");
}

function readUsage(usage: OpenAI.Responses.ResponseUsage | undefined): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
  };
}

function extractOutputText(response: OpenAI.Responses.Response): string {
  if (response.status === "incomplete") {
    throw new LlmError("incomplete", `응답이 완료되지 않았습니다: ${response.incomplete_details?.reason ?? "unknown"}`);
  }
  if (response.status !== "completed") {
    throw new LlmError("server_error", `응답 상태가 비정상입니다: ${response.status}`);
  }
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "refusal") throw new LlmError("refused", "모델이 응답을 거절했습니다.");
    }
  }
  const text = response.output_text;
  if (!text?.trim()) throw new LlmError("empty_response", "응답이 비어 있습니다.");
  return text;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_TIMEOUT_MS = 120_000;

function createClient(): OpenAI {
  const blocked = liveCallBlockReason();
  if (blocked) throw new LlmError("live_call_blocked", blocked, 0);
  // SDK 자체 재시도는 끄고 아래에서 한 번만 관리한다.
  return new OpenAI({ apiKey: requireApiKey(), maxRetries: 0, timeout: DEFAULT_TIMEOUT_MS });
}

export async function callStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const startedAt = Date.now();
  let calls = 0;
  let client: OpenAI;
  try {
    client = createClient();
  } catch (error) {
    throw classifyProviderError(error);
  }

  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      calls += 1;
      // temperature 등 모델 문서에서 확인하지 않은 옵션은 보내지 않는다.
      const response = await withConcurrencyLimit(() =>
        client.responses.create(
          {
            model: request.model,
            instructions: request.instructions,
            input: request.input,
            store: false,
            max_output_tokens: request.maxOutputTokens,
            reasoning: { effort: request.reasoningEffort as "low" },
            text: {
              format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: true },
            },
          },
          { timeout },
        ),
      );

      const text = extractOutputText(response);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError("invalid_output", "JSON을 해석할 수 없습니다.");
      }
      const parsed = request.parser.safeParse(json);
      if (!parsed.success) throw new LlmError("invalid_output", "출력 형식이 맞지 않습니다.");

      return {
        parsed: parsed.data,
        meta: {
          requestedModel: request.model,
          actualModel: response.model ?? null,
          responseId: response.id ?? null,
          usage: readUsage(response.usage),
          durationMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      const classified = classifyProviderError(error);
      const backoff = 500 * 2 ** attempt;
      const fitsDeadline = request.deadlineAt === undefined || Date.now() + backoff + timeout <= request.deadlineAt;
      if (RETRYABLE_TRANSPORT.has(classified.code) && attempt < LLM_SETTINGS.transportRetries && fitsDeadline) {
        await delay(backoff);
        continue;
      }
      throw new LlmError(classified.code, classified.message, calls);
    }
  }
}

export interface StreamedResult<T> {
  /** 끝까지 받고 형식이 맞으면 결과. 중간에 끊었거나 형식이 맞지 않으면 null. */
  readonly parsed: T | null;
  readonly text: string;
  /** onDelta가 멈추라고 해서 중간에 끊었는지. */
  readonly stopped: boolean;
  readonly meta: StructuredResult<T>["meta"];
}

const UNKNOWN_USAGE: LlmUsage = { inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, cachedInputTokens: null };

/** onDelta 안에서 난 오류. 호출 오류로 분류하지 않고 그대로 돌려준다. */
class DeltaHandlerFailure {
  constructor(readonly cause: unknown) {}
}

export const isRetryableTransport = (code: LlmErrorCode) => RETRYABLE_TRANSPORT.has(code);

/**
 * callStructured와 같은 요청을 스트리밍으로 받는다. 호출 수는 같다 (한 번).
 * 글자가 들어올 때마다 onDelta를 부르고, "stop"을 돌려받으면 생성을 끊는다 (끊은 호출은 사용량을 알 수 없다).
 * 글자를 받기 전의 네트워크·일시 오류만 다시 시도한다. 받기 시작한 뒤의 오류는 호출한 쪽이 이어 쓰기로 처리한다.
 */
export async function callStructuredStream<T>(
  request: StructuredRequest<T> & { readonly onDelta: (text: string, delta: string) => Promise<"continue" | "stop"> },
): Promise<StreamedResult<T>> {
  const startedAt = Date.now();
  let calls = 0;
  let client: OpenAI;
  try {
    client = createClient();
  } catch (error) {
    throw classifyProviderError(error);
  }

  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    let received = false;
    // SDK의 timeout은 응답 헤더까지만 본다. 스트림 전체 시간은 여기서 끊는다.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      calls += 1;
      const streamed = await withConcurrencyLimit(async () => {
        const stream = await client.responses.create(
          {
            model: request.model,
            instructions: request.instructions,
            input: request.input,
            store: false,
            max_output_tokens: request.maxOutputTokens,
            reasoning: { effort: request.reasoningEffort as "low" },
            text: {
              format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: true },
            },
            stream: true,
          },
          { timeout, signal: controller.signal },
        );
        let text = "";
        let final: OpenAI.Responses.Response | null = null;
        let stopped = false;
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            received = true;
            text += event.delta;
            let decision: "continue" | "stop";
            try {
              decision = await request.onDelta(text, event.delta);
            } catch (cause) {
              throw new DeltaHandlerFailure(cause);
            }
            if (decision === "stop") {
              // 반복을 멈추면 SDK가 요청을 끊는다.
              stopped = true;
              break;
            }
          } else if (event.type === "response.refusal.delta") {
            throw new LlmError("refused", "모델이 응답을 거절했습니다.");
          } else if (event.type === "response.completed") {
            final = event.response;
          } else if (event.type === "response.incomplete") {
            throw new LlmError("incomplete", `응답이 완료되지 않았습니다: ${event.response.incomplete_details?.reason ?? "unknown"}`);
          } else if (event.type === "response.failed") {
            throw new LlmError("server_error", "응답 생성에 실패했습니다.");
          } else if (event.type === "error") {
            throw new LlmError("server_error", `응답 중 오류가 났습니다: ${event.code ?? "unknown"}`);
          }
        }
        return { text, final, stopped };
      });

      const final = streamed.final as OpenAI.Responses.Response | null;
      if (!streamed.stopped && !final) throw new LlmError("incomplete", "응답이 끝까지 오지 않았습니다.");
      let parsed: T | null = null;
      if (!streamed.stopped) {
        try {
          const result = request.parser.safeParse(JSON.parse(streamed.text));
          parsed = result.success ? result.data : null;
        } catch {
          parsed = null;
        }
      }
      return {
        parsed,
        text: streamed.text,
        stopped: streamed.stopped,
        meta: {
          requestedModel: request.model,
          actualModel: final?.model ?? null,
          responseId: final?.id ?? null,
          usage: final ? readUsage(final.usage) : UNKNOWN_USAGE,
          durationMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      if (error instanceof DeltaHandlerFailure) throw error.cause;
      const classified = classifyProviderError(error);
      const backoff = 500 * 2 ** attempt;
      const fitsDeadline = request.deadlineAt === undefined || Date.now() + backoff + timeout <= request.deadlineAt;
      if (!received && RETRYABLE_TRANSPORT.has(classified.code) && attempt < LLM_SETTINGS.transportRetries && fitsDeadline) {
        await delay(backoff);
        continue;
      }
      throw new LlmError(classified.code, classified.message, calls);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 설정 확인용 최소 호출. 모델 접근 가능 여부만 확인한다. */
export async function pingModel(model: string): Promise<{ actualModel: string | null; usage: LlmUsage }> {
  const client = createClient();
  const response = await client.responses.create({
    model,
    input: "OK라고만 답하세요.",
    store: false,
    max_output_tokens: 64,
    reasoning: { effort: LLM_SETTINGS.reasoningEffort },
  });
  return { actualModel: response.model ?? null, usage: readUsage(response.usage) };
}
