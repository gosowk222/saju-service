import "server-only";
import OpenAI from "openai";
import type { z } from "zod";
import { LLM_SETTINGS, LlmConfigError, liveCallBlockReason, requireApiKey } from "./config";
import type { LlmUsage, UsageMeter, UsageRecord } from "./usage";

export type { LlmUsage } from "./usage";

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

/**
 * HTTP 요청 한 번(전송 재시도는 각각 한 번)의 기록. 호출 단위 사용량 표(llm_calls)에 태그와 함께 저장한다 (call-log.ts).
 * 생성 문장, 지시, 입력 원문은 담지 않는다.
 */
export interface LlmCallLog {
  /** 요청을 보낸 시각 (ISO). 동시 호출 제한을 기다린 시간은 넣지 않는다. */
  readonly startedAt: string;
  /** 응답·오류·중단으로 그 요청의 결과가 정해진 시각 (ISO). 다시 시도하기 전 대기 시간은 넣지 않는다. */
  readonly endedAt: string;
  /**
   * UsageMeter 기록 종류와 같다. usage: API가 usage를 돌려줌, rejected: API가 오류 응답(4xx·5xx)을 돌려 생성하지 않음,
   * unknown: 끊김·중단·시간 초과·onDelta의 stop처럼 usage를 받지 못함 (토큰이 쓰였을 수 있다).
   */
  readonly outcome: "usage" | "unknown" | "rejected";
  /** API가 돌려준 값 그대로. 받지 못했으면 null (0으로 채우지 않는다). */
  readonly usage: LlmUsage | null;
  readonly requestedModel: string;
  /** 응답(스트림은 응답 이벤트)에 적힌 실제 모델. */
  readonly actualModel: string | null;
  /** 공급자 응답 ID. 스트림은 시작 이벤트에서 받으므로 중간에 끊은 호출에도 남을 수 있다. */
  readonly responseId: string | null;
  /** 공급자 요청 ID (x-request-id 헤더). SDK의 응답 `_request_id`, `withResponse().request_id`, `APIError.requestID`에서 읽는다. */
  readonly requestId: string | null;
  /** 이 요청 시도의 오류 코드. 응답을 받은 뒤 형식 오류로 실패해도 usage는 그대로 두고 이 값을 채운다. 성공이면 null. */
  readonly errorCode: LlmErrorCode | null;
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
  /** 요청마다 사용량을 기록한다. 응답을 받은 뒤 실패해도(형식 오류, 미완료) 받은 usage는 남는다. */
  readonly meter?: UsageMeter;
  /**
   * HTTP 요청 시도마다(전송 재시도 포함) 정확히 한 번 부른다. 결과 종류는 meter 기록과 같은 기준이고, 오류 코드는 그 시도가 끝날 때 채운다.
   * 안에서 난 예외(비동기 거부 포함)는 무시하므로 호출 흐름·재시도·반환값이 바뀌지 않는다. 요청을 보내지 못한 경우(설정 오류, 실제 호출 차단)는 부르지 않는다.
   */
  readonly onCall?: (log: LlmCallLog) => void;
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

/** API가 돌려준 usage. usage 자체가 없으면 null (0으로 채우지 않는다). */
function readUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): LlmUsage | null {
  if (!usage) return null;
  const count = (value: number | null | undefined) => (typeof value === "number" ? value : null);
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    totalTokens: count(usage.total_tokens),
    reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
    cachedInputTokens: count(usage.input_tokens_details?.cached_tokens),
  };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * 요청 하나의 사용량을 한 번만 기록하는 도우미. 응답을 받으면 usage를, 오류 응답(4xx·5xx)이면 생성하지 않은 호출로,
 * 연결이 끊기거나 중간에 멈춘 경우는 usage를 모르는 호출로 남긴다.
 * onCall이 있으면 같은 결과에 시각·식별자·오류 코드를 붙여 그 요청 시도가 끝날 때 한 번 넘긴다 (report).
 */
