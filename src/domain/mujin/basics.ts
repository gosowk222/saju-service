import type { AssessmentFacet } from "sajuengine";
import { DAY_MASTER_IMAGE } from "../reading/lore";
import { ELEMENT_HANJA } from "../reading/chart";
import type { ChartElement, ChartPillar, ChartView } from "../reading/types";
import { FAMILIES, FAMILY_LABEL, FAMILY_MEANING, STRENGTH_LABEL, withJosa, type Family } from "../rules/materials";
import type { DraftMaterial } from "./draft";
import type { MujinTables, NatalStageCell } from "./types";

/**
 * 기초 분석(P01~P05)의 엔진 사실 재료. 원국표·오행표·12운성표·십성표(MujinTables)와 원국(ChartView), 엔진 판단(AssessmentFacet)의
 * 계산값만 옮긴다. 판단을 새로 하지 않고, 엔진이 계산하지 않은 격국·용신을 만들지 않는다.
 * 이름표는 엔진 표기를 따른다 (격국: 편관격·월겁격, 강약: 신강·신약). tests/unit/mujin-plan.test.ts가 엔진 공개 값과 같은지 확인한다.
 */

/** 엔진 STRENGTH_LABEL과 같은 값. */
export const ENGINE_STRENGTH_LABEL: Readonly<Record<string, string>> = {
  strong: "신강",
  "slightly-strong": "약간 신강",
  balanced: "중화",
  "slightly-weak": "약간 신약",
  weak: "신약",
};

/** 엔진 PATTERN_LABEL과 같은 값. 앱의 묘묘 표기(칠살격·양인격)와 다르다. */
export const ENGINE_PATTERN_LABEL: Readonly<Record<string, string>> = {
  "eating-god": "식신격",
  "hurting-officer": "상관격",
  "direct-wealth": "정재격",
  "indirect-wealth": "편재격",
  "direct-officer": "정관격",
  "seven-killings": "편관격",
  "direct-resource": "정인격",
  "indirect-resource": "편인격",
  "month-prosperity": "건록격",
  "month-robbery": "월겁격",
};

/** 엔진 SEASON_LABEL·SEASON_OF_BRANCH와 같은 대응 (월지로 계절을 정한다). */
export const SEASON_LABEL: Readonly<Record<string, string>> = { spring: "봄", summer: "여름", autumn: "가을", winter: "겨울" };
export const SEASON_OF_BRANCH: Readonly<Record<string, string>> = {
  인: "spring", 묘: "spring", 진: "spring", 사: "summer", 오: "summer", 미: "summer",
  신: "autumn", 유: "autumn", 술: "autumn", 해: "winter", 자: "winter", 축: "winter",
};

/** 월지 본기 십성 → 격국 ID (엔진의 대응과 같다). 월지 본기로 정한 격국인지 확인할 때만 쓴다. */
const PATTERN_OF_TEN_GOD: Readonly<Record<string, string>> = {
  식신: "eating-god",
  상관: "hurting-officer",
  정재: "direct-wealth",
  편재: "indirect-wealth",
  정관: "direct-officer",
  편관: "seven-killings",
  정인: "direct-resource",
  편인: "indirect-resource",
  비견: "month-prosperity",
  겁재: "month-robbery",
};

/**
 * 월지 본기 십성으로 읽은 격국 ID. 엔진 격국은 투출을 먼저 보므로(월지 본기 투출 → 다른 지장간 투출 → 본기) 다를 수 있다.
 * 다르면 '월지 본기 십성' 설명(lore의 patternLore)이 엔진 격국과 어긋나므로 무진 재료에서 뺀다.
 */
export function monthMainPattern(chart: ChartView): string | null {
  const tenGod = chart.pillars.find((pillar) => pillar.key === "month")?.branch?.tenGod;
  return tenGod ? (PATTERN_OF_TEN_GOD[tenGod] ?? null) : null;
}

/** 12운성의 순환 순서 (엔진 단계 이름). */
export const STAGE_CYCLE = ["장생", "목욕", "관대", "건록", "제왕", "쇠", "병", "사", "묘", "절", "태", "양"] as const;

