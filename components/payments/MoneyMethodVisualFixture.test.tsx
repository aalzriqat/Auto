/**
 * Renders the SCRUM-469 money-method surfaces to static HTML for the real-engine
 * visual gate (`playwright/visual/money-method.visual.spec.ts`).
 *
 * jsdom applies no stylesheet, so the "choose a method" placeholder, the
 * required-method message and the flex-col layout of `HeldDepositActions` can be
 * asserted but never SEEN. This bridge mounts the real components with the real
 * dictionaries (EN and AR) and the real Radix `PaymentMethodSelect`, walks each to
 * its empty and chosen state, and writes the markup for the spec to paint under
 * the app's compiled stylesheet.
 *
 * Gated on `MONEY_METHOD_VISUAL_FIXTURE=1` so the ordinary suite writes nothing,
 * and writes only into `MONEY_METHOD_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

const language = vi.hoisted(() => ({ locale: "en" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[language.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: language.locale === "ar",
    locale: language.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({ useCurrencyFormatter: () => (value: number) => `${value} JOD` }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => undefined }),
  useMutation: () => async () => undefined,
}));

import { HeldDepositActions } from "@/components/vehicles/HeldDepositActions";
import { StoppedDealDepositsPanel } from "@/components/applications/cockpit/StoppedDealDepositsPanel";
import { CustodyMovementDialog } from "@/components/applications/cockpit/DealCustodyDialogs";
import { ApprovalRequestDialog } from "@/components/accounting/CollectionsTab";
import { useState } from "react";

const ENABLED = process.env.MONEY_METHOD_VISUAL_FIXTURE === "1";
const DIR = process.env.MONEY_METHOD_VISUAL_FIXTURE_DIR ?? "";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const t = (key: string): string => {
  const table = dictionaries[language.locale] as Record<string, string>;
  return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
};

function pickFirstMethod(): void {
  fireEvent.keyDown(screen.getAllByRole("combobox")[0]!, { key: "Enter", code: "Enter" });
  fireEvent.click(screen.getAllByRole("option")[1]!);
}

function HeldHarness() {
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER" | "CARD" | "CHEQUE" | undefined>(undefined);
  return (
    <div className="bg-muted/30 p-3 rounded-lg border text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold tabular-nums">500 JOD</p>
          <p className="text-xs text-muted-foreground">HELD</p>
        </div>
        <HeldDepositActions
          method={method}
          onMethodChange={setMethod}
          busy={false}
          onRefund={() => undefined}
          onForfeit={() => undefined}
          t={t}
        />
      </div>
    </div>
  );
}

function write(name: string, html: string): void {
  writeFileSync(resolve(DIR, `${name}-${language.locale}.html`), html);
}

const receivable = { _id: "rec_1", customerName: "Dana", title: "Deal 7" } as never;

describe.skipIf(!ENABLED)("money-method visual fixtures (SCRUM-469)", () => {
  test.each(["en", "ar"] as const)("%s", (locale) => {
    language.locale = locale;
    mkdirSync(DIR, { recursive: true });

    // 1. HeldDepositActions in the vehicle's deposit list (the flex-col layout).
    render(<HeldHarness />);
    write("held-empty", document.body.innerHTML);
    pickFirstMethod();
    write("held-chosen", document.body.innerHTML);
    cleanup();

    // 2. The stopped-deal refund confirmation.
    render(
      <StoppedDealDepositsPanel
        deposits={[{ _id: "dep1", amount: 500, status: "HELD", method: "CASH", releaseCount: 0 }]}
        canResolve
        faceValueIsReleasable
        resolvingId={null}
        formatAmount={(n) => `${n} JOD`}
        t={t}
        onResolve={async () => undefined}
      />,
    );
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent === t("Refund"))!);
    write("stopped-empty", document.body.innerHTML);
    pickFirstMethod();
    write("stopped-chosen", document.body.innerHTML);
    cleanup();

    // 3. The refund approval request (a real Radix dialog).
    render(<ApprovalRequestDialog target={{ receivable, type: "REFUND" }} onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText(t("RefundAmount")), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText(t("Reason")), { target: { value: "x" } });
    write("approval-empty", document.body.innerHTML);
    pickFirstMethod();
    write("approval-chosen", document.body.innerHTML);
    cleanup();

    // 4. The custody hand-back dialog: empty, chosen, and a server refusal shown.
    const custody = (error: string | null) => (
      <CustodyMovementDialog
        open
        intentId="i1"
        kind="RETURNED"
        currency="JOD"
        scale={3}
        busy={false}
        error={error}
        suggestedMinor={100_000}
        maxMinor={700_000}
        money={(minor) => `${minor / 1000} JOD`}
        t={t as never}
        onOpenChange={() => undefined}
        onSubmit={() => undefined}
      />
    );
    render(custody(null));
    write("custody-empty", document.body.innerHTML);
    pickFirstMethod();
    write("custody-chosen", document.body.innerHTML);
    cleanup();
    render(custody(t("MoneyMethodRequired")));
    write("custody-error", document.body.innerHTML);
    expect(document.body.innerHTML.length).toBeGreaterThan(100);
  });
});
