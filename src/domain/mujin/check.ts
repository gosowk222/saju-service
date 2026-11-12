/**
 * 무진의 종합 사주: 장 단위 최소 검사 (Pass 1 초안, Pass 2 최종문).
 *
 * 정확히 비교할 수 있는 값만 본다. 응답과 블록의 형식, 장의 질문 누락, 알려진 근거 참조와 그 장 소속,
 * 원국 계산값(일간·기둥·시주), 날짜·비율·금액·확률, 결과 단정·진단·매매 지시, 강한 욕설, 범위 밖 질문의 재유입,
 * 창작 장면의 사실화. 최종문은 여기에 더해 초안이 답한 질문을 모두 다시 덮었는지, 초안에 없던 근거·장면·숫자를 더했는지 본다.
 * 문장 검사는 묘묘와 같은 함수(reading/check.ts의 checkTextV2, checkExcluded)를 쓴다.
 *
 * 말투, 말버릇, 어미, 농담, 감탄사의 개수와 본문 길이, 약점 표현의 직설성으로는 실패시키지 않는다 (AGENTS.md, 명세 06 5절).
 * 참조가 맞다는 것만으로 의미가 보존됐다고 보지 않는다. 대표 사례는 사람이 초안과 최종문을 나란히 읽어 확인한다.
 *
 * 문제 문구는 '어디: 무엇이 잘못됐습니다 (값)' 형태다. 기록할 때 issueSummary가 첫 '~니다'와 바로 뒤 괄호 값까지만 남긴다.
 * 생성 문장 전체를 문구에 담지 않는다 (재사용하는 문장 검사는 다시 쓰게 할 때 위치를 찾도록 앞부분 40자까지만 붙인다).
 *
 * 캐릭터 이름 '무진 도사'는 간지 무진(戊辰)과 글자가 같다. 기둥 검사는 '무진 일주'처럼 기둥 이름이 바로 붙을 때만,
 * 글자 이름 검사는 '무토'·'진토'처럼 오행이 붙은 이름만 보므로 이름 자체는 걸리지 않는다.
 */
import { checkExcluded, checkTextV2, percentsOf, SCENE_AS_FACT, type AllowedDates, type ExcludedQuestion } from "../reading/check";
import { allowedChartTerms } from "../reading/lore";
import type { ChartView } from "../reading/types";
import type {
  MujinLuck,
  MujinLuckPeriod,
  MujinMaterial,
  MujinMonths,
  MujinPlan,
  MujinSectionPlan,
  ScrollBlock,
  ScrollBlockType,
  ScrollDraftContent,
  ScrollSectionContent,
} from "./types";

type MujinTiming = { readonly luck: MujinLuck; readonly months: MujinMonths };

export interface MujinCheckContext {
  /** 원국표. 일간·기둥·시주를 계산값과 비교한다. */
  readonly chart: ChartView;
  /** 문장에 쓸 수 있는 비율(% 앞의 숫자). 원국표의 오행·계열 가중 비율과 작성 재료·기간 자료에 나온 비율. */
  readonly percents: ReadonlySet<string>;
  /** 문장에 쓸 수 있는 원국 글자·신살 이름. 원국 글자와 작성 재료에 나온 이름. */
  readonly terms: ReadonlySet<string>;
  /**
   * 기간 자료의 날짜: 10장 12개월의 달(경계일 포함)과 9장 직전·현재·다음 대운의 시작·끝 연도.
   * 9·10장과 기간 판단 재료(kind period)를 받은 장에서만 허용한다 (usesTiming).
   */
  readonly timingDates: AllowedDates;
  /**
   * 모든 장이 다시 말할 수 있는 날짜: 공통 사실·지금의 나·질문 재료 문장에 이미 있는 날짜 (사용자가 말한 날짜 등).
   * 장마다 그 장 재료 문장의 날짜를 더한다 (datesIn). 그 밖의 날짜는 쓸 수 없다.
   */
  readonly sharedDates: AllowedDates;
  /** 범위 밖으로 뺀 질문. 원문은 생성 입력에 넣지 않으므로 결과에 다시 나오면 잡는다. */
  readonly excluded: readonly ExcludedQuestion[];
  /** 모든 장이 쓸 수 있는 ref: 공통 사실(facts), 지금의 나(nowFacts), 질문 재료(questionMaterials), 사용자 질문의 ref(questions). */
  readonly sharedRefs: ReadonlySet<string>;
  /** 장별 허용 ref (공통 ref 포함): 그 장의 재료, 그 장 질문의 refs(이어 받은 사용자 질문 ref 포함), derived 재료가 이어 받은 판단(parentRefs). */
  readonly sectionRefs: Readonly<Record<string, ReadonlySet<string>>>;
  /**
   * 최종문의 새 수치 확인에 쓰는 숫자 출처 가운데 모든 장 공통인 것: 별명과 사용자 사실(지금의 나, 질문 재료).
   * 최종문 작성 단계는 초안, 사용자 사실, 장 제목만 받으므로 그 밖의 재료 숫자는 넣지 않는다.
   */
  readonly sharedNumbers: ReadonlySet<string>;
  /** 장별 숫자 출처 (장 제목, 질문 제목, 그 장에 붙은 사용자 사실). */
  readonly sectionNumbers: Readonly<Record<string, ReadonlySet<string>>>;
  /** 기간 자료의 숫자 (나이 라벨, 연도, 달, 경계일). 날짜를 쓸 수 있는 장에서만 더한다. */
  readonly timingNumbers: ReadonlySet<string>;
}

