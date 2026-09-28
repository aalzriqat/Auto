/**
 * SCRUM-417 / CodeRabbit on #355: the Upload control on the documents step must
 * be reachable and operable from the keyboard. It was a `<label>` rendered via
 * `Button asChild` over a `display:none` input — not in the tab order, not
 * activated by Enter/Space, and `disabled` meant nothing on a label.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DealDocumentsPanel, type DealDocument } from "./DealDocumentsPanel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

const t = (key: string) => key;

afterEach(cleanup);

function renderPanel(documents: DealDocument[], uploadingRuleIds: ReadonlySet<string> = new Set()) {
  return render(
    <DealDocumentsPanel
      documents={documents}
      checklist={[]}
      canUpload
      canVerify={false}
      uploadingRuleIds={uploadingRuleIds}
      t={t}
      onUpload={vi.fn()}
      onVerify={vi.fn()}
    />,
  );
}

const missing: DealDocument = { _id: "doc_1", ruleId: "rule_1", ruleName: "ID card", status: "MISSING", fileUrl: null };

describe("document upload control is a real, keyboard-operable button", () => {
  test("Upload is a focusable button that opens the hidden file picker", () => {
    renderPanel([missing]);
    const button = screen.getByRole("button", { name: "Upload" });
    // A native, tab-order button: the browser gives it Enter/Space activation.
    // (Sol T-1: `.focus()` alone would also pass with tabIndex={-1}.)
    expect(button.tagName).toBe("BUTTON");
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);

    const input = screen.getByTestId("deal-document-doc_1").querySelector('input[type="file"]') as HTMLInputElement;
    const openPicker = vi.spyOn(input, "click");
    fireEvent.click(button);
    expect(openPicker).toHaveBeenCalledTimes(1);
  });

  test("while its upload is in flight the button itself is disabled, not only the input", () => {
    renderPanel([missing], new Set(["rule_1"]));
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
