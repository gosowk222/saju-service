import "server-only";

/**
 * OpenAI 호출 설정을 모은 곳. 모델을 바꿀 때는 코드를 고치지 않고 OPENAI_MODEL만 바꾼다.
 * 지원 옵션은 공식 모델 문서 기준이다 (docs/LLM_OPERATIONS.md).
 */

/** 개발 기본 모델. OPENAI_MODEL이 비어 있는 개발·테스트 환경에서만 쓴다. */
const DEVELOPMENT_DEFAULT_MODEL = "gpt-5.6-luna";

export const LLM_SETTINGS = {
  /** 정해진 판단을 설명하는 작업이라 낮은 추론 설정에서 시작한다. */
  reasoningEffort: "low",
  /** 추론 토큰을 포함한 출력 상한. */
  maxOutputTokens: { reading: 9000, followup: 2500 },
  requestTimeoutMs: 120_000,
  /** 네트워크·일시 오류의 재시도 횟수 (처음 호출 제외). */
  transportRetries: 2,
  /** 인스턴스당 동시 호출 수. */
  concurrency: 4,
  /** 형식이나 검사 실패 시 다시 생성하는 횟수. */
  validationRetries: 1,
  /** 한 풀이가 시도할 수 있는 실행 횟수. 비용 상한 역할도 한다. */
  generationMaxAttempts: 4,
  /** 실행 중인 작업의 점유 시간. 지나면 다른 요청이 이어받는다. */
  generationLeaseSeconds: 300,
  followupLeaseSeconds: 90,
  followupRatePerMinute: 6,
  followupContextTurns: 3,
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