/** 기간 자료(9장 대운, 10장 12개월)를 다루는 장. */
export const TIMING_SECTION_IDS: ReadonlySet<string> = new Set(["ch9", "ch10"]);

/**
 * 이 장이 기간 자료(대운 구간, 12개월)를 받고 그 날짜를 쓸 수 있는지. 9·10장, 그리고 작성 계획이 기간 판단 재료(kind period)를 넣은 장이다.
 * 그 밖의 장도 재료 문장에 이미 있는 날짜(사용자가 말한 날짜, 마지막 정리가 받은 9·10장의 핵심 답)는 다시 말할 수 있다 (datesIn).
 */
export function usesTiming(section: Pick<MujinSectionPlan, "sectionId" | "materials">): boolean {
  return TIMING_SECTION_IDS.has(section.sectionId) || section.materials.some((material) => material.kind === "period");
}

const SEOUL_YEAR = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" });

function seoulYear(instant: string): string | null {
  const time = Date.parse(instant);
  if (!Number.isNaN(time)) return SEOUL_YEAR.format(time);
  return instant.match(/^(\d{4})/)?.[1] ?? null;
}

/** 대운 구간의 시작·끝 연도 (Asia/Seoul). 경계가 근사값이라 문장에는 연도까지만 쓴다. 생성 입력과 검사가 같은 값을 쓴다. */
export function luckYears(period: Pick<MujinLuckPeriod, "startsAt" | "endsAt">): { readonly startYear: string | null; readonly endYear: string | null } {
  return { startYear: seoulYear(period.startsAt), endYear: seoulYear(period.endsAt) };
}

const luckPeriods = (luck: MujinLuck): MujinLuckPeriod[] => [luck.previous, luck.current, luck.next].filter((period): period is MujinLuckPeriod => period !== null);

const emptyDates = (): AllowedDates => ({ months: new Set(), years: new Set(), days: new Set() });

const mergeDates = (...list: readonly AllowedDates[]): AllowedDates => ({
  months: new Set(list.flatMap((dates) => [...dates.months])),
  years: new Set(list.flatMap((dates) => [...dates.years])),
  days: new Set(list.flatMap((dates) => [...dates.days])),
});

// 문장 검사(reading/check.ts의 checkDates)와 같은 순서로 날짜를 읽는다: 연·월 → 월·일 → 연 → 월.
const YEAR_MONTH = /(\d{4})\s*년\s*(\d{1,2})\s*월/g;
const MONTH_DAY = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
const YEAR_ONLY = /(\d{4})\s*년/g;
const MONTH_ONLY = /(\d{1,2})\s*월/g;

/**
 * 재료 문장에 이미 있는 날짜. 서버가 준 문장(사용자가 알려 준 사실 포함)이라 그대로 다시 말할 수 있다.
 * 연도 없이 나온 달은 '*-월'로 둔다 (연도를 붙인 달로는 허용되지 않고, 연도 없는 달로만 허용된다).
 */
