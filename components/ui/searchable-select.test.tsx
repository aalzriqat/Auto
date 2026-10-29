import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchableSelect } from "./searchable-select";

afterEach(cleanup);

describe("SearchableSelect accessibility", () => {
  test("exposes an invalid selection as an invalid combobox", () => {
    render(
      <SearchableSelect
        options={[]}
        onValueChange={vi.fn()}
        ariaLabel="Customer"
        invalid
        dataTestId="customer-select"
      />
    );

    const trigger = screen.getByRole("combobox", { name: "Customer" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("customer-select")).toBe(trigger);
  });
});
