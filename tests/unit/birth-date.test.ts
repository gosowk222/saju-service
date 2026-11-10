import { manseryeokCalendarConversionAdapter } from "sajuengine/node";
import { describe, expect, it } from "vitest";
import { resolveBirthDate, seoulToday, type CalendarConverter, type CalendarKind, type YearMonthDay } from "@/domain/birth/date";

const convert: CalendarConverter = ({ calendar, isLeapMonth, year, month, day }) => {
  try {
    return {
      solar: manseryeokCalendarConversionAdapter.convert(
        calendar === "solar"
          ? { calendarType: "solar", isLeapMonth: false, year, month, day }
          : { calendarType: "lunar", isLeapMonth, year, month, day },
      ).solar,
    };
  } catch {
    return null;
  }
};

const TODAY: YearMonthDay = { year: 2026, month: 11, day: 9 };

function resolve(yymmdd: string, options: { calendar?: CalendarKind; leap?: boolean; today?: YearMonthDay } = {}) {
  return resolveBirthDate({
    yymmdd,
    calendar: options.calendar ?? "solar",
    isLeapMonth: options.leap ?? false,
    today: options.today ?? TODAY,
    convert,
  });
}

function birthDateOf(result: ReturnType<typeof resolve>): string {
  if (!result.ok) throw new Error(`resolved failed: ${result.code}`);
  return result.birthDate;
}

describe("YYMMDD 연도 자동 해석", () => {
  it.each([
    ["010203", "2001-02-03", "2001년 2월 3일"],
    ["980919", "1998-09-19", "1998년 9월 19일"],
    ["850615", "1985-06-15", "1985년 6월 15일"],
  ])("요구사항 예시 %s", (input, birthDate, display) => {
    const result = resolve(input);
    expect(result).toMatchObject({ ok: true, birthDate, display });
  });

  it("오늘 날짜는 포함하고 내일은 100년 전으로 해석한다", () => {
    expect(birthDateOf(resolve("261109"))).toBe("2026-11-09");
    expect(birthDateOf(resolve("261110"))).toBe("1926-11-10");
  });

  it("정확히 100년 전 오늘은 범위 밖이다", () => {
    expect(birthDateOf(resolve("261109", { today: { year: 2026, month: 11, day: 9 } }))).toBe("2026-11-09");
    // 2026-11-09를 입력해도 1926-11-09로 해석하지 않는다. 2027년이 되면 2026-11-09 그대로다.
    expect(birthDateOf(resolve("261109", { today: { year: 2027, month: 1, day: 1 } }))).toBe("2026-11-09");
  });

  it("해가 바뀌면 코드 수정 없이 기준이 따라간다", () => {
    expect(birthDateOf(resolve("261231", { today: { year: 2026, month: 12, day: 30 } }))).toBe("1926-12-31");
    expect(birthDateOf(resolve("261231", { today: { year: 2027, month: 1, day: 1 } }))).toBe("2026-12-31");
    expect(birthDateOf(resolve("300101", { today: { year: 2031, month: 6, day: 1 } }))).toBe("2030-01-01");
    expect(birthDateOf(resolve("320101", { today: { year: 2031, month: 6, day: 1 } }))).toBe("1932-01-01");
  });

  it("앞자리를 19나 20으로 고정하지 않는다", () => {
    expect(birthDateOf(resolve("000229"))).toBe("2000-02-29");
    expect(birthDateOf(resolve("990101"))).toBe("1999-01-01");
    expect(birthDateOf(resolve("270101"))).toBe("1927-01-01");
  });

  it("없는 날짜를 다른 날짜로 바꾸거나 세기를 옮기지 않는다", () => {
    expect(resolve("250229")).toMatchObject({ ok: false, code: "not-exist" });
    expect(resolve("991301")).toMatchObject({ ok: false, code: "not-exist" });
    expect(resolve("990132")).toMatchObject({ ok: false, code: "not-exist" });
    expect(resolve("990431")).toMatchObject({ ok: false, code: "not-exist" });
  });

  it("윤년 2월 29일은 받아들인다", () => {
    expect(birthDateOf(resolve("240229"))).toBe("2024-02-29");
  });

  it("형식이 틀리면 안내한다", () => {
    expect(resolve("9809")).toMatchObject({ ok: false, code: "format" });
    expect(resolve("98a919")).toMatchObject({ ok: false, code: "format" });
  });
});

describe("음력과 윤달", () => {
  it("음력 날짜는 선택한 달력의 날짜로 전달하고 양력도 함께 보여 준다", () => {
    const result = resolve("900129", { calendar: "lunar" });
    expect(result).toMatchObject({ ok: true, birthDate: "1990-01-29", solarDate: "1990-02-24", calendar: "lunar" });
    if (result.ok) expect(result.display).toContain("양력 1990년 2월 24일");
  });

  it("음력에 없는 날짜를 거부한다", () => {
    expect(resolve("900130", { calendar: "lunar" })).toMatchObject({ ok: false, code: "not-exist" });
  });

  it("실제 윤달만 받아들인다", () => {
    const result = resolve("230215", { calendar: "lunar", leap: true });
    expect(result).toMatchObject({ ok: true, birthDate: "2023-02-15", isLeapMonth: true, solarDate: "2023-04-05" });
    if (result.ok) expect(result.display).toContain("윤달");
    expect(resolve("240215", { calendar: "lunar", leap: true })).toMatchObject({ ok: false, code: "leap-not-exist" });
  });

  it("음력 숫자가 아니라 양력으로 바꾼 날짜로 미래 여부를 본다", () => {
    // 음력 2026-12-15는 양력 2027년이라 미래다. 음력 1926-12-15(양력 1927-01-18)로 해석한다.
    expect(birthDateOf(resolve("261215", { calendar: "lunar" }))).toBe("1926-12-15");
  });

  it("양력에서는 윤달 값을 무시한다", () => {
    const result = resolve("980919", { calendar: "solar", leap: true });
    expect(result).toMatchObject({ ok: true, isLeapMonth: false });
  });
});

describe("오늘 날짜", () => {
  it("Asia/Seoul 기준으로 판단한다", () => {
    expect(seoulToday(new Date("2026-11-09T14:59:59Z"))).toEqual({ year: 2026, month: 11, day: 9 });
    expect(seoulToday(new Date("2026-11-09T15:00:00Z"))).toEqual({ year: 2026, month: 11, day: 10 });
  });
});
