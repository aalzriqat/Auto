/**
 * SCRUM-629 F-27 (ruling c21924): a reserved car stays quotable, and the picker
 * says what the server will refuse next instead of letting the operator find out
 * at the deposit.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import VehiclePicker from "./VehiclePicker";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => en[key] ?? key, language: "en", dir: "ltr" }),
}));
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ currency: "JOD" }),
}));

afterEach(cleanup);

const car = (status: string) => ({
  _id: "v1",
  year: 2024,
  make: "Kia",
  model: "EV3",
  vin: "KNAV1234567890123",
  color: "White",
  sellingPrice: 12_500,
  status,
});

describe("VehiclePicker reserved-car note", () => {
  test("a selected reserved car names what a deposit or finance application will meet", () => {
    render(<VehiclePicker vehicles={[car("RESERVED")]} value="v1" onChange={() => {}} />);
    const note = screen.getByTestId("vehicle-picker-reserved-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe(en.ReservedQuoteWarning);
    expect(note.textContent).toMatch(/deposit or finance application will be refused/);
  });

  test("an available car carries no note", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} value="v1" onChange={() => {}} />);
    expect(screen.queryByTestId("vehicle-picker-reserved-note")).toBeNull();
  });

  test("the note exists in Arabic and is not the English", () => {
    expect(ar.ReservedQuoteWarning).toBeTruthy();
    expect(ar.ReservedQuoteWarning).not.toBe(en.ReservedQuoteWarning);
  });
});
