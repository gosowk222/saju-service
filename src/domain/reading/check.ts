import type { ChartView, FollowupOutput, NarrationOutput, ReadingPlan } from "./types";

/**
 * 생성 문장의 최소 검사. 형식이 맞아도 내용이 맞다는 뜻은 아니므로
 * 정확히 비교할 수 있는 값만 확인한다. 말투나 품질은 여기서 판단하지 않는다.
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
const FORBIDDEN_TOPIC = /질병|진단명|합격(?:할|합니다|해요)|재회(?:할|합니다|해요)/;
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
  if (FORBIDDEN_TOPIC.test(text)) issues.push(`다루지 않는 판단이 있습니다: ${text.slice(0, 40)}`);
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
