import "server-only";
import {
  EXAMPLE_POLICY_VERSION,
  MUJIN_EXAMPLE_CATALOG_VERSION,
  MYOMYO_EXAMPLE_CATALOG_VERSION,
  findExampleCatalog,
  findExamplePolicy,
  rewriteView,
  type CharacterExample,
  type ExamplePremiseLine,
  type ExampleRequest,
  type ExampleRoute,
  type PremiseKind,
  type RewriteView,
} from "@/domain/personas/examples";

/**
 * 캐릭터 문답 예시를 생성 지시에 붙이는 곳. 예시를 쓰는 모든 경로(묘묘 최초 풀이·후속 답변, 무진 Pass 2·후속 답변)가 이 함수 하나로 만든다.
 * 예시와 현재 입력의 경계 안내도 여기 한 곳에만 있다 (프롬프트마다 따로 적지 않는다).
 *
 * 놓는 자리: 지시(instructions)의 맨 끝. 현재 사용자의 작성 재료는 지금처럼 사용자 메시지(input, JSON)로 따로 간다.
 * 그래서 모델 입력에서 예시는 시스템 지시 안의 [캐릭터 문답 예시] 블록, 실제 재료는 사용자 메시지로 나뉘고,
 * 예시를 사용자와 캐릭터의 이전 대화(user/assistant 메시지)처럼 넣지 않는다. 블록 앞의 지시는 버전마다 같아 입력 캐시에 그대로 걸린다.
 * 출력 형식(JSON 스키마)은 바꾸지 않는다. 예시 답변은 본문 문장의 표현 참고라고 적는다.
 */

/** 생성 기록에 남기는 값. 예시 문장과 사용자 원문은 넣지 않는다. */
export interface ExampleRecord {
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly route: ExampleRoute;
  /** 실제로 넣은 예시 ID (재작성 예시가 먼저). */
  readonly ids: readonly string[];
}

export interface ExampleBlock {
  readonly text: string;
  readonly record: ExampleRecord;
}

interface PromptExampleConfig {
  readonly personaId: string;
  readonly catalogVersion: string;
  readonly policyVersion: string;
  readonly route: ExampleRoute;
}

/**
 * 예시를 쓰는 프롬프트 버전. 여기 없는 버전은 예시 없이 만든다:
 * 이전 버전(reading-3.1.0 이하, followup-3.1.0 이하, mujin-voice-1.0.0, mujin-followup-1.0.0)에 고정된 작업,
 * 무진 Pass 1(mujin-draft), 질문 정리(question, mujin-question). 이미 쓴 버전의 값을 바꾸지 않고 새 버전을 더한다.
 */
const PROMPT_EXAMPLES: Readonly<Record<string, PromptExampleConfig>> = {
  "reading-3.2.0": { personaId: "myomyo", catalogVersion: MYOMYO_EXAMPLE_CATALOG_VERSION, policyVersion: EXAMPLE_POLICY_VERSION, route: "reading" },
  "followup-3.2.0": { personaId: "myomyo", catalogVersion: MYOMYO_EXAMPLE_CATALOG_VERSION, policyVersion: EXAMPLE_POLICY_VERSION, route: "followup" },
  "mujin-voice-1.1.0": { personaId: "mujin", catalogVersion: MUJIN_EXAMPLE_CATALOG_VERSION, policyVersion: EXAMPLE_POLICY_VERSION, route: "voice" },
  "mujin-followup-1.1.0": { personaId: "mujin", catalogVersion: MUJIN_EXAMPLE_CATALOG_VERSION, policyVersion: EXAMPLE_POLICY_VERSION, route: "followup" },
};

/** 이 프롬프트 버전이 예시를 쓰는지. */
export function usesExamples(promptVersion: string): boolean {
  return Object.hasOwn(PROMPT_EXAMPLES, promptVersion);
}

/** 예시를 쓰는 프롬프트 버전 목록 (테스트·문서용). */
export function examplePromptVersions(): readonly string[] {
  return Object.keys(PROMPT_EXAMPLES);
}

export function promptExampleConfig(promptVersion: string): PromptExampleConfig | undefined {
  return Object.hasOwn(PROMPT_EXAMPLES, promptVersion) ? PROMPT_EXAMPLES[promptVersion] : undefined;
}

const PREMISE_LABEL: Readonly<Record<PremiseKind, string>> = {
  "user-fact": "예시 속 사용자가 말한 사실",
  judgment: "예시용 판단",
  condition: "판단의 조건",
  counter: "반대 근거",
  action: "예시 재료의 행동 제안",
  limit: "판단하지 않은 것",
  context: "대화 상황",
};

function premiseLines(premise: readonly ExamplePremiseLine[]): string[] {
  if (!premise.length) return ["예시 전제: 따로 없음 (질문에 담긴 말만 다룬 예시)"];
  return ["예시 전제 (이 예시에만 해당):", ...premise.map((line) => `- ${PREMISE_LABEL[line.kind]}: ${line.text}`)];
}