/** 엔진 단계 ID → 단계 이름. 표가 ID로 들어와도 같은 이름으로 읽는다. */
const STAGE_NAME_OF_ID: Readonly<Record<string, string>> = {
  jangsaeng: "장생", mogyok: "목욕", gwandae: "관대", geonrok: "건록", jewang: "제왕", soe: "쇠",
  byeong: "병", sa: "사", myo: "묘", jeol: "절", tae: "태", yang: "양",
};

/**
 * 12운성 단계의 전통적 의미 (원국 해설용). 천간이 지지에서 놓이는 기세의 단계를 비유한 것이며 사건·길흉·성격을 정하지 않는다.
 * 병·사·절은 이름 그대로 질병·죽음·불운으로 옮기지 않는다. 서비스가 쉬운 말로 옮긴 초안이다(unreviewed).
 */
export const STAGE_MEANING: Readonly<Record<string, string>> = {
  장생: "새로 생겨나 자라기 시작하는 단계",
  목욕: "아직 익숙하지 않은 것을 시험하며 변화가 많은 단계",
  관대: "모양을 갖추고 자리를 잡아 가는 단계",
  건록: "자기 힘으로 서는 단계",
  제왕: "기세가 가장 높은 단계",
  쇠: "정점을 지나 기세를 거두며 노련해지는 단계",
  병: "기세가 누그러지고 속도를 늦추는 단계(질병을 뜻하지 않는다)",
  사: "움직임을 멈추고 정리하는 단계(죽음을 뜻하지 않는다)",
  묘: "거두어 갈무리하고 저장하는 단계",
  절: "이전 흐름을 끊고 새로 바꾸는 전환 단계(불운을 뜻하지 않는다)",
  태: "새 흐름의 씨앗을 품는 단계",
  양: "기르며 준비하는 단계",
};

export const stageName = (stage: string) => STAGE_NAME_OF_ID[stage] ?? stage;

const ELEMENT_ORDER: readonly ChartElement[] = ["목", "화", "토", "금", "수"];
type Position = "year" | "month" | "day" | "hour";
const POSITIONS: readonly Position[] = ["year", "month", "day", "hour"];
const PILLAR_NAME: Readonly<Record<Position, string>> = { year: "연주", month: "월주", day: "일주", hour: "시주" };
const STEM_SLOT: Readonly<Record<Position, string>> = { year: "연간", month: "월간", day: "일간", hour: "시간" };
const BRANCH_SLOT: Readonly<Record<Position, string>> = { year: "연지", month: "월지", day: "일지", hour: "시지" };

export const COUNT_VS_PERCENT_CAVEAT = "글자 수(단순 개수)와 세력 비율(가중 비율)은 기준이 달라 서로 더하거나 바꿔 말하지 않는다.";
export const SCARCE_ELEMENT_CAVEAT = "가장 적거나 글자로 없는 오행을 용신·결핍·질병으로 연결하지 않는다.";
export const STRENGTH_FACT_CAVEAT =
  "강약은 원국 안에서 일간을 돕는 기운과 쓰는 기운의 비율을 채택한 관법(억부)으로 본 것이며, 체력·건강이나 돈의 손실·수입 변동을 견디는 능력을 뜻하지 않는다.";
export const PATTERN_FACT_CAVEAT = "격국은 월지와 천간에 드러난 글자로 정하는 채택 관법의 결과이며, 격국 이름만으로 성패나 사건을 정하지 않는다.";
export const STAGE_CAVEATS = [
  "12운성은 천간이 지지에서 놓이는 기세의 단계를 표로 읽은 것이며 길흉·사건·성격을 확정하지 않는다.",
  "병·사·절 같은 단계 이름은 질병·죽음·불운을 뜻하지 않는다.",
  "원국 항목만 썼고 대운·세운·월운 같은 기간 항목은 섞지 않았다.",
] as const;
export const FAMILY_FACT_CAVEAT = "계열 비율은 성향의 상대적 비중이며 실제 가족 관계나 사건을 뜻하지 않는다.";
export const UNSEEN_CAVEAT = "태어난 시간을 몰라 시주를 보지 못했다. 보이지 않는 것을 원국에 없다고 확정하지 않는다.";

