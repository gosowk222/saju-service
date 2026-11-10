import type { ChartElement, ChartPillar, ChartSymbol, ChartView } from "./types";

/** 계산이 아니라 표시용 표다. 한글 음을 한자로 바꿀 뿐이다. */
const STEM_HANJA: Readonly<Record<string, string>> = {
  갑: "甲", 을: "乙", 병: "丙", 정: "丁", 무: "戊", 기: "己", 경: "庚", 신: "辛", 임: "壬", 계: "癸",
};
const BRANCH_HANJA: Readonly<Record<string, string>> = {
  자: "子", 축: "丑", 인: "寅", 묘: "卯", 진: "辰", 사: "巳", 오: "午", 미: "未", 신: "申", 유: "酉", 술: "戌", 해: "亥",
};
export const ELEMENT_HANJA: Readonly<Record<ChartElement, string>> = {
  목: "木", 화: "火", 토: "土", 금: "金", 수: "水",
};

/** 사주 계산 결과에서 화면에 필요한 값만 뽑을 때 쓰는 최소 구조. */
export interface ChartFacts {
  readonly dayMaster: string | null;
  readonly positions: Readonly<
    Record<
      "year" | "month" | "day" | "hour",
      | {
          readonly stem: { readonly stem: string; readonly element: string; readonly tenGod: string | null };
          readonly branch: { readonly branch: string; readonly element: string; readonly tenGod: string | null };
        }
      | null
    >
  >;
  readonly status: string;
}

function symbol(ko: string, table: Readonly<Record<string, string>>, element: string, tenGod: string | null): ChartSymbol {
  return { ko, hanja: table[ko] ?? ko, element: element as ChartElement, tenGod };
}

const PILLAR_ORDER = [
  { key: "hour", label: "시주" },
  { key: "day", label: "일주" },
  { key: "month", label: "월주" },
  { key: "year", label: "연주" },
] as const;

export function buildChartView(
  facts: ChartFacts,
  elementPercent: Readonly<Record<ChartElement, number>> | null,
): ChartView {
  const pillars: ChartPillar[] = PILLAR_ORDER.map(({ key, label }) => {
    const position = facts.positions[key];
    if (!position) return { key, label, stem: null, branch: null };
    return {
      key,
      label,
      stem: symbol(position.stem.stem, STEM_HANJA, position.stem.element, position.stem.tenGod),
      branch: symbol(position.branch.branch, BRANCH_HANJA, position.branch.element, position.branch.tenGod),
    };
  });
  const hourKnown = facts.positions.hour !== null;
  const dayStem = facts.positions.day?.stem;
  return {
    pillars,
    dayMaster: dayStem
      ? { ko: dayStem.stem, hanja: STEM_HANJA[dayStem.stem] ?? dayStem.stem, element: dayStem.element as ChartElement }
      : null,
    elementPercent,
    hourKnown,
    status: facts.status,
    notes: hourKnown ? [] : ["태어난 시간을 몰라 시주는 비워 두었어요. 시주를 빼고 볼 수 있는 범위만 읽어요."],
  };
}

export function chartLabel(chart: ChartView): string {
  return chart.pillars
    .filter((pillar) => pillar.stem && pillar.branch)
    .map((pillar) => `${pillar.label} ${pillar.stem!.ko}${pillar.branch!.ko}`)
    .join(" · ");
}
