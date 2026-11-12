import "server-only";

/**
 * OpenAI 호출 설정을 모은 곳. 모델을 바꿀 때는 코드를 고치지 않고 OPENAI_MODEL만 바꾼다.
 * 지원 옵션은 공식 모델 문서 기준이다 (docs/LLM_OPERATIONS.md).
 */

/** 개발 기본 모델. OPENAI_MODEL이 비어 있는 개발·테스트 환경에서만 쓴다. */
const DEVELOPMENT_DEFAULT_MODEL = "gpt-5.6-luna";

export type LlmTask = "classify" | "reading" | "followup" | "draft" | "voice";

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
    /**
     * 최초 풀이 전체. 40~60개 말풍선과 JSON 구조를 한 번에 받는다.
     * 추론 설정은 2026-11-11 사용자 요청으로 low → medium. low에서는 많은 제약 아래 재료를 옮겨 적거나 캐릭터를 약하게 쓰는 쪽으로 기울었다
     * (docs/READING_QUALITY.md 20·21절, 추정). 추론 토큰은 출력 단가로 과금되고 첫 말풍선까지 시간이 늘어난다.
     * 작업을 시작할 때 이 값이 고정되므로(claim_generation) 이미 시작한 작업은 그때 값을 쓴다.
     */
    reading: { maxOutputTokens: 24_000, reasoningEffort: "medium", timeoutMs: 200_000 },
    /** 후속 질문 답변. 소질문 여러 개를 나눠 답한다. */
    followup: { maxOutputTokens: 6_000, reasoningEffort: "low", timeoutMs: 90_000 },
    /**
     * 2-pass의 Pass 1 (캐릭터 없는 중립 초안). 무진 족자는 장 묶음(장 1~3개), 묘묘는 주제 묶음(주제 2~3개) 하나를 스트림으로 받는다.
     * (2026-11-13 이름만 mujinDraft → draft로 바꿨다. 값은 같다.) 추론 설정은 최초 풀이(reading)와 같은 값이다. 바꾸려면 사용자 확인을 받는다.
     */
    draft: { maxOutputTokens: 16_000, reasoningEffort: "medium", timeoutMs: 170_000 },
    /**
     * 2-pass의 Pass 2 (캐릭터 문장). 초안 한 단위(무진 장 하나, 묘묘 주제 하나)를 캐릭터가 설명하는 글로 다시 쓴다.
     * (2026-11-13 이름만 mujinVoice → voice로 바꿨다. 값은 같다.) 추론 설정은 reading과 같은 값이다. 바꾸려면 사용자 확인을 받는다.
     */
    voice: { maxOutputTokens: 8_000, reasoningEffort: "medium", timeoutMs: 90_000 },
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

function isOpenAiHost(url: string): boolean {
  try {
    return /(^|\.)openai\.com$/i.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** Claude Code가 띄운 프로세스에 들어가는 환경 변수. 사용자가 직접 연 터미널에는 없다. */
const AGENT_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] as const;

/**
 * 실제 OpenAI 서버로 가는 호출을 막아야 하는 이유. 막지 않으면 null.
 *
 * 실제 호출은 사용자가 직접 연 Next 서버(개발 서버나 배포 서버) 안에서만 허용한다. 비용은 사용자가 내기 때문이다.
 * - 개발 스크립트(llm:compare, llm:check)와 테스트는 Next 밖에서 실행되므로 OPENAI_BASE_URL로 가짜 서버를 가리킬 때만 호출한다.
 * - Claude Code가 띄운 프로세스(스크립트, 빌드, 테스트 서버, 개발 서버)는 Next 서버라도 실제 OpenAI를 부르지 않는다.
 * 환경 변수는 `env` 객체로 읽어 실행할 때의 값을 본다. Next는 서버 코드를 만들 때 `process.env.NEXT_RUNTIME`을
 * "nodejs"로 바꿔 넣으므로 이 표현을 그대로 둔다.
 */
export function liveCallBlockReason(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime: string | undefined = process.env.NEXT_RUNTIME,
): string | null {
  const base = env.OPENAI_BASE_URL?.trim();
  if (base && !isOpenAiHost(base)) return null;
  if (AGENT_MARKERS.some((name) => env[name])) {
    return "Claude Code가 실행한 프로세스에서는 실제 OpenAI를 호출하지 않습니다. 사용자가 직접 연 터미널의 개발 서버에서만 호출합니다.";
  }
  if (runtime) return null;
  return "실제 OpenAI 호출은 직접 연 개발 서버(npm run dev)나 배포 서버 안에서만 할 수 있습니다.";
}

export function requireApiKey(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) throw new LlmConfigError("OPENAI_API_KEY가 설정되지 않았습니다.");
  return key;
}
