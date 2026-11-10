/** 앱이 정하는 상품 정의. 판매 정보, 주제 구성, 입력 항목을 한 파일에 모은다. */

export type InquiryDomain = "temperament" | "strengths" | "career" | "wealth" | "romance" | "social";

export interface ProductTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly inquiryDomain: InquiryDomain;
  /** 말풍선 개수의 목표치. 분량을 채우려 반복하지 않도록 범위로 둔다. */
  readonly bubbles: { readonly min: number; readonly target: number; readonly max: number };
  readonly creativeScene: boolean;
}

export interface ProductSituationOption {
  readonly id: string;
  readonly label: string;
}

export interface SampleBubble {
  readonly text: string;
  readonly scene?: boolean;
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
  };
  readonly sampleBubbles: readonly SampleBubble[];
}