export function datesIn(texts: readonly string[]): AllowedDates {
  const months = new Set<string>();
  const years = new Set<string>();
  const days = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(YEAR_MONTH)) {
      years.add(match[1]!);
      months.add(`${match[1]}-${Number(match[2])}`);
    }
    let rest = text.replace(YEAR_MONTH, " ");
    for (const match of rest.matchAll(MONTH_DAY)) {
      days.add(`${Number(match[1])}-${Number(match[2])}`);
      months.add(`*-${Number(match[1])}`);
    }
    rest = rest.replace(MONTH_DAY, " ");
    for (const match of rest.matchAll(YEAR_ONLY)) years.add(match[1]!);
    rest = rest.replace(YEAR_ONLY, " ");
    for (const match of rest.matchAll(MONTH_ONLY)) months.add(`*-${Number(match[1])}`);
  }
  return { months, years, days };
}

/** 기간 자료에서 허용할 날짜. 달은 라벨('2026년 11월')과 월운 ID(monthly:YYYY-MM)에서, 경계일은 startsOn·endsOn에서 읽는다. */
export function timingDatesOf(timing: MujinTiming | null): AllowedDates {
  if (!timing) return emptyDates();
  const months = new Set<string>();
  const years = new Set<string>();
  const days = new Set<string>();
  const addMonth = (year: string, month: number) => {
    years.add(year);
    months.add(`${year}-${month}`);
  };
  for (const month of timing.months.months) {
    const label = month.label.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/);
    if (label) addMonth(label[1]!, Number(label[2]));
    const id = month.periodId.match(/(\d{4})-(\d{2})$/);
    if (id) addMonth(id[1]!, Number(id[2]));
    for (const day of [month.startsOn, month.endsOn]) {
      const parts = day?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (parts) days.add(`${Number(parts[2])}-${Number(parts[3])}`);
    }
  }
  for (const period of luckPeriods(timing.luck)) {
    const { startYear, endYear } = luckYears(period);
    if (startYear) years.add(startYear);
    if (endYear) years.add(endYear);
  }
  return { months, years, days };
}

/** 작성 재료 한 줄에 들어 있는 문장 (판단, 이유, 장단점, 행동, 반대 근거, 비교 기준, 명리 설명, 조건). */
export function materialTexts(material: MujinMaterial): string[] {
  const weakness = material.weakness ? [material.weakness.what, material.weakness.when, material.weakness.cost, material.weakness.change] : [];
  const compare = material.compare
    ? [...material.compare.options, ...material.compare.criteria.flatMap((criterion) => [criterion.name, criterion.reason]), ...material.compare.needs]
    : [];
  return [
    material.text,
    ...(material.basis ?? []),
    material.upside ?? "",
    ...weakness,
    material.action ?? "",
    material.counterNote ?? "",
    ...compare,
    ...(material.lore ?? []),
    ...(material.caveats ?? []),
  ].filter((text) => text.trim().length > 0);
}

/** 기간 자료에 들어 있는 문장 (대운 라벨·간지·십성, 달 라벨, 표지, 분석 기간, 한계). */
function timingTexts(timing: MujinTiming | null): string[] {
  if (!timing) return [];
  return [
    ...luckPeriods(timing.luck).flatMap((period) => [period.label, period.ganzhi, period.stemTenGod ?? ""]),
    timing.months.window.label,
    ...timing.months.months.flatMap((month) => [month.label, ...month.cells.flatMap((cell) => cell.markers.flatMap((marker) => [marker.text, marker.activity]))]),
    ...timing.months.limitations,
  ].filter((text) => text.trim().length > 0);
}

/** 천 단위 쉼표(1,000)는 한 숫자로, 그 밖의 쉼표('1,2번')는 나눠 읽는다. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?/g;

const normalizeNumber = (raw: string) => {
  const plain = raw.replace(/,/g, "");
  const value = Number(plain);
  return Number.isFinite(value) ? String(value) : plain;
};

/** 문장에 나온 모든 숫자 (허용 출처를 만들 때). */
function numbersOf(texts: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(NUMBER)) values.add(normalizeNumber(match[0]));
  return values;
}

/**
 * 최종문에서 새로 나왔는지 볼 숫자. 날짜(4자리 연도+년, 1~2자리+월)와 비율(%)은 문장 검사가 허용 목록으로 따로 보므로 뺀다.
 * '3개월', '10분', '1년', '주 2회' 같은 기간·횟수는 여기서 본다.
 */
function claimedNumbers(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const raw = match[0];
    const after = text.slice((match.index ?? 0) + raw.length);
    if (/^\s*%/.test(after)) continue;
    if (/^\d{4}$/.test(raw) && /^\s*년/.test(after)) continue;
    if (/^\d{1,2}$/.test(raw) && /^\s*월/.test(after)) continue;
    values.push(normalizeNumber(raw));
  }
  return values;
}