function pillarAt(chart: ChartView, position: Position): ChartPillar | undefined {
  return chart.pillars.find((pillar) => pillar.key === position);
}

const glyph = (symbol: { readonly ko: string; readonly hanja: string }) => `${symbol.ko}(${symbol.hanja})`;
const elementName = (element: ChartElement) => `${element}(${ELEMENT_HANJA[element]})`;

/** 가장 큰 값을 가진 항목들 (동률이면 여럿). */
function leaders<K extends string>(values: Readonly<Record<K, number>>, keys: readonly K[]): K[] {
  const max = Math.max(...keys.map((key) => values[key]));
  return keys.filter((key) => values[key] === max);
}

/** "금(金) 38%" 또는 동률이면 "토(土)·금(金)이 각 30%로 공동". */
function leaderText(names: readonly string[], value: string): string {
  return names.length > 1 ? `${withJosa(names.join("·"), "이/가")} 각 ${value}로 공동` : `${names[0]} ${value}`;
}

function isPartialCoverage(chart: ChartView, assessment: AssessmentFacet | null): boolean {
  return !chart.hourKnown || (assessment?.coverage !== undefined && assessment.coverage !== "complete");
}

/**
 * 여러 장이 함께 쓰는 계산 사실 (plan.facts): 원국 구성, 일간, 계절, 강약, 격국, 오행·십성 분포, 시각 미상.
 * questionIds는 그 사실을 근거로 쓰는 질문이다. 원국표(P01)는 글이 없어 섹션 계획에 없고, 원국 구성 사실이 P01로 남는다.
 */