const numbered = (paragraphs: readonly string[]) => paragraphs.map((paragraph, index) => `[${index + 1}] ${paragraph}`);

function renderExample(example: CharacterExample): string {
  return [`<example id="${example.id}">`, ...premiseLines(example.premise), `예시 질문: ${example.question}`, "예시 답변:", example.answer, "</example>"].join("\n");
}

function renderRewrite(view: RewriteView): string {
  return [
    `<rewrite-example id="${view.id}" source="${view.sourceExampleId}">`,
    `예시 질문: ${view.question}`,
    ...premiseLines(view.premise),
    "중립 초안:",
    ...numbered(view.neutralDraft),
    "다시 쓴 글:",
    ...numbered(view.rewritten.split("\n\n")),
    "지켜야 할 뜻:",
    ...view.preserve.map((line) => `- ${line}`),
    "</rewrite-example>",
  ].join("\n");
}

/** 예시와 현재 입력의 경계 안내. 이 블록에만 있다. */
function guide(route: ExampleRoute): string[] {
  return [
    "아래 문답은 [캐릭터]의 관찰, 반응, 설명 전개와 문장 리듬을 보여 주는 가상 예시다. 현재 사용자의 대화 기록이나 판단 자료가 아니다.",
    "- 말하는 방식은 참고하되, 예시의 문장·비유·장면을 그대로 다시 쓰지 않는다.",
    "- 예시의 사용자 사실, 날짜, 수치, 판단, 행동 제안은 현재 입력으로 옮기지 않는다. 예시와 같은 판단이 지금 재료에 없으면 그 판단을 말하지 않는다.",
    "- 현재 답의 사실과 결론은 사용자 메시지로 받은 실제 작성 재료(JSON)만 따른다. 예시의 ID는 근거 ref가 아니므로 refs에 넣지 않는다.",
    "- 예시 답변은 본문 문장의 표현 참고다. 출력의 형식, 칸, 분량은 위 지시와 JSON 형식을 따른다.",
    ...(route === "voice"
      ? ["- 다시 쓰기 예시(rewrite-example)는 중립 초안이 같은 뜻의 [캐릭터] 설명으로 바뀌는 모습이다. 초안의 뜻은 모두 남기고 초안에 없는 뜻은 더하지 않는다. 바뀌는 것은 순서, 문장, 반응, 비유다."]
      : []),
  ];
}

export function renderExampleBlock(input: {
  readonly personaName: string;
  readonly route: ExampleRoute;
  readonly examples: readonly CharacterExample[];
  readonly rewrites: readonly RewriteView[];
}): string {
  return [
    `[캐릭터 문답 예시: ${input.personaName}]`,
    ...guide(input.route),
    "",
    ...input.rewrites.flatMap((view) => [renderRewrite(view), ""]),
    ...input.examples.flatMap((example) => [renderExample(example), ""]),
    "[캐릭터 문답 예시 끝]",
  ].join("\n");
}

/**
 * 프롬프트 버전에 맞는 예시를 골라 블록을 만든다. 예시를 쓰는 버전인데 카탈로그·정책이 없거나, 캐릭터가 다르거나,
 * 고른 예시가 0개면(Pass 2는 재작성 예시가 없으면) 오류를 던진다. 조용히 예시 없이 보내지 않는다.
 */
export function buildExampleBlock(
  promptVersion: string,
  persona: { readonly id: string; readonly name: string },
  request: Omit<ExampleRequest, "route">,
): ExampleBlock {
  const config = promptExampleConfig(promptVersion);
  if (!config) throw new Error(`examples_unavailable: ${promptVersion}에는 예시 설정이 없습니다.`);
  if (config.personaId !== persona.id) throw new Error(`examples_unavailable: ${promptVersion}은 ${config.personaId} 전용입니다 (${persona.id}).`);
  const catalog = findExampleCatalog(config.catalogVersion);
  const policy = findExamplePolicy(config.policyVersion);
  if (!catalog || catalog.personaId !== persona.id || !policy) {
    throw new Error(`examples_unavailable: ${config.catalogVersion} / ${config.policyVersion}`);
  }
  const selection = policy(catalog, { ...request, route: config.route });
  if (!selection.examples.length && !selection.rewrites.length) throw new Error(`examples_unavailable: ${promptVersion}에서 고른 예시가 없습니다.`);
  if (config.route === "voice" && !selection.rewrites.length) throw new Error(`examples_unavailable: ${promptVersion}에서 고른 재작성 예시가 없습니다.`);
  const rewrites = selection.rewrites.map((rewrite) => rewriteView(catalog, rewrite));
  return {
    text: renderExampleBlock({ personaName: persona.name, route: config.route, examples: selection.examples, rewrites }),
    record: {
      catalogVersion: catalog.version,
      policyVersion: config.policyVersion,
      route: config.route,
      ids: [...selection.rewrites.map((rewrite) => rewrite.id), ...selection.examples.map((example) => example.id)],
    },
  };
}
