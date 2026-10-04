/**
 * SCRUM-641 R2-F1: a financed quote on a soft-deleted car must say why Next is disabled.
 * The translator is the REAL dictionary for the locale, so the assertions are on the shipped EN/AR wording.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";

const ORG = "org_1" as Id<"organizations">;
const VEHICLE = "vehicle_1" as Id<"vehicles">;

const EN_DELETED = "This vehicle has been deleted and can no longer be quoted, reserved, sold or take a deposit.";
const AR_DELETED = "تم حذف هذه السيارة ولم يعد بالإمكان تسعيرها أو حجزها أو بيعها أو استلام عربون عليها.";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  verdict: undefined as unknown,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: ORG }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "USD",
    symbol: "$",
    displayLabel: "USD",
    format: (n: number) => `${n}`,
    formatCompact: (n: number) => `${n}`,
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "approvals:profitApprovalStatus") return stubs.verdict;
      if (name === "vehicles:listAll") return [];
      return null;
    },
    useMutation: () => async () => null,
  };
});
vi.mock("../components/VehiclePicker", () => ({ default: () => null }));
vi.mock("../components/VehicleLineItemsPicker", () => ({ VehicleLineItemsPicker: () => null }));
vi.mock("../components/FinancePanel", () => ({ FinancePanel: () => null }));
vi.mock("../components/VehicleCostBar", () => ({ VehicleCostBar: () => null }));

import Step1QuoteSetup from "./Step1QuoteSetup";

function renderStep() {
  return render(
    <Step1QuoteSetup
      paymentType="INSTALLMENT"
      initialData={{ vehicleId: VEHICLE, vehiclePrice: 11_100, desiredProfit: 0, downPayment: 1_000, termMonths: 60 } as never}
      onNext={vi.fn()}
    />
  );
}

beforeEach(() => {
  stubs.locale = "en";
  stubs.verdict = { status: "VEHICLE_DELETED" };
});
afterEach(cleanup);

describe("SCRUM-641 R2-F1: the wizard explains a deleted-vehicle block", () => {
  test.each([
    ["en", EN_DELETED],
    ["ar", AR_DELETED],
  ] as const)("%s: Next is disabled AND the verified refusal is shown", (locale, message) => {
    stubs.locale = locale;
    renderStep();
    expect(screen.getByRole("button", { name: dictionaries[locale].Next as string }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(message)).toBeTruthy();
  });

  test("control: an ordinary verdict shows no deleted-vehicle message and Next is enabled", () => {
    stubs.verdict = { status: "NOT_REQUIRED", margin: 1, minimumProfit: 0 };
    renderStep();
    expect(screen.queryByText(EN_DELETED)).toBeNull();
    expect(screen.getByRole("button", { name: dictionaries.en.Next as string }).hasAttribute("disabled")).toBe(false);
  });
});
