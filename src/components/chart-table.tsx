import { ELEMENT_HANJA, elementCounts } from "@/domain/reading/chart";
import type { ChartElement, ChartPillar, ChartSymbol, ChartView } from "@/domain/reading/types";

/** 디자인 시스템의 오행 틴트. 화면 표현에만 쓰며 계산과는 무관하다. */
const ELEMENT_STYLE: Readonly<Record<ChartElement, string>> = {
  목: "bg-green-50 text-green-600",
  화: "bg-orange-50 text-orange-600",
  토: "bg-gold-50 text-gold-700",
  금: "bg-gray-100 text-gray-500",
  수: "bg-blue-50 text-blue-600",
};

function Cell({ symbol, outlined }: { symbol: ChartSymbol | null; outlined?: boolean }) {
  if (!symbol) {
    return (
      <div className="flex h-tile w-full flex-col items-center justify-center rounded-md border border-gray-200 bg-gray-50 type-caption text-gray-500">
        모름
      </div>
    );
  }
  return (
    <div
      className={`flex h-tile w-full items-center justify-center rounded-md ${ELEMENT_STYLE[symbol.element]} ${
        outlined ? "outline-2 outline-offset-2 outline-current" : ""
      }`}
    >
      <span className="type-hanja">{symbol.hanja}</span>
      <span className="sr-only">
        {symbol.ko} {symbol.element}
      </span>
    </div>
  );
}

function Column({ pillar }: { pillar: ChartPillar }) {
  const isDay = pillar.key === "day";
  return (
    <div className="flex flex-col items-center gap-2">
      <span className={`type-caption-sm ${isDay ? "font-semibold text-gray-900" : "text-gray-500"}`}>{pillar.label}</span>
      <Cell symbol={pillar.stem} outlined={isDay} />
      <span className="type-caption-sm text-gray-600">{pillar.stem?.ko ?? ""}{pillar.branch?.ko ?? ""}</span>
      <Cell symbol={pillar.branch} />
      <span className="type-caption-sm text-gray-600">{pillar.stem?.tenGod && !isDay ? pillar.stem.tenGod : " "}</span>
    </div>
  );
}

const ELEMENTS: readonly ChartElement[] = ["목", "화", "토", "금", "수"];

/** showCounts: 오행 비율 아래에 원국 글자 수도 보여 준다 (메신저의 사주표 사진). */
export function ChartTable({ chart, showCounts = false }: { chart: ChartView; showCounts?: boolean }) {
  const counts = showCounts ? elementCounts(chart) : null;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-3" aria-label="사주원국">
        {chart.pillars.map((pillar) => (
          <Column key={pillar.key} pillar={pillar} />
        ))}
      </div>
      {chart.elementPercent ? (
        <ul className="grid grid-cols-5 gap-2" aria-label="오행 비율">
          {ELEMENTS.map((element) => (
            <li key={element} className={`flex flex-col items-center gap-1 rounded-md py-3 ${ELEMENT_STYLE[element]}`}>
              <span className="type-label">
                {element}({ELEMENT_HANJA[element]})
              </span>
              <span className="type-caption type-price">{chart.elementPercent![element]}%</span>
              {counts ? <span className="type-caption-sm">{counts[element]}개</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 메신저에서 상담사가 보낸 사진처럼 보이는 사주표. 저장된 원국 계산값만 보여 준다. */
export function ChartPhoto({ chart, nickname }: { chart: ChartView; nickname: string }) {
  return (
    <figure className="flex w-full flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4" aria-label="사주원국 표와 오행 비율">
      <ChartTable chart={chart} showCounts />
      <figcaption className="type-caption-sm text-gray-600">
        {nickname} 님의 사주원국 · 오행 비율과 글자 수{chart.hourKnown ? "" : " (시주 제외)"}
      </figcaption>
    </figure>
  );
}
