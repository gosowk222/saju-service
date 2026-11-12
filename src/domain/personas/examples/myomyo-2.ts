/**
 * 묘묘 예시 카탈로그 myomyo-examples-2.0.0 (2026-11-13 사용자 제공 기준 문답 12개). 새 묘묘 생성(묶음 myomyo-2pass-1.0.0의 Pass 2와
 * 후속 답변 followup-3.3.0)의 기본 카탈로그다. 이전 카탈로그(myomyo-examples-1.0.0, A·B·C 세트 27개)와 섞지 않는다.
 *
 * - 원문 12개: myomyo-originals-2.ts의 받은 그대로의 문답을 읽어(parseDividedOriginals) 쓴다. 질문·답변·입력 전제를 고치지 않는다.
 *   여기서는 경로·주제·표현 목적 같은 런타임 메타데이터와 전제 줄의 종류만 붙인다.
 * - 재작성 예시 3개: 본문용 04·05·08을 Pass 2(중립 초안 → 같은 뜻의 묘묘 설명)의 시범으로도 쓴다. 재작성 결과는 원문 답변 그대로다.
 *   중립 초안은 원문 답변의 뜻과 명시된 입력 전제만 정리했다. 답변에 있는 뜻을 초안에서 빼면 Pass 2가 새 내용을 더하는 법을 배우고,
 *   답변에 없는 판단을 초안에 넣으면 Pass 2가 내용을 빼는 법을 배운다. 묘묘의 비유("혼자 마음속 회의", "중간 계산을 건너뛰었다")와
 *   반응("그 신중함은 인정", "아깝잖아")은 초안에 이미 있는 뜻을 묘묘의 말로 옮긴 표현이라 초안에는 뜻만 둔다.
 *
 * 경로:
 * - voice: 최초 풀이 Pass 2 (주제 하나의 중립 초안을 묘묘 말풍선으로 다시 쓰기). 사용자가 방금 한 말에 반응하는 예시(11 오류 정정, 12 칭찬)는 넣지 않는다.
 * - followup: 후속 답변. 반응 예시는 같은 반응이 담긴 메시지에만, 진지한 예시(10)는 사용자가 지금 힘들다고 직접 말했을 때만,
 *   오류 정정(11)은 의심 반응이고 실제로 받은 직전 대화가 있을 때만 후보가 된다 (실제 오류가 없는 답에 정정 예시를 반복해 넣지 않게).
 */
import { parseDividedOriginals } from "./originals";
import { MYOMYO_ORIGINALS_2_TEXT } from "./myomyo-originals-2";
import type { CharacterExample, ExampleCatalog, ExampleLength, ExamplePurpose, ExampleReaction, ExampleRoute, ExampleTopic, PremiseKind, RewriteExample } from "./types";

export const MYOMYO_EXAMPLE_CATALOG_2_VERSION = "myomyo-examples-2.0.0";

interface OriginalMeta {
  readonly routes: readonly ExampleRoute[];
  readonly topics: readonly ExampleTopic[];
  readonly purposes: readonly ExamplePurpose[];
  readonly length: ExampleLength;
  readonly serious?: boolean;
  readonly reaction?: ExampleReaction;
  readonly needs?: CharacterExample["needs"];
  /** 원문 입력 전제 줄마다의 종류 (줄 수와 같아야 한다). */
  readonly premiseKinds: readonly PremiseKind[];
}

const BODY: readonly ExampleRoute[] = ["voice", "followup"];

