/**
 * 캐릭터별 질문–답변 예시 (few-shot). 실제 생성 요청에 골라 넣는 표현 참고 자료다.
 *
 * - 예시의 질문과 답변은 실제 이용자의 대화 기록이 아니다. 예시의 사용자 사실·판단·날짜·수치는 그 예시 안에서만 뜻이 있고
 *   현재 사용자의 작성 재료와 섞지 않는다 (모델 입력에서는 지시 끝의 예시 블록과 사용자 메시지의 작성 재료로 나뉜다).
 * - 카탈로그(캐릭터마다 전체 예시)와 요청별 선택 결과는 따로 둔다. 선택은 select.ts의 정책이 정한다.
 * - 원문(사용자가 준 문답)은 고치지 않는다. 원문 텍스트는 그대로 두고, 경로·주제 같은 런타임 메타데이터는 별도 표로 붙인다.
 * - 예시나 카탈로그를 바꿀 때는 이전 버전 번호를 다른 내용으로 다시 쓰지 않는다. 이미 시작한 생성 작업은 시작할 때의 프롬프트 버전이
 *   가리키는 카탈로그·정책 버전을 그대로 쓴다 (src/server/llm/example-block.ts의 PROMPT_EXAMPLES).
 */

/**
 * 예시를 쓸 수 있는 생성 경로.
 * reading: 묘묘 최초 풀이(캐릭터가 직접 쓰는 1-pass), followup: 후속 질문의 캐릭터 답변(묘묘·무진),
 * voice: 무진 Pass 2(중립 초안을 무진의 설명으로 다시 쓰기). 무진 Pass 1(중립 초안), 질문 정리, 사주 계산에는 예시를 넣지 않는다.
 */
export type ExampleRoute = "reading" | "followup" | "voice";

/** 예시가 다루는 주제. 묘묘 주제·질문 분야와 무진 장의 주제를 같은 이름으로 맞춘다. */
export type ExampleTopic =
  | "temperament"
  | "strengths"
  | "career"
  | "wealth"
  | "investment"
  | "romance"
  | "social"
  | "friends"
  | "family"
  | "place"
  | "health"
  | "timing"
  | "chart"
  | "general";

/**
 * 표현 목적.
 * greeting 첫 안내와 자연스러운 반응 · strength 강점을 인정하며 과해지는 조건 짚기 · weakness 근거 있는 약점을 직설적으로 ·
 * explain 이유와 조건을 충분히 푸는 설명 · compare 선택지 비교 · apply 사용자가 말한 상황에 적용 · uncertain 확정할 수 없는 질문 ·
 * serious 진지하거나 힘든 상황 · praise 칭찬에 대한 반응 · tease 가벼운 도발·허세 지적 · doubt 의심에 근거로 답하기 ·
 * correction 실제 오류 인정과 수정 · limits 모르는 것을 메우지 않기 · revisit 실제 이전 대화를 이어 받기 ·
 * persona-chat 캐릭터 배경·일상 (지금 서비스에는 이 대화를 모델이 답하는 경로가 없다).
 */
export type ExamplePurpose =
  | "greeting"
  | "strength"
  | "weakness"
  | "explain"
  | "compare"
  | "apply"
  | "uncertain"
  | "serious"
  | "praise"
  | "tease"
  | "doubt"
  | "correction"
  | "limits"
  | "revisit"
  | "persona-chat";

/** short: 한두 문장의 반응, medium: 한두 문단, long: 결론·이유·조건·대안·한계를 여러 문단으로 푸는 설명. */
export type ExampleLength = "short" | "medium" | "long";

/** 후속 메시지에 담긴 반응 (질문 정리의 reaction과 같은 이름). */
export type ExampleReaction = "praise" | "tease" | "doubt";

/**
 * 예시 전제 한 줄. 이 예시에만 해당한다.
 * user-fact: 예시 속 사용자가 알려 준 사실, judgment: 예시용 채택 판단, condition: 판단의 조건·예외, counter: 반대 근거,
 * action: 예시 재료에 있는 행동 제안, limit: 판단하지 않은 것·한계, context: 대화 상황(예: 앞선 답에 실제 오류가 있었다).
 */
export type PremiseKind = "user-fact" | "judgment" | "condition" | "counter" | "action" | "limit" | "context";

export interface ExamplePremiseLine {
  readonly kind: PremiseKind;
  readonly text: string;
}

