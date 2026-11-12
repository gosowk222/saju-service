/** 앱이 정하는 상품 정의. 판매 정보, 주제 구성, 입력 항목, 답변 범위를 한 파일에 모은다. */

import type { ImageAsset } from "@/domain/images";

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

/**
 * 상품 그림. 메신저 상품(묘묘)은 상품명과 부설명을 그림에 넣지 않고 화면 글자로 올린다.
 * 화면은 글자를 포스터 아래쪽, 배너 왼쪽에 놓으므로 그림은 그 자리를 비워 둔다.
 * 그림 안에 이미 글자가 있는 상품(무진)은 textInImage로 알려 화면 글자를 겹치지 않게 한다.
 */
export interface ProductArt {
  /** 3:4 포스터 카드. 아래쪽 여백에 부설명과 제목이 올라간다. 보관함 썸네일은 square 영역을 쓴다. */
  readonly poster: ImageAsset;
  /** 상품 상세 배너. 메신저 상품은 16:10이고 왼쪽 여백에 부설명과 제목이 올라간다. */
  readonly banner: ImageAsset;
  /**
   * 그림 안에 상품 이름과 문구가 이미 들어 있다. 화면은 그림 위에 글자·스크림을 겹치지 않고,
   * 화면 읽기용 제목과 상품 정보를 그림 밖에 둔다. 배너는 원본 비율로 보여 준다.
   */
  readonly textInImage?: boolean;
}

/** 결과를 보여 주는 형식. messenger: 말풍선 대화(묘묘), scroll: 장으로 나눈 긴 족자 보고서(무진). */
export type ProductFormat = "messenger" | "scroll";

/** 형식과 관계없이 모든 상품이 가진 판매·범위·입력 값. 질문 분류, 주문, 이용권, 후속 질문이 이 값만 읽는다. */
export interface ProductBase {
  readonly id: string;
  readonly version: string;
  /** 화면, 결제창, 보관함, PDF에 보이는 상품 이름. 주문에는 이름 대신 상품 ID와 버전이 남는다. */
  readonly name: string;
  /** 부설명. 포스터와 상세 배너에서 상품 이름 위에 보인다. */
  readonly tagline: string;
  readonly description: string;
  readonly art: ProductArt;
  /** 결제 금액의 최종 기준. 브라우저가 보낸 금액은 쓰지 않는다. */
  readonly priceKrw: number;
  /** final(없을 때 기본): 출시 가격. provisional: 출시 가격이 정해지지 않아 개발·테스트용으로 둔 임시 가격. */
  readonly priceStatus?: "final" | "provisional";
  /** 결제창에 보이는 주문 이름. */
  readonly orderName: string;
  readonly followupLimit: number;
  /**
   * 질문 없이 반응(칭찬·놀림·의심)만 보낸 메시지를 차감 없이 받아 주는 횟수 (풀이마다).
   * 넘으면 캐릭터가 같은 반응 문장으로 답하되 질문 1회로 센다.
   */
  readonly freeReactions: number;
  readonly archive: boolean;
  readonly pdf: boolean;
  /** 말하는 캐릭터 (src/domain/personas의 레지스트리 ID). 상품 ID와 다른 개념이다. */
  readonly personaId: string;
  /**
   * 생성 정책. 서버의 생성 묶음 ID를 가리킨다 (메신저: src/server/generation/bundles.ts, 족자: src/server/llm/mujin-prompts.ts의 MUJIN_BUNDLES).
   * 묶음이 실행 방식(1-pass·2-pass), 단계별 지시·출력 형식, 캐릭터 설정 버전, 예시 카탈로그·선택 정책을 함께 고정한다.
   * 새 생성 작업은 처음 시작할 때 이 묶음을 고정하고, 이미 시작한 작업은 그때 고정한 버전으로만 이어 쓴다.
   * 묶음의 캐릭터와 personaId가 같아야 한다 (tests/unit/persona-registry.test.ts).
   */
  readonly generation: { readonly bundle: string };
  readonly featureId: string;
  readonly rulesetId: string;
  readonly scope: ProductScope;
  readonly timing: ProductTiming;
  readonly expression: ProductExpression;
  readonly concern: {
    readonly enabled: boolean;
    readonly required: boolean;
    readonly title: string;
    readonly placeholder: string;
    readonly hint: string;
  };
}

