import type { AssessmentFacet, InquiryEvidence } from "sajuengine";
import { FAMILY_LABEL, SHINSAL_LABEL, tenGodFamily, withJosa, type Family, type PositionKey } from "../rules/materials";
import { ELEMENT_HANJA, elementCounts } from "./chart";
import type { ChartElement, ChartSymbol, ChartView } from "./types";

export { SHINSAL_LABEL };

/**
 * 명리 설명 재료. 규칙 결론이 쓴 엔진 근거(원국 글자와 십성, 신살 위치, 합충 쌍, 일간의 힘, 용신)를
 * 사람이 읽는 짧은 문장으로 옮긴다. 판단을 새로 하지 않는다. 풀이는 이 문장에 있는 글자와 이름만 쓸 수 있다.
 */

export interface LoreContext {
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
}

const PILLAR_LABEL: Readonly<Record<PositionKey, string>> = { year: "연주", month: "월주", day: "일주", hour: "시주" };
const POSITIONS: readonly PositionKey[] = ["year", "month", "day", "hour"];

const GENERATES: Readonly<Record<ChartElement, ChartElement>> = { 목: "화", 화: "토", 토: "금", 금: "수", 수: "목" };
const CONTROLS: Readonly<Record<ChartElement, ChartElement>> = { 목: "토", 토: "수", 수: "화", 화: "금", 금: "목" };
const ELEMENT_ORDER: readonly ChartElement[] = ["목", "화", "토", "금", "수"];
const generatorOf = (element: ChartElement) => ELEMENT_ORDER.find((candidate) => GENERATES[candidate] === element)!;
const controllerOf = (element: ChartElement) => ELEMENT_ORDER.find((candidate) => CONTROLS[candidate] === element)!;

const SEASON: Readonly<Record<string, string>> = {
  인: "봄", 묘: "봄", 진: "봄", 사: "여름", 오: "여름", 미: "여름", 신: "가을", 유: "가을", 술: "가을", 해: "겨울", 자: "겨울", 축: "겨울",
};

const RELATION_LABEL: Readonly<Record<string, string>> = {
  "branch-clash": "충(沖)",
  "branch-punishment": "형(刑)",
  "branch-self-punishment": "자형(自刑)",
  "branch-harm": "해(害)",
  "branch-break": "파(破)",
  "branch-wonjin": "원진(怨嗔)",
  "branch-six-combination": "육합(六合)",
  "branch-three-combination": "삼합(三合)",
  "branch-directional-combination": "방합(方合)",
  "stem-combination": "천간합(天干合)",
  "stem-clash": "천간충(天干沖)",
};

const USEFUL_BASIS: Readonly<Record<string, string>> = {
  fuyi: "일간의 힘을 맞추는 억부(抑扶)",
  climate: "태어난 계절의 차고 더움을 맞추는 조후(調候)",
};

/** 일간을 전통적으로 빗대는 자연물. 판단이 아니라 소개용 비유다. */
export const DAY_MASTER_IMAGE: Readonly<Record<string, string>> = {
  갑: "곧게 자라는 큰 나무",
  을: "덩굴과 화초",
  병: "하늘의 태양",
  정: "촛불과 등불",
  무: "큰 산과 둑",
  기: "기름진 논밭의 흙",
  경: "단단한 바위와 쇠",
  신: "다듬은 보석",
  임: "큰 강과 바다",
  계: "비와 이슬",
};

const TEN_GODS = ["비견", "겁재", "식신", "상관", "편재", "정재", "편관", "정관", "편인", "정인"] as const;

const elementName = (element: ChartElement) => `${element}(${ELEMENT_HANJA[element]})`;
/** "경금(庚金)"처럼 글자, 오행, 한자를 함께 쓴다. */
export const symbolName = (symbol: ChartSymbol) => `${symbol.ko}${symbol.element}(${symbol.hanja}${ELEMENT_HANJA[symbol.element]})`;

function finalOf(word: string): number | null {
  const base = word.replace(/\([^)]*\)$/, "");
  const code = base.charCodeAt(base.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28;
}
const copula = (word: string) => `${word}${finalOf(word) ? "이에요" : "예요"}`;
/** ㄹ 받침과 받침 없는 말은 '로', 나머지 받침은 '으로'. */
const withRo = (word: string) => {
  const final = finalOf(word);
  return `${word}${final && final !== 8 ? "으로" : "로"}`;
};

interface Slot {
  readonly position: PositionKey;
  readonly part: "stem" | "branch";
  readonly symbol: ChartSymbol;
}

