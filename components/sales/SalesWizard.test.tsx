/**
 * SCRUM-746: "source another like this" opens the wizard with a seed for the
 * picker's source form. SalesWizard's field-by-field draft initialiser used to
 * drop it, so the wizard opened empty. The seed is a one-shot UI hint: it
 * reaches step 1, never the persisted wizardData, and is consumed on Next.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { Toaster, toast } from "@/components/ui/sonner";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SEED = { make: "Kia", model: "K5", year: 2022, color: "White", fuelType: "PETROL", transmission: "AUTOMATIC" };

const stubs = vi.hoisted(() => ({ saved: [] as unknown[], result: undefined as Promise<null> | undefined,
  locale: "en" as "en" | "ar" }));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => {
    const locale = stubs.locale;
    return { t: (key: keyof typeof dictionaries.en) => dictionaries[locale][key] ?? key, isRtl: locale === "ar", locale };
  },
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => (args: unknown) => {
    stubs.saved.push(args);
    return stubs.result ?? Promise.resolve(null);
  },
}));
vi.mock("@/components/sales/wizard/components/StepIndicator", () => ({ StepIndicator: () => null }));
vi.mock("@/components/sales/wizard/steps/Step2Customer", () => ({ default: () => <div data-testid="step2" /> }));
vi.mock("@/components/sales/wizard/steps/Step3Review", () => ({ Step3Review: () => null }));
vi.mock("@/components/sales/wizard/steps/Step4QuoteSuccess", () => ({ Step4QuoteSuccess: () => null }));
vi.mock("@/components/sales/wizard/steps/Step1QuoteSetup", () => ({
  default: ({
    initialSourceData,
    initialData,
    onNext,
  }: {
    initialSourceData?: { make: string };
    initialData: Record<string, unknown>;
    onNext: (data: never) => void;
  }) => (
    <div>
      <div data-testid="seed" data-make={initialSourceData?.make ?? ""} data-in-wizard-data={"sourceLikeVehicle" in initialData ? "yes" : "no"}
        data-vehicle={String(initialData.vehicleId ?? "")} data-price={String(initialData.vehiclePrice ?? "")} />
      <button onClick={() => onNext(initialData as never)}>next</button>
    </div>
  ),
}));

import { SalesWizard } from "./SalesWizard";

afterEach(() => {
  toast.dismiss();
  cleanup();
  stubs.saved.length = 0;
  stubs.result = undefined;
  stubs.locale = "en";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.dir = "ltr";
});

test.each(["en", "ar"] as const)("autosave rejection reports generic %s feedback and retains the current draft", async locale => {
  vi.useFakeTimers();
  stubs.locale = locale;
  const rejected = Promise.reject(new Error("Synthetic internal backend detail"));
  // Observe the fixture rejection to keep the intentionally broken pre-fix run isolated.
  void rejected.catch(() => {});
  stubs.result = rejected;
  const failure = vi.spyOn(toast, "error").mockReturnValue("fixture-toast");
  render(<SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "vehicle-a", vehiclePrice: 123 }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(stubs.saved).toHaveLength(1);
  expect(failure).toHaveBeenCalledExactlyOnceWith(dictionaries[locale].FailedToSave);
  expect(screen.getByTestId("seed")).toBeTruthy();
  expect(screen.getByTestId("seed").getAttribute("data-vehicle")).toBe("vehicle-a");
  expect(screen.getByTestId("seed").getAttribute("data-price")).toBe("123");
  expect(screen.queryByTestId("step2")).toBeNull();
  expect(stubs.saved[0]).toMatchObject({ currentStep: 1, wizardData: { vehicleId: "vehicle-a", vehiclePrice: 123 } });
});

test.each(["en", "ar"] as const)("successful %s autosave does not report failure", async locale => {
  vi.useFakeTimers();
  stubs.locale = locale;
  const failure = vi.spyOn(toast, "error").mockReturnValue("fixture-toast");
  render(<SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "vehicle-a" }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(stubs.saved).toHaveLength(1);
  expect(failure).not.toHaveBeenCalled();
});

function pendingSave() {
  let reject: (error: Error) => void = () => { throw new Error("Pending save not initialized"); };
  const promise = new Promise<null>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

test.each(["unmount", "next step"])("an obsolete save rejection after %s does not show stale feedback", async state => {
  vi.useFakeTimers();
  const pending = pendingSave();
  stubs.result = pending.promise;
  const failure = vi.spyOn(toast, "error").mockReturnValue("fixture-toast");
  const view = render(<SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "vehicle-a" }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  if (state === "unmount") view.unmount();
  else fireEvent.click(screen.getByText("next"));
  await act(async () => { pending.reject(new Error("Synthetic obsolete response")); });
  expect(failure).not.toHaveBeenCalled();
});

test("a pending failure uses the latest locale without triggering another autosave", async () => {
  vi.useFakeTimers();
  const pending = pendingSave();
  stubs.result = pending.promise;
  const failure = vi.spyOn(toast, "error").mockReturnValue("fixture-toast");
  const props = { paymentType: "CASH", onClose: vi.fn(), initialDraft: { vehicleId: "vehicle-a" } } as const;
  const view = render(<SalesWizard {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  stubs.locale = "ar";
  view.rerender(<SalesWizard {...props} />);
  await act(async () => { pending.reject(new Error("Synthetic delayed response")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(failure).toHaveBeenCalledExactlyOnceWith(dictionaries.ar.FailedToSave);
  expect(stubs.saved).toHaveLength(1);
});

test.each(["en", "ar"] as const)("autosave failure paints the real %s toaster", async locale => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "autoflow-locale" ? locale : null,
    setItem: () => {}, removeItem: () => {} });
  stubs.locale = locale;
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  const rejected = Promise.reject(new Error("Synthetic internal backend detail"));
  void rejected.catch(() => {});
  stubs.result = rejected;
  render(<><SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "vehicle-a" }} />
    <Toaster duration={Infinity} /></>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(screen.getByText(dictionaries[locale].FailedToSave)).toBeTruthy();
  expect(screen.queryByText("Synthetic internal backend detail")).toBeNull();
  const directory = process.env.SALES_WIZARD_VISUAL_FIXTURE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `autosave-${locale}.html`),
      `<head>${document.head.innerHTML}</head><body>${document.body.innerHTML}</body>`);
  }
});

describe("SalesWizard: the source-like seed", () => {
  test.each(["CASH", "INSTALLMENT"] as const)("%s: reaches step 1 and stays out of wizardData", (paymentType) => {
    render(<SalesWizard paymentType={paymentType} onClose={vi.fn()} initialDraft={{ sourceLikeVehicle: SEED }} />);
    const seed = screen.getByTestId("seed");
    expect(seed.getAttribute("data-make")).toBe("Kia");
    expect(seed.getAttribute("data-in-wizard-data")).toBe("no");
  });

  test("control: no seed, nothing is passed", () => {
    render(<SalesWizard paymentType="CASH" onClose={vi.fn()} initialDraft={{ vehicleId: "v1" }} />);
    expect(screen.getByTestId("seed").getAttribute("data-make")).toBe("");
  });

  test("it is consumed on Next, so going back does not reopen the form", () => {
    render(<SalesWizard paymentType="INSTALLMENT" onClose={vi.fn()} initialDraft={{ sourceLikeVehicle: SEED }} />);
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByTestId("step2")).toBeTruthy();
  });
});