/** 메신저 말풍선 상품 (묘묘의 사주 참견). format이 없으면 메신저다. */
export interface ProductDefinition extends ProductBase {
  readonly format?: "messenger";
  readonly expectedBubbles: string;
  readonly topics: readonly ProductTopic[];
  /** 궁금한 점에 직접 답하는 영역. 메시지의 topicId로 저장된다. */
  readonly focusSection: { readonly id: string; readonly title: string };
  readonly length: ProductLength;
  readonly situation: {
    readonly required: boolean;
    readonly title: string;
    readonly options: readonly ProductSituationOption[];
  };
  readonly sampleBubbles: readonly SampleBubble[];
}

/** 족자 보고서의 질문 하나. 목차·관심 주제·진행 상태에 같은 제목을 쓴다. */
export interface ScrollQuestion {
  /** 설계 문서의 질문 ID (P01~P05, 1-1~10-4). */
  readonly id: string;
  readonly title: string;
}

/** 족자 보고서의 한 칸 (기초 분석 한 항목, 한 장, 마지막 정리). */
export interface ScrollSectionSpec {
  readonly id: string;
  /** chart: 원국표(계산값만, 글 없음), basics: 기초 분석, chapter: 1~10장, closing: 마지막 질문 정리. */
  readonly kind: "chart" | "basics" | "chapter" | "closing";
  /** 장 번호 (chapter만). */
  readonly number: number | null;
  readonly title: string;
  readonly tier: "free" | "paid";
  readonly questions: readonly ScrollQuestion[];
  /** 최종 한국어 본문(공백 포함)의 편집 목표. 강제 최소 글자 수가 아니며 범위 밖이라고 다시 만들지 않는다. */
  readonly targetChars: { readonly min: number; readonly max: number };
  /** 구매 전 목차에 보이는 설명. 개인 풀이 내용이 아니다. */
  readonly summary: string;
  /** 앱이 실제 계산값으로 그리는 표. LLM이 값을 다시 쓰지 않는다. */
  readonly tables: readonly ScrollTable[];
}

export type ScrollTable = "pillars" | "elements" | "stages" | "ten-gods" | "luck" | "months";

/** Pass 1 초안을 한 번의 스트림 호출로 받는 장 묶음. 첫 표시 단위는 작게, 뒤쪽은 관련 장끼리 묶는다. */
export interface ScrollDraftBatch {
  readonly id: string;
  readonly tier: "free" | "paid";
  readonly sectionIds: readonly string[];
}

export interface ScrollSpec {
  /** 목차 순서. 생성이 끝나는 순서와 관계없이 화면은 이 순서를 지킨다. */
  readonly sections: readonly ScrollSectionSpec[];
  /** Pass 1 묶음. 같은 단계 안에서 순서대로 실행한다. 마지막 정리는 다른 장의 초안 요약이 필요해 맨 뒤에 둔다. */
  readonly draftBatches: readonly ScrollDraftBatch[];
}

/** 장으로 나눈 긴 족자 보고서 상품 (무진의 종합 사주). */
export interface ScrollProductDefinition extends ProductBase {
  readonly format: "scroll";
  /** 상품 화면에 보이는 구성 안내 (예: "무료 기초 분석과 1장 · 유료 2~10장과 질문 정리"). */
  readonly contentsLabel: string;
  readonly scroll: ScrollSpec;
}

export type AnyProductDefinition = ProductDefinition | ScrollProductDefinition;

export function isScrollProduct(product: AnyProductDefinition | undefined | null): product is ScrollProductDefinition {
  return product?.format === "scroll";
}

export function isMessengerProduct(product: AnyProductDefinition | undefined | null): product is ProductDefinition {
  return !!product && product.format !== "scroll";
}

/** 화면과 PDF에서 쓰는 주제 제목. 질문 답변 영역의 제목도 포함한다. 족자 상품은 장 제목을 쓴다. */
export function topicTitlesOf(product: AnyProductDefinition | undefined): Readonly<Record<string, string>> {
  if (!product) return {};
  if (isScrollProduct(product)) return Object.fromEntries(product.scroll.sections.map((section) => [section.id, section.title] as const));
  return Object.fromEntries([
    [product.focusSection.id, product.focusSection.title],
    ...product.topics.map((topic) => [topic.id, topic.title] as const),
  ]);
}