function slotAt(chart: ChartView, position: PositionKey, part: "stem" | "branch"): Slot | null {
  const pillar = chart.pillars.find((item) => item.key === position);
  const symbol = part === "stem" ? pillar?.stem : pillar?.branch;
  return symbol ? { position, part, symbol } : null;
}

const isDayStem = (slot: Slot) => slot.position === "day" && slot.part === "stem";
const slotName = (slot: Slot) => (isDayStem(slot) ? `일간 ${symbolName(slot.symbol)}` : `${PILLAR_LABEL[slot.position]}의 ${symbolName(slot.symbol)}`);

/** 일간을 뺀 원국 글자. 지지의 십성은 본기 기준이다. */
function slots(chart: ChartView): Slot[] {
  return POSITIONS.flatMap((position) =>
    (["stem", "branch"] as const)
      .map((part) => slotAt(chart, position, part))
      .filter((slot): slot is Slot => slot !== null && !isDayStem(slot)),
  );
}

function familyRelation(family: Family, dayName: string, day: ChartElement): string {
  switch (family) {
    case "peer":
      return `${withJosa(dayName, "과/와")} 같은 ${elementName(day)} 기운이라 나와 어깨를 나란히 하는 자리예요.`;
    case "output":
      return `${withJosa(dayName, "이/가")} 생하는(${day}생${GENERATES[day]}) ${elementName(GENERATES[day])} 기운이라 내 기운을 밖으로 풀어내는 자리예요.`;
    case "wealth":
      return `${withJosa(dayName, "이/가")} 극하는(${day}극${CONTROLS[day]}) ${elementName(CONTROLS[day])} 기운이라 내가 다루고 거두는 자리예요.`;
    case "authority":
      return `${withJosa(dayName, "을/를")} 극하는(${controllerOf(day)}극${day}) ${elementName(controllerOf(day))} 기운이라 나를 다스리고 틀을 잡아 주는 자리예요.`;
    case "resource":
      return `${withJosa(dayName, "을/를")} 생해 주는(${generatorOf(day)}생${day}) ${elementName(generatorOf(day))} 기운이라 나를 돕고 채워 주는 자리예요.`;
  }
}

function dayStem(chart: ChartView): ChartSymbol | null {
  return chart.pillars.find((pillar) => pillar.key === "day")?.stem ?? null;
}

/** 한 십성 계열이 원국 어디에 있는지와 일간과의 생극. */
export function familyLore(chart: ChartView, family: Family, only?: ReadonlySet<string>): string | null {
  const day = dayStem(chart);
  if (!day) return null;
  const dayName = `일간 ${symbolName(day)}`;
  const relation = familyRelation(family, dayName, day.element);
  const items = slots(chart).filter((slot) => tenGodFamily(slot.symbol.tenGod) === family && (!only || only.has(slot.symbol.tenGod!)));
  if (!items.length) return `원국 글자 가운데 ${withJosa(FAMILY_LABEL[family], "은/는")} 겉으로 드러나 있지 않아요. ${FAMILY_LABEL[family]}은 ${relation}`;
  const byGod = new Map<string, string[]>();
  for (const item of items) byGod.set(item.symbol.tenGod!, [...(byGod.get(item.symbol.tenGod!) ?? []), slotName(item)]);
  const parts = [...byGod].map(([god, names]) => `${withJosa(names.join(", "), "은/는")} ${god}`);
  return `${copula(parts.join(", "))}. ${relation}`;
}

export function strengthLore(chart: ChartView): string | null {
  const day = dayStem(chart);
  const month = slotAt(chart, "month", "branch");
  if (!day || !month) return null;
  const season = SEASON[month.symbol.ko];
  const birth = season
    ? `월주의 ${withJosa(symbolName(month.symbol), "이/가")} ${season} 기운이라, ${season}에 태어난 ${symbolName(day)} 일간이에요.`
    : `월주의 ${withJosa(symbolName(month.symbol), "이/가")} 태어난 달의 기운이에요.`;
  const percent = chart.elementPercent;
  if (!percent) return birth;
  const helper = generatorOf(day.element);
  return `${birth} 일간과 같은 ${withJosa(elementName(day.element), "과/와")} 일간을 생해 주는 ${elementName(helper)} 기운이 합쳐 ${percent[day.element] + percent[helper]}%예요.`;
}

export function patternLore(chart: ChartView): string | null {
  const month = slotAt(chart, "month", "branch");
  if (!month?.symbol.tenGod) return null;
  return `격국을 보는 태어난 달의 자리, 월주의 ${withJosa(symbolName(month.symbol), "은/는")} ${copula(month.symbol.tenGod)}.`;
}

