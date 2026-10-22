/**
 * SCRUM-831 Gate B bridge: renders the MOUNTED Approvals page to markup for the
 * static visual gate (`playwright/visual/refund-approval-queue.visual.spec.ts`).
 *
 * Real page, real `RetainedCreditRefundApprovalQueue`, real dictionaries, and the
 * permission sets of the SHIPPED default MANAGER and ACCOUNTANT templates; only
 * Convex, Clerk and the provider shells are stubbed.
 *
 * Gated on `REFUND_APPROVAL_VISUAL_FIXTURE=1`; writes only into the per-run
 * directory named by `REFUND_APPROVAL_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: new Set<string>(),
  queryResults: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[stubs.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", format: (n: number) => `${n} JOD` }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: (p: string) => stubs.permissions.has(p) }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "memberships:getMyMembership") return { permissions: [...stubs.permissions], isSystemOwnerRole: false };
      const value = stubs.queryResults.get(name);
      if (typeof value === "function") return (value as () => unknown)();
      return value;
    },
    usePaginatedQuery: (reference: never, args: unknown) => {
      const loading = { results: [], status: "LoadingFirstPage", loadMore: () => undefined };
      if (args === "skip") return loading;
      const value = stubs.queryResults.get(getFunctionName(reference));
      if (typeof value === "function") return (value as () => unknown)();
      return value ?? loading;
    },
    useMutation: () => async () => null,
  };
});

import ApprovalsPage from "@/app/(dashboard)/[orgId]/approvals/page";

const ENABLED = process.env.REFUND_APPROVAL_VISUAL_FIXTURE === "1";
const DIR = process.env.REFUND_APPROVAL_VISUAL_FIXTURE_DIR ?? "";
const QUEUE = "retainedCreditRefunds:listRetainedCreditRefundApprovalQueue";

const permissionsOf = (role: string): Set<string> =>
  new Set(DEFAULT_ROLE_TEMPLATES.find((template) => template.name === role)!.permissions);

const request = (over: Record<string, unknown>) => ({
  _id: "r1", amountMinor: 1_250_000, currency: "JOD", method: "BANK_TRANSFER",
  reason: "Customer withdrew from the purchase and asked for the cheque amount back.",
  createdAt: Date.UTC(2026, 9, 12), requestedByMe: false, requestedByName: "Dana Haddad",
  customerName: "Layla Haddad", sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED",
  ...over,
});
/** The paginated hook's result shape; the server stamps `payoutAvailable` on every row. */
const paged = (
  rows: ReadonlyArray<Record<string, unknown>>,
  payoutAvailable: boolean,
  status: "Exhausted" | "CanLoadMore" | "LoadingMore" = "Exhausted",
) => ({
  results: rows.map((row) => ({ ...row, payoutAvailable })),
  status,
  loadMore: () => undefined,
});
const ROWS = [
  request({}),
  request({
    _id: "r2", amountMinor: 300_000, customerName: "Omar Nasser", method: "CASH", requestedByMe: true,
    requestedByName: "Sam Khoury", reason: "Duplicate receipt.", sourceChequeLabel: undefined,
    originatingSaleStatus: undefined,
  }),
];

function write(name: string): void {
  writeFileSync(resolve(DIR, `${name}-${stubs.locale}.html`), document.body.innerHTML);
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
});

describe.skipIf(!ENABLED)("refund approval queue visual fixtures (SCRUM-831)", () => {
  test.each(["en", "ar"] as const)("%s", (locale) => {
    stubs.locale = locale;
    mkdirSync(DIR, { recursive: true });
    const shot = (name: string) => { write(name); cleanup(); };

    // The pilot: payout reported dark. Approve is shown disabled beside its reason.
    stubs.permissions = permissionsOf("MANAGER");
    expect(stubs.permissions.has("view:finance")).toBe(false);
    stubs.queryResults.set("approvals:listPendingApprovals", []);
    stubs.queryResults.set(QUEUE, paged(ROWS, false));
    render(<ApprovalsPage />);
    expect(screen.getByTestId("refund-approval-paused")).toBeTruthy();
    shot("manager-pilot");

    // Payout open: approve and reject both live; the requester's own row offers neither.
    stubs.queryResults.set(QUEUE, paged(ROWS, true));
    render(<ApprovalsPage />);
    shot("manager-open");

    // A queue longer than one page: Load more offered, then busy while the next page loads.
    stubs.queryResults.set(QUEUE, paged(ROWS, true, "CanLoadMore"));
    render(<ApprovalsPage />);
    shot("manager-more");

    stubs.queryResults.set(QUEUE, paged(ROWS, true, "LoadingMore"));
    render(<ApprovalsPage />);
    shot("manager-loading-more");

    stubs.queryResults.set(QUEUE, paged([], true));
    render(<ApprovalsPage />);
    shot("manager-empty");

    stubs.queryResults.delete(QUEUE);
    render(<ApprovalsPage />);
    expect(screen.getByTestId("refund-approval-loading")).toBeTruthy();
    shot("manager-loading");

    stubs.queryResults.set(QUEUE, () => { throw new Error("backend refused (server English)"); });
    const original = console.error;
    console.error = () => undefined;
    try {
      render(<ApprovalsPage />);
    } finally {
      console.error = original;
    }
    shot("manager-failed");

    // The default ACCOUNTANT holds no approve:requests: the queue is not offered at all.
    stubs.permissions = permissionsOf("ACCOUNTANT");
    stubs.queryResults.set(QUEUE, paged(ROWS, true));
    render(<ApprovalsPage />);
    expect(screen.queryByTestId("refund-approval-queue")).toBeNull();
    shot("accountant");
  });
});
