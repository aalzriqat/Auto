import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { CancelApplicationDialog, type CancelApplicationValues } from "./CancelApplicationDialog";

afterEach(cleanup);

const t = (key: string) => key;

describe("CancelApplicationDialog", () => {
  test("renders failure reason and appraisal fee responsibility fields and passes values on submit", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CancelApplicationDialog
        open={true}
        submitting={false}
        error={null}
        isClosed={false}
        t={t}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />
    );

    // Assert that the FailureReasonLabel is present
    expect(screen.getByText("FailureReasonLabel")).toBeDefined();
    expect(screen.getByText("AppraisalFeeResponsibilityLabel")).toBeDefined();

    // Fill in reason
    const reasonInput = screen.getByLabelText("CancellationReasonLabel");
    fireEvent.change(reasonInput, { target: { value: "Customer decided not to proceed" } });

    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: "CancelApplication" }));

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0][0] as CancelApplicationValues;
    expect(submitted.reason).toBe("Customer decided not to proceed");
  });
});
