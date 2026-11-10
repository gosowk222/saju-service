import "server-only";
import { ApiError } from "./api";

/**
 * 인스턴스 안에서만 세는 간단한 제한. 검색처럼 값싼 요청의 남용을 막는 용도다.
 * 결제나 질문 차감의 정확성은 데이터베이스 함수가 맡는다.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 5000;

export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError(429, "rate_limited", "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
  }
}