export function usefulLore(assessment: AssessmentFacet | null): string | null {
  const useful = assessment?.usefulElement as ChartElement | undefined;
  if (!useful || !ELEMENT_ORDER.includes(useful)) return null;
  const helpful = assessment?.helpfulElement as ChartElement | null | undefined;
  const adverse = ((assessment?.adverseElements ?? []) as string[]).filter((item): item is ChartElement => ELEMENT_ORDER.includes(item as ChartElement));
  const parts = [`용신은 ${elementName(useful)}`];
  if (helpful && ELEMENT_ORDER.includes(helpful)) parts.push(`희신은 ${elementName(helpful)}`);
  if (adverse.length) parts.push(`기신은 ${adverse.map(elementName).join("·")}`);
  const adopted = (assessment?.usefulGodBasis as { adopted?: string } | undefined)?.adopted;
  const basis = adopted && USEFUL_BASIS[adopted] ? ` ${USEFUL_BASIS[adopted]} 기준이에요.` : "";
  return `${withRo(parts.join(", "))} 계산됐어요.${basis}`;
}

export function elementCountLore(chart: ChartView): string | null {
  const counts = elementCounts(chart);
  const total = ELEMENT_ORDER.reduce((sum, element) => sum + counts[element], 0);
  if (!total) return null;
  const listed = ELEMENT_ORDER.map((element) => `${element} ${counts[element]}개`).join(", ");
  const missing = ELEMENT_ORDER.filter((element) => counts[element] === 0);
  return `원국 ${total}글자의 오행은 ${listed}예요.${missing.length ? ` ${withJosa(missing.join("·"), "은/는")} 글자로는 하나도 없어요.` : ""}`;
}

function shinsalLore(entry: InquiryEvidence, chart: ChartView): string | null {
  const id = entry.tags.find((tag) => tag.startsWith("shinsal:"))?.slice("shinsal:".length);
  const label = id ? SHINSAL_LABEL[id] : undefined;
  if (!label) return null;
  const at = entry.id.match(/:(year|month|day|hour):(earthlyBranch|heavenlyStem)$/);
  const slot = at ? slotAt(chart, at[1] as PositionKey, at[2] === "heavenlyStem" ? "stem" : "branch") : null;
  return slot ? `${slotName(slot)}에 ${withJosa(label, "이/가")} 있어요.` : `원국에 ${withJosa(label, "이/가")} 있어요.`;
}

function relationLines(entries: readonly InquiryEvidence[], chart: ChartView): string[] {
  const groups = new Map<string, { names: string[]; labels: string[] }>();
  for (const entry of entries) {
    const type = entry.tags.find((tag) => tag.startsWith("relation:"))?.slice("relation:".length);
    const label = type ? RELATION_LABEL[type] : undefined;
    if (!type || !label) continue;
    const part = type.startsWith("stem-") ? "stem" : "branch";
    const positions = [...new Set([...entry.id.matchAll(/natal:(year|month|day|hour):/g)].map((match) => match[1] as PositionKey))];
    const found = positions.map((position) => slotAt(chart, position, part));
    if (!found.length || found.some((slot) => !slot)) continue;
    const key = `${part}:${positions.join(",")}`;
    const group = groups.get(key) ?? { names: found.map((slot) => slotName(slot!)), labels: [] };
    if (!group.labels.includes(label)) group.labels.push(label);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ names, labels }) => {
    const joined = labels.join("·");
    if (names.length === 2) return `${withJosa(names[0]!, "과/와")} ${withJosa(names[1]!, "이/가")} ${joined} 관계예요.`;
    if (names.length === 1) return `${withJosa(names[0]!, "이/가")} ${joined} 표지를 띠어요.`;
    return `${withJosa(names.join(", "), "이/가")} 함께 ${joined}을 이뤄요.`;
  });
}