/** 원국 표의 가중 비율 (오행, 다섯 계열). 문장에는 정수로 반올림해 쓸 수 있다. */
function tablePercents(plan: MujinPlan, chart: ChartView): string[] {
  const values = [
    ...Object.values(plan.tables.elements.percents ?? {}),
    ...Object.values(plan.tables.tenGods.families ?? {}),
    ...Object.values(chart.elementPercent ?? {}),
  ];
  return values.flatMap((value) => [`${value}%`, `${Math.round(value)}%`]);
}

function sectionRefsOf(section: MujinSectionPlan, shared: ReadonlySet<string>): Set<string> {
  return new Set([
    ...shared,
    ...section.materials.map((material) => material.ref),
    ...section.materials.flatMap((material) => material.parentRefs ?? []),
    ...section.questions.flatMap((question) => question.refs),
  ]);
}

/** 최종문 작성 단계가 받는 장 정보 (장 ID의 장 번호, 제목, 질문 제목, 그 장에 붙은 사용자 사실). */
function sectionNumberSources(section: MujinSectionPlan): string[] {
  return [
    section.sectionId,
    section.title,
    ...section.questions.map((question) => question.title),
    ...section.materials.filter((material) => material.kind === "user-fact").map((material) => material.text),
  ];
}

/** 같은 장 ID가 둘 다 있으면 생성 단계에서 받은 장(sections)을 쓴다. 9·10장과 마지막 정리는 저장된 원국 계획에 없다. */
function mergeSections(planned: readonly MujinSectionPlan[], given: readonly MujinSectionPlan[]): MujinSectionPlan[] {
  const ids = new Set(given.map((section) => section.sectionId));
  return [...planned.filter((section) => !ids.has(section.sectionId)), ...given];
}

/**
 * 검사 기준을 한 번 만든다. 생성 단계에서 받은 장(9·10장, 마지막 정리 포함)과 저장된 원국 계획의 장을 함께 등록한다.
 * timing은 유료 생성 때 고정한 기간 재료이며, 없으면(무료 단계) 재료 문장에 이미 있는 날짜 말고는 날짜를 허용하지 않는다.
 * questions는 생성 입력에 넣은 사용자 질문이다. 사용자 질문에 답한 블록은 그 질문의 ref를 refs에 넣을 수 있다.
 */
export function buildCheckContext(input: {
  readonly plan: MujinPlan;
  readonly sections: readonly MujinSectionPlan[];
  readonly questionMaterials?: readonly MujinMaterial[];
  readonly questions?: readonly { readonly ref: string }[];
  readonly chart: ChartView;
  readonly timing: MujinTiming | null;
  readonly excluded: readonly ExcludedQuestion[];
}): MujinCheckContext {
  const { plan, chart, timing } = input;
  const sections = mergeSections(plan.sections, input.sections);
  const shared = [...plan.facts, ...plan.nowFacts, ...(input.questionMaterials ?? [])];
  const sharedRefs = new Set([...shared.map((material) => material.ref), ...(input.questions ?? []).map((question) => question.ref)]);
  const texts = [...shared, ...sections.flatMap((section) => section.materials)].flatMap(materialTexts);
  const timingSources = timingTexts(timing);
  // 기준일과 달 경계일(YYYY-MM-DD), 대운 연도. 최종문 숫자 확인의 출처로만 쓴다.
  const timingDayStrings = timing
    ? [timing.luck.referenceAt.slice(0, 10), ...timing.months.months.flatMap((month) => [month.startsOn ?? "", month.endsOn ?? ""])]
    : [];
  const timingYears = timing ? luckPeriods(timing.luck).flatMap((period) => Object.values(luckYears(period)).filter((year): year is string => year !== null)) : [];
  return {
    chart,
    percents: percentsOf([...tablePercents(plan, chart), ...texts, ...timingSources]),
    terms: allowedChartTerms(chart, [...texts, ...timingSources]),
    timingDates: timingDatesOf(timing),
    sharedDates: datesIn(shared.flatMap(materialTexts)),
    excluded: input.excluded,
    sharedRefs,
    sectionRefs: Object.fromEntries(sections.map((section) => [section.sectionId, sectionRefsOf(section, sharedRefs)])),
    sharedNumbers: numbersOf([plan.nickname, ...[...plan.nowFacts, ...(input.questionMaterials ?? [])].map((material) => material.text)]),
    sectionNumbers: Object.fromEntries(sections.map((section) => [section.sectionId, numbersOf(sectionNumberSources(section))])),
    timingNumbers: numbersOf([...timingSources, ...timingDayStrings, ...timingYears]),
  };
}

