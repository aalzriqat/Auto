import { describe, expect, it } from "vitest";
import { openPeriodCovering, parseDisplayedRange, type DisplayedPeriodRow } from "./periodCoverage";

const row = (label: string, status: string, range: string): DisplayedPeriodRow => ({ label, status, range });
const utc = (iso: string) => Date.parse(iso);

describe("parseDisplayedRange: the table's 'MMM d, yyyy - MMM d, yyyy' cell, as UTC day bounds", () => {
  it("reads the start of the first day and the end of the last day", () => {
    expect(parseDisplayedRange("Sep 1, 2026 - Sep 30, 2026")).toEqual({
      startMs: utc("2026-09-01T00:00:00.000Z"),
      endMs: utc("2026-09-30T23:59:59.999Z"),
    });
  });

  it("reads a multi-month range", () => {
    expect(parseDisplayedRange("Jan 1, 2026 - Dec 31, 2026")?.endMs).toBe(utc("2026-12-31T23:59:59.999Z"));
  });

  it.each(["", "No accounting periods", "Sep 1, 2026", "Sep 1, 2026 - not a date"])("rejects %j", (text) => {
    expect(parseDisplayedRange(text)).toBeNull();
  });
});

describe("openPeriodCovering: an OPEN row whose dates contain the instant", () => {
  const rows = [
    row("2026-01", "Open", "Jan 1, 2026 - Dec 31, 2026"),
    row("2027-03", "Closed", "Mar 1, 2027 - Mar 31, 2027"),
    row("2027-04", "Future", "Apr 1, 2027 - Apr 30, 2027"),
  ];

  it("counts a full-year period labelled January as covering September", () => {
    expect(openPeriodCovering(rows, utc("2026-09-01T00:00:00Z"))?.label).toBe("2026-01");
  });

  it("includes the last millisecond of the end day and excludes the next instant", () => {
    expect(openPeriodCovering(rows, utc("2026-12-31T23:59:59.999Z"))?.label).toBe("2026-01");
    expect(openPeriodCovering(rows, utc("2027-01-01T00:00:00.000Z"))).toBeNull();
  });

  it("does not count a closed or future period", () => {
    expect(openPeriodCovering(rows, utc("2027-03-15T00:00:00Z"))).toBeNull();
    expect(openPeriodCovering(rows, utc("2027-04-15T00:00:00Z"))).toBeNull();
  });

  it("ignores a row whose dates cannot be read rather than treating it as covering", () => {
    expect(openPeriodCovering([row("2026-09", "Open", "")], utc("2026-09-15T00:00:00Z"))).toBeNull();
  });
});
