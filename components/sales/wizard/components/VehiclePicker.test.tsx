/**
 * SCRUM-636 (ruling c22077): the picker's hold badge is the server's advisory
 * verdict, never vehicle.status. A car the verdict does not cover reads
 * UNCERTAIN, never FREE (N1). Both badges are neutral and selection stays
 * enabled (F.39). A held car keeps the SCRUM-629 F-27 note naming what the
 * server will refuse next.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import VehiclePicker from "./VehiclePicker";
import type { PickerAvailability } from "../hooks/usePickerAvailability";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => en[key] ?? key, language: "en", dir: "ltr" }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ currency: "JOD", format: (n: number) => `${n} JOD`, formatCurrency: (n: number) => `${n} JOD` }),
}));

afterEach(cleanup);

const car = (status: string, id = "v1") => ({
  _id: id,
  year: 2024,
  make: "Kia",
  model: "EV3",
  vin: "KNAV1234567890123",
  color: "White",
  sellingPrice: 12_500,
  status,
});

const verdicts = (entries: Record<string, PickerAvailability>) => new Map(Object.entries(entries));

const badge = () => screen.queryByTestId("vehicle-picker-availability-badge");
const note = () => screen.queryByTestId("vehicle-picker-availability-note");

describe("VehiclePicker availability badge (selected car)", () => {
  test("HELD shows the neutral held badge and the F-27 refusal note", () => {
    render(<VehiclePicker vehicles={[car("RESERVED")]} availability={verdicts({ v1: "HELD" })} value="v1" onChange={() => {}} />);
    expect(badge()?.textContent).toBe("Held for a deal");
    expect(badge()?.getAttribute("data-availability")).toBe("HELD");
    expect(note()?.getAttribute("role")).toBe("status");
    expect(note()?.textContent).toBe(en.ReservedQuoteWarning);
  });

  test("FREE shows no badge and no note", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} availability={verdicts({ v1: "FREE" })} value="v1" onChange={() => {}} />);
    expect(badge()).toBeNull();
    expect(note()).toBeNull();
  });

  test("UNCERTAIN shows the unverified badge and the completion note", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} availability={verdicts({ v1: "UNCERTAIN" })} value="v1" onChange={() => {}} />);
    expect(badge()?.textContent).toBe("Availability unverified");
    expect(note()?.textContent).toBe("You can quote this car; availability is checked when the sale completes.");
  });

  // DA-8: these two are green under a status-driven badge only if the badge ignores the server.
  test("a RESERVED status the server calls FREE shows no badge (root ≠ status)", () => {
    render(<VehiclePicker vehicles={[car("RESERVED")]} availability={verdicts({ v1: "FREE" })} value="v1" onChange={() => {}} />);
    expect(badge()).toBeNull();
    expect(note()).toBeNull();
  });

  test("an AVAILABLE car the server calls HELD (finance-only hold) shows held", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} availability={verdicts({ v1: "HELD" })} value="v1" onChange={() => {}} />);
    expect(badge()?.getAttribute("data-availability")).toBe("HELD");
  });

  // N1: no verdict is never FREE.
  test("with no verdict map at all the car reads UNCERTAIN", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} value="v1" onChange={() => {}} />);
    expect(badge()?.getAttribute("data-availability")).toBe("UNCERTAIN");
  });

  test("a car missing from the verdict map reads UNCERTAIN", () => {
    render(<VehiclePicker vehicles={[car("AVAILABLE")]} availability={verdicts({ other: "FREE" })} value="v1" onChange={() => {}} />);
    expect(badge()?.getAttribute("data-availability")).toBe("UNCERTAIN");
  });
});

describe("VehiclePicker availability badge (list)", () => {
  test("each row carries its own verdict and a held car stays selectable", () => {
    const onChange = vi.fn();
    render(
      <VehiclePicker
        vehicles={[car("AVAILABLE", "a"), car("AVAILABLE", "b"), car("RESERVED", "c")]}
        availability={verdicts({ a: "HELD", b: "FREE", c: "UNCERTAIN" })}
        value=""
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Select an available vehicle/ }));
    const rows = screen.getAllByTestId("vehicle-picker-availability-badge").map((el) => el.getAttribute("data-availability"));
    expect(rows).toEqual(["HELD", "UNCERTAIN"]);
    fireEvent.click(screen.getByText("Held for a deal").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("a", 12_500);
  });
});

describe("VehiclePicker availability copy (ruling c22077)", () => {
  test("English and Arabic carry the ruled strings", () => {
    expect(en.PickerHeldForDeal).toBe("Held for a deal");
    expect(en.PickerAvailabilityUnverified).toBe("Availability unverified");
    expect(ar.PickerHeldForDeal).toBe("محجوزة لصفقة");
    expect(ar.PickerAvailabilityUnverified).toBe("تعذّر التحقق من إتاحتها");
    expect(ar.PickerAvailabilityNote).toBe("يمكنك إعداد عرض سعر لهذه السيارة؛ تُتحقّق إتاحتها عند إتمام البيع.");
    expect(ar.ReservedQuoteWarning).toBeTruthy();
    expect(ar.ReservedQuoteWarning).not.toBe(en.ReservedQuoteWarning);
  });
});
