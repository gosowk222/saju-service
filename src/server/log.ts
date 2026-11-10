import "server-only";

const APP_CODE = /^[a-z][a-z0-9_]{2,60}$/;

/**
 * 내부 예외를 로그에 남길 때 쓰는 원인 코드.
 * 앱이 직접 던지는 고정 코드(예: analysis_load_failed)만 그대로 쓰고, 그 밖의 메시지는
 * 출생정보나 입력값이 섞일 수 있어 예외 이름(TypeError 등)만 남긴다.
 */
export function internalReason(error: unknown): string {
  if (error instanceof Error) return APP_CODE.test(error.message) ? error.message : error.name;
  return typeof error;
}
