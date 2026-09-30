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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { FC_RETURN_REASON_MAX_LENGTH } from "@/convex/utils/fcCheque";

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
import { ChequeReturnedByBankDialog } from "../ChequeReturnedByBankDialog";
import { CollectionsTab } from "@/components/accounting/CollectionsTab";
import { SaleDialog } from "@/components/sales/SaleDialog";

const GENERATE = process.env.FC_CHEQUE_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.FC_CHEQUE_VISUAL_FIXTURE_DIR;

const FC_KEYS = [
  "FcChequeRegisteredNote", "FcChequeFaceLabel", "FcChequeFaceHelp", "FcCorrectExpectedPayment",
  "FcCorrectExpectedPaymentDesc", "FcCorrectReasonLabel", "FcCorrectReasonPlaceholder",
  "FcAttestChequeFace", "FcAttestChequeFaceDesc", "FcChequeFaceUnrecordedNotice", "FcReRegisterNotice",
  "FcDrawerLine", "FcDrawerUnverified", "FcChequeBadge", "FcHandledFromDeal", "FcSaleCancelFromDeal",
  "FcOpenDeal", "RegisterExpectedPayment", "Cancel", "Confirm", "FcAttestNoteLabel", "FcAttestNotePlaceholder",
  "FcFaceAttestedBadge", "FcCorrectNeededNotice", "FcNeedsFinanceAttest", "FcNeedsFinanceCorrect",
  "FcNeedsRegisterPermission", "FcAccountingReviewNotice",
];

/**
 * SCRUM-239: every user-facing string this branch added, by dictionary key. The
 * dialog and the cockpit action are checked to read in the locale; the notices
 * are painted as toasts (headline: the three cockpit toasts; refusals: the coded
 * refusals the return and the confirm-after-return paths can raise).
 */
const SC239_DIALOG_KEYS = [
  "ChequeReturnedByBankAction", "ChequeReturnedByBankTitle", "ChequeReturnedByBankDesc",
  "ChequeReturnedByBankReasonLabel", "ChequeReturnedByBankConfirm", "Cancel",
];
const SC239_HEADLINE_NOTICES = [
  ["error", "DisbursementChangedWhileConfirming"],
  ["error", "DisbursementChangedOutcomeUnknown"],
  ["success", "ChequeReturnedByBankSuccess"],
] as const;
const SC239_REFUSAL_KEYS = [
  "ServerError_FINANCE_RETURN_NOT_DISBURSED", "ServerError_FINANCE_RETURN_CHEQUE_NOT_CLEARED",
  "ServerError_FINANCE_RETURN_CHAIN_MISMATCH", "ServerError_FINANCE_RETURN_ALLOCATION_SHAPE",
  "ServerError_FINANCE_RETURN_REVERSAL_UNPROVEN", "ServerError_FINANCE_RETURN_REASON_REQUIRED",
  "ServerError_FINANCE_RETURN_REASON_TOO_LONG", "ServerError_FINANCE_CHEQUE_RETURN_FROM_DEAL",
  "ServerError_FINANCE_RETURN_NOT_FOUND", "ServerError_FINANCE_RETURN_KEY_CONFLICT",
  "ServerError_CHEQUE_ALREADY_RETURNED", "ServerError_CHEQUE_NOT_RETURNABLE", "ServerError_CHEQUE_NOT_FOUND",
  "ServerError_CHEQUE_NOT_CLEARED", "ServerError_FINANCE_RETURN_KEY_INVALID",
  "ServerError_FINANCE_CONFIRM_STALE_REQUEST", "ServerError_FINANCE_CONFIRM_ALREADY_CONFIRMED",
  "ServerError_FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED", "ServerError_FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED",
  "ServerError_FINANCE_CONFIRM_CHEQUE_NOT_FOUND", "ServerError_FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES",
  "ServerError_FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED", "ServerError_FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH",
  "ServerError_CHEQUE_BANK_FEE_INVALID", "ServerError_CHEQUE_RETURN_NO_RECEIPT_LINEAGE",
  "ServerError_CHEQUE_RETURN_NO_PAYMENT_TO_REVERSE", "ServerError_CHEQUE_RETURN_KEY_CONFLICT",
];
const ARABIC_LETTERS = /[\u0600-\u06FF]/;
/** The toast text exactly as a caller paints it: `{max}` filled the way the server-error path fills it. */
const noticeText = (table: Record<string, string>, key: string) =>
  table[key].replace("{max}", String(FC_RETURN_REASON_MAX_LENGTH));

