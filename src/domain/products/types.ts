/** 앱이 정하는 상품 정의. 판매 정보, 주제 구성, 입력 항목, 답변 범위를 한 파일에 모은다. */

/** 상품 주제로 쓸 수 있는 엔진 질문 분야. */
export type InquiryDomain = "temperament" | "strengths" | "career" | "wealth" | "romance" | "social" | "family" | "friends" | "place";

/**
 * 질문 분류에 쓰는 전체 분야. 분류는 상품과 무관하게 "무엇에 대한 답을 원하는가"로 정하고,
 * 상품이 다루는지는 서버가 scope.domains로 판단한다.
 */
export type QuestionDomain = InquiryDomain | "general" | "health" | "investment" | "study" | "other-person" | "non-saju";

/**
 * explain: 풀이 내용이나 표현의 뜻, apply: 내 상황에 적용하는 방법, timing: 언제,
 * compare: 선택지 비교, outcome: 합격·결혼처럼 사건 결과의 확정, general: 그 밖의 넓은 질문.
 */
export type QuestionIntent = "explain" | "apply" | "timing" | "compare" | "outcome" | "general";

export interface ProductTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly inquiryDomain: InquiryDomain;
  /**
   * 말풍선 수의 계획 목표. 질문의 중심 주제(focus)는 늘리고 관련이 적은 주제(light)는 줄인다.
   * 내용을 자르는 상한이 아니다.
   */
  readonly depth: { readonly light: number; readonly standard: number; readonly focus: number };
  readonly creativeScene: boolean;
  /** 이 주제에서 다루는 항목. 작성 계획과 설계 문서가 같은 목록을 쓴다. */
  readonly outline: readonly string[];
}

export interface ProductSituationOption {
  readonly id: string;
  readonly label: string;
  /** 궁금한 점이 없을 때 비중을 높일 주제. */
  readonly focusDomains: readonly InquiryDomain[];
  /** 예시와 장면을 고를 때 쓰는 생활 맥락. 사용자가 직접 알려 준 사실이 아니라 선택지의 의미다. */
  readonly context: string;
  /** 주제별로 이 상황에서 짚을 관점. */
  readonly angles: Partial<Readonly<Record<InquiryDomain, string>>>;
}

export interface SampleBubble {
  readonly text: string;
  readonly scene?: boolean;
}

/** 상품이 답할 수 있는 범위. 질문의 관련성은 직전 대화 주제가 아니라 이 값으로 판단한다. */
export interface ProductScope {
  /** 답하는 질문 분야. 상품 주제가 아닌 분야(건강, 투자)는 routes로 답할 주제를 정한다. */
  readonly domains: readonly QuestionDomain[];
  /** 분류기가 분야를 고를 때 참고하는 각 분야의 설명. */
  readonly domainGuide: Partial<Readonly<Record<QuestionDomain, string>>>;
  /** 상품 주제가 아닌 질문 분야를 답할 주제로 잇는다 (예: 건강→기본 성향, 투자→돈). */
  readonly routes?: Partial<Readonly<Record<QuestionDomain, InquiryDomain>>>;
  readonly intents: readonly QuestionIntent[];
  /** 입력 화면과 후속 질문 안내에 쓰는 한 줄 설명. */
  readonly summary: string;
  /**
   * 캐릭터가 범위 밖 질문에 답할 때 말하는 주제 목록 (예: "성향, 강점, 일, 돈").
   * 안내 문장 자체는 캐릭터 말투라 캐릭터 설정(personas)의 lines에 있다.
   */
  readonly topicsLabel: string;
}

/** 시기 질문의 기본 분석 범위. */
export interface ProductTiming {
  /** 기간 판단 규칙이 있는 주제. 그 밖의 주제는 기간을 묻더라도 원국 설명과 한계를 전달한다. */
  readonly domains: readonly InquiryDomain[];
  /** 기간을 말하지 않은 시기 질문의 기본 분석 개월 수. */
  readonly defaultMonths: number;
  /** 사용자가 기간을 정해도 넘지 않는 최대 개월 수. */
  readonly maxMonths: number;
  readonly timezoneId: string;
}

/** 분량 기준. 상한이 아니라 계획 목표와 화면이 깨지지 않을 형식 범위다. */
export interface ProductLength {
  /** 말풍선 한 개의 권장 글자 수. */
  readonly bubbleChars: number;
  /** 화면과 PDF의 읽기를 위한 형식 상한. 넘으면 나눠 쓰게 한다. */
  readonly bubbleHardMax: number;
  /** 질문 하나당 답변 영역의 말풍선 목표. */
  readonly focusBubblesPerQuestion: number;
  /** 전체 말풍선 수의 형식 범위. 응답 이상을 잡는 용도이며 내용을 줄이는 기준이 아니다. */
  readonly totalBubbles: { readonly min: number; readonly max: number };
}

/** 페르소나가 표현할 강도. 판단과 근거는 바꾸지 않는다. */
export interface ProductExpression {
  readonly directness: "gentle" | "clear" | "blunt";
  readonly humor: "none" | "light" | "playful";
  readonly scenes: "minimal" | "rich";
}

export interface ProductDefinition {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  /** 결제 금액의 최종 기준. 브라우저가 보낸 금액은 쓰지 않는다. */
  readonly priceKrw: number;
  readonly orderName: string;
  readonly followupLimit: number;
  readonly archive: boolean;
  readonly pdf: boolean;
  readonly personaId: string;
  readonly featureId: string;
  readonly rulesetId: string;
  readonly expectedBubbles: string;
  readonly topics: readonly ProductTopic[];
  /** 궁금한 점에 직접 답하는 영역. 메시지의 topicId로 저장된다. */
  readonly focusSection: { readonly id: string; readonly title: string };
  readonly scope: ProductScope;
  readonly timing: ProductTiming;
  readonly length: ProductLength;
  readonly expression: ProductExpression;
  readonly situation: {
    readonly required: boolean;
    readonly title: string;
    readonly options: readonly ProductSituationOption[];
  };
  readonly concern: {
    readonly enabled: boolean;
    readonly required: boolean;
    readonly title: string;
    readonly placeholder: string;
    readonly hint: string;
  };
  readonly sampleBubbles: readonly SampleBubble[];
}

/** 화면과 PDF에서 쓰는 주제 제목. 질문 답변 영역의 제목도 포함한다. */
export function topicTitlesOf(product: ProductDefinition | undefined): Readonly<Record<string, string>> {
  if (!product) return {};
  return Object.fromEntries([
    [product.focusSection.id, product.focusSection.title],
    ...product.topics.map((topic) => [topic.id, topic.title] as const),
  ]);
}
