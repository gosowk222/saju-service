import type { QuestionDomain } from "../products/types";
import { timingStatements } from "./focus";
import { allowedChartTerms, chartTermIssues } from "./lore";
import type {
  ChartView,
  FollowupOutput,
  FollowupOutputV2,
  InterpretationStatement,
  NarrationBubble,
  NarrationTopic,
  NarrationOutput,
  NarrationOutputV2,
  NarrationPlanV2,
  ReadingPlan,
  TimingPeriodStatement,
} from "./types";

/**
 * 생성 문장의 최소 검사. 형식이 맞아도 내용이 맞다는 뜻은 아니므로
 * 정확히 비교할 수 있는 값만 확인한다. 말투나 품질, 약점 표현의 직설성은 여기서 판단하지 않는다.
 *
 * 1.0.0 검사(checkNarration, checkFollowup)는 이전 형식으로 시작한 생성 작업에만 쓴다.
 */

export const BUBBLE_MAX_CHARS = 220;
export const FOLLOWUP_MAX_CHARS = 700;
const TOTAL_BUBBLES = { min: 12, max: 30 };

const STEMS = "갑을병정무기경신임계";
const BRANCHES = "자축인묘진사오미신유술해";

const DATE_CLAIM = /\d{4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일/;
/** 3원칙, 2원화처럼 금액이 아닌 말은 제외한다. */
const MONEY_CLAIM = /\d[\d,]*\s*(?:만\s*원|억|원(?![칙인리래소화형]))/;
const PERCENT_VALUE = /(\d{1,3})\s*%/g;
const PROBABILITY_CLAIM = /확률|적중률/;
/**
 * 건강·투자·미래는 완곡하게만 말한다 (상품 3.0.0). 단어가 아니라 단정하는 결과, 진단, 매매 지시만 잡는다.
 * "합격할 흐름이 보여요"는 통과하고 "합격합니다", "지금 매수하세요"는 걸린다.
 */
const FORBIDDEN_TOPIC =
  /진단명|처방(?:해|을|받)|(?:합격|재회|결혼|취업|당첨)(?:합니다|할 거예요|하게 됩니다|하게 될 거예요|할 겁니다)|(?:매수|매도)하세요|수익(?:이|을)\s*보장/;
const SCENE_AS_FACT = /사주(?:에|로|가)\s*(?:나와|나옵|보면|확정|정해)|계산(?:상|결과|된)|반드시|확실(?:히|합니다|해요)|틀림없/;

function collectRefs(plan: ReadingPlan): Map<string, Set<string>> {
  const shared = [...plan.facts.map((fact) => fact.ref), ...plan.userContext.map((item) => item.ref)];
  return new Map(
    plan.topics.map((topic) => [topic.topicId, new Set([...shared, ...topic.statements.map((item) => item.ref)])]),
  );
}

function allowedPercents(plan: ReadingPlan): Set<string> {
  const values = new Set<string>();
  for (const fact of plan.facts) {
    for (const match of fact.text.matchAll(PERCENT_VALUE)) values.add(match[1]!);
  }
  return values;
}

/** 일간이나 기둥을 명시한 표현이 실제 계산값과 다른지 본다. */
function checkAgainstChart(text: string, chart: ChartView): string[] {
  const issues: string[] = [];
  const dayStem = chart.dayMaster?.ko;
  const dayMatch = text.match(new RegExp(`일간[은는이가]?\\s*[‘'"]?([${STEMS}])(?=[(（\\s목화토금수,.]|$)`, "u"));
  if (dayMatch && dayStem && dayMatch[1] !== dayStem) {
    issues.push(`일간을 계산값(${dayStem})과 다르게 설명했습니다: ${dayMatch[1]}`);
  }
  const pillars = new Map(chart.pillars.map((pillar) => [pillar.label, pillar]));
  const pillarNames: Readonly<Record<string, string>> = { 년주: "연주", 연주: "연주", 월주: "월주", 일주: "일주", 시주: "시주" };
  for (const match of text.matchAll(new RegExp(`([${STEMS}][${BRANCHES}])\\s*(년주|연주|월주|일주|시주)`, "gu"))) {
    const pillar = pillars.get(pillarNames[match[2]!]!);
    if (!pillar?.stem || !pillar.branch) {
      issues.push(`계산하지 않은 기둥을 언급했습니다: ${match[0]}`);
    } else if (`${pillar.stem.ko}${pillar.branch.ko}` !== match[1]) {
      issues.push(`기둥을 계산값과 다르게 설명했습니다: ${match[0]}`);
    }
  }
  if (!chart.hourKnown && new RegExp(`시주[는은가이]\\s*[${STEMS}]`, "u").test(text)) {
    issues.push("태어난 시간을 모르는데 시주를 단정했습니다.");
  }
  return issues;
}

function checkCommonText(text: string, chart: ChartView, percents: Set<string>): string[] {
  const issues: string[] = [...checkAgainstChart(text, chart)];
  if (DATE_CLAIM.test(text)) issues.push(`근거 없는 날짜가 있습니다: ${text.slice(0, 40)}`);
  if (MONEY_CLAIM.test(text)) issues.push(`근거 없는 금액이 있습니다: ${text.slice(0, 40)}`);
  if (PROBABILITY_CLAIM.test(text)) issues.push(`확률 표현이 있습니다: ${text.slice(0, 40)}`);
  if (FORBIDDEN_TOPIC.test(text)) issues.push(`결과를 단정하거나 진단·매매를 지시했습니다: ${text.slice(0, 40)}`);
  for (const match of text.matchAll(PERCENT_VALUE)) {
    if (!percents.has(match[1]!)) issues.push(`계산에 없는 비율입니다: ${match[0]}`);
  }
  return issues;
}

export function checkNarration(output: NarrationOutput, plan: ReadingPlan, chart: ChartView): string[] {
  const issues: string[] = [];
  const refsByTopic = collectRefs(plan);
  const percents = allowedPercents(plan);
  const seenTexts = new Set<string>();

  const expected = plan.topics.map((topic) => topic.topicId).join(",");
  const actual = output.topics.map((topic) => topic.topicId).join(",");
  if (expected !== actual) issues.push(`주제 구성이 다릅니다: ${actual}`);

  let total = 2;
  for (const frame of [output.opening, output.closing]) {
    if (!frame.trim()) issues.push("시작 또는 마무리 말풍선이 비어 있습니다.");
    if (frame.length > BUBBLE_MAX_CHARS) issues.push("시작 또는 마무리 말풍선이 너무 깁니다.");
    issues.push(...checkCommonText(frame, chart, percents));
  }

  for (const topic of output.topics) {
    const planned = plan.topics.find((item) => item.topicId === topic.topicId);
    if (!planned) {
      issues.push(`상품에 없는 주제입니다: ${topic.topicId}`);
      continue;
    }
    const allowed = refsByTopic.get(topic.topicId)!;
    total += topic.bubbles.length;
    if (topic.bubbles.length < planned.bubbles.min || topic.bubbles.length > planned.bubbles.max) {
      issues.push(`${topic.topicId}: 말풍선 개수가 범위를 벗어났습니다 (${topic.bubbles.length}개).`);
    }
    if (!topic.bubbles.some((bubble) => bubble.kind === "explanation")) {
      issues.push(`${topic.topicId}: 설명 말풍선이 없습니다.`);
    }
    for (const bubble of topic.bubbles) {
      const text = bubble.text.trim();
      if (!text) issues.push(`${topic.topicId}: 빈 말풍선입니다.`);
      if (text.length > BUBBLE_MAX_CHARS) issues.push(`${topic.topicId}: 말풍선이 너무 깁니다 (${text.length}자).`);
      if (seenTexts.has(text)) issues.push(`같은 문장이 반복되었습니다: ${text.slice(0, 40)}`);
      seenTexts.add(text);
      issues.push(...checkCommonText(text, chart, percents));

      for (const ref of bubble.refs) {
        if (!allowed.has(ref)) issues.push(`${topic.topicId}: 없는 근거를 참조했습니다 (${ref}).`);
      }
      if (bubble.kind === "explanation") {
        const cites = bubble.refs.some((ref) => ref.startsWith("s") || ref.startsWith("f"));
        if (!cites) issues.push(`${topic.topicId}: 설명 말풍선에 근거 연결이 없습니다.`);
      }
      if (bubble.kind === "creative-scene") {
        if (!planned.creativeSceneAllowed) issues.push(`${topic.topicId}: 창작 장면을 허용하지 않은 주제입니다.`);
        if (SCENE_AS_FACT.test(text)) issues.push(`${topic.topicId}: 창작 장면을 사실처럼 표현했습니다.`);
      }
    }
  }
  if (total < TOTAL_BUBBLES.min || total > TOTAL_BUBBLES.max) {
    issues.push(`전체 말풍선 개수가 범위를 벗어났습니다 (${total}개).`);
  }
  return issues;
}

export function checkFollowup(output: FollowupOutput, plan: ReadingPlan, chart: ChartView): string[] {
  if (output.relevance === "unrelated") return [];
  const issues: string[] = [];
  const answer = output.answer.trim();
  if (!answer) issues.push("답변이 비어 있습니다.");
  if (answer.length > FOLLOWUP_MAX_CHARS) issues.push("답변이 너무 깁니다.");
  issues.push(...checkCommonText(answer, chart, allowedPercents(plan)));
  const known = new Set([
    ...plan.facts.map((fact) => fact.ref),
    ...plan.userContext.map((item) => item.ref),
    ...plan.topics.flatMap((topic) => topic.statements.map((item) => item.ref)),
  ]);
  for (const ref of output.refs) {
    if (!known.has(ref)) issues.push(`없는 근거를 참조했습니다 (${ref}).`);
  }
  return issues;
}

// ─── 2.0.0 검사 ──────────────────────────────────────────────

/** 기간 분석에 있는 달·해만 날짜로 허용한다. 일(日) 단위 날짜는 기간 경계와 같을 때만 허용한다. */
interface AllowedDates {
  readonly months: ReadonlySet<string>;
  readonly years: ReadonlySet<string>;
  readonly days: ReadonlySet<string>;
}

function allowedDates(statements: readonly TimingPeriodStatement[]): AllowedDates {
  const months = new Set<string>();
  const years = new Set<string>();
  const days = new Set<string>();
  for (const statement of statements) {
    const match = statement.label.match(/(\d{4})년(?:\s*(\d{1,2})월)?/);
    if (match) {
      years.add(match[1]!);
      if (match[2]) months.add(`${match[1]}-${Number(match[2])}`);
    }
    for (const day of [statement.startsOn, statement.endsOn]) {
      if (!day) continue;
      const [, month, date] = day.split("-").map(Number) as [number, number, number];
      days.add(`${month}-${date}`);
    }
  }
  return { months, years, days };
}

const YEAR_MONTH = /(\d{4})\s*년\s*(\d{1,2})\s*월/g;
const MONTH_DAY = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
const YEAR_ONLY = /(\d{4})\s*년/g;
const MONTH_ONLY = /(\d{1,2})\s*월/g;

function checkDates(text: string, allowed: AllowedDates): string[] {
  const issues: string[] = [];
  let rest = text;
  for (const match of text.matchAll(YEAR_MONTH)) {
    if (!allowed.months.has(`${match[1]}-${Number(match[2])}`)) issues.push(`분석하지 않은 기간을 말했습니다: ${match[0]}`);
  }
  rest = rest.replace(YEAR_MONTH, " ");
  for (const match of rest.matchAll(MONTH_DAY)) {
    if (!allowed.days.has(`${Number(match[1])}-${Number(match[2])}`)) issues.push(`근거 없는 날짜가 있습니다: ${match[0]}`);
  }
  rest = rest.replace(MONTH_DAY, " ");
  for (const match of rest.matchAll(YEAR_ONLY)) {
    if (!allowed.years.has(match[1]!)) issues.push(`분석하지 않은 연도를 말했습니다: ${match[0]}`);
  }
  rest = rest.replace(YEAR_ONLY, " ");
  const monthNumbers = new Set([...allowed.months].map((month) => month.split("-")[1]));
  for (const match of rest.matchAll(MONTH_ONLY)) {
    if (!monthNumbers.has(String(Number(match[1])))) issues.push(`분석하지 않은 달을 말했습니다: ${match[0]}`);
  }
  return issues;
}

function percentsOf(texts: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(PERCENT_VALUE)) values.add(match[1]!);
  return values;
}