/** 문제 문구의 괄호 값. issueSummary가 괄호 안 20자까지 남기므로 괄호를 빼고 자른다. */
const clip = (value: string) => value.replace(/[()]/g, "").slice(0, 20);

const TEXT_BLOCKS: ReadonlySet<ScrollBlockType> = new Set(["paragraph", "basis", "condition", "apply", "scene"]);

/** 블록의 글 (본문과 비교·점검 항목). 화면에 보이는 글은 모두 같은 문장 검사를 받는다. */
function blockTexts(block: ScrollBlock): string[] {
  return [block.text, ...block.items.flatMap((item) => [item.label, item.text])].filter((text) => text.trim().length > 0);
}

function contentTexts(content: ScrollSectionContent): string[] {
  return [content.coreAnswer, ...content.blocks.flatMap(blockTexts)].filter((text) => text.trim().length > 0);
}

function shapeIssues(block: ScrollBlock, where: string): string[] {
  const issues: string[] = [];
  if (TEXT_BLOCKS.has(block.type)) {
    if (!block.text.trim()) issues.push(`${where}: 블록의 글이 비어 있습니다.`);
    if (block.items.length) issues.push(`${where}: 비교·점검이 아닌 블록에 항목을 넣었습니다.`);
  } else if (block.type === "compare") {
    if (block.items.length < 2) issues.push(`${where}: 비교 항목이 두 개보다 적습니다.`);
    if (block.items.some((item) => !item.label.trim())) issues.push(`${where}: 비교 항목의 이름이 비어 있습니다.`);
    if (block.items.some((item) => !item.text.trim())) issues.push(`${where}: 비교 항목의 설명이 비어 있습니다.`);
  } else if (block.type === "checklist") {
    if (!block.items.length) issues.push(`${where}: 점검 항목이 없습니다.`);
    if (block.items.some((item) => !item.text.trim())) issues.push(`${where}: 비어 있는 점검 항목이 있습니다.`);
  }
  return issues;
}

const SCENE_DATE = /\d{4}\s*년|\d{1,2}\s*월/;

/** 장면은 가정해 보는 생활 장면이다. 사주로 확정된 일처럼 쓰거나 날짜를 넣으면 사실처럼 읽힌다. */
function sceneIssues(block: ScrollBlock, where: string): string[] {
  if (block.type !== "scene") return [];
  const texts = blockTexts(block);
  const issues: string[] = [];
  if (texts.some((text) => SCENE_AS_FACT.test(text))) issues.push(`${where}: 장면을 사실처럼 표현했습니다.`);
  if (texts.some((text) => SCENE_DATE.test(text))) issues.push(`${where}: 장면에 날짜를 넣었습니다.`);
  return issues;
}

const sceneCount = (blocks: readonly ScrollBlock[]) => blocks.filter((block) => block.type === "scene").length;

const has = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** 장의 허용 ref. 검사 기준에 등록된 값과 지금 받은 장 계획에서 만든 값을 합친다. */
function refsFor(section: MujinSectionPlan, context: MujinCheckContext): Set<string> {
  return new Set([...(has(context.sectionRefs, section.sectionId) ?? []), ...sectionRefsOf(section, context.sharedRefs)]);
}

function numbersFor(section: MujinSectionPlan, context: MujinCheckContext): Set<string> {
  return new Set([
    ...context.sharedNumbers,
    ...(has(context.sectionNumbers, section.sectionId) ?? []),
    ...numbersOf(sectionNumberSources(section)),
    ...(usesTiming(section) ? context.timingNumbers : []),
  ]);
}

