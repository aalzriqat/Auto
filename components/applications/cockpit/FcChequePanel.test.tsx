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
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(props.onAttest).toHaveBeenCalledWith("20000.5"));
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