/**
 * 강한 욕설과 비속어. 장난스러운 놀림(바보, 허접 같은 약한 말)은 막지 않는다. 캐릭터의 말투를 판정하는 검사는 두지 않는다.
 * '시발점', '새끼손가락', '불이 꺼져', '엄마를 졸라' 같은 일상어는 걸리지 않게 뺐다.
 */
const STRONG_PROFANITY = /씨발|시발(?!점)|ㅅㅂ|존나|좆|병신|ㅂㅅ|개새|새끼(?!손가락)|닥쳐|지랄|엿\s?먹어/;
function checkTextV2(text: string, chart: ChartView, percents: ReadonlySet<string>, dates: AllowedDates, terms: ReadonlySet<string>): string[] {
  const issues: string[] = [...checkAgainstChart(text, chart), ...checkDates(text, dates), ...chartTermIssues(text, terms)];
  if (STRONG_PROFANITY.test(text)) issues.push(`강한 욕설이나 비속어가 있습니다: ${text.slice(0, 40)}`);
  if (MONEY_CLAIM.test(text)) issues.push(`근거 없는 금액이 있습니다: ${text.slice(0, 40)}`);
  if (PROBABILITY_CLAIM.test(text)) issues.push(`확률 표현이 있습니다: ${text.slice(0, 40)}`);
  if (FORBIDDEN_TOPIC.test(text)) issues.push(`결과를 단정하거나 진단·매매를 지시했습니다: ${text.slice(0, 40)}`);
  for (const match of text.matchAll(PERCENT_VALUE)) {
    if (!percents.has(match[1]!)) issues.push(`계산에 없는 비율입니다: ${match[0]}`);
  }
  return issues;
}