function sectionIssues(
  content: ScrollSectionContent,
  section: MujinSectionPlan,
  context: MujinCheckContext,
  draft: ScrollDraftContent | null,
): string[] {
  const id = section.sectionId;
  const issues: string[] = [];
  const dates = mergeDates(usesTiming(section) ? context.timingDates : emptyDates(), context.sharedDates, datesIn(section.materials.flatMap(materialTexts)));
  const sectionQuestionIds = new Set(section.questions.map((question) => question.id));
  const allowedRefs = refsFor(section, context);
  const draftRefs = draft ? new Set(draft.blocks.flatMap((block) => block.refs)) : null;
  // 최종문은 초안에 있던 숫자만 쓴다 (새 금액·날짜·횟수·보장을 더하지 않는다, 명세 04 6절).
  // 함께 받은 사용자 사실·장 제목의 숫자와, 날짜를 쓰는 장의 기간 자료 숫자는 허용한다.
  const allowedNumbers = draft ? new Set([...numbersOf(contentTexts(draft)), ...numbersFor(section, context)]) : null;

  const textIssues = (texts: readonly string[], where: string) => {
    for (const text of texts) {
      for (const issue of checkTextV2(text, context.chart, context.percents, dates, context.terms)) issues.push(`${where}: ${issue}`);
      if (!allowedNumbers) continue;
      for (const value of claimedNumbers(text)) {
        if (!allowedNumbers.has(value)) issues.push(`${where}: 초안에 없던 숫자를 썼습니다 (${clip(value)}).`);
      }
    }
  };

  if (content.sectionId !== id) issues.push(`${id}: 장 ID가 계획과 다릅니다 (${clip(content.sectionId)}).`);
  if (!content.coreAnswer.trim()) issues.push(`${id}: 핵심 답이 비어 있습니다.`);
  if (!content.blocks.length) issues.push(`${id}: 블록이 없습니다.`);
  textIssues([content.coreAnswer].filter((text) => text.trim()), `${id} 핵심 답`);

  content.blocks.forEach((block, index) => {
    const where = `${id} 블록 ${index + 1}`;
    issues.push(...shapeIssues(block, where));
    for (const questionId of block.questionIds) {
      if (!sectionQuestionIds.has(questionId)) issues.push(`${where}: 이 장에 없는 질문 ID입니다 (${clip(questionId)}).`);
    }
    for (const ref of block.refs) {
      if (draftRefs) {
        if (!draftRefs.has(ref)) issues.push(`${where}: 초안에 없던 근거를 참조했습니다 (${clip(ref)}).`);
      } else if (!allowedRefs.has(ref)) {
        issues.push(`${where}: 이 장에서 쓸 수 없는 근거를 참조했습니다 (${clip(ref)}).`);
      }
    }
    textIssues(blockTexts(block), where);
    issues.push(...sceneIssues(block, where));
  });

  // 장의 모든 질문에 답한 블록이 있어야 한다. 초안은 이 검사를 통과해야 최종문 단계로 가므로,
  // 최종문이 장의 모든 질문을 덮으면 초안이 답한 질문(questionIds)도 모두 다시 덮은 것이다.
  const answered = new Set(content.blocks.flatMap((block) => block.questionIds));
  for (const questionId of sectionQuestionIds) {
    if (!answered.has(questionId)) issues.push(`${id}: 질문에 답한 블록이 없습니다 (${clip(questionId)}).`);
  }

  if (draft && sceneCount(content.blocks) > sceneCount(draft.blocks)) issues.push(`${id}: 초안에 없던 장면을 더했습니다.`);

  issues.push(...checkExcluded(contentTexts(content), context.excluded).map((issue) => `${id}: ${issue}`));
  return [...new Set(issues)];
}

/**
 * Pass 1 초안 한 장. 장 ID, 핵심 답, 블록 형식, 그 장의 질문 누락, 근거 참조(그 장 재료·공통 사실·지금의 나·질문 재료),
 * 문장 검사(원국 계산값, 날짜 허용 목록, 계산에 없는 비율, 금액, 확률, 결과 단정·진단·매매 지시, 강한 욕설), 장면의 사실화,
 * 범위 밖 질문의 재유입을 본다. 초안의 scenes(장면 요약)는 다음 묶음에 넘기는 내부 메모라 검사하지 않는다.
 */
export function checkDraftSection(content: ScrollDraftContent, section: MujinSectionPlan, context: MujinCheckContext): string[] {
  return sectionIssues(content, section, context, null);
}

/**
 * Pass 2 최종문 한 장. 초안 검사와 같은 문장·형식 검사에 더해, 초안이 답한 질문을 모두 다시 덮었는지,
 * 근거 참조가 초안의 참조 안에 있는지, 초안(과 함께 받은 사용자 사실·장 제목, 날짜를 쓰는 장의 기간 자료)에 없던 숫자를 더했는지,
 * 초안에 없던 장면을 더했는지 본다. 날짜와 비율은 초안과 같은 허용 목록으로 본다.
 */
export function checkVoiceSection(content: ScrollSectionContent, draft: ScrollDraftContent, section: MujinSectionPlan, context: MujinCheckContext): string[] {
  return sectionIssues(content, section, context, draft);
}
