import "server-only";
import { findPersona, type Persona, type PersonaLookup } from "@/domain/personas";
import type { ProductDefinition } from "@/domain/products/types";
import { EXAMPLE_POLICY_VERSION, MYOMYO_EXAMPLE_CATALOG_2_VERSION } from "@/domain/personas/examples";
import { SCROLL_SETTINGS } from "@/server/scroll/config";
import { EXAMPLE_GUIDE_1_1_0, type ExampleBinding } from "@/server/llm/example-block";
import {
  MESSENGER_DRAFT_PROMPT_1_0_0,
  MESSENGER_DRAFT_SCHEMA_1_0_0,
  MESSENGER_VOICE_PROMPT_1_0_0,
  MESSENGER_VOICE_SCHEMA_1_0_0,
} from "@/server/llm/messenger-prompts";
import { MUJIN_BUNDLES } from "@/server/llm/mujin-prompts";
import { FOLLOWUP_SCHEMA_VERSION, QUESTION_PROMPT_VERSION } from "@/server/llm/prompts";
import type { TwoPassSettings } from "./two-pass";

/**
 * 메신저 상품의 생성 묶음. 상품 설정의 generation.bundle이 이 ID를 가리키고, 생성 작업은 처음 시작할 때 이 ID를
 * generation_jobs.prompt_version에 고정한다. 재시도·이어 쓰기는 고정된 묶음으로만 만든다 (지금 상품 설정이 바뀌어도).
 *
 * 묶음 하나가 정하는 것 (생성 정책):
 * - 실행 방식: two-pass (Pass 1 중립 초안 → Pass 2 캐릭터 문장). 이 묶음 밖의 이전 작업(reading-x.y.z에 고정된 1-pass)은 prompts.ts가 맡는다.
 * - 각 단계의 지시·출력 형식 버전, 질문 정리 버전, 후속 답변 버전.
 * - 말하는 캐릭터와 그 설정 버전, 예시 카탈로그·선택 정책·안내 버전 (Pass 2와 후속 답변).
 * - 묶음 나누기, 동시 호출 수, 단위마다의 시도 수, 시간 예산, 작업 시작 수 상한.
 * 캐릭터 이름이나 말씨로 실행 방식을 고르지 않는다. 새 캐릭터는 캐릭터 설정과 예시 카탈로그를 등록하고 묶음을 더한 뒤 상품이 그 묶음을 가리키게 한다
 * (docs/personas/adding-a-character.md). 묶음을 바꿀 때는 기존 항목을 고치지 않고 새 ID를 더한다. 한 번 쓴 ID는 다시 쓰지 않는다.
 */
export interface MessengerBundle {
  readonly id: string;
  readonly format: "messenger";
  readonly mode: "two-pass";
  /** 말하는 캐릭터. 상품 설정의 personaId와 같아야 한다. */
  readonly personaId: string;
  readonly personaVersion: string;
  readonly draftPrompt: string;
  readonly draftSchema: string;
  readonly voicePrompt: string;
  readonly voiceSchema: string;
  /** 궁금한 점 질문 정리 지시 (prompts.ts의 buildQuestionPrompt). */
  readonly questionPrompt: string;
  /** Pass 2 예시 연결 (경로 voice). */
  readonly examples: ExampleBinding;
  /** 후속 답변. 후속 질문은 요청 하나 안에서 끝나므로 그 풀이 상품의 현재 묶음으로 만든다. */
  readonly followup: { readonly prompt: string; readonly schema: string; readonly examples: ExampleBinding };
  /** Pass 1 묶음 나누기: 첫 묶음은 firstUnits개(첫 화면을 빨리), 그 뒤는 nextUnits개씩. */
  readonly draftBatches: { readonly firstUnits: number; readonly nextUnits: number };
  /** 풀이 하나의 생성 작업 시작(claim) 상한 (generation_jobs.attempts). 시간 예산이 끝나 반납한 뒤 이어받기도 센다. */
  readonly maxAttempts: number;
  readonly settings: TwoPassSettings;
}

