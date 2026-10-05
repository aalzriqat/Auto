/**
 * SCRUM-641 R2-F1: a financed quote on a soft-deleted car must say why Next is disabled.
 * The translator is the REAL dictionary for the locale, so the assertions are on the shipped EN/AR wording.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";

const ORG = "org_1" as Id<"organizations">;
const VEHICLE = "vehicle_1" as Id<"vehicles">;

const EN_DELETED = "This vehicle has been deleted and can no longer be quoted, reserved, sold or take a deposit.";
const AR_DELETED = "تم حذف هذه السيارة ولم يعد بالإمكان تسعيرها أو حجزها أو بيعها أو استلام عربون عليها.";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  verdict: undefined as unknown,
  mutation: (async () => null) as (...args: unknown[]) => Promise<unknown>,
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
    useMutation: () => (...args: unknown[]) => stubs.mutation(...args),
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
  stubs.mutation = async () => null;
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

/**
 * SCRUM-656: the wizard's profit-approval alerts were hard-coded English. The
 * expected wording is written out literally (not read from the dictionary) so a
 * missing key or an English fallback under Arabic fails here. The English half
 * is the wording playwright/tests/profit-approval.spec.ts binds to.
 */
describe("SCRUM-656: profit-approval alerts follow the language", () => {
  const COPY = {
    en: {
      requiredTitle: "Approval Required",
      requiredBody:
        "At this price the profit over the list price (100 JOD) is below the minimum required profit for this vehicle (5,000 JOD).",
      pending: "Approval request is currently pending. Please wait for a manager.",
      rejected: "Your request for this profit amount was rejected. Please increase the profit or request again.",
      request: "Request Profit Approval",
      requesting: "Requesting...",
      approvedTitle: "Profit Approved",
      approvedBody: "Management approved this sale price (profit over the list price: 100 JOD). You may proceed.",
    },
    ar: {
      requiredTitle: "مطلوب اعتماد",
      requiredBody:
        "عند هذا السعر، الربح فوق سعر القائمة (100 د.أ) أقل من الحد الأدنى المطلوب لربح هذه المركبة (5,000 د.أ).",
      pending: "طلب الاعتماد قيد الانتظار. يرجى انتظار قرار المدير.",
      rejected: "رُفض طلبك لمبلغ الربح هذا. يرجى زيادة الربح أو إعادة الطلب.",
      request: "طلب اعتماد الربح",
      requesting: "جارٍ الإرسال…",
      approvedTitle: "تم اعتماد الربح",
      approvedBody: "اعتمدت الإدارة سعر البيع هذا (الربح فوق سعر القائمة: 100 د.أ). يمكنك المتابعة.",
    },
  } as const;
  const verdict = (status: string) => ({ status, margin: 100, minimumProfit: 5000 });

  test.each(["en", "ar"] as const)("%s: REQUIRED shows the title, body and request action", (locale) => {
    stubs.locale = locale;
    stubs.verdict = verdict("REQUIRED");
    renderStep();
    const copy = COPY[locale];
    expect(screen.getByText(copy.requiredTitle)).toBeTruthy();
    expect(screen.getByText(copy.requiredBody)).toBeTruthy();
    expect(screen.getByRole("button", { name: copy.request })).toBeTruthy();
    expect(screen.getByRole("button", { name: dictionaries[locale].Next as string }).hasAttribute("disabled")).toBe(true);
  });

  test.each(["en", "ar"] as const)("%s: PENDING shows the waiting notice and no request action", (locale) => {
    stubs.locale = locale;
    stubs.verdict = verdict("PENDING");
    renderStep();
    const copy = COPY[locale];
    expect(screen.getByText(copy.requiredTitle)).toBeTruthy();
    expect(screen.getByText(copy.pending)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.request })).toBeNull();
  });

  test.each(["en", "ar"] as const)("%s: REJECTED shows the rejection and offers to ask again", (locale) => {
    stubs.locale = locale;
    stubs.verdict = verdict("REJECTED");
    renderStep();
    const copy = COPY[locale];
    expect(screen.getByText(copy.rejected)).toBeTruthy();
    expect(screen.getByRole("button", { name: copy.request })).toBeTruthy();
  });

  test.each(["en", "ar"] as const)("%s: APPROVED shows the approval with the margin", (locale) => {
    stubs.locale = locale;
    stubs.verdict = verdict("APPROVED");
    renderStep();
    const copy = COPY[locale];
    expect(screen.getByText(copy.approvedTitle)).toBeTruthy();
    expect(screen.getByText(copy.approvedBody)).toBeTruthy();
    expect(screen.queryByText(copy.requiredTitle)).toBeNull();
  });

  test.each(["en", "ar"] as const)("%s: while the request is in flight the button says so", async (locale) => {
    stubs.locale = locale;
    stubs.verdict = verdict("REQUIRED");
    stubs.mutation = () => new Promise(() => {});
    renderStep();
    const copy = COPY[locale];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: copy.request }));
    });
    expect(screen.getByRole("button", { name: copy.requesting }).hasAttribute("disabled")).toBe(true);
  });
  test("ar: no English approval wording leaks into the Arabic UI", () => {
    stubs.locale = "ar";
    for (const status of ["REQUIRED", "PENDING", "REJECTED", "APPROVED"]) {
      stubs.verdict = verdict(status);
      const { container } = renderStep();
      expect(container.textContent).not.toMatch(/Approval|Approved|Requesting|Management|pending|rejected/);
      cleanup();
    }
  });
});
