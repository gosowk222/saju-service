/**
 * 캐릭터별 질문–답변 예시 카탈로그 목록과 선택 정책 목록. 생성 경로는 프롬프트 버전이 가리키는 카탈로그·정책 버전으로 찾는다
 * (src/server/llm/example-block.ts). 카탈로그나 정책을 바꿀 때는 이전 버전을 고치지 않고 새 버전을 더한다.
 * 사람이 읽는 설명: docs/personas/examples.md
 */
import { MUJIN_EXAMPLES_1_0_0 } from "./mujin";
import { MYOMYO_EXAMPLES_1_0_0 } from "./myomyo";
import { EXAMPLE_POLICY_VERSION, selectExamples, type ExampleRequest, type ExampleSelection } from "./select";
import type { ExampleCatalog, RewriteExample, RewriteView } from "./types";

export * from "./types";
export {
  EXAMPLE_LIMITS,
  EXAMPLE_POLICY_VERSION,
  sectionOrdinal,
  seriousSignal,
  stableHash,
  topicOfDomain,
  topicOfProductTopic,
  topicsOfSection,
  uniqueTopics,
  type ExampleRequest,
  type ExampleSelection,
} from "./select";
export { MYOMYO_EXAMPLE_CATALOG_VERSION } from "./myomyo";
export { MUJIN_EXAMPLE_CATALOG_VERSION } from "./mujin";
export { echoLines, exampleEchoes, type ExampleEcho } from "./echo";

const CATALOGS: readonly ExampleCatalog[] = [MYOMYO_EXAMPLES_1_0_0, MUJIN_EXAMPLES_1_0_0];

const POLICIES: Readonly<Record<string, (catalog: ExampleCatalog, request: ExampleRequest) => ExampleSelection>> = {
  [EXAMPLE_POLICY_VERSION]: selectExamples,
};

export function findExampleCatalog(version: string): ExampleCatalog | undefined {
  return CATALOGS.find((catalog) => catalog.version === version);
}

export function allExampleCatalogs(): readonly ExampleCatalog[] {
  return CATALOGS;
}

export function findExamplePolicy(version: string): ((catalog: ExampleCatalog, request: ExampleRequest) => ExampleSelection) | undefined {
  return Object.hasOwn(POLICIES, version) ? POLICIES[version] : undefined;
}

/** 재작성 예시를 원문과 합쳐 읽는다. 질문·전제·재작성 결과는 원문 그대로다. 원문이 없으면 예외를 던진다. */
export function rewriteView(catalog: ExampleCatalog, rewrite: RewriteExample): RewriteView {
  const source = catalog.examples.find((example) => example.id === rewrite.sourceExampleId);
  if (!source) throw new Error(`재작성 예시 ${rewrite.id}의 원문 ${rewrite.sourceExampleId}이 카탈로그에 없습니다.`);
  return {
    id: rewrite.id,
    sourceExampleId: source.id,
    question: source.question,
    premise: source.premise,
    neutralDraft: rewrite.neutralDraft,
    rewritten: source.answer,
    preserve: rewrite.preserve,
  };
}
