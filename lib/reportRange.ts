/** Longest span an interactive report may request. The server enforces it; the reports screen uses the same number. */
export const MAX_REPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export type ReportRangeProblem = "NOT_VALID" | "REVERSED" | "TOO_LONG";

/** The one rule for an acceptable report range, shared by the query and the screen that calls it. */
export function reportRangeProblem(startDate: number, endDate: number): ReportRangeProblem | null {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) return "NOT_VALID";
  if (startDate > endDate) return "REVERSED";
  if (endDate - startDate > MAX_REPORT_RANGE_MS) return "TOO_LONG";
  return null;
}
