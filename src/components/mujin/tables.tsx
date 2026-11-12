import type { ReactNode } from "react";
import { ChartTable } from "@/components/chart-table";
import { Notice } from "@/components/ui/layout";
import type { MujinLuck, MujinMonths, MujinTables, MonthTone, NatalStageCell, ScrollStateView, TenGodCell } from "@/domain/mujin/types";
import type { ScrollTable } from "@/domain/products/types";
import { ELEMENT_HANJA } from "@/domain/reading/chart";
import type { ChartElement, ChartView } from "@/domain/reading/types";
import { FAMILIES, FAMILY_LABEL, FAMILY_MEANING } from "@/domain/rules/materials";
import {
  byPosition,
  formatFullDate,
  formatMonthDay,
  formatYearMonth,
  luckRows,
  luckUnavailableText,
  MONTH_DOMAIN_LABEL,
  MONTH_DOMAINS,
  MONTH_TONE_LABEL,
  monthFlags,
  POSITION_LABEL,
  POSITION_ORDER,
  stageAt,
  stageBasesOf,
  stagePillarLabel,
  STAGE_BASIS_LABEL,
} from "./scroll-model";

/**
 * 족자 보고서의 표. 모두 서버가 저장한 엔진 계산값과 규칙 결과로 그린다. LLM이 쓴 값은 없다.
 * 장식용 운세 확률이나 점수 그래프는 그리지 않는다. 오행 분포 막대는 디자인 시스템의 명식 표 구성 요소이며 실제 비율이다.
 * 오행·분야 색은 화면 표현에만 쓰고, 색만으로 뜻을 전하지 않도록 글자를 함께 쓴다.
 */

const ELEMENTS: readonly ChartElement[] = ["목", "화", "토", "금", "수"];

/** 디자인 시스템의 오행 틴트 (chart-table.tsx와 같은 값). */
const ELEMENT_TINT: Readonly<Record<ChartElement, string>> = {
  목: "bg-green-50 text-green-600",
  화: "bg-orange-50 text-orange-600",
  토: "bg-gold-50 text-gold-700",
  금: "bg-gray-100 text-gray-500",
  수: "bg-blue-50 text-blue-600",
};

/** 오행 분포 막대의 조각 색 (디자인 시스템 컴포넌트 보드의 분포 바와 같이 오행 글자색). */
const ELEMENT_FILL: Readonly<Record<ChartElement, string>> = {
  목: "bg-green-600",
  화: "bg-orange-600",
  토: "bg-gold-700",
  금: "bg-gray-500",
  수: "bg-blue-600",
};

/** 같은 달의 표지 구성. 긍정은 길(green), 주의는 경고(gold), 함께는 정보(primary) 틴트. 글자를 함께 쓴다. */
const TONE_TINT: Readonly<Record<MonthTone, string>> = {
  positive: "bg-green-50 text-green-600",
  caution: "bg-gold-50 text-gold-700",
  mixed: "bg-primary-50 text-primary-600",
  neutral: "bg-white text-gray-700",
  "no-data": "bg-white text-gray-500",
};

/** 표 칸의 공통 모양. 정렬·글자 유틸리티가 한 칸에서 겹치지 않도록 용도별로 나눠 둔다. */
const CELL = "border-b border-gray-100 px-3 py-3";
const TH_COL_BASE = "border-b border-gray-200 px-3 py-2 type-caption-sm text-gray-600";
const TH_COL = `${TH_COL_BASE} text-left`;
const TH_COL_END = `${TH_COL_BASE} text-right`;
const TH_ROW = `${CELL} text-left type-label font-semibold text-gray-900`;
const TD = `${CELL} text-left type-label font-normal text-gray-900`;
const TD_STRONG = `${CELL} text-left type-label font-semibold text-gray-900`;
const TD_SMALL = `${CELL} text-left type-caption text-gray-700`;
const TD_NUM = `${CELL} text-center type-label font-normal tabular-nums text-gray-900`;
const TD_NUM_END = `${CELL} text-right type-label font-normal tabular-nums text-gray-900`;

/** 좁은 화면에서 표가 넘치면 가로로 밀어 보는 영역. 키보드로도 밀 수 있게 포커스를 받는다. */
function TableScroller({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      {children}
    </div>
  );
}

