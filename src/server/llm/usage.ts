/**
 * LLM 사용량 집계. 호출(HTTP 요청) 하나마다 API가 돌려준 usage를 그대로 기록하고 합친다. 글자 수로 토큰을 추정하지 않는다.
 *
 * 기록 종류
 * - usage: API가 usage를 돌려준 호출. 응답을 받은 뒤 JSON 해석이나 검사에 실패해도 이미 받은 usage는 남는다.
 * - unknown: 요청은 보냈지만 usage를 받지 못한 호출 (스트림을 중간에 끊음, 시간 초과, 연결 끊김). 토큰이 쓰였을 수 있으므로
 *   합계는 불완전(complete=false)으로 표시하고 0으로 채우지 않는다.
 * - rejected: API가 오류 응답(4xx·5xx)을 돌려 생성하지 않은 호출. 호출 수에는 넣고 usage가 없는 호출로 세지 않는다.
 *
 * 합계 규칙 (OpenAI Responses API usage)
 * - cachedInputTokens는 inputTokens에 포함된 값이다. 캐시되지 않은 입력 = inputTokens - cachedInputTokens.
 * - reasoningTokens는 outputTokens에 포함된 값이다. 다시 더하지 않는다.
 * - totalTokens = inputTokens + outputTokens. 캐시·추론 토큰을 다시 더하지 않는다.
 * - API가 실제로 돌려준 0과 값을 받지 못한 null을 구분한다. 받은 값이 하나도 없는 칸은 null이다.
 */
export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export type UsageRecord =
  | { readonly kind: "usage"; readonly usage: LlmUsage }
  | { readonly kind: "unknown" }
  | { readonly kind: "rejected" };

export interface UsageSummary extends LlmUsage {
  /** 보낸 요청 수 (전송 재시도와 검사 재시도를 모두 센다). */
  readonly calls: number;
  /** usage를 받은 호출 수. */
  readonly callsWithUsage: number;
  /** 요청은 보냈지만 usage를 받지 못한 호출 수. 0보다 크면 합계가 불완전하다. */
  readonly callsWithoutUsage: number;
  /** 모든 호출의 입력·출력·캐시 토큰을 받았는지. false면 토큰 합계는 확인된 호출만의 합이다. */
  readonly complete: boolean;
}

export class UsageMeter {
  private readonly records: UsageRecord[] = [];

  /** parent가 있으면 같은 기록을 부모에도 남긴다 (질문 분석·본문 생성이 각자 집계하면서 한 시도 전체도 집계하려고). */
  constructor(private readonly parent?: UsageMeter) {}

  record(entry: UsageRecord): void {
    this.records.push(entry);
    this.parent?.record(entry);
  }

  get calls(): number {
    return this.records.length;
  }

  summary(): UsageSummary {
    return summarizeUsage(this.records);
  }
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary {
  const used = records.flatMap((entry) => (entry.kind === "usage" ? [entry.usage] : []));
  const callsWithoutUsage = records.filter((entry) => entry.kind === "unknown").length;
  // 받은 값만 더한다. 받은 값이 하나도 없으면 null (호출이 없거나 생성하지 않은 호출뿐이면 실제로 쓴 토큰이 없으므로 0).
  const sum = (pick: (usage: LlmUsage) => number | null): number | null => {
    const values = used.map(pick).filter((value): value is number => typeof value === "number");
    if (values.length) return values.reduce((total, value) => total + value, 0);
    return callsWithoutUsage || used.length ? null : 0;
  };
  const inputTokens = sum((usage) => usage.inputTokens);
  const outputTokens = sum((usage) => usage.outputTokens);
  const complete =
    callsWithoutUsage === 0 && used.every((usage) => usage.inputTokens !== null && usage.outputTokens !== null && usage.cachedInputTokens !== null);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    reasoningTokens: sum((usage) => usage.reasoningTokens),
    cachedInputTokens: sum((usage) => usage.cachedInputTokens),
    calls: records.length,
    callsWithUsage: used.length,
    callsWithoutUsage,
    complete,
  };
}
