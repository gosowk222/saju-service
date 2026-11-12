/**
 * 무진 도사 예시 카탈로그 (mujin-examples-1.0.0).
 *
 * - 원문 21개: mujin-originals.ts의 받은 그대로의 문답을 읽어(parseOriginals) 쓴다. 질문·답변·입력 전제를 고치지 않는다.
 *   여기서는 경로·주제·표현 목적 같은 런타임 메타데이터와 전제 줄의 종류만 붙인다.
 * - 재작성 예시 4개: Pass 2(중립 초안 → 같은 뜻의 무진 설명)를 보여 준다. 원문 05·07·09·10을 참조하며, 재작성 결과는 원문 답변 그대로다.
 *   중립 초안은 원문 답변에 있는 뜻만 정리했다 (원문 답변에 없는 판단·사실을 초안에 넣으면 Pass 2가 내용을 빼는 법을 배우고,
 *   원문 답변의 뜻을 초안에서 빼면 Pass 2가 새 내용을 더하는 법을 배운다). 원문의 건조한 농담과 태도 표현(예: "이름에 ‘자유’가…",
 *   "그 빈칸을 자신감으로 메우진 않겠습니다")은 이미 초안에 있는 뜻을 무진의 말로 옮긴 표현이라 초안에는 뜻만 둔다.
 *
 * 경로 (지금 서비스에서 모델이 답하는 경로만):
 * - voice: Pass 2 장 다시 쓰기. followup: 후속 질문 답변 (반응 예시는 같은 반응이 담긴 질문에만).
 * - 01(첫 상담)은 입력 안내가 모델 없이 고정 문장이라, 18(자기 사연)·21(일상)은 그런 질문에 모델이 답하는 경로가 없어
 *   경로를 비워 둔다 (보관·평가용). 후속 질문 범위나 차감 정책은 바꾸지 않는다.
 */
import { parseOriginals } from "./originals";
import { MUJIN_ORIGINALS_TEXT } from "./mujin-originals";
import type { CharacterExample, ExampleCatalog, ExampleLength, ExamplePurpose, ExampleReaction, ExampleRoute, ExampleTopic, PremiseKind, RewriteExample } from "./types";

export const MUJIN_EXAMPLE_CATALOG_VERSION = "mujin-examples-1.0.0";

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

/** 원문 번호별 메타데이터. 원문 텍스트는 여기에 없다. */
const ORIGINAL_META: Readonly<Record<string, OriginalMeta>> = {
  "01": { routes: [], topics: ["general"], purposes: ["greeting"], length: "short", premiseKinds: [] },
  "02": { routes: ["followup"], topics: ["general"], purposes: ["doubt"], length: "short", reaction: "doubt", premiseKinds: [] },
  "03": { routes: ["followup"], topics: ["general"], purposes: ["tease"], length: "short", reaction: "tease", premiseKinds: [] },
  "04": { routes: ["followup", "voice"], topics: ["general"], purposes: ["uncertain", "limits"], length: "short", premiseKinds: [] },
  "05": { routes: ["voice", "followup"], topics: ["strengths", "temperament"], purposes: ["strength"], length: "medium", premiseKinds: ["judgment", "condition"] },
  "06": { routes: ["followup", "voice"], topics: ["social"], purposes: ["weakness", "apply"], length: "medium", premiseKinds: [] },
  "07": { routes: ["voice", "followup"], topics: ["romance"], purposes: ["weakness", "explain"], length: "medium", premiseKinds: ["judgment", "action"] },
  "08": { routes: ["followup", "voice"], topics: ["romance"], purposes: ["uncertain"], length: "short", premiseKinds: [] },
  "09": {
    routes: ["voice", "followup"],
    topics: ["career"],
    purposes: ["compare", "explain"],
    length: "long",
    premiseKinds: ["judgment", "judgment", "action", "limit"],
  },
  "10": { routes: ["followup", "voice"], topics: ["timing", "romance"], purposes: ["uncertain", "limits"], length: "short", premiseKinds: ["judgment", "limit"] },
  "11": { routes: ["followup", "voice"], topics: ["wealth"], purposes: ["apply", "weakness"], length: "medium", premiseKinds: [] },
  "12": { routes: ["followup", "voice"], topics: ["general"], purposes: ["serious"], length: "medium", serious: true, premiseKinds: [] },
  "13": { routes: ["followup"], topics: ["general"], purposes: ["praise", "limits"], length: "short", reaction: "praise", premiseKinds: [] },
  "14": { routes: ["followup"], topics: ["general"], purposes: ["tease"], length: "short", reaction: "tease", premiseKinds: [] },
  "15": { routes: ["followup"], topics: ["general"], purposes: ["correction"], length: "short", reaction: "doubt", premiseKinds: ["user-fact", "context"] },
  "16": { routes: ["voice", "followup"], topics: ["chart"], purposes: ["limits"], length: "short", needs: { hourUnknown: true }, premiseKinds: [] },
  "17": { routes: ["followup"], topics: ["general"], purposes: ["serious", "uncertain"], length: "short", serious: true, premiseKinds: [] },
  "18": { routes: [], topics: ["general"], purposes: ["persona-chat"], length: "short", premiseKinds: [] },
  "19": { routes: ["followup"], topics: ["general"], purposes: ["praise"], length: "short", reaction: "praise", premiseKinds: [] },
  "20": { routes: ["followup"], topics: ["social"], purposes: ["revisit"], length: "medium", needs: { lastTurn: true }, premiseKinds: ["context"] },
  "21": { routes: [], topics: ["general"], purposes: ["persona-chat"], length: "short", premiseKinds: [] },
};

