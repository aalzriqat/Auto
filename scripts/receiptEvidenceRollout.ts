import { isCount, parseCursorPage, walkCursorPages } from "./releaseCursorPages.ts";
import type { RegistryStep } from "./releaseGuard.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

export function runReceiptEvidenceBackfill(input: {
  convex: (argv: string[]) => RegistryStep;
  now: () => number;
  startedAt: number;
  timeoutMs: number;
  fail: (reason: string) => never;
}): string {
  let checked = 0;
  const result = walkCursorPages(
    { ...input, maxPages: MAX_PAGES, refuseAtDeadline: true },
    "Production is deployed, but the receipt evidence backfill",
    (cursor) => input.convex(["run", "receiptEvidenceBackfill:runPage", JSON.stringify({ cursor })]),
    (value) => {
      const page = parseCursorPage(value);
      if (!page || typeof value !== "object" || value === null || !("checkedCount" in value)) return null;
      const { checkedCount } = value;
      if (!isCount(checkedCount) || checkedCount > PAGE_SIZE) return null;
      if (page.isDone ? page.continueCursor !== null : checkedCount !== PAGE_SIZE) return null;
      return { ...page, checkedCount };
    },
    (page) => { checked += page.checkedCount; },
  );
  if (!result.ok) return input.fail(result.reason);
  return `${checked} existing receipt references indexed.`;
}