/** 범위 밖으로 뺀 질문. 원문은 생성 입력에 넣지 않으므로, 결과에 다시 나타나면 검사에서 잡는다. */
export interface ExcludedQuestion {
  readonly summary: string;
  readonly domain: QuestionDomain;
}

const OUTSIDE_WORDS: Partial<Readonly<Record<QuestionDomain, RegExp>>> = {
  // "건강한 관계"처럼 형용사로 쓰는 말은 범위 밖 주제의 재유입이 아니다.
  health: /건강(?!한|하게|하|히)|질병|병원|다이어트|수술/,
  investment: /주식|코인|종목|매수|매도|수익률/,
  study: /시험\s*합격|입시|성적/,
};

const squash = (text: string) => text.replace(/[\s.,!?~'"“”‘’()*]/g, "");

function checkExcluded(texts: readonly string[], excluded: readonly ExcludedQuestion[]): string[] {
  const issues: string[] = [];
  const joined = texts.join("\n");
  const squashed = squash(joined);
  for (const item of excluded) {
    const words = OUTSIDE_WORDS[item.domain];
    if (words?.test(joined)) issues.push(`범위 밖으로 뺀 주제가 다시 나왔습니다: ${item.domain}`);
    const phrase = squash(item.summary);
    if (phrase.length >= 8 && squashed.includes(phrase)) issues.push("범위 밖으로 뺀 질문 문장이 다시 나왔습니다.");
  }
  return issues;
}

function statementsOf(plan: NarrationPlanV2): InterpretationStatement[] {
  return plan.topics.flatMap((topic) => topic.statements);
}

/** 서버가 쓴 해석 문장에 들어 있는 숫자(예: 계산 비율, "마지막 10%" 같은 행동 제안). LLM이 새로 만든 비율만 잡는다. */
export function statementTexts(statement: InterpretationStatement): string[] {
  const weakness = statement.weakness ? Object.values(statement.weakness) : [];
  return [
    statement.text,
    ...(statement.basis ?? []),
    ...weakness,
    statement.upside ?? "",
    statement.action ?? "",
    statement.counterNote ?? "",
    ...(statement.lore ?? []),
  ];
}

/** 기간 판단에 들어 있는 문장 (표지에 세운·월운 글자가 나올 수 있다). */
function timingTexts(item: TimingPeriodStatement): string[] {
  return [item.statement, ...item.markers.flatMap((marker) => [marker.text, marker.activity])];
}

function planPercents(plan: NarrationPlanV2): Set<string> {
  return percentsOf([...plan.base.facts.map((fact) => fact.text), ...statementsOf(plan).flatMap(statementTexts)]);
}

const CITES = /^[sft]\d+$/;

/**
 * 풀이를 부분마다 검사하는 도구. 전체 검사(checkNarrationV2)와, 주제가 완성될 때마다 먼저 보여 주는 생성이 함께 쓴다.
 * 같은 문장 반복은 한 검사기 안에서 이어서 본다. 검사한 문장은 통과 여부와 관계없이 기억하므로,
 * 먼저 보여 주는 생성은 시도마다 새 검사기를 만들고 실제로 보낸 문장만 remember로 넣는다.
 * 말투·말버릇·감탄사 개수로 캐릭터를 판정하는 검사는 없다 (묘묘 2.0.0부터 말버릇 횟수 검사를 뺐다).
 */
export interface NarrationChecker {
  /** 시작이나 마무리 말풍선. */
  readonly frame: (text: string) => string[];
  /** 궁금한 점에 대한 답 전체. 질문이 없으면 비어 있어야 한다. */
  readonly focus: (bubbles: readonly NarrationBubble[]) => string[];
  /** 한 주제의 말풍선 전체. */
  readonly topic: (topic: NarrationTopic) => string[];
  /** 범위 밖으로 뺀 질문이 다시 나왔는지. */
  readonly excluded: (texts: readonly string[]) => string[];
  /** 이미 보낸 문장을 같은 문장 반복 확인에 넣는다. 굵게 표시는 빼고 비교한다. */
  readonly remember: (text: string) => void;
}

export function narrationChecker(plan: NarrationPlanV2, chart: ChartView, excluded: readonly ExcludedQuestion[] = []): NarrationChecker {
  const timing = timingStatements(plan);
  const dates = allowedDates(timing);
  const percents = planPercents(plan);
  const terms = allowedChartTerms(chart, [...plan.base.facts.map((fact) => fact.text), ...statementsOf(plan).flatMap(statementTexts), ...timing.flatMap(timingTexts)]);
  const seen = new Set<string>();
  const shared = [...plan.base.facts.map((fact) => fact.ref), ...plan.userContext.map((item) => item.ref)];
  const questionRefs = plan.questions.map((question) => question.ref);
  const hardMax = plan.length.bubbleHardMax;

  const bubbleIssues = (bubble: NarrationBubble, where: string, allowed: ReadonlySet<string>, scenesAllowed: boolean): string[] => {
    const issues: string[] = [];
    const text = bubble.text.trim();
    if (!text) issues.push(`${where}: 빈 말풍선입니다.`);
    if (text.length > hardMax) issues.push(`${where}: 말풍선이 너무 깁니다 (${text.length}자). 나눠서 써 주세요.`);
    if (seen.has(text)) issues.push(`같은 문장이 반복되었습니다: ${text.slice(0, 40)}`);
    seen.add(text);
    issues.push(...checkTextV2(text, chart, percents, dates, terms));
    for (const ref of bubble.refs) {
      if (!allowed.has(ref)) issues.push(`${where}: 없는 근거를 참조했습니다 (${ref}).`);
    }
    if (bubble.kind === "explanation" && !bubble.refs.some((ref) => CITES.test(ref))) {
      issues.push(`${where}: 설명 말풍선에 근거 연결이 없습니다.`);
    }
    if (bubble.kind === "creative-scene") {
      if (!scenesAllowed) issues.push(`${where}: 창작 장면을 허용하지 않은 곳입니다.`);
      if (SCENE_AS_FACT.test(text)) issues.push(`${where}: 창작 장면을 사실처럼 표현했습니다.`);
      if (/\d{4}\s*년|\d{1,2}\s*월/.test(text)) issues.push(`${where}: 창작 장면에 날짜를 넣었습니다.`);
    }
    return issues;
  };

  return {
    frame: (text) => {
      const issues: string[] = [];
      if (!text.trim()) issues.push("시작 또는 마무리 말풍선이 비어 있습니다.");
      if (text.length > hardMax) issues.push("시작 또는 마무리 말풍선이 너무 깁니다.");
      issues.push(...checkTextV2(text, chart, percents, dates, terms));
      return issues;
    },
    focus: (bubbles) => {
      const issues: string[] = [];
      if (!plan.questions.length) {
        if (bubbles.length) issues.push("궁금한 점이 없는데 답변 영역을 썼습니다.");
        return issues;
      }
      if (bubbles.length < 2) issues.push("궁금한 점에 대한 답이 너무 짧습니다.");
      const focusAllowed = new Set([...shared, ...questionRefs, ...statementsOf(plan).map((item) => item.ref), ...timing.map((item) => item.ref)]);
      const focusScenes = plan.questions.some((question) => plan.topics.find((topic) => topic.topicId === question.topicId)?.creativeSceneAllowed);
      if (bubbles.filter((bubble) => bubble.kind === "creative-scene").length > 1) issues.push("답변 영역의 창작 장면은 1개까지입니다.");
      for (const bubble of bubbles) issues.push(...bubbleIssues(bubble, plan.focusSection.id, focusAllowed, focusScenes));
      for (const question of plan.questions) {
        if (!bubbles.some((bubble) => bubble.refs.includes(question.ref))) issues.push(`질문(${question.ref})에 대한 답이 없습니다: ${question.summary}`);
        const timingPlan = plan.timing.find((entry) => entry.id === question.timingId);
        if (timingPlan && timingPlan.status === "available") {
          const refs = new Set(timingPlan.months.map((month) => month.ref));
          if (!bubbles.some((bubble) => bubble.refs.some((ref) => refs.has(ref)))) issues.push(`질문(${question.ref})의 기간 분석을 답에 쓰지 않았습니다.`);
        }
      }
      return issues;
    },
    topic: (topic) => {
      const planned = plan.topics.find((item) => item.topicId === topic.topicId);
      if (!planned) return [`상품에 없는 주제입니다: ${topic.topicId}`];
      const issues: string[] = [];
      const allowed = new Set([
        ...shared,
        ...planned.statements.map((item) => item.ref),
        ...plan.timing.filter((entry) => entry.topicId === planned.topicId).flatMap((entry) => [...entry.months, ...entry.years].map((item) => item.ref)),
        ...plan.questions.filter((question) => question.topicId === planned.topicId).map((question) => question.ref),
      ]);
      if (topic.bubbles.length < Math.min(2, planned.target)) issues.push(`${topic.topicId}: 말풍선이 너무 적습니다 (${topic.bubbles.length}개).`);
      if (planned.status !== "limited" && !topic.bubbles.some((bubble) => bubble.kind === "explanation")) issues.push(`${topic.topicId}: 설명 말풍선이 없습니다.`);
      if (topic.bubbles.filter((bubble) => bubble.kind === "creative-scene").length > 1) issues.push(`${topic.topicId}: 창작 장면은 주제당 1개까지입니다.`);
      for (const bubble of topic.bubbles) issues.push(...bubbleIssues(bubble, topic.topicId, allowed, planned.creativeSceneAllowed));
      return issues;
    },
    excluded: (texts) => checkExcluded(texts, excluded),
    remember: (text) => {
      seen.add(text.replace(/\*\*/g, "").trim());
    },
  };
}

export function checkNarrationV2(
  output: NarrationOutputV2,
  plan: NarrationPlanV2,
  chart: ChartView,
  excluded: readonly ExcludedQuestion[] = [],
): string[] {
  const issues: string[] = [];
  const check = narrationChecker(plan, chart, excluded);

  const expected = plan.topics.map((topic) => topic.topicId).join(",");
  const actual = output.topics.map((topic) => topic.topicId).join(",");
  if (expected !== actual) issues.push(`주제 구성이 다릅니다: ${actual}`);

  for (const frame of [output.opening, output.closing]) issues.push(...check.frame(frame));
  issues.push(...check.focus(output.focus));

  let total = 2 + output.focus.length;
  for (const topic of output.topics) {
    if (plan.topics.some((item) => item.topicId === topic.topicId)) total += topic.bubbles.length;
    issues.push(...check.topic(topic));
  }
  if (total < plan.length.totalBubbles.min || total > plan.length.totalBubbles.max) {
    issues.push(`전체 말풍선 개수가 형식 범위를 벗어났습니다 (${total}개).`);
  }

  issues.push(
    ...check.excluded([
      output.opening,
      output.closing,
      ...output.focus.map((bubble) => bubble.text),
      ...output.topics.flatMap((topic) => topic.bubbles.map((bubble) => bubble.text)),
    ]),
  );
  return issues;
}

export const FOLLOWUP_SECTION_MAX = 900;
export const FOLLOWUP_TOTAL_MAX = 2400;
export const CLARIFY_MAX = 300;

export interface FollowupCheckContext {
  readonly questionRefs: readonly string[];
  readonly knownRefs: ReadonlySet<string>;
  readonly timing: readonly TimingPeriodStatement[];
  readonly percentSources: readonly string[];
  /** 원국 글자·신살 이름을 확인할 때 함께 허용할 문장 (전체 해석 재료와 이미 전달한 풀이). */
  readonly termSources?: readonly string[];
  readonly excluded: readonly ExcludedQuestion[];
}

export function checkFollowupV2(output: FollowupOutputV2, context: FollowupCheckContext, chart: ChartView): string[] {
  const issues: string[] = [];
  const dates = allowedDates(context.timing);
  const percents = percentsOf(context.percentSources);
  const terms = allowedChartTerms(chart, [...context.percentSources, ...(context.termSources ?? []), ...context.timing.flatMap(timingTexts)]);
  if (output.mode === "clarify") {
    const question = output.clarifyQuestion.trim();
    if (!question) issues.push("되묻는 질문이 비어 있습니다.");
    if (question.length > CLARIFY_MAX) issues.push("되묻는 질문이 너무 깁니다.");
    issues.push(...checkTextV2(question, chart, percents, dates, terms), ...checkExcluded([question], context.excluded));
    return issues;
  }
  let total = 0;
  for (const ref of context.questionRefs) {
    const section = output.sections.find((item) => item.questionRef === ref);
    if (!section || !section.text.trim()) issues.push(`질문(${ref})에 대한 답이 없습니다.`);
  }
  for (const section of output.sections) {
    const text = section.text.trim();
    total += text.length;
    if (!context.questionRefs.includes(section.questionRef)) issues.push(`없는 질문에 답했습니다 (${section.questionRef}).`);
    if (text.length > FOLLOWUP_SECTION_MAX) issues.push("한 질문의 답변이 너무 깁니다.");
    issues.push(...checkTextV2(text, chart, percents, dates, terms));
    for (const ref of section.refs) {
      // 답하는 질문의 ref는 근거는 아니지만 틀린 참조도 아니다. 이것 때문에 다시 생성하지 않는다.
      if (!context.knownRefs.has(ref) && !context.questionRefs.includes(ref)) issues.push(`없는 근거를 참조했습니다 (${ref}).`);
    }
  }
  if (total > FOLLOWUP_TOTAL_MAX) issues.push("답변 전체가 너무 깁니다.");
  issues.push(...checkExcluded(output.sections.map((section) => section.text), context.excluded));
  return issues;
}

/**
 * 후속 답변을 문단이 완성될 때마다 검사하는 도구 (문단마다 먼저 보여 주는 후속 답변). checkFollowupV2와 같은 기준을 쓴다.
 * 문단마다 따로 검사하므로 이전 시도의 문단 기록을 갖지 않는다.
 */
export function followupChecker(context: FollowupCheckContext, chart: ChartView) {
  const dates = allowedDates(context.timing);
  const percents = percentsOf(context.percentSources);
  const terms = allowedChartTerms(chart, [...context.percentSources, ...(context.termSources ?? []), ...context.timing.flatMap(timingTexts)]);
  return {
    /** 문단보다 먼저 오는 질문 ref와 근거 연결. */
    section: (questionRef: string, refs: readonly string[]): string[] => [
      ...(context.questionRefs.includes(questionRef) ? [] : [`없는 질문에 답했습니다 (${questionRef}).`]),
      ...refs.filter((ref) => !context.knownRefs.has(ref) && !context.questionRefs.includes(ref)).map((ref) => `없는 근거를 참조했습니다 (${ref}).`),
    ],
    paragraph: (text: string): string[] => [...checkTextV2(text, chart, percents, dates, terms), ...checkExcluded([text], context.excluded)],
    clarify: (question: string): string[] => {
      const issues: string[] = [];
      if (!question.trim()) issues.push("되묻는 질문이 비어 있습니다.");
      if (question.length > CLARIFY_MAX) issues.push("되묻는 질문이 너무 깁니다.");
      return [...issues, ...checkTextV2(question, chart, percents, dates, terms), ...checkExcluded([question], context.excluded)];
    },
    /** 이미 보낸 뒤라 고칠 수 없는 길이 기준. 넘으면 기록만 한다. */
    overLength: (texts: readonly string[]): boolean =>
      texts.some((text) => text.length > FOLLOWUP_SECTION_MAX) || texts.reduce((sum, text) => sum + text.length, 0) > FOLLOWUP_TOTAL_MAX,
  };
}
