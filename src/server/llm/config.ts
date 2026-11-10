import "server-only";

/**
 * OpenAI 호출 설정을 모은 곳. 모델을 바꿀 때는 코드를 고치지 않고 OPENAI_MODEL만 바꾼다.
 * 지원 옵션은 공식 모델 문서 기준이다 (docs/LLM_OPERATIONS.md).
 */

/** 개발 기본 모델. OPENAI_MODEL이 비어 있는 개발·테스트 환경에서만 쓴다. */
const DEVELOPMENT_DEFAULT_MODEL = "gpt-5.6-luna";

export type LlmTask = "classify" | "reading" | "followup";

export interface LlmTaskSettings {
  /** 추론 토큰을 포함한 출력 상한. 한국어 본문과 JSON 구조를 함께 담을 수 있게 잡는다. */
  readonly maxOutputTokens: number;
  readonly reasoningEffort: "low" | "medium";
  /** 요청 한 번의 시간 제한. */
  readonly timeoutMs: number;
}

export const LLM_SETTINGS = {
  /** 정해진 판단을 설명하는 작업이라 낮은 추론 설정에서 시작한다. */
  reasoningEffort: "low",
  tasks: {
    /** 질문 정리. 짧은 구조화 출력이다. */
    classify: { maxOutputTokens: 2_000, reasoningEffort: "low", timeoutMs: 30_000 },
    /** 최초 풀이 전체. 40~60개 말풍선과 JSON 구조를 한 번에 받는다. */
    reading: { maxOutputTokens: 24_000, reasoningEffort: "low", timeoutMs: 200_000 },
    /** 후속 질문 답변. 소질문 여러 개를 나눠 답한다. */
    followup: { maxOutputTokens: 6_000, reasoningEffort: "low", timeoutMs: 90_000 },
  } satisfies Record<LlmTask, LlmTaskSettings>,
  /** 네트워크·일시 오류의 재시도 횟수 (처음 호출 제외). 남은 시간이 부족하면 재시도하지 않는다. */
  transportRetries: 2,
  /** 인스턴스당 동시 호출 수. */
  concurrency: 4,
  /** 형식이나 검사 실패 시 다시 생성하는 횟수. */
  validationRetries: 1,
  /** 한 풀이가 시도할 수 있는 실행 횟수. 비용 상한 역할도 한다. */
  generationMaxAttempts: 4,
  /** 실행 중인 작업의 점유 시간. 지나면 다른 요청이 이어받는다. route의 maxDuration(300초)과 맞춘다. */
  generationLeaseSeconds: 300,
  /** 생성 요청 안에서 쓸 수 있는 시간. 이 시간을 넘길 재시도는 하지 않는다. */
  generationBudgetMs: 280_000,
  followupLeaseSeconds: 180,
  followupBudgetMs: 170_000,
  followupRatePerMinute: 6,
  /** 짧은 후속 질문의 문맥을 이해하는 데 쓰는 직전 대화 수. 대화 전체를 보내지 않는다. */
  followupContextTurns: 1,
  /** 후속 질문에 함께 보내는 이전 풀이 말풍선 수의 상한 (질문 주제의 말풍선만 고른다). */
  followupDeliveredMessages: 14,
} as const;

export class LlmConfigError extends Error {
  readonly code = "model_not_configured";
}

/**
 * 호출할 모델 ID. NODE_ENV에 따라 다른 모델을 고르지 않는다.
 * 운영에서 값이 비어 있으면 임의의 모델을 쓰지 않고 설정 오류로 처리한다.
 */
export function resolveModelId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.OPENAI_MODEL?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new LlmConfigError("OPENAI_MODEL이 설정되지 않았습니다.");
  }
  return DEVELOPMENT_DEFAULT_MODEL;
}

export function requireApiKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) throw new LlmConfigError("OPENAI_API_KEY가 설정되지 않았습니다.");
  return key;
}
