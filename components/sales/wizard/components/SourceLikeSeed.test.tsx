/**
 * SCRUM-746: the closest jsdom proxy for "source another like this" — with the
 * seed, BOTH pickers open the source form pre-filled with make/model/year. The
 * rendered click-through (dialog -> gateway -> wizard) is recorded UNVERIFIED.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import VehiclePicker from "./VehiclePicker";
import { VehicleLineItemsPicker } from "./VehicleLineItemsPicker";

const en = dictionaries.en as Record<string, string>;

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => en[key] ?? key, language: "en", dir: "ltr", isRtl: false }),
}));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ currency: "JOD" }) }));

afterEach(cleanup);

const SEED = { make: "Kia", model: "K5", year: 2022, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC" };

function expectSeededForm() {
  expect(screen.getByDisplayValue("Kia")).toBeTruthy();
  expect(screen.getByDisplayValue("K5")).toBeTruthy();
  expect(screen.getByDisplayValue("2022")).toBeTruthy();
}

describe("SCRUM-746: the seeded source form opens on both payment types", () => {
  test("installment (single picker)", () => {
    render(<VehiclePicker vehicles={[]} value="" onChange={() => {}} onSourceVehicle={async () => "v"} initialSourceData={SEED} />);
    expectSeededForm();
  });

  test("cash (line-items picker, first row)", () => {
    render(
      <VehicleLineItemsPicker
        vehicles={[]}
        items={[{ vehicleId: "", unitPrice: 0 }]}
        onChange={() => {}}
        onSourceVehicle={async () => "v"}
        initialSourceData={SEED}
      />
    );
    expectSeededForm();
  });

  test("control: without the seed the form stays closed", () => {
    render(<VehicleLineItemsPicker vehicles={[]} items={[{ vehicleId: "", unitPrice: 0 }]} onChange={() => {}} onSourceVehicle={async () => "v"} />);
    expect(screen.queryByDisplayValue("Kia")).toBeNull();
  });
});
