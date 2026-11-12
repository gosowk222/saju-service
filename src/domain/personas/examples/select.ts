/**
 * 예시 선택 정책 example-select-1.0.0. 카탈로그 전체에서 이번 요청에 맞는 예시 몇 개를 고른다.
 *
 * 재현성: 무작위를 쓰지 않는다. 결과는 (카탈로그 버전, 정책 버전, 요청의 특징, seed)만으로 정해진다. 요청의 특징은 작업에 저장된
 * 작성 계획과 질문 정리에서 오고 seed는 풀이·장·후속 질문 ID라서, 같은 작업의 재시도와 이어 쓰기는 늘 같은 예시를 받는다.
 * 실제로 고른 ID는 생성 기록에 남는다 (example-block.ts의 ExampleRecord).
 *
 * 고르는 순서:
 * 1. 경로가 맞는 예시만 후보로 둔다. 다른 캐릭터의 카탈로그는 처음부터 받지 않는다.
 *    반응 예시는 같은 반응이 담긴 메시지에만, 진지한 예시는 사용자가 지금 힘들다고 직접 말했을 때만,
 *    조건이 있는 예시(출생 시각 미상, 직전 대화)는 그 조건이 있을 때만 후보가 된다.
 * 2. 무진 Pass 2는 재작성 예시 하나를 장의 주제로 먼저 고르고, 그 원문은 문답 후보에서 뺀다 (같은 글이 두 번 들어가지 않게).
 * 3. 반드시 채울 자리: 반응이 있으면 그 반응 예시 하나, 진지한 상황이면 진지한 예시 하나,
 *    긴 설명이 필요하면 긴 예시 하나 (Pass 2는 재작성 예시가 긴 설명 자리를 채운다).
 * 4. 남은 자리는 점수 순서로 채운다: 주제 일치, 질문 의도(비교·기간·확정 불가)와 표현 목적의 일치, 길이.
 *    이미 고른 예시와 주제가 같으면 점수를 깎는다. 긴 설명이 필요한 작성에는 짧은 반응 예시를 넣지 않는다.
 * 5. 점수가 비슷한 후보(최고 점수와 2점 안)끼리는 seed에서 나온 회전 값으로 하나를 고른다. 장마다·풀이마다 같은 문답만 붙지 않게 한다.
 * 주제가 맞는 예시가 없으면 공통(general) 예시와 점수가 남은 예시로 채운다. 후보가 아예 없으면 빈 결과를 돌려주고,
 * 호출한 쪽(example-block.ts)이 예시가 필요한 버전이면 오류로 처리한다 (조용히 0개로 보내지 않는다).
 */
import type { CharacterExample, ExampleCatalog, ExampleReaction, ExampleRoute, ExampleTopic, RewriteExample } from "./types";

export const EXAMPLE_POLICY_VERSION = "example-select-1.0.0";

export interface ExampleRequest {
  readonly route: ExampleRoute;
  /** 이번 작성의 주제. 앞일수록 중요하다. */
  readonly topics: readonly ExampleTopic[];
  /** 결론·이유·조건을 여러 문단으로 푸는 작성인가 (최초 풀이, Pass 2의 장). */
  readonly long: boolean;
  /** 사용자가 지금 힘들다고 직접 말했는가 (seriousSignal). 고른 상황의 일반적인 걱정은 넣지 않는다. */
  readonly serious: boolean;
  readonly reaction: "none" | ExampleReaction;
  /** 질문의 의도 (compare, timing, outcome, apply 등). */
  readonly intents: readonly string[];
  /** 사주로 확정할 수 없는 부분이 있는 질문이 있는가 (answerability limited). */
  readonly limited: boolean;
  readonly hourUnknown: boolean;
  readonly hasLastTurn: boolean;
  /** 같은 작업 안에서 늘 같은 값 (예: 풀이 ID, 풀이 ID:장 ID, 후속 질문 ID). 비슷한 후보 사이의 순서만 정한다. */
  readonly seed: string;
}

export interface ExampleSelection {
  readonly examples: readonly CharacterExample[];
  readonly rewrites: readonly RewriteExample[];
}

/** 요청 하나에 넣는 수 (정책 1.0.0). 토큰 부담을 보며 바꿀 때는 정책 버전을 올린다. */
export const EXAMPLE_LIMITS: Readonly<Record<ExampleRoute, { readonly examples: number; readonly rewrites: number }>> = {
  reading: { examples: 3, rewrites: 0 },
  followup: { examples: 3, rewrites: 0 },
  voice: { examples: 1, rewrites: 1 },
};

