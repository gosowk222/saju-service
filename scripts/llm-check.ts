/**
 * 현재 키로 지정한 모델을 호출할 수 있는지만 확인한다. 풀이 품질 검증이 아니다.
 *
 *   npm run llm:check                        OPENAI_MODEL을 확인
 *   npm run llm:check -- gpt-6-luna          특정 모델을 확인
 */
import { LlmError, classifyProviderError, pingModel } from "@/server/llm/client";
import { liveCallBlockReason, resolveModelId } from "@/server/llm/config";

async function main() {
  const model = process.argv[2] ?? resolveModelId();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log(JSON.stringify({ model, result: "LIVE_NOT_RUN", reason: "OPENAI_API_KEY 없음" }));
    return;
  }
  const blocked = liveCallBlockReason();
  if (blocked) {
    console.log(JSON.stringify({ model, result: "LIVE_NOT_RUN", reason: blocked }));
    return;
  }
  try {
    const { actualModel, usage } = await pingModel(model);
    console.log(JSON.stringify({ model, result: "ok", actualModel, totalTokens: usage?.totalTokens ?? null }));
  } catch (error) {
    const classified = error instanceof LlmError ? error : classifyProviderError(error);
    console.log(JSON.stringify({ model, result: "failed", code: classified.code }));
    process.exitCode = 1;
  }
}

void main();
