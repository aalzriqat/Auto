import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchableSelect } from "./searchable-select";

afterEach(cleanup);

describe("SearchableSelect accessibility", () => {
  test("exposes an invalid selection as an invalid combobox", () => {
    render(
      <SearchableSelect
        value=""
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

  test("names the combobox from its displayed value and controls its open listbox", () => {
    const onValueChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={[{ value: "customer-1", label: "A customer" }]}
        placeholder="Select customer"
        onValueChange={onValueChange}
      />
    );

    const trigger = screen.getByRole("combobox", { name: "Select customer" });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).not.toBe("");
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const option = screen.getByRole("option", { name: "A customer" });
    expect(option.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("customer-1");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
