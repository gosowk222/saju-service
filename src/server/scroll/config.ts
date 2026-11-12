import "server-only";

/**
 * 무진의 종합 사주(족자 상품) 생성 실행기 설정. 장 단위 2-pass 생성의 시간·점유·비용 상한을 한곳에 모은다.
 * 모델, 출력 한도, 장 하나의 호출 제한 시간은 LLM 설정(src/server/llm/config.ts의 tasks.mujinDraft·mujinVoice)이 정한다.
 *
 * - 무료 단계(기초 분석 4개와 1장)는 reading_free_runs로, 유료 단계(2~10장과 마지막 정리)는 generation_jobs로 점유한다.
 * - 요청 하나는 budgetMs 안에서 할 수 있는 만큼만 쓰고, 남은 장이 있으면 점유를 반납해 브라우저가 곧바로 다시 요청하게 한다.
 * - 값은 임시값이다 (docs/implementation/mujin/00_START_HERE.md 미확정 7). 바꾸면 이미 시작한 작업에도 다음 요청부터 적용된다.
 */
export const SCROLL_SETTINGS = {
  /** 요청 하나에서 쓸 시간 (생성 라우트의 maxDuration 300초 안). 이 시간을 넘길 호출은 시작하지 않는다. */
  budgetMs: 270_000,
  /** 무료·유료 단계의 점유 시간. 지나면 다른 요청이 이어받는다. */
  leaseSeconds: 300,
  /** 풀이당 무료 단계 시작(claim) 상한. 이어받기·반납 뒤 재개·재시도를 모두 센다 (결제 전 비용 상한). */
  freeMaxRuns: 8,
  /** 풀이당 유료 단계 시작 상한 (generation_jobs.attempts). 반납 뒤 이어받기도 센다. */
  paidMaxRuns: 20,
  /** 회원당 24시간 안에 새로 시작할 수 있는 무료 단계 수 (임시값). */
  freeDailyLimit: 10,
  /** 요청 하나에서 함께 부르는 Pass 2(무진 문장) 호출 수. 프로세스 전역 동시 호출 제한(4)보다 작게 둔다. */
  voiceConcurrency: 2,
  /** 장 하나의 Pass 1 시도 총수 상한 (reading_units.draft_attempts). 넘으면 그 장만 실패로 남는다. */
  draftAttemptsPerUnit: 3,
  /** 장 하나의 Pass 2 시도 총수 상한 (reading_units.voice_attempts). */
  voiceAttemptsPerUnit: 3,
  /** 한 요청 안에서 검사에 걸린 장만 다시 요청하는 횟수. */
  retriesPerRun: 1,
  /** Pass 2를 시작할 때 호출 제한 시간 외에 남겨 둘 여유 (대기열 정리, 저장, 반납). */
  voiceStartMarginMs: 5_000,
} as const;

/**
 * 생성 단계를 실패로 정리해야 하는 오류. code는 앱 고정 코드라 그대로 기록·로그에 남는다 (생성 문장·질문 원문 없음).
 * retryable은 다시 시도해도 같은 결과가 아닐 때 true다 (설정·버전 문제는 false).
 */
export class ScrollStepError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