function requestLedger(request: { readonly model: string; readonly meter?: UsageMeter; readonly onCall?: (log: LlmCallLog) => void }) {
  let done = false;
  let reported = false;
  let startedAt = Date.now();
  let endedAt: number | null = null;
  let outcome: UsageRecord["kind"] = "unknown";
  let received: LlmUsage | null = null;
  let actualModel: string | null = null;
  let responseId: string | null = null;
  let requestId: string | null = null;
  const settle = (entry: UsageRecord) => {
    done = true;
    endedAt = Date.now();
    outcome = entry.kind;
    received = entry.kind === "usage" ? entry.usage : null;
    request.meter?.record(entry);
  };
  return {
    /** 동시 호출 제한을 통과해 요청을 보내기 직전. */
    begin() {
      startedAt = Date.now();
    },
    /** 응답·스트림 이벤트·응답 헤더에서 받은 식별자. 값이 있는 것만 남긴다. */
    identify(found: { readonly model?: string | null; readonly id?: string | null; readonly requestId?: string | null }) {
      if (found.model) actualModel = found.model;
      if (found.id) responseId = found.id;
      if (found.requestId) requestId = found.requestId;
    },
    usage(usage: OpenAI.Responses.ResponseUsage | null | undefined) {
      if (done) return;
      const read = readUsage(usage);
      settle(read ? { kind: "usage", usage: read } : { kind: "unknown" });
    },
    unknown() {
      if (done) return;
      settle({ kind: "unknown" });
    },
    failed(error: unknown) {
      if (!requestId && error instanceof OpenAI.APIError && error.requestID) requestId = error.requestID;
      if (done) return;
      const rejected = error instanceof OpenAI.APIError && typeof error.status === "number";
      settle(rejected ? { kind: "rejected" } : { kind: "unknown" });
    },
    /** 이 요청 시도의 기록을 onCall로 한 번만 넘긴다. onCall 안의 예외는 호출 흐름에 영향을 주지 않게 무시한다. */
    report(errorCode: LlmErrorCode | null) {
      if (reported || !request.onCall) return;
      reported = true;
      try {
        const log: LlmCallLog = {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt ?? Date.now()).toISOString(),
          outcome,
          usage: received,
          requestedModel: request.model,
          actualModel,
          responseId,
          requestId,
          errorCode,
        };
        const returned: unknown = request.onCall(log);
        if (isThenable(returned)) returned.then(undefined, () => undefined);
      } catch {
        // 기록 실패는 생성 실패가 아니다.
      }
    },
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
    const ledger = requestLedger(request);
    try {
      calls += 1;
      // temperature 등 모델 문서에서 확인하지 않은 옵션은 보내지 않는다.
      const response = await withConcurrencyLimit(() => {
        ledger.begin();
        return client.responses.create(
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
        );
      });
      // SDK가 JSON 응답에 x-request-id 헤더 값을 _request_id로 붙인다.
      ledger.identify({ model: response.model, id: response.id, requestId: response._request_id });
      // 응답을 받았으면 형식 확인 전에 사용량부터 남긴다 (미완료·형식 오류로 실패해도 토큰은 쓰였다).
      ledger.usage(response.usage);

      const text = extractOutputText(response);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError("invalid_output", "JSON을 해석할 수 없습니다.");
      }
      const parsed = request.parser.safeParse(json);
      if (!parsed.success) throw new LlmError("invalid_output", "출력 형식이 맞지 않습니다.");

      ledger.report(null);
      return {
        parsed: parsed.data,
        meta: {
          requestedModel: request.model,
          actualModel: response.model ?? null,
          responseId: response.id ?? null,
          usage: readUsage(response.usage) ?? UNKNOWN_USAGE,
          durationMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      ledger.failed(error);
      const classified = classifyProviderError(error);
      ledger.report(classified.code);
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
    const ledger = requestLedger(request);
    // SDK의 timeout은 응답 헤더까지만 본다. 스트림 전체 시간은 여기서 끊는다.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      calls += 1;
      const streamed = await withConcurrencyLimit(async () => {
        ledger.begin();
        // 스트림 응답에는 SDK가 _request_id를 붙이지 않으므로 withResponse로 헤더의 요청 ID를 함께 받는다 (요청·오류 처리는 같다).
        const { data: stream, request_id: streamRequestId } = await client.responses
          .create(
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
          )
          .withResponse();
        ledger.identify({ requestId: streamRequestId });
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
              // 반복을 멈추면 SDK가 요청을 끊는다. 끊은 호출은 usage를 받을 수 없다.
              stopped = true;
              ledger.unknown();
              break;
            }
          } else if (event.type === "response.created") {
            // 응답 ID와 실제 모델은 시작 이벤트에도 있다. 중간에 끊은 호출의 기록에도 남긴다.
            ledger.identify(event.response);
          } else if (event.type === "response.refusal.delta") {
            throw new LlmError("refused", "모델이 응답을 거절했습니다.");
          } else if (event.type === "response.completed") {
            final = event.response;
            ledger.identify(event.response);
            ledger.usage(event.response.usage);
          } else if (event.type === "response.incomplete") {
            ledger.identify(event.response);
            ledger.usage(event.response.usage);
            throw new LlmError("incomplete", `응답이 완료되지 않았습니다: ${event.response.incomplete_details?.reason ?? "unknown"}`);
          } else if (event.type === "response.failed") {
            ledger.identify(event.response);
            ledger.usage(event.response.usage);
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
      // 끝까지 받았는데 전체 형식이 맞지 않으면 기록에 invalid_output을 남긴다. 함수는 지금처럼 parsed: null로 돌려준다
      // (호출한 쪽이 이미 받은 완성 단위를 쓸 수 있다).
      ledger.report(!streamed.stopped && parsed === null ? "invalid_output" : null);
      return {
        parsed,
        text: streamed.text,
        stopped: streamed.stopped,
        meta: {
          requestedModel: request.model,
          actualModel: final?.model ?? null,
          responseId: final?.id ?? null,
          usage: (final ? readUsage(final.usage) : null) ?? UNKNOWN_USAGE,
          durationMs: Date.now() - startedAt,
          calls,
        },
      };
    } catch (error) {
      // 화면 저장 중 오류(다른 요청이 이어받음 등)로 멈춘 호출도 토큰을 썼을 수 있다. usage는 모르는 호출로 남긴다.
      if (error instanceof DeltaHandlerFailure) {
        ledger.unknown();
        ledger.report(error.cause instanceof LlmError ? error.cause.code : null);
        throw error.cause;
      }
      ledger.failed(error);
      const classified = classifyProviderError(error);
      ledger.report(classified.code);
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
export async function pingModel(model: string): Promise<{ actualModel: string | null; usage: LlmUsage | null }> {
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
