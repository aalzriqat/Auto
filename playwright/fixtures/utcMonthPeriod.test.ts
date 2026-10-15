import { describe, expect, it } from "vitest";
import { utcMonthPeriod, utcMonthPeriodsCovering } from "./utcMonthPeriod";

describe("utcMonthPeriodsCovering: every UTC month an instant within the window can fall in", () => {
  const WINDOW = 5 * 60_000;

  it("is just the current month when the window stays inside it", () => {
    expect(utcMonthPeriodsCovering(new Date("2026-08-15T10:00:00Z"), WINDOW).map((p) => p.periodNumber)).toEqual(["8"]);
  });

  it("includes the next month when the window crosses the month boundary", () => {
    const periods = utcMonthPeriodsCovering(new Date("2026-08-31T23:57:00Z"), WINDOW);
    expect(periods.map((p) => p.startDate)).toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("crosses the year boundary", () => {
    const periods = utcMonthPeriodsCovering(new Date("2026-12-31T23:59:30Z"), WINDOW);
    expect(periods.map((p) => [p.fiscalYear, p.periodNumber])).toEqual([["2026", "12"], ["2027", "1"]]);
  });

  it("does not include the next month when the window ends before it", () => {
    expect(utcMonthPeriodsCovering(new Date("2026-08-31T23:55:00Z"), WINDOW - 1).length).toBe(1);
  });

  it("includes the next month when the window ends exactly on its first instant", () => {
    expect(utcMonthPeriodsCovering(new Date("2026-08-31T23:55:00Z"), WINDOW).length).toBe(2);
  });
});

describe("utcMonthPeriod: the UTC month containing an instant", () => {
  it.each([
    ["2026-08-15T10:00:00Z", { fiscalYear: "2026", periodNumber: "8", startDate: "2026-08-01", endDate: "2026-08-31" }],
    ["2026-02-28T23:59:59Z", { fiscalYear: "2026", periodNumber: "2", startDate: "2026-02-01", endDate: "2026-02-28" }],
    ["2028-02-01T00:00:00Z", { fiscalYear: "2028", periodNumber: "2", startDate: "2028-02-01", endDate: "2028-02-29" }],
    ["2026-12-31T23:59:59Z", { fiscalYear: "2026", periodNumber: "12", startDate: "2026-12-01", endDate: "2026-12-31" }],
    ["2026-01-01T00:00:00Z", { fiscalYear: "2026", periodNumber: "1", startDate: "2026-01-01", endDate: "2026-01-31" }],
  ])("%s", (instant, expected) => {
    expect(utcMonthPeriod(new Date(instant))).toEqual(expected);
  });

  it("uses the UTC month even when the local date is in the next month", () => {
    // 2026-08-31T22:00Z is already September 1 in UTC+3; the server's today is August.
    expect(utcMonthPeriod(new Date("2026-08-31T22:00:00Z")).periodNumber).toBe("8");
  });
});
