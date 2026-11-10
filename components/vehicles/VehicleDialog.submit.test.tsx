/** SCRUM-939: navigation must never become the vehicle's final confirmation. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const mutations = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: () => ({ locked: false }),
    useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(reference);
      if (!mutations.has(name)) mutations.set(name, vi.fn(async () => undefined));
      return mutations.get(name)!;
    },
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/custom-fields/CustomFieldsSection", () => ({
  CustomFieldsSection: () => null,
  useSaveCustomFieldValues: () => async () => undefined,
}));

import { VehicleDialog } from "./VehicleDialog";

vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

beforeEach(() => {
  mutations.clear();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fillCreate() {
  fireEvent.change(screen.getByLabelText("Make"), { target: { value: "Toyota" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Synthetic" } });
  fireEvent.change(screen.getByLabelText("Color"), { target: { value: "Black" } });
  fireEvent.click(screen.getByRole("button", { name: "VehicleOwnershipOwned" }));
}

async function continueTo(step: string) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "WizardContinue" })); });
  expect(screen.getByText(step, { selector: "p" })).toBeTruthy();
}

describe("SCRUM-939 vehicle wizard confirmation", () => {
  test("Photos Continue and Availability submit are different DOM nodes", async () => {
    render(<VehicleDialog open onOpenChange={() => undefined} canCreate />);
    fillCreate();
    await continueTo("VehicleWizardDetails");
    await continueTo("VehicleWizardAcquisitionCost");
    await continueTo("Photos");
    const navigation = screen.getByRole("button", { name: "WizardContinue" });
    await continueTo("VehicleWizardAvailability");
    const confirmation = screen.getByRole("button", { name: "AddVehicle" });
    expect(confirmation).not.toBe(navigation);
    expect(navigation.isConnected).toBe(false);
    expect(confirmation.getAttribute("type")).toBe("submit");
    expect(mutations.get("vehicles:create")).not.toHaveBeenCalled();
  });

  test.each([true, false])("early form submit cannot save (canCreate: %s), final confirmation can", async (canCreate) => {
    const close = vi.fn();
    render(<VehicleDialog open onOpenChange={close} canCreate={canCreate} />);
    fillCreate();
    const form = screen.getByRole("dialog").querySelector("form");
    if (!form) throw new Error("Vehicle form missing");
    // Fully valid values ensure schema validation cannot hide an absent step guard.
    await act(async () => { fireEvent.submit(form); });
    expect(mutations.get("vehicles:create")).not.toHaveBeenCalled();
    expect(mutations.get("vehicleEdits:requestCreate")).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await continueTo("VehicleWizardDetails");
    await continueTo("VehicleWizardAcquisitionCost");
    await continueTo("Photos");
    await continueTo("VehicleWizardAvailability");
    fireEvent.click(screen.getByRole("button", { name: canCreate ? "AddVehicle" : "SubmitForApproval" }));
    await waitFor(() => expect(mutations.get(canCreate ? "vehicles:create" : "vehicleEdits:requestCreate")).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledWith(false);
  });

  test("edit mode still saves through its submit button", async () => {
    const vehicle: Doc<"vehicles"> = {
      _id: "vehicle_1" as Id<"vehicles">, _creationTime: 1, orgId: "org_1" as Id<"organizations">,
      make: "Toyota", model: "Synthetic", year: 2024, mileage: 100,
      color: "Black", fuelType: "Gasoline", transmission: "Automatic",
      sourceType: "STOCK", status: "AVAILABLE", purchasePrice: 0, sellingPrice: 100,
    };
    render(<VehicleDialog open onOpenChange={() => undefined} vehicle={vehicle} canEdit />);
    const submit = screen.getByRole("button", { name: "SaveChanges" });
    expect(submit.getAttribute("type")).toBe("submit");
    fireEvent.click(submit);
    await waitFor(() => expect(mutations.get("vehicles:update")).toHaveBeenCalledTimes(1));
  });
});