/** 원문 번호별 메타데이터. 원문 텍스트는 여기에 없다. */
const ORIGINAL_META: Readonly<Record<string, OriginalMeta>> = {
  "01": { routes: BODY, topics: ["career", "temperament"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "02": { routes: BODY, topics: ["career", "temperament"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "03": { routes: BODY, topics: ["romance"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "04": { routes: BODY, topics: ["romance"], purposes: ["weakness", "explain"], length: "medium", premiseKinds: ["judgment", "condition", "action", "limit"] },
  "05": { routes: BODY, topics: ["strengths", "career"], purposes: ["strength", "explain"], length: "medium", premiseKinds: ["judgment", "condition", "action"] },
  "06": { routes: BODY, topics: ["temperament", "career"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "07": { routes: BODY, topics: ["wealth", "friends"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "08": {
    routes: BODY,
    topics: ["career"],
    purposes: ["compare", "explain"],
    length: "long",
    premiseKinds: ["judgment", "condition", "judgment", "action", "limit"],
  },
  "09": { routes: BODY, topics: ["friends", "social"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "10": { routes: BODY, topics: ["general"], purposes: ["serious"], length: "medium", serious: true, premiseKinds: [] },
  "11": {
    routes: ["followup"],
    topics: ["general"],
    purposes: ["correction"],
    length: "medium",
    reaction: "doubt",
    needs: { lastTurn: true },
    premiseKinds: ["user-fact", "context"],
  },
  "12": { routes: ["followup"], topics: ["general"], purposes: ["praise"], length: "short", reaction: "praise", premiseKinds: [] },
};

function buildOriginals(): CharacterExample[] {
  return parseDividedOriginals(MYOMYO_ORIGINALS_2_TEXT, "묘묘").map((original) => {
    const meta = ORIGINAL_META[original.number];
    if (!meta) throw new Error(`묘묘 예시 ${original.number}의 메타데이터가 없습니다.`);
    if (meta.premiseKinds.length !== original.premise.length) {
      throw new Error(`묘묘 예시 ${original.number}: 입력 전제 ${original.premise.length}줄에 종류가 ${meta.premiseKinds.length}개입니다.`);
    }
    return {
      id: `myomyo-v2-${original.number}`,
      personaId: "myomyo",
      version: "2.0.0",
      setId: "original-2",
      routes: meta.routes,
      topics: meta.topics,
      purposes: meta.purposes,
      length: meta.length,
      serious: meta.serious ?? false,
      ...(meta.reaction ? { reaction: meta.reaction } : {}),
      ...(meta.needs ? { needs: meta.needs } : {}),
      premise: original.premise.map((text, index) => ({ kind: meta.premiseKinds[index]!, text })),
      question: original.question,
      answer: original.answer,
      source: { kind: "user-original", ref: `묘묘 예시 ${original.number} — ${original.title}` },
    };
  });
}

/** Pass 2 재작성 예시. 질문·전제·재작성 결과는 원문(sourceExampleId)에서 읽는다 (rewriteView). */
const REWRITES: readonly RewriteExample[] = [
  {
    id: "myomyo-v2-rw-04",
    personaId: "myomyo",
    version: "2.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["romance"],
    sourceExampleId: "myomyo-v2-04",
    neutralDraft: [
      "이 풀이에서는 마음이 움직여도 곧바로 표현하기보다 상대를 더 살펴보는 쪽으로 해석된다. 아무에게나 쉽게 마음을 주지 않는 신중함은 장점으로 인정할 만하다.",
      "다만 확신이 생길 때까지 아무 신호도 보내지 않으면, 상대는 호감을 알아챌 단서를 얻지 못한다. 혼자 속으로 검토하는 것만으로는 마음이 전달되지 않는다.",
      "처음부터 큰 고백을 할 필요는 없다. 안부를 묻거나 함께할 일을 제안하는 정도로 접점을 만들어 보는 것이 좋다. 상대를 확인하는 시간과 조금씩 표현해 보는 시간을 나누어 두는 방식이다.",
    ],
    preserve: [
      "판단: 호감이 생겨도 표현보다 상대를 확인하는 과정이 앞서는 경향 (성향 해석이며 단정하지 않는다)",
      "인정: 쉽게 마음을 주지 않는 신중함은 장점이다",
      "조건: 확신을 기다리며 신호를 보내지 않으면 상대가 알아챌 단서가 없고 관계 진전이 늦어질 수 있다",
      "조언과 범위: 큰 고백이 아니라 안부나 함께할 일 제안 같은 작은 접점부터",
      "한계: 사용자의 실제 연애 경험과 상대의 마음은 말하지 않는다",
    ],
  },
  {
    id: "myomyo-v2-rw-05",
    personaId: "myomyo",
    version: "2.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["strengths", "career"],
    sourceExampleId: "myomyo-v2-05",
    neutralDraft: [
      "이 풀이에서 가장 활용하기 좋은 강점은 한 가지를 붙잡으면 깊이 파고드는 힘이다. 겉만 확인하고 넘어가기보다 자기 것으로 만들 때까지 들여다보는 쪽이 강점으로 채택되어 있다.",
      "다만 이 힘을 모든 일에 똑같이 쓰는 것은 권하지 않는다.",
      "지금 완성해야 하는 결과에서 중요한 부분이 어디인지 먼저 고르는 것이 좋다. 작은 부분까지 모두 같은 깊이로 파고들면 정작 보여 줘야 할 결과의 완성이 늦어질 수 있다.",
      "몰입하는 힘이 있다는 점은 분명하므로, 그 힘을 어디에 쓸지 신중하게 골라야 강점을 낭비하지 않는다.",
    ],
    preserve: [
      "강점: 한 가지를 깊이 탐구하고 지속하는 힘 (채택된 강점)",
      "조건: 중요도가 낮은 부분까지 같은 깊이로 몰입하면 필요한 결과의 완성이 늦어질 수 있다",
      "조언: 몰입할 대상을 핵심 결과물에 맞춰 고른다",
    ],
  },
  {
    id: "myomyo-v2-rw-08",
    personaId: "myomyo",
    version: "2.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["career"],
    sourceExampleId: "myomyo-v2-08",
    neutralDraft: [
      "이 풀이에서는 일하는 방식을 스스로 정할 수 있는지가 중요한 성향으로 해석된다. 다만 회사가 맞지 않는다는 이유만으로 곧바로 프리랜서가 정답이라고 결론 내리기에는 따져야 할 단계가 빠져 있다.",
      "맡은 일을 어떻게 해낼지 스스로 정하고 결과로 확인받는 조직이라면 자율성을 살릴 여지가 있다. 회사라는 형태보다 재량과 책임이 어떻게 나뉘는지를 먼저 보는 것이 좋다.",
      "독립하면 혼자 몰입하는 시간만 늘어나는 것이 아니다. 일을 구하고, 고객 의견을 듣고, 조건을 맞추는 일도 직접 맡게 될 수 있다. 회사 밖에서도 조율해야 할 상대는 있다.",
      "따라서 선택지를 비교할 때는 스스로 정할 수 있는 범위가 얼마나 되는지, 그 대신 어떤 책임을 맡는지를 함께 본다. 독립할 준비가 되었는지는 실제 일감과 생활 조건까지 함께 확인해야 판단할 수 있다.",
      "자율성과 몰입이라는 강점은 살리는 것이 좋다. 그러나 자유로워 보이는 형태만 보고 고르면 다른 형태의 간섭을 만나 다시 부담을 느낄 수 있으므로, 이름보다 실제 내용을 비교해야 한다.",
    ],
    preserve: [
      "판단: 자율성과 몰입이 강점이며 일하는 방식을 스스로 정할 수 있는지가 중요하다 (성향 해석)",
      "결론의 범위: 회사가 맞지 않는다는 이유만으로 독립이 정답이라고 하지 않는다",
      "대안: 재량권이 있는 조직도 선택지다",
      "조건: 반복적인 간섭과 모호한 역할 분담에서 부담이 커질 수 있고, 독립한 뒤에도 다른 형태의 간섭을 만날 수 있다",
      "비교 조건: 독립 활동은 일감 확보와 고객 조율을 함께 비교한다",
      "한계: 실제 자금·고객·경력·성공 여부·전환 시점은 말하지 않고, 준비 여부는 실제 일감과 생활 조건으로 확인한다",
    ],
  },
];

export const MYOMYO_EXAMPLES_2_0_0: ExampleCatalog = {
  version: MYOMYO_EXAMPLE_CATALOG_2_VERSION,
  personaId: "myomyo",
  examples: buildOriginals(),
  rewrites: REWRITES,
};