export function buildSharedFacts(chart: ChartView, assessment: AssessmentFacet | null, tables: MujinTables): DraftMaterial[] {
  const facts: DraftMaterial[] = [];
  const add = (key: string, questionIds: readonly string[], text: string, caveats: readonly string[] = []) =>
    facts.push({ key: `fact:${key}`, kind: "engine-fact", questionIds, text, scope: "natal", ...(caveats.length ? { caveats } : {}) });
  const partial = isPartialCoverage(chart, assessment);

  const known = POSITIONS.map((position) => pillarAt(chart, position)).filter(
    (pillar): pillar is ChartPillar & { stem: NonNullable<ChartPillar["stem"]>; branch: NonNullable<ChartPillar["branch"]> } =>
      Boolean(pillar?.stem && pillar.branch),
  );
  if (known.length) {
    const listed = known.map((pillar) => `${PILLAR_NAME[pillar.key]} ${pillar.stem.ko}${pillar.branch.ko}(${pillar.stem.hanja}${pillar.branch.hanja})`);
    add("pillars", ["P01", "P02"], `원국은 ${listed.join(", ")}입니다.${chart.hourKnown ? "" : " 태어난 시간을 몰라 시주는 비워 두었습니다."}`);
  }

  if (chart.dayMaster) {
    const { ko, hanja, element } = chart.dayMaster;
    const image = DAY_MASTER_IMAGE[ko];
    const name = withJosa(`일간 ${ko}${element}(${hanja}${ELEMENT_HANJA[element]})`, "은/는");
    add(
      "day-master",
      ["P01", "P02", "P05"],
      `일간은 ${glyph({ ko, hanja })}이고 오행으로는 ${elementName(element)}입니다.${image ? ` ${name} 전통적으로 ${image}에 빗댑니다.` : ""}`,
      image ? ["자연물 비유는 일간을 소개하는 전통 비유이며 성격을 판정하지 않는다."] : [],
    );
  }

  const month = pillarAt(chart, "month")?.branch;
  const season = month ? SEASON_OF_BRANCH[month.ko] : undefined;
  if (month && season) {
    add("season", ["P02"], `태어난 달의 자리(월지)는 ${glyph(month)}로, 계절로는 ${SEASON_LABEL[season]}에 해당합니다.`);
  }

  if (assessment?.strength) {
    const strength = assessment.strength;
    add(
      "strength",
      ["P02", "1-3"],
      `일간의 힘(강약)은 엔진 계산으로 ${ENGINE_STRENGTH_LABEL[strength] ?? strength}(${STRENGTH_LABEL[strength] ?? strength})입니다.`,
      [STRENGTH_FACT_CAVEAT, ...(partial ? ["태어난 시간을 몰라 시주를 뺀 기둥으로 계산했다."] : [])],
    );
  }

  if (assessment?.pattern) {
    const pattern = assessment.pattern;
    const monthGod = month?.tenGod ?? null;
    const fromMonthMain = monthMainPattern(chart) === pattern;
    add(
      "pattern",
      ["P02", "2-1"],
      `격국은 엔진 계산으로 ${ENGINE_PATTERN_LABEL[pattern] ?? pattern}입니다.${
        fromMonthMain && month ? ` 격국을 보는 태어난 달의 자리, 월지 ${glyph(month)}의 본기 십성이 ${monthGod}입니다.` : ""
      }`,
      [PATTERN_FACT_CAVEAT],
    );
  }

  const counts = tables.elements.counts;
  const total = ELEMENT_ORDER.reduce((sum, element) => sum + counts[element], 0);
  if (total > 0) {
    const top = leaders(counts, ELEMENT_ORDER);
    add(
      "element-counts",
      ["P03"],
      `오행 글자 수(원국 겉 ${total}글자의 단순 개수): ${ELEMENT_ORDER.map((element) => `${element} ${counts[element]}개`).join(", ")}. 가장 많은 오행은 ${leaderText(
        top.map(elementName),
        `${counts[top[0]!]}개`,
      )}입니다.`,
      [COUNT_VS_PERCENT_CAVEAT, ...(chart.hourKnown ? [] : ["태어난 시간을 몰라 시주를 뺀 여섯 글자만 셌다."])],
    );
  }

  const percents = tables.elements.percents;
  if (percents) {
    const top = leaders(percents, ELEMENT_ORDER);
    add(
      "element-percents",
      ["P03"],
      `오행 세력 비율(엔진 가중 비율: 천간 1, 지장간 1·0.5·0.3, 월지 지장간 2배): ${ELEMENT_ORDER.map((element) => `${element} ${percents[element]}%`).join(
        ", ",
      )}. 가장 큰 오행은 ${leaderText(top.map(elementName), `${percents[top[0]!]}%`)}입니다.`,
      [COUNT_VS_PERCENT_CAVEAT, ...(partial ? ["태어난 시간을 몰라 시주를 뺀 기둥으로 계산했다."] : [])],
    );
  }

  const families = tables.tenGods.families;
  if (families) {
    const top = leaders(families, FAMILIES);
    add(
      "family-percents",
      ["P05", "1-1", "1-2"],
      `십성 다섯 계열의 세력 비율(엔진 가중 비율, 일간 제외·지장간 포함): ${FAMILIES.map(
        (family) => `${FAMILY_LABEL[family]}(${FAMILY_MEANING[family]}) ${families[family]}%`,
      ).join(", ")}. 가장 큰 계열은 ${leaderText(
        top.map((family) => FAMILY_LABEL[family]),
        `${families[top[0]!]}%`,
      )}입니다.`,
      [FAMILY_FACT_CAVEAT, ...(partial ? ["태어난 시간을 몰라 시주를 뺀 기둥으로 계산했다."] : [])],
    );
  }

  if (!chart.hourKnown) {
    add(
      "hour-unknown",
      ["P01", "P02", "P03", "P04", "P05"],
      "태어난 시간을 몰라 시주를 계산하지 않았습니다. 시주에 있을 수 있는 글자·십성·12운성·신살은 비어 있습니다.",
      [UNSEEN_CAVEAT],
    );
  }
  return facts;
}

