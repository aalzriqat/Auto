/**
 * SCRUM-447 Gate B bridge: renders the finance-company cheque lineage UI to
 * static markup for the real-engine visual gate
 * (`playwright/visual/fc-cheque.visual.spec.ts`).
 *
 * Three real components, no re-implementation:
 *   - `FcChequePanel` in each state the server can put it in, plus its two
 *     dialogs opened;
 *   - `CollectionsTab` on the Cheques tab, with a named-drawer FC row, an
 *     unverified-drawer FC row and an ordinary cheque row;
 *   - `SaleDialog` opened on a financed sale.
 * Every dictionary key painted is checked against the locale's own dictionary,
 * so a key falling through to English would fail here, not paint as a lie.
 *
 * Gated on `FC_CHEQUE_VISUAL_FIXTURE=1` and writes only into the fresh per-run
 * directory named by `FC_CHEQUE_VISUAL_FIXTURE_DIR`, exactly as the deal
 * cockpit bridge does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));
const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  paginated: new Map<string, unknown[]>(),
}));

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
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) =>
    `${n.toLocaleString("en-US")} ${language.locale === "ar" ? "دينار أردني" : "JOD"}`,
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/components/accounting/collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("@/components/accounting/collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("@/components/accounting/collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: (reference: never) => ({
      results: stubs.paginated.get(getFunctionName(reference)) ?? [],
      status: "Exhausted",
      loadMore: () => {},
    }),
    useMutation: () => vi.fn(),
  };
});

import { FcChequePanel, type FcChequePanelProps } from "./FcChequePanel";
import { CollectionsTab } from "@/components/accounting/CollectionsTab";
import { SaleDialog } from "@/components/sales/SaleDialog";

const GENERATE = process.env.FC_CHEQUE_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.FC_CHEQUE_VISUAL_FIXTURE_DIR;

const FC_KEYS = [
  "FcChequeRegisteredNote", "FcChequeFaceLabel", "FcChequeFaceHelp", "FcCorrectExpectedPayment",
  "FcCorrectExpectedPaymentDesc", "FcCorrectReasonLabel", "FcCorrectReasonPlaceholder",
  "FcAttestChequeFace", "FcAttestChequeFaceDesc", "FcChequeFaceUnrecordedNotice", "FcReRegisterNotice",
  "FcDrawerLine", "FcDrawerUnverified", "FcChequeBadge", "FcHandledFromDeal", "FcSaleCancelFromDeal",
  "FcOpenDeal", "RegisterExpectedPayment", "Cancel", "Confirm",
];

function tFor(locale: "en" | "ar") {
  const table = dictionaries[locale] as Record<string, string>;
  return (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
}

function panelProps(locale: "en" | "ar", overrides: Partial<FcChequePanelProps>): FcChequePanelProps {
  return {
    canManage: true,
    chequeFaceUnrecorded: false,
    unattestedChequeId: null,
    expectedPaymentCorrectable: false,
    chequePaymentRegistered: false,
    needsReRegistration: false,
    t: tFor(locale),
    onAttest: async () => {},
    onCorrect: async () => {},
    onRegister: () => {},
    ...overrides,
  };
}

/** The panel as the cockpit hosts it: a direct child of the constrained column. */
function hosted(inner: string, id: string): string {
  return `<div class="mx-auto w-full max-w-5xl space-y-4" data-testid="fc-scenario-${id}">${inner}</div>`;
}

const cheque = (over: Record<string, unknown>) =>
  ({
    _id: "c1",
    _creationTime: 0,
    orgId: "org1",
    chequeDate: Date.UTC(2026, 9, 12),
    customerName: "Layla Haddad",
    vehicleLabel: "Toyota Camry 2024",
    receivableTitle: undefined,
    bank: "Arab Bank",
    chequeNumber: "004512",
    status: "HELD",
    amount: 20000,
    ...over,
  }) as unknown as Doc<"postDatedCheques">;

const write = (locale: string, name: string, html: string) =>
  writeFileSync(resolve(OUT_DIR!, `fc-${name}-${locale}.html`), html);

afterEach(cleanup);

