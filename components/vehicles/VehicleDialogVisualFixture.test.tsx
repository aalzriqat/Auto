/** SCRUM-939: reuse the offline Vitest markup bridge for the real create wizard. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      if (getFunctionName(reference) === "orgSettings:get") return { currency: "JOD" };
      return [];
    },
    useMutation: () => async () => { throw new Error("Offline navigation must not save"); },
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_fixture" }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/custom-fields/CustomFieldsSection", () => ({
  CustomFieldsSection: () => null,
  useSaveCustomFieldValues: () => async () => undefined,
}));

import { VehicleDialog } from "./VehicleDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["en", "ar"] as const)("SCRUM-939 create wizard markup %s", async locale => {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => undefined });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const t = dictionaries[locale];
  render(<LanguageProvider><VehicleDialog open onOpenChange={() => undefined} canCreate /></LanguageProvider>);
  fireEvent.change(screen.getByLabelText(t.Make), { target: { value: "Toyota" } });
  fireEvent.change(screen.getByLabelText(t.Model), { target: { value: "Synthetic" } });
  fireEvent.change(screen.getByLabelText(t.Color), { target: { value: "Black" } });
  fireEvent.click(screen.getByRole("button", { name: t.VehicleOwnershipOwned }));
  for (const step of [2, 3, 4, 5]) {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: t.WizardContinue })); });
    if (step < 4) continue;
    const label = step === 4 ? t.Photos : t.VehicleWizardAvailability;
    expect(screen.getByText(label, { selector: "p" })).toBeTruthy();
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    const directory = process.env.SCRUM939_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, `vehicle-${locale}-step${step}.html`), document.body.innerHTML);
    }
  }
});
