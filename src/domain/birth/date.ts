/**
 * YYMMDD 생년월일의 네 자리 연도를 정한다.
 *
 * 정책: 오늘(Asia/Seoul)까지의 최근 100년 안에 있으면서 미래가 아닌 연도를 쓴다.
 * 달력 계산은 주입받은 변환기(서버의 sajuengine 공개 변환기)에 맡긴다.
 * 이 파일은 양력·음력을 직접 계산하지 않는다.
 */

export type CalendarKind = "solar" | "lunar";

export interface CalendarQuery {
  readonly calendar: CalendarKind;
  readonly isLeapMonth: boolean;
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface YearMonthDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** 해당 달력에 없는 날짜면 null을 돌려준다. */
export type CalendarConverter = (query: CalendarQuery) => { readonly solar: YearMonthDay } | null;

export type DateErrorCode = "format" | "not-exist" | "leap-not-exist" | "out-of-range";

export type ResolvedBirthDate =
  | {
      readonly ok: true;
      /** 고른 달력 기준의 YYYY-MM-DD. 음력이면 음력 날짜다. */
      readonly birthDate: string;
      readonly year: number;
      readonly calendar: CalendarKind;
      readonly isLeapMonth: boolean;
      readonly solarDate: string;
      readonly display: string;
    }
  | { readonly ok: false; readonly code: DateErrorCode; readonly message: string };

const ERROR_MESSAGES: Readonly<Record<DateErrorCode, string>> = {
  format: "생년월일을 숫자 여섯 자리로 입력해 주세요. 예: 980919",
  "not-exist": "달력에 없는 날짜예요. 월과 일을 다시 확인해 주세요.",
  "leap-not-exist": "그해에는 해당 윤달이 없어요. 윤달 선택을 다시 확인해 주세요.",
  "out-of-range": "최근 100년 안의 날짜만 입력할 수 있어요.",
};

const pad = (value: number) => String(value).padStart(2, "0");

export function formatIsoDate({ year, month, day }: YearMonthDay): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

export function formatKoreanDate({ year, month, day }: YearMonthDay): string {
  return `${year}년 ${month}월 ${day}일`;
}

export function parseIsoDate(value: string): YearMonthDay {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

/** 지금 이 순간의 Asia/Seoul 달력 날짜. */
export function seoulToday(now: Date = new Date()): YearMonthDay {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function failure(code: DateErrorCode): ResolvedBirthDate {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

export function resolveBirthDate(input: {
  readonly yymmdd: string;
  readonly calendar: CalendarKind;
  readonly isLeapMonth: boolean;
  readonly today: YearMonthDay;
  readonly convert: CalendarConverter;
}): ResolvedBirthDate {
  const { yymmdd, calendar, today, convert } = input;
  const isLeapMonth = calendar === "lunar" && input.isLeapMonth;
  if (!/^\d{6}$/.test(yymmdd)) return failure("format");

  const yy = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return failure("not-exist");

  const windowEnd = formatIsoDate(today);
  const windowStart = formatIsoDate({ ...today, year: today.year - 100 });

  // 음력은 양력으로 바꾸면 다음 해로 넘어갈 수 있어 한 해 더 앞까지 후보로 본다.
  const candidates: number[] = [];
  for (let year = today.year; year >= today.year - 101; year -= 1) {
    if (year % 100 === yy) candidates.push(year);
  }

  let anyValid = false;
  for (const year of candidates) {
    const converted = convert({ calendar, isLeapMonth, year, month, day });
    if (!converted) continue;
    anyValid = true;
    const solarDate = formatIsoDate(converted.solar);
    // 최근 100년: 100년 전 오늘은 제외하고 오늘은 포함한다.
    if (solarDate <= windowStart || solarDate > windowEnd) continue;

    const selected = { year, month, day };
    const label = formatKoreanDate(selected);
    return {
      ok: true,
      birthDate: formatIsoDate(selected),
      year,
      calendar,
      isLeapMonth,
      solarDate,
      display:
        calendar === "solar"
          ? label
          : `음력 ${label}${isLeapMonth ? " (윤달)" : ""} · 양력 ${formatKoreanDate(converted.solar)}`,
    };
  }
  if (anyValid) return failure("out-of-range");
  return failure(isLeapMonth ? "leap-not-exist" : "not-exist");
}