describe.skipIf(!GENERATE)("SCRUM-447 finance-company cheque visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", async (locale) => {
    expect(OUT_DIR, "FC_CHEQUE_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    language.locale = locale;
    const table = dictionaries[locale] as Record<string, string>;
    for (const key of FC_KEYS) expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();

    // 1. Panel states, server-flag driven.
    const states: Record<string, Partial<FcChequePanelProps>> = {
      unattested: { chequeFaceUnrecorded: true, unattestedChequeId: "c1" },
      "unattested-readonly": { canManage: false, chequeFaceUnrecorded: true, unattestedChequeId: "c1" },
      attested: { expectedPaymentCorrectable: true, chequePaymentRegistered: true },
      reregister: { needsReRegistration: true },
    };
    for (const [id, over] of Object.entries(states)) {
      const html = renderToStaticMarkup(<FcChequePanel {...panelProps(locale, over)} />);
      expect(html, id).toContain('data-testid="deal-fc-cheque-panel"');
      write(locale, `panel-${id}`, hosted(html, id));
    }
    // No cheque concern: the panel paints nothing at all.
    expect(renderToStaticMarkup(<FcChequePanel {...panelProps(locale, {})} />)).toBe("");
    write(locale, "panel-none", hosted("", "none"));

    // 2. The two dialogs, opened.
    for (const [id, over, button] of [
      ["attest-dialog", states.unattested, "FcAttestChequeFace"],
      ["correct-dialog", states.attested, "FcCorrectExpectedPayment"],
    ] as const) {
      render(<FcChequePanel {...panelProps(locale, over)} />);
      fireEvent.click(screen.getByRole("button", { name: table[button] }));
      await screen.findByRole("dialog");
      if (id === "attest-dialog") fireEvent.change(document.querySelector("#fc-face")!, { target: { value: "20000.500" } });
      await new Promise((r) => setTimeout(r, 400));
      write(locale, id, document.body.innerHTML);
      cleanup();
    }

    // 3. Collections, Cheques tab.
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c1", isFinanceCompanyCheque: true, drawerName: "Ahli Finance Company" }),
      cheque({ _id: "c2", isFinanceCompanyCheque: true, drawerName: null, chequeNumber: "004513", amount: 18250.5 }),
      cheque({ _id: "c3", customerName: "Omar Nasser", bank: "Housing Bank", chequeNumber: "771204", amount: 3200 }),
    ]);
    stubs.queryResults.set("collections:summary", {
      totalOutstanding: 58000, overdueOutstanding: 0, dueToday: 1000, collectedToday: 0, upcomingChequeTotal: 41450.5,
    });
    render(<CollectionsTab />);
    const chequesTab = screen.getByRole("tab", { name: table.Cheques });
    fireEvent.mouseDown(chequesTab, { button: 0, ctrlKey: false });
    fireEvent.focus(chequesTab);
    expect(await screen.findAllByText(table.FcChequeBadge, undefined, { timeout: 3000 })).toHaveLength(2);
    expect(screen.getAllByText(table.FcHandledFromDeal)).toHaveLength(2);
    write(locale, "collections", document.body.innerHTML);
    cleanup();

    // 4. SaleDialog on a financed sale, and on a cash sale for contrast.
    stubs.queryResults.set("vehicles:listAll", [
      { _id: "car1", make: "Toyota", model: "Camry", year: 2024, vin: "JT2BG22K1W0123456", sellingPrice: 12500, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 9500 },
    ]);
    const sale = (over: Record<string, unknown>) =>
      ({
        _id: "sale1" as Id<"sales">, _creationTime: Date.now(), orgId: "org1", vehicleId: "car1", customerId: "cust1",
        salespersonId: "user1", salePrice: 12500, saleDate: Date.now(), status: "PENDING", ...over,
      }) as unknown as Doc<"sales">;
    render(<SaleDialog open onOpenChange={() => {}} sale={sale({ applicationId: "app1" })} />);
    await screen.findByTestId("sale-cancel-from-deal");
    write(locale, "saledialog-financed", document.body.innerHTML);
    cleanup();
    render(<SaleDialog open onOpenChange={() => {}} sale={sale({})} />);
    await screen.findByRole("dialog");
    expect(screen.queryByTestId("sale-cancel-from-deal")).toBeNull();
    await waitFor(() => expect(document.body.innerHTML.length).toBeGreaterThan(1000));
    write(locale, "saledialog-cash", document.body.innerHTML);
    cleanup();
  });
});