/** P03 오행 분석의 섹션 재료: 두 기준의 1위 비교, 글자로 없는 오행. */
export function buildElementMaterials(chart: ChartView, tables: MujinTables): DraftMaterial[] {
  const out: DraftMaterial[] = [];
  const counts = tables.elements.counts;
  const percents = tables.elements.percents;
  const total = ELEMENT_ORDER.reduce((sum, element) => sum + counts[element], 0);
  if (!total) return out;

  if (percents) {
    const byCount = leaders(counts, ELEMENT_ORDER);
    const byPercent = leaders(percents, ELEMENT_ORDER);
    const same = byCount.length === byPercent.length && byCount.every((element) => byPercent.includes(element));
    out.push({
      key: "basics:element-leaders",
      kind: "engine-fact",
      questionIds: ["P03"],
      scope: "natal",
      text: same
        ? `글자 수로도 세력 비율로도 가장 큰 오행은 ${byCount.map(elementName).join("·")}입니다.`
        : `글자 수로 가장 많은 오행(${byCount.map(elementName).join("·")})과 세력 비율로 가장 큰 오행(${byPercent
            .map(elementName)
            .join("·")})이 다릅니다. 글자 수는 겉 글자만 세고, 세력 비율은 지장간과 월지 가중치를 반영하기 때문입니다.`,
      caveats: [COUNT_VS_PERCENT_CAVEAT],
    });
  }

  const absent = ELEMENT_ORDER.filter((element) => counts[element] === 0);
  if (absent.length) {
    const lines = absent.map((element) => {
      const name = withJosa(elementName(element), "은/는");
      if (!percents) return `${name} 겉 글자로는 없습니다.`;
      return percents[element] > 0
        ? `${name} 겉 글자로는 없지만 세력 비율로는 ${percents[element]}%입니다.`
        : `${name} 겉 글자에도 없고 세력 비율도 0%입니다.`;
    });
    out.push({
      key: "basics:element-absent",
      kind: "engine-fact",
      questionIds: ["P03"],
      scope: "natal",
      text: lines.join(" "),
      caveats: [SCARCE_ELEMENT_CAVEAT, ...(chart.hourKnown ? [] : ["태어난 시간을 몰라 시주에 있을 수 있는 글자는 세지 못했다."])],
    });
  }
  return out;
}

/** P04 원국 12운성의 섹션 재료. 표의 원국 항목만 쓴다(기간 항목 없음). 단계 이름은 엔진 이름 그대로다. */
export function buildStageMaterials(chart: ChartView, tables: MujinTables): DraftMaterial[] {
  const cells = tables.stages;
  if (!cells.length) return [];
  const caveats = [...STAGE_CAVEATS, ...(chart.hourKnown ? [] : ["태어난 시간을 몰라 시주의 12운성은 없다."])];
  const ordered = (basis: NatalStageCell["basis"]) =>
    cells.filter((cell) => cell.basis === basis).sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));
  const branchGlyph = (cell: NatalStageCell) => {
    const symbol = pillarAt(chart, cell.position)?.branch;
    return symbol && symbol.ko === cell.branch ? glyph(symbol) : cell.branch;
  };
  const pillarGlyph = (cell: NatalStageCell) => {
    const pillar = pillarAt(chart, cell.position);
    return pillar?.stem && pillar.branch && pillar.stem.ko === cell.stem && pillar.branch.ko === cell.branch
      ? `${cell.stem}${cell.branch}(${pillar.stem.hanja}${pillar.branch.hanja})`
      : `${cell.stem}${cell.branch}`;
  };

  const out: DraftMaterial[] = [];
  const dayMaster = ordered("day-master");
  if (dayMaster.length) {
    const subject = chart.dayMaster ? withJosa(`일간 ${glyph(chart.dayMaster)}`, "이/가") : "일간이";
    out.push({
      key: "basics:stages-day-master",
      kind: "engine-fact",
      questionIds: ["P04"],
      scope: "natal",
      text: `${subject} 각 지지에서 놓이는 12운성(일간 기준): ${dayMaster
        .map((cell) => `${BRANCH_SLOT[cell.position]} ${branchGlyph(cell)} ${stageName(cell.stage)}`)
        .join(", ")}.`,
      caveats,
    });
  }
  const self = ordered("self");
  if (self.length) {
    out.push({
      key: "basics:stages-self",
      kind: "engine-fact",
      questionIds: ["P04"],
      scope: "natal",
      text: `각 기둥의 천간이 자기 지지에서 놓이는 12운성(자좌): ${self
        .map((cell) => `${PILLAR_NAME[cell.position]} ${pillarGlyph(cell)} ${stageName(cell.stage)}`)
        .join(", ")}.`,
      caveats,
    });
  }
  const present = STAGE_CYCLE.filter((stage) => cells.some((cell) => stageName(cell.stage) === stage));
  if (present.length) {
    out.push({
      key: "basics:stage-meanings",
      kind: "engine-fact",
      questionIds: ["P04"],
      scope: "natal",
      text: `이 원국에 나온 단계의 전통적 뜻: ${present.map((stage) => `${withJosa(stage, "은/는")} ${STAGE_MEANING[stage]}`).join(", ")}.`,
      caveats,
    });
  }
  return out;
}

