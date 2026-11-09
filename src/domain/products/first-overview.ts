import type { ProductDefinition } from "./types";

/**
 * 첫 상품. 이름, 가격, 질문 횟수, 주제 구성은 이 파일에서 바꾼다.
 * 내용을 바꾸면 version도 올린다. 이미 만든 주문과 풀이에는 당시 버전이 기록되어 있다.
 */
export const FIRST_OVERVIEW: ProductDefinition = {
  id: "first-overview",
  version: "1.0.0",
  name: "나를 읽는 짧은 사주",
  tagline: "성향부터 돈, 사람까지 여섯 가지를 짧게",
  description:
    "타고난 사주를 바탕으로 나의 성향과 강점, 일하는 방식, 돈을 다루는 습관, 연애와 사람 관계를 상담사가 메신저로 차근차근 설명해 드려요.",
  priceKrw: 990,
  orderName: "나를 읽는 짧은 사주",
  followupLimit: 3,
  archive: true,
  pdf: true,
  personaId: "yeoul",
  featureId: "first-overview-natal",
  rulesetId: "first-overview",
  expectedBubbles: "메시지 약 20개",
  topics: [
    {
      id: "temperament",
      title: "기본 성향",
      summary: "내가 평소에 어떻게 반응하고 움직이는지",
      inquiryDomain: "temperament",
      bubbles: { min: 2, target: 4, max: 4 },
      creativeScene: false,
    },
    {
      id: "strengths",
      title: "강점과 활용 방법",
      summary: "자주 꺼내 쓰는 힘과 써먹는 방법",
      inquiryDomain: "strengths",
      bubbles: { min: 2, target: 3, max: 4 },
      creativeScene: false,
    },
    {
      id: "work",
      title: "일과 직업",
      summary: "일할 때 힘이 나는 환경과 방식",
      inquiryDomain: "career",
      bubbles: { min: 2, target: 4, max: 4 },
      creativeScene: true,
    },
    {
      id: "money",
      title: "돈을 다루는 경향",
      summary: "돈을 대하는 습관과 챙길 점",
      inquiryDomain: "wealth",
      bubbles: { min: 2, target: 3, max: 4 },
      creativeScene: false,
    },
    {
      id: "romance",
      title: "연애와 관계 방식",
      summary: "가까운 사이에서 드러나는 나",
      inquiryDomain: "romance",
      bubbles: { min: 2, target: 3, max: 4 },
      creativeScene: true,
    },
    {
      id: "people",
      title: "인간관계의 특징",
      summary: "사람들과 지내는 나만의 방식",
      inquiryDomain: "social",
      bubbles: { min: 2, target: 3, max: 4 },
      creativeScene: false,
    },
  ],
  situation: {
    required: false,
    title: "요즘 어떤 상황이에요?",
    options: [
      { id: "student", label: "학생" },
      { id: "employee", label: "직장인" },
      { id: "job-seeking", label: "취업 준비 중" },
      { id: "self-employed", label: "자영업·프리랜서" },
      { id: "homemaker", label: "가사·육아 중" },
      { id: "resting", label: "쉬는 중" },
    ],
  },
  concern: {
    enabled: true,
    required: false,
    title: "진짜 궁금한 점이 있나요?",
    placeholder: "예: 요즘 일을 계속해도 될지 고민이에요",
  },
  sampleBubbles: [
    { text: "안녕하세요, 저는 여울이에요. 오늘은 타고난 기운을 같이 천천히 읽어 볼게요." },
    {
      text: "사주에서 드러나는 힘을 보면, 생각을 말이나 결과물로 꺼내면서 정리하는 쪽에 가까워요.",
    },
    { text: "그래서 혼자 오래 고민하기보다 메모라도 적어 보면 훨씬 빨리 풀리는 편이에요." },
    {
      text: "회의 전에 혼자 끄적인 아이디어를 동료에게 보여 주는 장면을 떠올려 볼게요. 이건 상상으로 그려 본 장면이에요.",
      scene: true,
    },
  ],
};