function buildOriginals(): CharacterExample[] {
  return parseOriginals(MUJIN_ORIGINALS_TEXT, "무진", "무진").map((original) => {
    const meta = ORIGINAL_META[original.number];
    if (!meta) throw new Error(`무진 원문 ${original.number}의 메타데이터가 없습니다.`);
    if (meta.premiseKinds.length !== original.premise.length) {
      throw new Error(`무진 원문 ${original.number}: 입력 전제 ${original.premise.length}줄에 종류가 ${meta.premiseKinds.length}개입니다.`);
    }
    return {
      id: `mujin-${original.number}`,
      personaId: "mujin",
      version: "1.0.0",
      setId: "original",
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
      source: { kind: "user-original", ref: `무진 ${original.number} — ${original.title}` },
    };
  });
}

/** Pass 2 재작성 예시. 질문·전제·재작성 결과는 원문(sourceExampleId)에서 읽는다 (rewriteView). */
const REWRITES: readonly RewriteExample[] = [
  {
    id: "mujin-rw-05",
    personaId: "mujin",
    version: "1.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["strengths", "temperament"],
    sourceExampleId: "mujin-05",
    neutralDraft: [
      "이 풀이에서 두드러지는 강점은 맡은 일을 끝까지 이어 가는 책임감과 지속성이다. 일을 시작만 하고 그만두기보다 남은 일을 마무리하는 편으로 해석된다. 다만 끝까지 할 수 있다는 것이 모든 일을 맡아야 한다는 뜻은 아니므로 둘을 구분하는 것이 좋다. 능력이 있다는 이유로 매번 마무리까지 떠맡을 의무는 없다.",
    ],
    preserve: [
      "강점: 맡은 일을 끝까지 이어 가는 책임감과 지속성",
      "확신 수준: 성향 해석으로 말한다 (단정하지 않는다)",
      "조건: 끝까지 할 수 있다는 것과 전부 맡아야 한다는 것은 다르다",
      "조언: 그 둘을 구분하고, 매번 마무리까지 떠맡을 의무는 없다",
    ],
  },
  {
    id: "mujin-rw-07",
    personaId: "mujin",
    version: "1.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["romance"],
    sourceExampleId: "mujin-07",
    neutralDraft: [
      "이 풀이에서는 호감이 생겨도 표현하기보다 상대의 반응을 확인하는 쪽이 먼저인 성향으로 해석된다. 상대를 살피는 신중함 자체는 좋은 점이다. 그러나 확신이 생길 때까지 아무것도 표현하지 않으면 관계가 진전될 계기도 줄어든다.",
      "처음부터 큰 고백을 할 필요는 없다. 안부를 묻거나 함께할 일을 제안하는 정도의 작은 표현부터 시작하는 것이 좋다. 혼자 오래 고민한 마음은 상대에게 전달되지 않기 때문이다.",
    ],
    preserve: [
      "판단: 호감이 생겨도 표현보다 확인이 앞선다 (성향 해석)",
      "인정: 상대를 살피는 신중함 자체는 좋다",
      "조건: 확신이 생길 때까지 표현하지 않으면 관계가 움직일 계기가 줄어든다",
      "조언과 범위: 큰 고백이 아니라 안부나 함께할 일 제안 같은 작은 표현부터",
      "이유: 마음속에서만 검토한 것은 상대가 알 수 없다",
    ],
  },
  {
    id: "mujin-rw-09",
    personaId: "mujin",
    version: "1.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["career"],
    sourceExampleId: "mujin-09",
    neutralDraft: [
      "이 풀이에서는 조직 생활 자체가 맞지 않는다기보다, 일하는 방식을 스스로 정할 수 있을 때 힘이 나는 성향으로 해석된다. 일을 맡긴 뒤 결과로 확인하는 환경과 과정마다 간섭하는 환경의 차이가 크게 작용한다. 같은 회사 생활이라도 어떤 환경이냐에 따라 체감이 달라질 수 있다.",
      "따라서 지금 답답하다는 이유만으로 독립이 정답이라고 판단하지 않는다. 재량권이 있는 팀이나 역할을 찾는 것도 선택지다. 직함을 바꾼다고 간섭이 모두 사라지는 것은 아니다.",
      "프리랜서를 고려한다면 혼자 몰입하는 시간만이 아니라 고객과 조건을 조율하고 일을 구하는 부담까지 함께 비교해야 한다. 지금 싫은 일이 줄어드는 대신 다른 종류의 일이 생길 수 있다.",
      "이번 풀이의 기준은 '회사냐 독립이냐'보다 '스스로 결정할 수 있는 범위가 얼마나 되느냐'이다. 독립의 성공 여부와 시기는 제공된 자료로 판단할 수 없으며 판단하지 않는다.",
    ],
    preserve: [
      "판단: 조직 생활 자체보다 일하는 방식을 스스로 정할 수 있을 때 힘이 난다 (성향 해석)",
      "조건: 결과로 확인하는 환경과 과정마다 간섭하는 환경의 차이가 크다",
      "결론의 범위: 답답하다는 이유만으로 독립이 정답이라고 하지 않는다",
      "대안: 재량권이 있는 팀이나 역할도 선택지다",
      "비교 조건: 프리랜서는 고객 조율과 일을 구하는 부담까지 함께 따진다",
      "기준: 회사냐 독립이냐보다 스스로 결정할 수 있는 범위",
      "한계: 성공 여부와 시기는 판단하지 않는다",
    ],
  },
  {
    id: "mujin-rw-10",
    personaId: "mujin",
    version: "1.0.0",
    setId: "rewrite",
    routes: ["voice"],
    topics: ["timing"],
    sourceExampleId: "mujin-10",
    neutralDraft: [
      "질문한 그 달은 연애가 성사되는 달이라는 뜻이 아니다. 제공된 기간 자료에서는 사람을 만나는 활동에 힘을 실어 볼 시기로 해석된다. 소개나 모임처럼 사람과 접점을 만드는 활동에 써 보는 것이 좋다. 그 달이 특정한 만남을 보장하지는 않는다.",
    ],
    preserve: [
      "날짜: 질문한 그 달을 다른 달로 바꾸거나 새 날짜를 더하지 않는다",
      "판단: 사람을 만나는 활동에 힘을 실어 볼 시기 (기간 흐름의 해석)",
      "한계: 연애 성사나 특정한 만남을 보장하지 않는다",
      "활용: 소개나 모임처럼 접점을 만드는 활동",
    ],
  },
];

export const MUJIN_EXAMPLES_1_0_0: ExampleCatalog = {
  version: MUJIN_EXAMPLE_CATALOG_VERSION,
  personaId: "mujin",
  examples: buildOriginals(),
  rewrites: REWRITES,
};