/** FNV-1a 32비트. 무작위가 아니라 같은 글자에 늘 같은 값을 준다. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function topicScore(topics: readonly ExampleTopic[], wanted: readonly ExampleTopic[]): number {
  let best = 0;
  wanted.forEach((topic, index) => {
    if (topics.includes(topic)) best = Math.max(best, index === 0 ? 6 : index === 1 ? 4 : 2);
  });
  if (!best && topics.includes("general")) best = 1;
  return best;
}

/** 후보가 될 수 없으면 null. */
function exampleScore(example: CharacterExample, request: ExampleRequest, longQa: boolean): number | null {
  if (!example.routes.includes(request.route)) return null;
  if (example.reaction && example.reaction !== request.reaction) return null;
  if (example.serious && !request.serious) return null;
  if (example.needs?.hourUnknown && !request.hourUnknown) return null;
  if (example.needs?.lastTurn && !request.hasLastTurn) return null;
  let score = topicScore(example.topics, request.topics);
  if (request.reaction !== "none" && example.reaction === request.reaction) score += 8;
  if (request.serious && example.serious) score += 8;
  if (request.intents.includes("compare") && example.purposes.includes("compare")) score += 5;
  if (request.intents.includes("timing") && example.topics.includes("timing")) score += 5;
  if ((request.limited || request.intents.includes("outcome")) && example.purposes.includes("uncertain")) score += 4;
  if (request.intents.includes("apply") && example.purposes.includes("apply")) score += 2;
  if (request.hourUnknown && example.needs?.hourUnknown) score += 4;
  if (longQa) score += example.length === "long" ? 3 : example.length === "medium" ? 1 : -2;
  else if (example.length !== "short") score += 1;
  return score;
}

interface Candidate<T> {
  readonly item: T;
  readonly score: number;
  readonly order: number;
}

/** 점수가 최고 점수와 2점 안인 후보 가운데 회전 값으로 하나를 고른다. 순서가 같으면 seed+ID 해시로 정한다. */
function pickNear<T>(candidates: readonly Candidate<T>[], rotation: number): T | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((left, right) => right.score - left.score || left.order - right.order);
  const best = sorted[0]!.score;
  const near = sorted.filter((candidate) => candidate.score >= best - 2);
  return near[rotation % near.length]!.item;
}

export function selectExamples(catalog: ExampleCatalog, request: ExampleRequest): ExampleSelection {
  const limit = EXAMPLE_LIMITS[request.route];
  const rotation = stableHash(`rotation:${request.seed}`);
  const orderOf = (id: string) => stableHash(`${request.seed}:${id}`);

  const rewrites: RewriteExample[] = [];
  const rewritePool = catalog.rewrites.filter((rewrite) => rewrite.routes.includes(request.route));
  for (let slot = 0; slot < limit.rewrites; slot += 1) {
    const pick = pickNear(
      rewritePool
        .filter((rewrite) => !rewrites.includes(rewrite))
        .map((rewrite) => ({ item: rewrite, score: topicScore(rewrite.topics, request.topics), order: orderOf(rewrite.id) })),
      rotation + slot,
    );
    if (pick) rewrites.push(pick);
  }

  const usedSources = new Set(rewrites.map((rewrite) => rewrite.sourceExampleId));
  // 재작성 예시가 긴 설명 자리를 채우면 문답은 주제와 반응으로만 고른다.
  const longQa = request.long && rewrites.length === 0;
  const pool: Candidate<CharacterExample>[] = [];
  for (const example of catalog.examples) {
    if (usedSources.has(example.id)) continue;
    const score = exampleScore(example, request, longQa);
    if (score !== null) pool.push({ item: example, score, order: orderOf(example.id) });
  }

  const chosen: CharacterExample[] = [];
  /** minScore: 남은 자리를 채울 때는 점수가 0 이하인 후보(주제도 목적도 맞지 않는 예시)를 넣지 않는다. */
  const take = (accept: (example: CharacterExample) => boolean, minScore = Number.NEGATIVE_INFINITY) => {
    if (chosen.length >= limit.examples) return;
    const remaining = pool
      .filter((candidate) => !chosen.includes(candidate.item) && accept(candidate.item))
      .map((candidate) => {
        const sameTopic = chosen.filter((example) => example.topics[0] === candidate.item.topics[0]).length;
        return { ...candidate, score: candidate.score - 3 * sameTopic };
      })
      .filter((candidate) => candidate.score > minScore);
    const pick = pickNear(remaining, rotation + chosen.length);
    if (pick) chosen.push(pick);
  };

  if (request.reaction !== "none") take((example) => example.reaction === request.reaction);
  if (request.serious) take((example) => example.serious);
  if (longQa) take((example) => example.length === "long");
  while (chosen.length < limit.examples) {
    const before = chosen.length;
    // 긴 설명이 필요한 작성에는 짧은 예시를 넣지 않는다 (반응 예시는 위에서 이미 골랐다).
    take((example) => !(longQa && example.length === "short"), 0);
    if (chosen.length === before) break;
  }
  // 반드시 채울 자리도 남은 자리도 비었으면(주제가 하나도 맞지 않는 경로) 공통 예시 하나라도 넣는다.
  if (!chosen.length && !rewrites.length) take(() => true);
  return { examples: chosen, rewrites };
}

