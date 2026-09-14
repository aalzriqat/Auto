/**
 * Renders the cockpit view to static HTML for the real-engine visual gate.
 *
 * jsdom has no stylesheet and no layout, so `DealCockpitView.test.tsx` can
 * assert content and attributes but never paint: whether the `.dark` tokens
 * apply, whether `ms-`/`rtl:` mirror, whether 390px overflows. Those need a
 * browser, and the full Playwright suite needs a built app, Clerk credentials
 * and a provisioned deal to reach this screen. This bridge is the cheap middle:
 * the SAME server-shaped fixtures the view tests use, rendered through React
 * to markup, with the REAL dictionaries so the Arabic is the Arabic the
 * operator reads. `playwright/visual/deal-cockpit.visual.spec.ts` styles it
 * with the compiled app stylesheet and looks at it.
 *
 * Gated on `DEAL_COCKPIT_VISUAL_FIXTURE` so the ordinary suite never writes
 * files. The spec sets it and runs this file itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { DealCockpitData } from "./DealCockpit";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));

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

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "د.أ",
    displayLabel: language.locale === "ar" ? "دينار اردني" : "JOD",
    format: (n: number) => `${n.toLocaleString()} ${language.locale === "ar" ? "دينار اردني" : "JOD"}`,
    formatCompact: (n: number) => String(n),
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (code === "USD" ? 2 : 3),
}));

import { DealCockpitView } from "./DealCockpit";

const SCALE = 1_000;

/** A financed deal mid-flight: one blocked stage, a management headline, a supplier. */
function financedDeal(): DealCockpitData {
  return {
    dealKind: "FINANCED",
    denomination: { code: "JOD", scale: 3 },
    dealRef: "app_2048",
    applicationId: "app_2048",
    saleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28, 9, 30),
    updatedAt: Date.UTC(2026, 7, 9, 14, 5),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1",
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: true,
      supplierName: "شركة عمّان للاستيراد",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    stages: [
      { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
      { key: "CREDIT_DECISION", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPRAISAL", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "DEALER" },
      { key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" },
      { key: "DISBURSEMENT", state: "PENDING", authority: "MIRROR" },
      { key: "HANDOVER", state: "PENDING", authority: "DEALER" },
      { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
    ],
    documents: [
      { ruleId: "r1", name: "سند نقل الملكية", required: true, status: "MISSING" },
      { ruleId: "r2", name: "هوية العميل", required: true, status: "VERIFIED" },
    ],
    timeline: [
      { toStatus: "PENDING_DOCS", changedAt: Date.UTC(2026, 6, 28, 9, 30), actorName: "ليث العمري" },
      { toStatus: "APPROVED", changedAt: Date.UTC(2026, 7, 9, 14, 5), actorName: "رنا حداد" },
    ],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      profit: {
        available: true,
        basis: "MANAGEMENT_ESTIMATE",
        amountMinor: 2_410 * SCALE,
        currency: "JOD",
        classification: "ESTIMATED_AWAITING_SETTLEMENT",
        postable: false,
        lines: [
          { key: "APPROVED_PURCHASE", sign: 1, amountMinor: 12_500 * SCALE },
          { key: "SUPPLIER_SETTLEMENT", sign: -1, amountMinor: 9_500 * SCALE },
          { key: "DEALER_CONTRIBUTION", sign: -1, amountMinor: 500 * SCALE },
          { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90 * SCALE },
        ],
      },
      expenses: { lines: [], actualTotalMinor: 90 * SCALE, awaitingActuals: 1 },
      parties: [
        { party: "CUSTOMER", name: "سامر الخطيب", position: "DEALERSHIP_HOLDS", amountMinor: 500 * SCALE, currency: "JOD" },
        { party: "FINANCIER", name: "شركة التمويل الوطني", position: "OWED_TO_DEALERSHIP", amountMinor: 12_000 * SCALE, currency: "JOD" },
        { party: "SUPPLIER", name: "شركة عمّان للاستيراد", position: "DEALERSHIP_OWES", amountMinor: 9_500 * SCALE, currency: "JOD" },
      ],
      appraisalGapMinor: 300 * SCALE,
    },
    settlementAdviceRequiresReconciliation: false,
  } as unknown as DealCockpitData;
}

const OUT_DIR = resolve(process.cwd(), "test-results/deal-cockpit-visual/fixtures");

describe.skipIf(!process.env.DEAL_COCKPIT_VISUAL_FIXTURE)("deal cockpit visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", (locale) => {
    language.locale = locale;
    const html = renderToStaticMarkup(
      <DealCockpitView
        deal={financedDeal()}
        backHref="/org_1/deals"
        activeAppraisalProvider="INDEPENDENT"
        onRecordSupplierReceipt={async () => {}}
      />
    );
    // Not an empty render: the headline and the rail are both in the markup.
    expect(html).toContain("data-testid=\"deal-header\"");
    expect(html).toContain("data-testid=\"deal-stage-rail\"");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, `deal-cockpit-${locale}.html`), html);
  });
});
