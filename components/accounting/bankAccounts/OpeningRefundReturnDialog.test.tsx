// @vitest-environment jsdom
// NON-PILOT-CERTIFYING: retained post-pilot bank-return retry coverage (SCRUM-956 c25206).
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { OpeningRefundReturnDialog } from "./OpeningRefundReturnDialog";

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/convex/utils/pilotSwitches", async importOriginal => ({
  ...await importOriginal<typeof import("@/convex/utils/pilotSwitches")>(),
  OPENING_REFUND_BANK_PILOT_DISABLED: false,
}));
vi.mock("convex/react", () => ({ useMutation: () => record }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(() => {
  cleanup();
  record.mockReset();
});

test("posts both bank references and retries the same statement command after an ambiguous failure", async () => {
  record.mockRejectedValueOnce(new Error("No response")).mockResolvedValueOnce({ journalEntryId: "posted" });
  const onClose = vi.fn();
  render(<OpeningRefundReturnDialog
    orgId={"dealer" as Id<"organizations">}
    line={{ id: "statement" as Id<"bankStatementLines">, description: "Bank credit", amountLabel: "JOD 1.250" }}
    onClose={onClose}
  />);
  expect(screen.getByText("JOD 1.250")).toBeTruthy();
  const submit = screen.getByRole("button", { name: "OpeningRefundRecordBankReturn" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("OpeningRefundOriginalTransferReference"), { target: { value: "PAY-102" } });
  fireEvent.change(screen.getByLabelText("OpeningRefundBankReturnReference"), { target: { value: "RET-301" } });
  fireEvent.change(screen.getByLabelText("OpeningRefundIndependentEvidenceReference"), { target: { value: "BANK-FILE-1" } });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText("OpeningRefundIndependentEvidenceConfirmed"));
  fireEvent.click(submit);
  expect((await screen.findByRole("alert")).textContent).toBe("OpeningRefundBankReturnFailed");
  fireEvent.click(submit);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(record).toHaveBeenCalledTimes(2);
  const [first] = record.mock.calls[0];
  expect(first).toMatchObject({
    orgId: "dealer", statementLineId: "statement", originalRefundReference: "PAY-102", bankReturnReference: "RET-301",
    bankEvidenceReference: "BANK-FILE-1", confirmedIndependentBankEvidence: true, idempotencyKey: expect.any(String),
  });
  expect(record.mock.calls[1][0]).toEqual(first);
});
