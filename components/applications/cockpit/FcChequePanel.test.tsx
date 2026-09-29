/**
 * SCRUM-447 D6 — the finance-company cheque actions on a deal.
 * The panel hides what a caller can never do and never invents a state: the
 * flags come from the server, the panel only chooses what to offer.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { FcChequePanel, type FcChequePanelProps } from "./FcChequePanel";

afterEach(cleanup);

function panel(overrides: Partial<FcChequePanelProps> = {}) {
  const props: FcChequePanelProps = {
    canManage: true,
    canRegisterPayment: false,
    needsCorrection: false,
    chequeFaceAttested: false,
    chequeFaceUnrecorded: false,
    unattestedChequeId: null,
    expectedPaymentCorrectable: false,
    chequePaymentRegistered: false,
    needsReRegistration: false,
    t: (key: string) => key,
    onAttest: vi.fn(async () => {}),
    onCorrect: vi.fn(async () => {}),
    onRegister: vi.fn(),
    ...overrides,
  };
  render(<FcChequePanel {...props} />);
  return props;
}

describe("FcChequePanel", () => {
  test("renders nothing when there is no cheque concern", () => {
    panel();
    expect(screen.queryByTestId("deal-fc-cheque-panel")).toBeNull();
  });

  test("an unrecorded face is announced to everyone but only a finance manager can attest it", () => {
    panel({ canManage: false, chequeFaceUnrecorded: true, unattestedChequeId: "c1" });
    expect(screen.getByText("FcChequeFaceUnrecordedNotice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "FcAttestChequeFace" })).toBeNull();
  });

  test("attest sends the typed face and refuses a non-decimal one", async () => {
    const props = panel({ chequeFaceUnrecorded: true, unattestedChequeId: "c1" });
    fireEvent.click(screen.getByRole("button", { name: "FcAttestChequeFace" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    const input = document.querySelector("#fc-face") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20,000" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "20000.5" } });
    // B4: a valid face alone is not enough — the operator must say why.
    expect(confirm.disabled).toBe(true);
    const note = document.querySelector("#fc-note") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(note, { target: { value: "Read off the printed instrument" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(props.onAttest).toHaveBeenCalledWith("20000.5", "Read off the printed instrument")
    );
  });

  test("B5: a raw Convex error never reaches the screen; an unknown throw shows the generic message; the dialog stays open", async () => {
    const raw = new Error(
      "[CONVEX M(applications:correctExpectedPayment)] [Request ID: abc] Server Error\nUncaught Error: Nope\n    at handler (../convex/applications.ts:3733:5)\n  Called by client"
    );
    const onCorrect = vi.fn(async () => {
      throw raw;
    });
    panel({ expectedPaymentCorrectable: true, chequePaymentRegistered: true, onCorrect });
    fireEvent.click(screen.getByRole("button", { name: "FcCorrectExpectedPayment" }));
    fireEvent.change(document.querySelector("#fc-reason") as HTMLTextAreaElement, { target: { value: "why" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Nope");
    expect(document.body.textContent).not.toContain("Request ID");
    expect(document.body.textContent).not.toContain("convex/applications.ts");
    expect(screen.getByRole("dialog")).toBeTruthy();

    onCorrect.mockImplementationOnce(async () => {
      throw { weird: true };
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("An unexpected error occurred"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("B5: the attest dialog also sanitises a raw error", async () => {
    const onAttest = vi.fn(async () => {
      throw new Error("[CONVEX M(x)] [Request ID: q] Server Error Uncaught Error: bad at ../convex/applications.ts:1:1");
    });
    panel({ chequeFaceUnrecorded: true, unattestedChequeId: "c1", onAttest });
    fireEvent.click(screen.getByRole("button", { name: "FcAttestChequeFace" }));
    fireEvent.change(document.querySelector("#fc-face") as HTMLInputElement, { target: { value: "5" } });
    fireEvent.change(document.querySelector("#fc-note") as HTMLTextAreaElement, { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("Request ID");
    expect(alert.textContent).not.toContain("convex/applications.ts");
  });

  test("B2: on a corrected CLOSED deal every visible action is one the server accepts", () => {
    // The server accepts register with REGISTER_EXPECTED_PAYMENT or MANAGE_FINANCE
    // on a CLOSED undisbursed deal, and correct/attest with MANAGE_FINANCE only.
    const registerName = { name: "RegisterExpectedPayment" };
    // OWNER: both.
    panel({ canManage: true, canRegisterPayment: true, needsReRegistration: true });
    expect(screen.getByRole("button", registerName)).toBeTruthy();
    expect(screen.queryByTestId("fc-reason-line")).toBeNull();
    cleanup();
    // ACCOUNTANT: MANAGE_FINANCE only — must still be able to register.
    panel({ canManage: true, canRegisterPayment: false, needsReRegistration: true });
    expect(screen.getByRole("button", registerName)).toBeTruthy();
    expect(screen.queryByTestId("fc-reason-line")).toBeNull();
    cleanup();
    // MANAGER: REGISTER_EXPECTED_PAYMENT only — registers, never corrects.
    panel({ canManage: false, canRegisterPayment: true, needsReRegistration: true });
    expect(screen.getByRole("button", registerName)).toBeTruthy();
    cleanup();
    panel({
      canManage: false,
      canRegisterPayment: true,
      needsCorrection: true,
      expectedPaymentCorrectable: true,
      chequePaymentRegistered: true,
    });
    expect(screen.queryByRole("button", { name: "FcCorrectExpectedPayment" })).toBeNull();
    expect(screen.getByTestId("fc-reason-line").textContent).toBe("FcNeedsFinanceCorrect");
    cleanup();
    // Neither permission: no action, and the line names who acts.
    panel({ canManage: false, canRegisterPayment: false, needsReRegistration: true });
    expect(screen.queryByRole("button", registerName)).toBeNull();
    expect(screen.getByTestId("fc-reason-line").textContent).toBe("FcNeedsRegisterPermission");
  });

  test("a returned cheque on an APPROVED deal offers Correct to a finance manager (never Register)", () => {
    panel({
      canManage: true,
      needsCorrection: true,
      expectedPaymentCorrectable: true,
      chequePaymentRegistered: true,
    });
    expect(screen.getByText("FcCorrectNeededNotice")).toBeTruthy();
    expect(screen.getByRole("button", { name: "FcCorrectExpectedPayment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPayment" })).toBeNull();
    expect(screen.queryByTestId("fc-reason-line")).toBeNull();
  });

  test("an attested face is labelled, and a viewer who cannot attest is told who does", () => {
    panel({ expectedPaymentCorrectable: true, chequePaymentRegistered: true, chequeFaceAttested: true });
    expect(screen.getByText("FcFaceAttestedBadge")).toBeTruthy();
    cleanup();
    panel({ canManage: false, chequeFaceUnrecorded: true, unattestedChequeId: "c1" });
    expect(screen.getByTestId("fc-reason-line").textContent).toBe("FcNeedsFinanceAttest");
  });

  test("correct needs a reason and shows the server refusal on the dialog", async () => {
    const onCorrect = vi.fn(async () => {
      throw new Error("A deposited cheque cannot be withdrawn.");
    });
    panel({ expectedPaymentCorrectable: true, chequePaymentRegistered: true, onCorrect });
    fireEvent.click(screen.getByRole("button", { name: "FcCorrectExpectedPayment" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(document.querySelector("#fc-reason") as HTMLTextAreaElement, {
      target: { value: "wrong bank" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(onCorrect).toHaveBeenCalledWith("wrong bank"));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be withdrawn");
  });

  test("a closed deal with nothing registered offers registration to a finance manager only", () => {
    const props = panel({ needsReRegistration: true });
    fireEvent.click(screen.getByRole("button", { name: "RegisterExpectedPayment" }));
    expect(props.onRegister).toHaveBeenCalledTimes(1);
    cleanup();
    panel({ canManage: false, needsReRegistration: true });
    expect(screen.getByText("FcReRegisterNotice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RegisterExpectedPayment" })).toBeNull();
  });
});