/**
 * 예시의 출처.
 * user-original: 사용자가 준 원문 (고치지 않는다), user-reference: 사용자가 준 참고 문답 (그대로 두고 출발점으로 쓴다),
 * authored: 작성한 예시. basis에 근거로 삼은 상품 규칙 결론과 판단 범위를 적는다.
 */
export interface ExampleSource {
  readonly kind: "user-original" | "user-reference" | "authored";
  /** 원문의 번호와 제목 (예: "무진 05 — 강점을 설명할 때"). */
  readonly ref?: string;
  /** 작성 근거. 현재 코드에 있는 규칙 결론만 쓴다 (예: first-overview.wealth keeping). */
  readonly basis?: string;
}

/** 이 예시가 맞는 대화 조건. 조건이 있는 예시는 그 조건이 있을 때만 고른다. */
export interface ExampleNeeds {
  /** 출생 시각을 모르는 풀이. */
  readonly hourUnknown?: boolean;
  /** 실제로 받은 직전 대화가 있는 후속 질문. */
  readonly lastTurn?: boolean;
}

export interface CharacterExample {
  /** 고유 ID (예: myomyo-a-02, mujin-05). 다른 캐릭터·세트와 겹치지 않는다. */
  readonly id: string;
  readonly personaId: string;
  /** 예시 하나의 버전. 문장을 고치면 올리고, 카탈로그 버전도 함께 올린다. */
  readonly version: string;
  /** 세트 (묘묘 A/B/C, 무진 원문 original). */
  readonly setId: string;
  /** 쓸 수 있는 생성 경로. 비어 있으면 지금 서비스의 어떤 생성 요청에도 넣지 않는다 (보관·평가용). */
  readonly routes: readonly ExampleRoute[];
  readonly topics: readonly ExampleTopic[];
  readonly purposes: readonly ExamplePurpose[];
  readonly length: ExampleLength;
  /** 진지하거나 힘든 상황의 예시. 그런 상황이 아닐 때는 먼저 고르지 않는다. */
  readonly serious: boolean;
  /** 반응 예시. 같은 반응이 담긴 후속 메시지에만 고른다. */
  readonly reaction?: ExampleReaction;
  readonly needs?: ExampleNeeds;
  /** 예시 전제. 이 예시에만 해당하는 사용자 사실·판단·조건이다. */
  readonly premise: readonly ExamplePremiseLine[];
  /** 가상의 사용자 질문. */
  readonly question: string;
  /** 캐릭터의 답. 문단은 빈 줄로 나눈다. */
  readonly answer: string;
  readonly source: ExampleSource;
}

/**
 * 무진 Pass 2용 재작성 예시. 원문 문답(sourceExampleId)을 고치지 않고 참조한다.
 * 질문·전제·재작성 결과(=원문 답변)는 원문에서 가져오고, 여기에는 중립 초안과 지켜야 할 뜻만 둔다.
 * 중립 초안은 원문 답변에 있는 뜻과 명시된 전제만 정리한 것이다. 새 사주 판단이나 사용자 사실을 더하지 않는다.
 */
export interface RewriteExample {
  readonly id: string;
  readonly personaId: string;
  readonly version: string;
  readonly setId: "rewrite";
  readonly routes: readonly ExampleRoute[];
  readonly topics: readonly ExampleTopic[];
  readonly sourceExampleId: string;
  /** 중립 초안의 문단. 재작성 결과(원문 답변)의 문단과 순서대로 짝이 맞는다. */
  readonly neutralDraft: readonly string[];
  /** 다시 쓸 때 반드시 남아야 하는 뜻. */
  readonly preserve: readonly string[];
}

/** 캐릭터 하나의 예시 카탈로그. */
export interface ExampleCatalog {
  /** 예: myomyo-examples-1.0.0 */
  readonly version: string;
  readonly personaId: string;
  readonly examples: readonly CharacterExample[];
  readonly rewrites: readonly RewriteExample[];
}

/** 재작성 예시를 원문과 합쳐 읽은 모양 (조립·문서·테스트가 쓴다). */
export interface RewriteView {
  readonly id: string;
  readonly sourceExampleId: string;
  readonly question: string;
  readonly premise: readonly ExamplePremiseLine[];
  readonly neutralDraft: readonly string[];
  readonly rewritten: string;
  readonly preserve: readonly string[];
}