/** P05 십성 분석의 섹션 재료: 실제 십성 배치, 지장간 십성, 관측되지 않았거나 비율이 0%인 계열. */
export function buildTenGodMaterials(chart: ChartView, assessment: AssessmentFacet | null, tables: MujinTables): DraftMaterial[] {
  const out: DraftMaterial[] = [];
  const cells = [...tables.tenGods.cells].sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position));
  if (cells.length) {
    const surface: string[] = [];
    for (const cell of cells) {
      const pillar = pillarAt(chart, cell.position);
      if (cell.position !== "day" && cell.stem && pillar?.stem) surface.push(`${STEM_SLOT[cell.position]} ${glyph(pillar.stem)} ${cell.stem}`);
      if (cell.branch && pillar?.branch) surface.push(`${BRANCH_SLOT[cell.position]} ${glyph(pillar.branch)} ${cell.branch}`);
    }
    if (surface.length) {
      out.push({
        key: "basics:ten-gods-surface",
        kind: "engine-fact",
        questionIds: ["P05"],
        scope: "natal",
        text: `원국 글자의 십성(지지는 본기 기준): ${surface.join(", ")}.`,
        ...(chart.hourKnown ? {} : { caveats: [UNSEEN_CAVEAT] }),
      });
    }
    const hidden = cells
      .filter((cell) => cell.hidden.length > 0)
      .map((cell) => {
        const branch = pillarAt(chart, cell.position)?.branch;
        return `${BRANCH_SLOT[cell.position]}${branch ? ` ${glyph(branch)}` : ""} ${cell.hidden.join("·")}`;
      });
    if (hidden.length) {
      out.push({
        key: "basics:ten-gods-hidden",
        kind: "engine-fact",
        questionIds: ["P05"],
        scope: "natal",
        text: `지지 속 지장간의 십성(엔진 순서, 첫째가 본기): ${hidden.join(", ")}.`,
        caveats: ["지장간은 세력 비율에 가중치로 반영된다. 겉 글자와 같은 무게로 세지 않는다."],
      });
    }
  }

  const observedMissing = ((assessment?.observedMissingFamilies as readonly string[] | undefined) ?? []).filter((family): family is Family =>
    (FAMILIES as readonly string[]).includes(family),
  );
  const confirmedMissing = ((assessment?.missingFamilies as readonly string[] | undefined) ?? []).filter((family): family is Family =>
    (FAMILIES as readonly string[]).includes(family),
  );
  const partial = isPartialCoverage(chart, assessment);
  const unseen = partial ? observedMissing.filter((family) => !confirmedMissing.includes(family)) : [];
  if (unseen.length) {
    out.push({
      key: "basics:families-unseen",
      kind: "engine-fact",
      questionIds: ["P05"],
      scope: "natal",
      text: `시주를 뺀 기둥에서는 ${unseen.map((family) => FAMILY_LABEL[family]).join("·")} 계열이 보이지 않지만, 시주를 몰라 원국에 없다고 확정하지 않습니다.`,
      caveats: ["관측되지 않은 십성을 그 기질의 결핍으로 확정하지 않는다."],
    });
  }
  const families = tables.tenGods.families;
  const zero = !partial && families ? FAMILIES.filter((family) => families[family] === 0) : [];
  if (zero.length) {
    out.push({
      key: "basics:families-zero",
      kind: "engine-fact",
      questionIds: ["P05"],
      scope: "natal",
      text: `원국 전체에서 ${zero.map((family) => FAMILY_LABEL[family]).join("·")} 계열의 세력 비율은 0%입니다.`,
      caveats: ["비율이 0%인 계열도 그 영역의 능력이나 관계가 없다는 뜻이 아니다.", FAMILY_FACT_CAVEAT],
    });
  }
  return out;
}
