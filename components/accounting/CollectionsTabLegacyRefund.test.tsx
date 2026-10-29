/**
 * SCRUM-760 ruling 11: the legacy collection REFUND request and approval are blocked SERVER-SIDE
 * (convex/utils/legacyCollectionRefundContainment.ts). The Collections screen must not offer them
 * and must say why, in English and Arabic; REJECTING a pending refund request stays offered, and the
 * other approval types are untouched. The server refusal remains the guarantee, not this screen.
 *
 * Not asserted here: RTL layout direction (the component reads no RTL flag; this pins the text).
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { commonAr } from "@/lib/i18n/domains/common";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  paginated: new Map<string, unknown[]>(),
  t: (key: string): string => key,
}));

// The block is a live handle: the shipped state is ON, the OFF state proves the screen follows the switch.
const pilot = vi.hoisted(() => ({ legacyCollectionRefund: true }));
vi.mock("@/convex/utils/legacyCollectionRefundContainment", async (importOriginal) =>
  (await import("@/test-utils/legacyCollectionRefundSwitches")).withLegacyCollectionRefundSwitch(await importOriginal(), pilot));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => stubs.t(key), isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("@/hooks/useCurrencyFormatter", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useCurrencyFormatter")>(),
  useCurrencyFormatter: () => (n: number) => `${n} JOD`,
}));
vi.mock("@/hooks/useCommandIdentity", () => ({ useCommandIdentity: () => ({ for: (i: string) => i, retire: () => {} }) }));
vi.mock("@/components/accounting/collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("@/components/accounting/collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("@/components/accounting/collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));
vi.mock("@/components/accounting/RetainedCreditRefundsSection", () => ({ RetainedCreditRefundsSection: () => null }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: (reference: never) => ({
      results: stubs.paginated.get(getFunctionName(reference)) ?? [],
      status: "Exhausted",
      loadMore: () => {},
    }),
    useMutation: () => vi.fn(),
  };
});

import { CollectionsTab } from "./CollectionsTab";

const KEY = "ServerError_LEGACY_COLLECTION_REFUND_PILOT_DISABLED";
const ENGLISH =
  "Recording a refund against a collection receivable is not available during the pilot. You can still reject a pending refund request. Nothing has been changed.";
// Hard-coded literal (copied from lib/i18n/domains/common.ts) so a missing or key-valued AR entry cannot pass.
const ARABIC =
  "تسجيل استرداد على مستحقات التحصيل غير متاح خلال المرحلة التجريبية. يمكنك رفض أي طلب استرداد معلّق. لم يتم تغيير أي شيء.";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  pilot.legacyCollectionRefund = true;
  cleanup();
  stubs.queryResults.clear();
  stubs.paginated.clear();
  stubs.t = (key: string) => key;
});

const receivable = {
  _id: "r1", _creationTime: 0, orgId: "org1", customerName: "Layla Haddad", title: "Reservation",
  sourceType: "RESERVATION_PAYMENT", status: "PARTIALLY_PAID", originalAmount: 1000, outstandingAmount: 600,
  dueDate: Date.UTC(2026, 9, 12),
} as unknown as Doc<"receivables">;

const approval = (requestType: string) => ({
  _id: `a-${requestType}`, requestType, customerName: "Layla Haddad", receivableTitle: "Reservation",
  requestedByName: requestType === "REFUND" ? "Refund requester" : "Reschedule requester", requestedAmount: requestType === "REFUND" ? 200 : undefined,
  disbursementMethod: requestType === "REFUND" ? "CASH" : undefined,
});

function mount() {
  stubs.queryResults.set("collections:summary", {
    totalOutstanding: 0, overdueOutstanding: 0, dueToday: 0, collectedToday: 0, upcomingChequeTotal: 0,
  });
  stubs.paginated.set("collections:listReceivables", [receivable]);
  stubs.queryResults.set("collections:listApprovals", [approval("REFUND"), approval("RESCHEDULE")]);
  render(<CollectionsTab />);
}

function openApprovals() {
  const tab = screen.getByRole("tab", { name: "Approvals" });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.focus(tab);
}

describe("Collections: legacy refund is blocked for the pilot", () => {
  test("the Refund action is disabled and the notice says why (English)", () => {
    stubs.t = (key: string) => (key === KEY ? ENGLISH : key);
    mount();
    const refund = screen.getByRole("button", { name: ENGLISH }) as HTMLButtonElement;
    expect(refund.disabled).toBe(true);
    expect(screen.getByTestId("collection-refund-pilot-notice").textContent).toBe(ENGLISH);
  });

  test("the notice and the Refund label render the Arabic text, not the key", () => {
    stubs.t = (key: string) => (key === KEY ? (commonAr as Record<string, string>)[key] ?? key : key);
    mount();
    expect((commonAr as Record<string, string>)[KEY]).toBe(ARABIC);
    expect(screen.getByTestId("collection-refund-pilot-notice").textContent).toBe(ARABIC);
    expect((screen.getByRole("button", { name: ARABIC }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a pending REFUND request cannot be approved but can be rejected; a RESCHEDULE request is untouched", () => {
    mount();
    openApprovals();
    const rows = screen.getAllByRole("row");
    const refundRow = rows.find((r) => r.textContent?.includes("Refund requester"));
    expect(refundRow).toBeTruthy();
    const buttons = (row: HTMLElement) => ({
      approve: Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Approve") as HTMLButtonElement,
      reject: Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Reject") as HTMLButtonElement,
    });
    const refund = buttons(refundRow as HTMLElement);
    expect(refund.approve.disabled).toBe(true);
    expect(refund.reject.disabled).toBe(false);
    expect(screen.getByTestId("collection-refund-pilot-disabled").textContent).toBe(KEY);
    const rescheduleRow = rows.find((r) => r.textContent?.includes("Reschedule requester"));
    expect(rescheduleRow).toBeTruthy();
    expect(buttons(rescheduleRow as HTMLElement).approve.disabled).toBe(false);
  });

  test("CONTROL: with the switch off the screen offers Refund and Approve again", () => {
    pilot.legacyCollectionRefund = false;
    mount();
    expect((screen.getByRole("button", { name: "Refund" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("collection-refund-pilot-notice")).toBeNull();
    openApprovals();
    expect(screen.queryByTestId("collection-refund-pilot-disabled")).toBeNull();
  });
});