const MYOMYO_2PASS_1_0_0: MessengerBundle = {
  id: "myomyo-2pass-1.0.0",
  format: "messenger",
  mode: "two-pass",
  personaId: "myomyo",
  // 캐릭터 설정은 바꾸지 않았다 (묘묘 2.1.0). 바뀐 것은 실행 방식과 예시 카탈로그다.
  personaVersion: "2.1.0",
  draftPrompt: MESSENGER_DRAFT_PROMPT_1_0_0,
  draftSchema: MESSENGER_DRAFT_SCHEMA_1_0_0,
  voicePrompt: MESSENGER_VOICE_PROMPT_1_0_0,
  voiceSchema: MESSENGER_VOICE_SCHEMA_1_0_0,
  questionPrompt: QUESTION_PROMPT_VERSION,
  examples: {
    personaId: "myomyo",
    catalogVersion: MYOMYO_EXAMPLE_CATALOG_2_VERSION,
    policyVersion: EXAMPLE_POLICY_VERSION,
    route: "voice",
    guideVersion: EXAMPLE_GUIDE_1_1_0,
  },
  followup: {
    prompt: "followup-3.3.0",
    schema: FOLLOWUP_SCHEMA_VERSION,
    examples: {
      personaId: "myomyo",
      catalogVersion: MYOMYO_EXAMPLE_CATALOG_2_VERSION,
      policyVersion: EXAMPLE_POLICY_VERSION,
      route: "followup",
      guideVersion: EXAMPLE_GUIDE_1_1_0,
    },
  },
  draftBatches: { firstUnits: 2, nextUnits: 3 },
  maxAttempts: 12,
  // 시간·동시 호출·시도 수는 무진 족자와 같은 값에서 시작한다 (임시값, 실제 실행 시간을 보고 조정한다).
  settings: {
    budgetMs: SCROLL_SETTINGS.budgetMs,
    voiceConcurrency: SCROLL_SETTINGS.voiceConcurrency,
    draftAttemptsPerUnit: SCROLL_SETTINGS.draftAttemptsPerUnit,
    voiceAttemptsPerUnit: SCROLL_SETTINGS.voiceAttemptsPerUnit,
    retriesPerRun: SCROLL_SETTINGS.retriesPerRun,
    voiceStartMarginMs: SCROLL_SETTINGS.voiceStartMarginMs,
  },
};

export const MESSENGER_BUNDLES: Readonly<Record<string, MessengerBundle>> = {
  [MYOMYO_2PASS_1_0_0.id]: MYOMYO_2PASS_1_0_0,
};

/** 메신저 생성 묶음을 찾는다. 모르는 ID면 undefined (다른 묶음이나 1-pass로 바꾸지 않는다). */
export function findMessengerBundle(id: string): MessengerBundle | undefined {
  return Object.hasOwn(MESSENGER_BUNDLES, id) ? MESSENGER_BUNDLES[id] : undefined;
}

/**
 * 메신저 상품의 후속 답변에 쓸 묶음과 캐릭터 설정. 상품의 현재 묶음이 상품의 캐릭터와 같고 그 버전의 설정이 있을 때만 돌려준다.
 * 모르는 묶음·캐릭터·버전이면 null이다 (다른 캐릭터나 현재 설정으로 바꾸지 않는다). lookup은 테스트가 임시 캐릭터를 넣을 때만 준다.
 */
export function messengerFollowupFor(
  product: Pick<ProductDefinition, "personaId" | "generation">,
  lookup: PersonaLookup = findPersona,
  bundles: (id: string) => MessengerBundle | undefined = findMessengerBundle,
): { readonly bundle: MessengerBundle; readonly persona: Persona } | null {
  const bundle = bundles(product.generation.bundle);
  if (!bundle || bundle.personaId !== product.personaId) return null;
  const persona = lookup(bundle.personaId, bundle.personaVersion);
  return persona ? { bundle, persona } : null;
}

/** 이전 1-pass 작업(reading-x.y.z)과 메신저 2-pass 이전의 작업 시작 수 상한 (llm/config.ts의 generationMaxAttempts와 같다). */
export const LEGACY_ATTEMPT_LIMIT = 4;

/**
 * 생성 작업에 고정된 버전으로 작업 시작 상한을 정한다. 다시 시도 버튼과 이용권 반환 판단이 같은 값을 쓴다.
 * 메신저 2-pass 묶음은 그 묶음의 maxAttempts, 무진 묶음은 유료 단계 상한, 그 밖(이전 1-pass, 아직 시작 전)은 4다.
 */
export function attemptLimitFor(promptVersion: string | null | undefined): number {
  if (promptVersion) {
    const messenger = findMessengerBundle(promptVersion);
    if (messenger) return messenger.maxAttempts;
    if (Object.hasOwn(MUJIN_BUNDLES, promptVersion)) return SCROLL_SETTINGS.paidMaxRuns;
  }
  return LEGACY_ATTEMPT_LIMIT;
}
