/**
 * Renders the SCRUM-571 S1 held-payments surfaces to static HTML for the
 * real-engine visual gate (`playwright/visual/held-payments.visual.spec.ts`).
 *
 * jsdom applies no stylesheet, so the held-payments table's wrapping at 390px,
 * its RTL mirroring and the two dialogs' layout can be asserted but never SEEN.
 * This bridge mounts the real `PaymentLinksPanel` with the real dictionaries (EN
 * and AR), opens the Resolve and Expire dialogs through the real buttons, and
 * writes the markup for the spec to paint under the app's compiled stylesheet.
 *
 * Gated on `HELD_PAYMENTS_VISUAL_FIXTURE=1` so the ordinary suite writes nothing,
 * and writes only into `HELD_PAYMENTS_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { formatInCurrency } from "@/lib/currencyFormat";

const stubs = vi.hoisted(() => ({
  locale: "en" as "ar" | "en",
  rows: [] as unknown[],
  held: [] as unknown[] | undefined,
  heldThrows: false,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[stubs.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ code: "JOD" }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number, digits = 0) =>
    formatInCurrency(stubs.locale === "ar" ? "ar" : "en-US", "JOD", n, digits),
  // The real hook's behaviour: the row's own currency, at the row's own scale.
  useCurrencyFormatterInCurrency: () => (n: number, currency: string, digits = 0) =>
    formatInCurrency(stubs.locale === "ar" ? "ar" : "en-US", currency, n, digits),
}));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: stubs.rows, status: "Exhausted", loadMore: () => undefined }),
  // Convex's useQuery throws a failed query during render; mirror that.
  useQuery: () => {
    if (stubs.heldThrows) throw new Error("query failed");
    return stubs.held;
  },
  useMutation: () => async () => undefined,
}));

import { PaymentLinksPanel } from "./PaymentLinksPanel";

const ENABLED = process.env.HELD_PAYMENTS_VISUAL_FIXTURE === "1";
const DIR = process.env.HELD_PAYMENTS_VISUAL_FIXTURE_DIR ?? "";

afterEach(() => {
  cleanup();
  stubs.rows = [];
  stubs.held = [];
  stubs.heldThrows = false;
});

const t = (key: string): string => {
  const table = dictionaries[stubs.locale] as Record<string, string>;
  return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
};

function write(name: string): void {
  writeFileSync(resolve(DIR, `${name}-${stubs.locale}.html`), document.body.innerHTML);
}

const NOW = Date.UTC(2026, 9, 2, 9, 30);

const link = (over: Record<string, unknown>) => ({
  _id: "pi1",
  _creationTime: 0,
  orgId: "org1",
  customerId: "c1",
  customerName: "Layla Nasser",
  amountMinor: 600_000,
  currency: "JOD",
  provider: "tap",
  externalId: "chg_TS02A5820261003",
  status: "PENDING",
  checkoutUrl: "https://checkout.example.test/pay/chg_TS02A5820261003",
  ...over,
});

const heldRow = (over: Record<string, unknown>) => ({
  _id: "uf1",
  amountMinor: 12_500,
  currency: "JOD",
  provider: "tap",
  externalId: "chg_TS11B4420261002",
  reason: "INTENT_NOT_PENDING",
  intentStatusAtReceipt: "EXPIRED",
  deliveryCount: 2,
  amountConflict: false,
  reviewStatus: "OPEN",
  firstReceivedAt: NOW - 3_600_000,
  lastReceivedAt: NOW,
  ...over,
});

const HELD = [
  heldRow({}),
  heldRow({
    _id: "uf2",
    amountMinor: 450_000,
    currency: "USD",
    provider: "stripe",
    externalId: "pi_3Q9xK2LkdIwHu7ix0abcDEF1",
    reason: "AMOUNT_OR_ACCOUNT_MISMATCH",
    deliveryCount: 3,
    amountConflict: true,
  }),
  // An unsupported code: the panel falls back to the raw minor units.
  heldRow({
    _id: "uf3",
    amountMinor: 987_654,
    currency: "XYZ",
    provider: "hyperpay",
    externalId: "8ac7a4a2-9d1b-4c11-b0f3-0a6e5c1d2e44",
    reason: "UNKNOWN_REFERENCE",
    intentStatusAtReceipt: undefined,
    deliveryCount: 1,
  }),
];

describe.skipIf(!ENABLED)("held-payments visual fixtures (SCRUM-571 S1)", () => {
  test.each(["en", "ar"] as const)("%s", (locale) => {
    stubs.locale = locale;
    mkdirSync(DIR, { recursive: true });
    stubs.rows = [link({}), link({ _id: "pi2", customerName: "Omar Haddad", status: "SETTLED", externalId: "chg_TS77C1020260930" })];

    // a. Three held rows: JOD, USD and an unsupported code (raw minor units).
    stubs.held = HELD;
    render(<PaymentLinksPanel />);
    write("held-rows");
    cleanup();

    // b. Empty.
    stubs.held = [];
    render(<PaymentLinksPanel />);
    write("held-empty");
    cleanup();

    // c. The query throws: the section degrades to its own error state.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubs.held = HELD;
    stubs.heldThrows = true;
    render(<PaymentLinksPanel />);
    write("held-error");
    cleanup();
    quiet.mockRestore();
    stubs.heldThrows = false;

    // d. The Resolve dialog, open on the first row.
    stubs.held = HELD;
    render(<PaymentLinksPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: t("HeldPaymentsResolve") })[0]!);
    expect(screen.getByRole("dialog").textContent).toContain(t("HeldPaymentsResolveTitle"));
    write("resolve-dialog");
    cleanup();

    // e. The Expire confirmation, open on the PENDING link.
    stubs.held = HELD;
    render(<PaymentLinksPanel />);
    const expire = screen
      .getAllByRole("button", { name: t("ExpirePaymentLink") })
      .find((button) => !(button as HTMLButtonElement).disabled)!;
    fireEvent.click(expire);
    expect(screen.getByRole("dialog").textContent).toContain(t("ExpirePaymentLinkTitle"));
    write("expire-dialog");
    expect(document.body.innerHTML.length).toBeGreaterThan(100);

    // f. D-22: the Expire dialog with the provider-check attestation, unticked
    // (Expire disabled) and then ticked (Expire enabled).
    const confirmButton = () =>
      within(screen.getByRole("dialog")).getByRole("button", { name: t("ExpirePaymentLink") }) as HTMLButtonElement;
    const attest = within(screen.getByRole("dialog")).getByRole("checkbox");
    expect(attest.getAttribute("aria-checked")).toBe("false");
    expect(confirmButton().disabled).toBe(true);
    write("expire-dialog-attest");
    fireEvent.click(attest);
    expect(attest.getAttribute("aria-checked")).toBe("true");
    expect(confirmButton().disabled).toBe(false);
    write("expire-dialog-attest-checked");
    cleanup();

    // g. D-22: a payment link whose capture is held for review shows its label.
    stubs.held = HELD;
    stubs.rows = [
      link({ _id: "pi3", customerName: "Sami Qudah", status: "CAPTURE_HELD", externalId: "chg_TS55D3320261001" }),
      ...(stubs.rows as unknown[]),
    ];
    render(<PaymentLinksPanel />);
    write("capture-held-row");
  });
});