/** 근거 문장(basis)에 나온 십성 계열. 앞에 나온 계열부터 최대 두 개. */
function familiesIn(basis: readonly string[]): Family[] {
  const text = basis.join(" ");
  return (Object.entries(FAMILY_LABEL) as [Family, string][])
    .map(([family, label]) => ({ family, at: text.indexOf(label) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((item) => item.family);
}

/** 근거 문장에 이름이 나온 십성 가운데 원국에 있는 것 ("편재 0개"처럼 없다고 한 것은 뺀다). */
function tenGodsIn(basis: readonly string[]): string[] {
  const text = basis.join(" ");
  return TEN_GODS.filter((god) => text.includes(god) && !text.includes(`${god} 0개`));
}

const MAX_LINES = 3;

/**
 * 한 해석 문장의 명리 설명 재료. 신살·합충처럼 위치가 있는 근거를 먼저 쓰고, 계열·일간의 힘·격국·용신을 잇는다.
 */
export function loreFor(evidence: readonly InquiryEvidence[], basis: readonly string[], context: LoreContext): string[] {
  const { chart, assessment } = context;
  const lines: string[] = [];
  const push = (line: string | null) => {
    if (line && !lines.includes(line)) lines.push(line);
  };
  for (const entry of evidence) if (entry.kind === "shinsal") push(shinsalLore(entry, chart));
  for (const line of relationLines(evidence.filter((entry) => entry.kind === "relation"), chart)) push(line);

  const judgments = new Set(evidence.filter((entry) => entry.kind === "judgment").map((entry) => entry.ruleId));
  if (judgments.has("m01.assessment.families")) {
    const families = familiesIn(basis);
    for (const family of families) push(familyLore(chart, family));
    const extra = tenGodsIn(basis).filter((god) => !families.includes(tenGodFamily(god)!));
    if (extra.length) push(familyLore(chart, tenGodFamily(extra[0]!)!, new Set(extra)));
  }
  if (judgments.has("m01.assessment.strength")) push(strengthLore(chart));
  if (judgments.has("m01.assessment.pattern")) push(patternLore(chart));
  if (judgments.has("m01.assessment.useful-gods")) push(usefulLore(assessment));
  if (judgments.has("m01.assessment.elements")) push(elementCountLore(chart));
  return lines.slice(0, MAX_LINES);
}

const STEM_ELEMENT: Readonly<Record<string, ChartElement>> = {
  갑: "목", 을: "목", 병: "화", 정: "화", 무: "토", 기: "토", 경: "금", 신: "금", 임: "수", 계: "수",
};
const BRANCH_ELEMENT: Readonly<Record<string, ChartElement>> = {
  자: "수", 축: "토", 인: "목", 묘: "목", 진: "토", 사: "화", 오: "화", 미: "토", 신: "금", 유: "금", 술: "토", 해: "수",
};
/** 일상어와 겹쳐 글자 이름으로 확인할 수 없는 말 (정화, 해수, 자수, 묘목, 계수). */
const AMBIGUOUS_TERMS = new Set(["정화", "해수", "자수", "묘목", "계수"]);

/** 풀이에 나오면 원국과 맞는지 확인할 글자 이름 ("경금", "사화")과 신살 이름. */
export const CHART_TERMS: readonly string[] = [
  ...new Set([
    ...Object.entries(STEM_ELEMENT).map(([stem, element]) => `${stem}${element}`),
    ...Object.entries(BRANCH_ELEMENT).map(([branch, element]) => `${branch}${element}`),
  ]),
].filter((term) => !AMBIGUOUS_TERMS.has(term));
export const SHINSAL_TERMS: readonly string[] = Object.values(SHINSAL_LABEL);

/** 다른 낱말의 일부가 아닌 이름만 잡는다. 뒤에는 조사나 한글이 아닌 글자가 온다. */
const TERM_PATTERN = new RegExp(
  `(?<![가-힣])(${[...SHINSAL_TERMS, ...CHART_TERMS].join("|")})(?=$|[^가-힣]|[은는이가을를의에과와도만로으랑예라])`,
  "gu",
);

/** 원국 글자 이름과, 작성 재료(사실·해석·명리 설명·기간 표지)에 나온 글자·신살 이름. */
export function allowedChartTerms(chart: ChartView, sources: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const pillar of chart.pillars) {
    for (const symbol of [pillar.stem, pillar.branch]) if (symbol) allowed.add(`${symbol.ko}${symbol.element}`);
  }
  for (const source of sources) for (const term of termsIn(source)) allowed.add(term);
  return allowed;
}

export function termsIn(text: string): string[] {
  return [...text.matchAll(TERM_PATTERN)].map((match) => match[1]!);
}

/** 작성 재료에 없는 원국 글자나 신살을 말했는지. 명리 설명이 엔진 계산과 어긋나지 않게 한다. */
export function chartTermIssues(text: string, allowed: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const term of new Set(termsIn(text))) {
    if (allowed.has(term)) continue;
    issues.push(
      SHINSAL_TERMS.includes(term) ? `원국 재료에 없는 신살을 말했습니다: ${term}` : `원국에 없는 글자를 말했습니다: ${term}`,
    );
  }
  return issues;
}
