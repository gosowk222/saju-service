/**
 * 메신저에서 다음 말풍선을 보여 주기 전에 기다리는 시간 (ms). 사람이 입력하는 것처럼 말풍선이 길수록 조금 더 기다린다.
 * 짧은 맞장구는 0.8초, 긴 설명은 최대 2.6초. 그동안 입력 중 표시가 보인다.
 */
export const TYPING_DELAY = { minMs: 800, maxMs: 2600, baseMs: 450, perCharMs: 12 } as const;

export function typingDelay(text: string): number {
  return Math.min(TYPING_DELAY.maxMs, Math.max(TYPING_DELAY.minMs, TYPING_DELAY.baseMs + text.length * TYPING_DELAY.perCharMs));
}