function tFor(locale: "en" | "ar") {
  const table = dictionaries[locale] as Record<string, string>;
  return (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
}

function panelProps(locale: "en" | "ar", overrides: Partial<FcChequePanelProps>): FcChequePanelProps {
  return {
    canManage: true,
    canRegisterPayment: false,
    needsCorrection: false,
    chequeFaceAttested: false,
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
      attested: { expectedPaymentCorrectable: true, chequePaymentRegistered: true, chequeFaceAttested: true },
      reregister: { needsReRegistration: true },
      // B2: a sales manager holds REGISTER_EXPECTED_PAYMENT only.
      "reregister-manager": { canManage: false, canRegisterPayment: true, needsReRegistration: true },
      "reregister-noperm": { canManage: false, canRegisterPayment: false, needsReRegistration: true },
      "returned-finance": { needsCorrection: true, expectedPaymentCorrectable: true, chequePaymentRegistered: true },
      // F6: a cleared cheque nobody confirmed: notice only, no action.
      "accounting-review": {
        needsAccountingReview: true, expectedPaymentCorrectable: true, chequePaymentRegistered: true,
      },
      "returned-manager": {
        canManage: false, canRegisterPayment: true, needsCorrection: true,
        expectedPaymentCorrectable: true, chequePaymentRegistered: true,
      },
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
      if (id === "attest-dialog") {
        fireEvent.change(document.querySelector("#fc-face")!, { target: { value: "20000.500" } });
        fireEvent.change(document.querySelector("#fc-note")!, {
          target: { value: locale === "ar" ? "قُرئ من الشيك المطبوع في الملف." : "Read from the printed instrument in the file." },
        });
      }
      await new Promise((r) => setTimeout(r, 400));
      write(locale, id, document.body.innerHTML);
      cleanup();
    }

    // 3. Collections, Cheques tab.
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c1", isFinanceCompanyCheque: true, drawerName: "Ahli Finance Company" }),
      // SCRUM-239: c1 is a pre-clear finance-company cheque (Return offered), c2 a CLEARED one
      // (Return withheld: its return is recorded from the deal), c3 an ordinary customer cheque.
      cheque({ _id: "c2", isFinanceCompanyCheque: true, drawerName: null, chequeNumber: "004513", amount: 18250.5, status: "CLEARED" }),
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
    // SCRUM-239 (8b5eae026): Return is offered on a pre-clear finance-company cheque and on
    // the customer's cheque, and withheld only from a CLEARED finance-company cheque, whose
    // return is recorded from the deal. Named per row rather than counted loosely.
    const returnIn = (chequeNumber: string) =>
      within(screen.getByText(chequeNumber).closest("tr") as HTMLElement).queryAllByRole("button", { name: table.Return });
    expect(returnIn("004512"), "pre-clear FC cheque keeps Return").toHaveLength(1);
    expect(returnIn("004513"), "CLEARED FC cheque has no Return").toHaveLength(0);
    expect(returnIn("771204"), "customer cheque keeps Return").toHaveLength(1);
    expect(screen.getAllByRole("button", { name: table.Return })).toHaveLength(2);
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

  // SCRUM-239: the dialog the "Cheque returned by bank" action opens, as a modal.
  test.each(["en", "ar"] as const)("writes the %s returned-by-bank dialog", async (locale) => {
    expect(OUT_DIR, "FC_CHEQUE_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    language.locale = locale;
    const table = dictionaries[locale] as Record<string, string>;
    for (const key of SC239_DIALOG_KEYS) {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
      // A key that fell through to English would still be truthy in the English table.
      if (locale === "ar") expect(table[key], `ar ${key} is not Arabic`).toMatch(ARABIC_LETTERS);
    }
    const reason =
      locale === "ar"
        ? "أعاد البنك الشيك لعدم كفاية الرصيد عند تقديمه للصرف."
        : "The bank returned the cheque for insufficient funds when it was presented.";
    render(
      <ChequeReturnedByBankDialog open submitting={false} t={tFor(locale)} onOpenChange={() => {}} onConfirm={() => {}} />,
    );
    await screen.findByRole("dialog");
    fireEvent.change(document.querySelector("#cheque-returned-by-bank-reason")!, { target: { value: reason } });
    await new Promise((r) => setTimeout(r, 400));
    expect((screen.getByRole("button", { name: table.ChequeReturnedByBankConfirm }) as HTMLButtonElement).disabled).toBe(false);
    write(locale, "returned-by-bank-dialog", document.body.innerHTML);
    cleanup();
  });

  // SCRUM-239: the new notices in the app's REAL Toaster (real `toast` wrapper, real
  // sonner markup and stylesheet). Sonner positions toasts absolutely from measured
  // heights, which a static page cannot reproduce, so each toast is captured alone from
  // the real Toaster and the captured markup is laid out in normal flow by the spec.
  test.each(
    (["en", "ar"] as const).flatMap((locale) => (["light", "dark"] as const).map((theme) => [locale, theme] as const)),
  )("writes the %s %s notices", async (locale, theme) => {
    expect(OUT_DIR, "FC_CHEQUE_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    const table = dictionaries[locale] as Record<string, string>;
    const { Toaster: RealToaster, toast: realToast } =
      await vi.importActual<typeof import("@/components/ui/sonner")>("@/components/ui/sonner");
    // The app toast wrapper reads the locale from localStorage, which this jsdom lacks.
    vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {}, removeItem: () => {} });
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = locale;

    const capture = async (kind: "error" | "success", key: string) => {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
      if (locale === "ar") expect(table[key], `ar ${key} is not Arabic`).toMatch(ARABIC_LETTERS);
      const text = noticeText(table, key);
      render(<RealToaster theme={theme} expand visibleToasts={20} />);
      realToast[kind](text, { duration: Number.POSITIVE_INFINITY });
      const li = await waitFor(() => {
        const el = document.querySelector<HTMLElement>("[data-sonner-toast]");
        if (!el) throw new Error("no toast painted");
        return el;
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(li.textContent, `${key} was altered by the toast wrapper`).toContain(text);
      expect(li.getAttribute("data-type")).toBe(kind);
      const shell = (li.closest("[data-sonner-toaster]") as HTMLElement).cloneNode(false) as HTMLElement;
      const html = li.outerHTML;
      realToast.dismiss();
      cleanup();
      return { shell: shell.outerHTML, html };
    };

    const group = async (items: ReadonlyArray<readonly ["error" | "success", string]>) => {
      const parts = [];
      for (const [kind, key] of items) parts.push(await capture(kind, key));
      const open = parts[0].shell.replace(/<\/ol>$/, "");
      return `${open}${parts.map((p) => p.html).join("")}</ol>`;
    };
    const sonnerCss = Array.from(document.head.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .filter((s) => s.includes("data-sonner-toaster"))
      .join("\n");
    expect(sonnerCss.length, "sonner's stylesheet was not injected").toBeGreaterThan(1000);
    const flow =
      "[data-sonner-toaster]{position:static!important;inset:auto!important;transform:none!important;" +
      "width:min(100%,356px)!important;margin-left:auto;margin-right:0}" +
      "[data-sonner-toast]{position:relative!important;inset:auto!important;transform:none!important;" +
      "opacity:1!important;height:auto!important;margin-bottom:12px}";
    const wrap = (id: string, inner: string) =>
      `<style>${sonnerCss}</style><style>${flow}</style>` +
      `<div class="mx-auto w-full max-w-5xl space-y-4" data-testid="fc-scenario-${id}">${inner}</div>`;

    write(locale, `sc239-notices-${theme}`, wrap("sc239-notices", await group(SC239_HEADLINE_NOTICES)));
    write(
      locale,
      `sc239-refusals-${theme}`,
      wrap("sc239-refusals", await group(SC239_REFUSAL_KEYS.map((key) => ["error", key] as const))),
    );
    vi.unstubAllGlobals();
    document.documentElement.dir = "ltr";
  }, 120_000);
});

