import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const useQueryMock = vi.fn();
vi.mock("convex/react", () => ({ useQuery: () => useQueryMock(), useMutation: () => vi.fn() }));
import { DealCommissionLinesDialog } from "./DealCommissionLinesDialog";

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("lang");
  document.body.classList.remove("font-cairo", "font-inter");
});
test.each(["UNAVAILABLE", "SERVED"] as const)("commission dialog handles %s line evidence truthfully", (lineEvidence) => {
  useQueryMock.mockReturnValue({
    lineEvidence, currency: "JOD", totalMinor: null, saleStatus: "COMPLETED", canManage: true,
    writesEnabled: true, salesperson: { employeeName: "Synthetic employee", amountMinor: null }, lines: [],
  });
  render(<LanguageProvider><DealCommissionLinesDialog orgId={"org" as Id<"organizations">} saleId={"sale" as Id<"sales">}
    members={[]} money={String} t={(key) => key} onOpenChange={() => {}} /></LanguageProvider>);
  if (lineEvidence === "UNAVAILABLE") {
    expect(screen.getByRole("alert").textContent).toBe("DealCommissionsUnreadable");
    expect(screen.queryByRole("button", { name: "DealCommissionLinesSave" })).toBeNull();
  } else {
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "DealCommissionLinesSave" })).toBeTruthy();
  }
});