function Notes({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item} className="type-caption text-gray-600">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** 원국표: 기존 사주원국 표에 지지 십성과 지장간 십성을 더한다. 오행 비율은 바로 아래 오행 분석 표에서 따로 보여 준다. */
function PillarsTable({ chart, cells }: { chart: ChartView; cells: readonly TenGodCell[] }) {
  const ordered = byPosition(cells);
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <ChartTable chart={{ ...chart, elementPercent: null }} />
      </div>
      <TableScroller label="자리별 지지 십성과 지장간 십성">
        <table className="w-full border-collapse">
          <caption className="sr-only">자리별 지지 십성과 지장간 십성</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                <span className="sr-only">항목</span>
              </th>
              {POSITION_ORDER.map((position) => (
                <th key={position} scope="col" className={TH_COL}>
                  {POSITION_LABEL[position]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={TH_ROW}>
                지지 십성
              </th>
              {ordered.map((cell, index) => (
                <td key={POSITION_ORDER[index]} className={TD}>
                  {cell ? (cell.branch ?? "없음") : "모름"}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={TH_ROW}>
                지장간
              </th>
              {ordered.map((cell, index) => (
                <td key={POSITION_ORDER[index]} className={TD_SMALL}>
                  {cell ? cell.hidden.join(" · ") || "없음" : "모름"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </TableScroller>
      <Notes items={[...chart.notes, "지장간 칸은 지지 속에 든 천간의 십성을 본기부터 적은 것이에요."]} />
    </div>
  );
}

/** 오행: 겉글자의 단순 개수와 엔진의 가중 비율을 다른 이름으로 나눠 보여 준다. */
function ElementsTable({ elements, hourKnown }: { elements: MujinTables["elements"]; hourKnown: boolean }) {
  const { counts, percents } = elements;
  return (
    <div className="flex flex-col gap-3">
      <TableScroller label="오행 글자 수와 세력 비율">
        <table className="w-full min-w-max border-collapse">
          <caption className="sr-only">오행 글자 수와 세력 비율</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                오행
              </th>
              {ELEMENTS.map((element) => (
                <th key={element} scope="col" className={`border-b border-gray-200 px-3 py-2 text-center ${ELEMENT_TINT[element]}`}>
                  <span className="type-label">
                    {element}({ELEMENT_HANJA[element]})
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={TH_ROW}>
                글자 수
              </th>
              {ELEMENTS.map((element) => (
                <td key={element} className={TD_NUM}>
                  {counts[element]}개
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={TH_ROW}>
                세력 비율
              </th>
              {ELEMENTS.map((element) => (
                <td key={element} className={TD_NUM}>
                  {percents ? `${percents[element]}%` : "–"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </TableScroller>
      {percents ? (
        <div aria-hidden className="flex h-4 gap-1 overflow-hidden rounded-sm">
          {ELEMENTS.filter((element) => percents[element] > 0).map((element) => (
            <span key={element} className={`basis-0 ${ELEMENT_FILL[element]}`} style={{ flexGrow: percents[element] }} />
          ))}
        </div>
      ) : null}
      <Notes
        items={[
          `글자 수: 천간과 지지의 겉글자 ${hourKnown ? "여덟" : "여섯(태어난 시간을 몰라 시주 제외)"} 자를 오행별로 센 수예요.`,
          percents
            ? "세력 비율: 지지 속 천간(지장간)과 태어난 달의 힘까지 넣어 계산한 비율이에요. 글자 수와 다를 수 있어요."
            : "세력 비율은 이 원국에서 계산되지 않았어요.",
        ]}
      />
    </div>
  );
}

/**
 * 원국 12운성. 원국 자리의 단계만 보여 주고, 대운·올해 같은 기간의 단계는 섞지 않는다.
 * 엔진은 일간 기준과 자좌(그 기둥의 천간 기준) 두 가지를 주므로 기준마다 한 줄씩 보여 준다.
 */
function StagesTable({ stages }: { stages: readonly NatalStageCell[] }) {
  const bases = stageBasesOf(stages);
  return (
    <div className="flex flex-col gap-3">
      <TableScroller label="원국 12운성">
        <table className="w-full border-collapse">
          <caption className="sr-only">원국 12운성</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                <span className="sr-only">항목</span>
              </th>
              {POSITION_ORDER.map((position) => (
                <th key={position} scope="col" className={TH_COL}>
                  {POSITION_LABEL[position]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={TH_ROW}>
                기둥
              </th>
              {POSITION_ORDER.map((position) => (
                <td key={position} className={TD}>
                  {stagePillarLabel(stages, position)}
                </td>
              ))}
            </tr>
            {bases.map((basis) => (
              <tr key={basis}>
                <th scope="row" className={TH_ROW}>
                  {STAGE_BASIS_LABEL[basis]}
                </th>
                {POSITION_ORDER.map((position) => (
                  <td key={position} className={TD_STRONG}>
                    {stageAt(stages, position, basis)?.stage ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <Notes
        items={[
          "일간 기준은 일간이 각 자리의 지지에서 놓이는 단계, 그 기둥의 천간 기준은 각 기둥의 천간이 자기 지지에서 놓이는 단계예요.",
          "대운이나 올해처럼 기간에 따라 달라지는 단계와는 다른 표예요.",
        ]}
      />
    </div>
  );
}

/** 십성: 자리별 십성과 다섯 계열의 비율. */
function TenGodsTable({ tenGods }: { tenGods: MujinTables["tenGods"] }) {
  const ordered = byPosition(tenGods.cells);
  const families = tenGods.families;
  return (
    <div className="flex flex-col gap-5">
      <TableScroller label="자리별 십성">
        <table className="w-full border-collapse">
          <caption className="sr-only">자리별 십성</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                자리
              </th>
              <th scope="col" className={TH_COL}>
                천간
              </th>
              <th scope="col" className={TH_COL}>
                지지(본기)
              </th>
              <th scope="col" className={TH_COL}>
                지장간
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((cell, index) => (
              <tr key={POSITION_ORDER[index]}>
                <th scope="row" className={TH_ROW}>
                  {POSITION_LABEL[POSITION_ORDER[index]!]}
                </th>
                <td className={TD}>{cell ? (cell.stem ?? "없음") : "모름"}</td>
                <td className={TD}>{cell ? (cell.branch ?? "없음") : "모름"}</td>
                <td className={TD_SMALL}>{cell ? cell.hidden.join(" · ") || "없음" : "모름"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      {families ? (
        <TableScroller label="다섯 계열 비율">
          <table className="w-full border-collapse">
            <caption className="sr-only">십성 다섯 계열의 비율</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_COL}>
                  계열
                </th>
                <th scope="col" className={TH_COL}>
                  뜻
                </th>
                <th scope="col" className={TH_COL_END}>
                  비율
                </th>
              </tr>
            </thead>
            <tbody>
              {FAMILIES.map((family) => (
                <tr key={family}>
                  <th scope="row" className={TH_ROW}>
                    {FAMILY_LABEL[family]}
                  </th>
                  <td className={TD_SMALL}>{FAMILY_MEANING[family]}</td>
                  <td className={TD_NUM_END}>{families[family]}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      ) : (
        <Notes items={["다섯 계열의 비율은 이 원국에서 계산되지 않았어요."]} />
      )}
    </div>
  );
}

/** 9장 대운: 직전·현재·다음 구간. 경계는 근사값이다. 계산할 수 없으면 이유를 쓴다. */
function LuckTable({ luck, referenceDate }: { luck: MujinLuck; referenceDate: string | null }) {
  if (luck.status === "unavailable" || !luck.current) return <Notice>{luckUnavailableText(luck.reason)}</Notice>;
  return (
    <div className="flex flex-col gap-3">
      <TableScroller label="직전·현재·다음 대운">
        <table className="w-full min-w-max border-collapse">
          <caption className="sr-only">직전·현재·다음 대운</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                구간
              </th>
              <th scope="col" className={TH_COL}>
                간지
              </th>
              <th scope="col" className={TH_COL}>
                시작
              </th>
              <th scope="col" className={TH_COL}>
                기간(근사)
              </th>
              <th scope="col" className={TH_COL}>
                천간 십성
              </th>
            </tr>
          </thead>
          <tbody>
            {luckRows(luck).map((row) => {
              const period = row.period;
              const current = row.key === "current";
              return (
                <tr key={row.key} aria-current={current ? "true" : undefined} className={current ? "bg-primary-50" : undefined}>
                  <th scope="row" className={TH_ROW}>
                    {row.label}
                  </th>
                  <td className={TD}>{period?.ganzhi ?? "없음"}</td>
                  <td className={TD}>{period?.label ?? "–"}</td>
                  <td className={TD}>
                    {period ? `${formatYearMonth(period.startsAt)} ~ ${formatYearMonth(period.endsAt)}${period.approximate ? " 무렵" : ""}` : "–"}
                  </td>
                  <td className={TD}>
                    {period?.stemTenGod ? `${period.stemTenGod}${period.stemFamily ? ` (${FAMILY_LABEL[period.stemFamily]})` : ""}` : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroller>
      <Notes
        items={[
          "대운이 바뀌는 시점은 계산 정책상 근사값이라 앞뒤로 조금 차이가 날 수 있어요.",
          ...(referenceDate ? [`현재 대운은 기준일 ${formatFullDate(referenceDate)}로 골랐어요.`] : []),
        ]}
      />
    </div>
  );
}

/** 10장 12개월: 절기 기준 달마다 네 분야의 표지 구성과 주목·주의 구간. 점수나 확률이 아니다. */
function MonthsTable({ months }: { months: MujinMonths }) {
  if (months.status === "insufficient" || months.months.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Notice>앞으로 12개월을 표로 보여 줄 자료가 부족해요.</Notice>
        <Notes items={months.limitations} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="type-label font-normal text-gray-700">분석 기간: {months.window.label}</p>
      <TableScroller label="앞으로 12개월 분야별 표지">
        <table className="w-full min-w-max border-collapse">
          <caption className="sr-only">달마다 분야별 표지와 주목·주의 구간</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_COL}>
                달
              </th>
              {MONTH_DOMAINS.map((domain) => (
                <th key={domain} scope="col" className={TH_COL}>
                  {MONTH_DOMAIN_LABEL[domain]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.months.map((month) => (
              <tr key={month.periodId}>
                <th scope="row" className={`${TH_ROW} align-top`}>
                  <span className="block">{month.label}</span>
                  {month.startsOn ? <span className="block type-caption font-normal text-gray-600">{formatMonthDay(month.startsOn)}부터</span> : null}
                  {month.startedBeforeReference ? <span className="block type-caption-sm text-gold-700">기준일 전에 이미 시작한 달</span> : null}
                </th>
                {MONTH_DOMAINS.map((domain) => {
                  const tone = month.cells.find((cell) => cell.domain === domain)?.tone ?? "no-data";
                  const flags = monthFlags(months, month.periodId, domain);
                  return (
                    <td key={domain} className={`border-b border-gray-100 px-3 py-3 align-top ${TONE_TINT[tone]}`}>
                      <span className="block type-caption">{MONTH_TONE_LABEL[tone]}</span>
                      {flags.notable ? <span className="block type-caption-sm font-semibold text-green-600">주목</span> : null}
                      {flags.careful ? <span className="block type-caption-sm font-semibold text-rose-600">주의</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <Notes
        items={[
          "달은 절기로 나눈 월운이라 달력의 1일과 시작일이 달라요.",
          "주목은 분야마다 긍정 표지가 주의 표지보다 많은 달 가운데 고른 구간(최대 세 달), 주의는 주의 표지가 더 많은 달 가운데 고른 구간(최대 두 달)이에요.",
          "표지는 그 달에 들어온 근거의 구성이에요. 점수나 일이 일어날 확률이 아니에요.",
          ...months.limitations,
        ]}
      />
    </div>
  );
}

/** 칸에 정해진 표를 그린다. 기간표(대운·12개월)는 권한이 있어 기간 재료를 받았을 때만 그린다. */
export function SectionTables({ tables, state }: { tables: readonly ScrollTable[]; state: ScrollStateView }) {
  if (tables.length === 0) return null;
  return (
    <>
      {tables.map((table) => {
        switch (table) {
          case "pillars":
            return <PillarsTable key={table} chart={state.chart} cells={state.tables.tenGods.cells} />;
          case "elements":
            return <ElementsTable key={table} elements={state.tables.elements} hourKnown={state.hourKnown} />;
          case "stages":
            return <StagesTable key={table} stages={state.tables.stages} />;
          case "ten-gods":
            return <TenGodsTable key={table} tenGods={state.tables.tenGods} />;
          case "luck":
            return state.timing ? <LuckTable key={table} luck={state.timing.luck} referenceDate={state.paid.referenceDate} /> : null;
          case "months":
            return state.timing ? <MonthsTable key={table} months={state.timing.months} /> : null;
        }
      })}
    </>
  );
}
