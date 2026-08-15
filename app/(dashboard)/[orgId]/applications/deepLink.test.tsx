/**
 * The `?application=` deep link into the finance-application dialog.
 *
 * This is the door Accounting's finance-company AR queue sends the accountant
 * to, and the dialog behind it owns `confirmDisbursement` — the mutation that
 * settles finance-company AR. The link exists because the queue reports that
 * money but deliberately cannot settle it (SCRUM-51).
 *
 * Two failures shipped and were caught in review rather than here, which is why
 * this file exists: a raw URL parameter reaching a `v.id()` query argument threw
 * an argument-validation error into the React tree and took the page down, and
 * navigating the parameter away left the previous deal on screen. Both are
 * URL-shaped, so neither is reachable from a test that only clicks rows.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  searchParam: null as string | null,
  /** What the server resolver returns: an id, null (unresolvable), or undefined (loading). */
  resolved: undefined as string | null | undefined,
  dialogRenders: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(stubs.searchParam ? `application=${stubs.searchParam}` : ""),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useQuery: () => stubs.resolved,
}));

// The dialog itself is exercised by its own tests; here it stands in as a
// recorder so the assertions are about WHICH id reaches it, and whether it is
// mounted at all.
vi.mock("@/components/applications/ApplicationDetailsDialog", () => ({
  ApplicationDetailsDialog: ({ applicationId, open }: { applicationId: string; open: boolean }) => {
    stubs.dialogRenders.push(String(applicationId));
    return open ? <div data-testid="app-dialog">{String(applicationId)}</div> : null;
  },
}));

import { ApplicationClient } from "./client";

beforeEach(() => {
  cleanup();
  stubs.searchParam = null;
  stubs.resolved = undefined;
  stubs.dialogRenders = [];
});

describe("?application= deep link", () => {
  test("a malformed id opens nothing and does not crash", () => {
    stubs.searchParam = "garbage";
    // The server resolver normalizes and returns null rather than the page
    // handing "garbage" to a v.id() argument.
    stubs.resolved = null;

    expect(() => render(<ApplicationClient />)).not.toThrow();
    expect(screen.queryByTestId("app-dialog")).toBeNull();
    expect(stubs.dialogRenders).toEqual([]);
  });

  test("a resolved id opens the dialog with the resolved id, never the raw parameter", () => {
    stubs.searchParam = "whatever-the-url-said";
    stubs.resolved = "app_real_id";

    render(<ApplicationClient />);

    expect(screen.getByTestId("app-dialog").textContent).toBe("app_real_id");
    expect(stubs.dialogRenders).not.toContain("whatever-the-url-said");
  });

  test("nothing opens while the resolver is still loading", () => {
    stubs.searchParam = "app_real_id";
    stubs.resolved = undefined;

    render(<ApplicationClient />);

    expect(screen.queryByTestId("app-dialog")).toBeNull();
  });

  test("no parameter leaves the dialog closed and the row-click path alone", () => {
    stubs.searchParam = null;
    stubs.resolved = undefined;

    render(<ApplicationClient />);

    expect(screen.queryByTestId("app-dialog")).toBeNull();
  });
});
