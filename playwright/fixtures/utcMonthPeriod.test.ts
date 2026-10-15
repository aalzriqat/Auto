import { describe, expect, it } from "vitest";
import { utcMonthPeriod } from "./utcMonthPeriod";

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