// ─── 요청의 특징을 만드는 도우미 ─────────────────────

/**
 * 사용자가 지금 힘들다고 직접 말했는지. 예시 선택에만 쓰고 판단에는 쓰지 않는다.
 * 사용자가 쓴 말(질문 요약, 궁금한 점·이번 메시지에서 정리한 사실)만 넣는다. 고른 상황의 일반 맥락은 넣지 않는다.
 */
const SERIOUS_SIGNAL =
  /지쳤|지쳐요|지쳐서|지친다|너무 힘들|많이 힘들|힘들어요|힘들어서|힘들다|불안해|불안하|우울|무기력|망친 것|망쳤|쓸모없|죽고 싶|포기하고 싶|괴로워|괴롭|아프셔|아파서|돌아가셨|잃었|잃어서/;

export function seriousSignal(texts: readonly string[]): boolean {
  return texts.some((text) => SERIOUS_SIGNAL.test(text));
}

/** 묘묘 상품 주제 ID → 예시 주제. */
const MYOMYO_TOPIC: Readonly<Record<string, ExampleTopic>> = {
  temperament: "temperament",
  strengths: "strengths",
  work: "career",
  money: "wealth",
  romance: "romance",
  people: "social",
  friends: "friends",
  family: "family",
  place: "place",
};

/** 질문 분야 → 예시 주제. */
const DOMAIN_TOPIC: Readonly<Record<string, ExampleTopic>> = {
  temperament: "temperament",
  strengths: "strengths",
  career: "career",
  study: "career",
  wealth: "wealth",
  investment: "investment",
  romance: "romance",
  social: "social",
  "other-person": "social",
  friends: "friends",
  family: "family",
  place: "place",
  health: "health",
  general: "general",
};

export function topicOfProductTopic(topicId: string): ExampleTopic | null {
  return MYOMYO_TOPIC[topicId] ?? null;
}

export function topicOfDomain(domain: string): ExampleTopic | null {
  return DOMAIN_TOPIC[domain] ?? null;
}

/** 무진 족자 장 ID → 예시 주제 (앞일수록 중요). */
const MUJIN_SECTION_TOPICS: Readonly<Record<string, readonly ExampleTopic[]>> = {
  chart: ["chart", "temperament"],
  ch1: ["temperament", "strengths"],
  ch2: ["strengths", "career"],
  ch3: ["career"],
  ch4: ["wealth", "investment"],
  ch5: ["romance"],
  ch6: ["social", "friends"],
  ch7: ["family"],
  ch8: ["health", "temperament"],
  ch9: ["timing"],
  ch10: ["timing"],
  closing: ["general"],
};

export function topicsOfSection(sectionId: string): readonly ExampleTopic[] {
  if (sectionId.startsWith("basics-")) return MUJIN_SECTION_TOPICS.chart!;
  return MUJIN_SECTION_TOPICS[sectionId] ?? ["general"];
}

/** 겹치는 주제를 빼고 순서를 지킨다. */
export function uniqueTopics(topics: readonly (ExampleTopic | null | undefined)[]): ExampleTopic[] {
  const seen: ExampleTopic[] = [];
  for (const topic of topics) if (topic && !seen.includes(topic)) seen.push(topic);
  return seen;
}
