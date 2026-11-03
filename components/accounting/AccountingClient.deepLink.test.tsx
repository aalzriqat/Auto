/**
 * SCRUM-891: the Pilot Role Audit's Accounting traversal deep-links to
 * `?section=<id>` and reads the section's panel with
 * PILOT_ACCOUNTING_SECTION_PANEL_XPATH (playwright/tests/audit-role-access.spec.ts).
 * That expression is evaluated here against the real AccountingClient shell,
 * every hosted tab stubbed.
 *
 * Radix Tabs 1.1.x renders EVERY TabsContent element and only hides the inactive
 * ones (Presence forces the mount when its children are a function), so "the one
 * tabpanel in <main>" is wrong: it matched all eight and the audit failed with a
 * strict-mode violation for every role allowed on /accounting. The section's panel
 * is the one that is ACTIVE and not nested in another panel.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ACCOUNTING_SECTIONS } from "./accountingSections";
import { PILOT_ACCOUNTING_SECTION_PANEL_XPATH, PILOT_ACCOUNTING_VIEWS } from "../../playwright/fixtures/pilotHunt";

const search = vi.hoisted(() => ({ value: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_123" }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("./AccountingOverview", () => ({ AccountingOverview: () => <p>overview-stub</p> }));
vi.mock("./AccountingSetupTab", () => ({ AccountingSetupTab: () => <p>setup-stub</p> }));
vi.mock("./BankAccountsTab", () => ({ BankAccountsTab: () => <p>bank-stub</p> }));
vi.mock("./FinancialReportsTab", () => ({ FinancialReportsTab: () => <p>reports-stub</p> }));
vi.mock("./GeneralLedgerTab", () => ({ GeneralLedgerTab: () => <p>ledger-stub</p> }));
vi.mock("./FixedAssetsTab", () => ({ FixedAssetsTab: () => <p>fixed-stub</p> }));
vi.mock("./PrepaidExpensesTab", () => ({ PrepaidExpensesTab: () => <p>prepaid-stub</p> }));
vi.mock("./PartnerEquityTab", () => ({ PartnerEquityTab: () => <p>equity-stub</p> }));
vi.mock("./ClaimsTab", () => ({ ClaimsTab: () => <p>claims-stub</p> }));
vi.mock("./CollectionsTab", () => ({ CollectionsTab: () => <p>collections-stub</p> }));
vi.mock("./ManualJournalTab", () => ({ ManualJournalTab: () => <p>manual-stub</p> }));

import { AccountingClient } from "./AccountingClient";

/** Nodes the audit's section-panel XPath resolves to inside the app shell's <main>. */
function sectionPanels(): HTMLElement[] {
  const found = document.evaluate(
    PILOT_ACCOUNTING_SECTION_PANEL_XPATH,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  return Array.from({ length: found.snapshotLength }, (_, index) => found.snapshotItem(index) as HTMLElement);
}

function renderSection(value: string) {
  search.value = value;
  return render(
    <main>
      <AccountingClient />
    </main>,
  );
}

describe("Accounting ?section= deep link, as the role audit reads it", () => {
  afterEach(cleanup);

  test.each(ACCOUNTING_SECTIONS.map((section) => section.id))("%s resolves to exactly its own active panel", (id) => {
    renderSection(`section=${id}`);
    const panels = sectionPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0].id).toMatch(new RegExp(`-content-${id}$`));
    expect(panels[0].hidden).toBe(false);
  });

  test("every section the audit traversal visits is a real section id", () => {
    const known = new Set<string>(ACCOUNTING_SECTIONS.map((section) => section.id));
    for (const view of PILOT_ACCOUNTING_VIEWS) expect(known.has(view.section)).toBe(true);
  });

  test("an unknown section falls back to Overview, which the audit's id check refuses", () => {
    renderSection("section=nonsense");
    const panels = sectionPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0].id).toMatch(/-content-overview$/);
  });
});
