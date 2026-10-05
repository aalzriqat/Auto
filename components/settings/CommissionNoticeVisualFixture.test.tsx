/**
 * SCRUM-390 (OR-17) Gate B bridge: renders the REAL commission settings page
 * (`app/(dashboard)/[orgId]/settings/commission/page.tsx`) with the REAL
 * dictionaries to static markup for `playwright/visual/commission-notice.visual.spec.ts`.
 *
 * Only the data hooks are mocked (org, settings, Convex, toasts). Effects run
 * (RTL render), so the two configured tiers are painted, not the empty state.
 *
 * Gated on `COMMISSION_NOTICE_VISUAL_FIXTURE=1`; writes only into the fresh
 * per-run directory named by `COMMISSION_NOTICE_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

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
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useOrgSettings", () => {
  const settings = {
    commissionMode: "AUTO_TIERS",
    commissionTiers: [
      { minProfitAmount: 500, commissionPct: 2 },
      { minProfitAmount: 2000, commissionPct: 3.5 },
    ],
  };
  return { useOrgSettings: () => settings };
});
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));

import CommissionSettingsPage from "@/app/(dashboard)/[orgId]/settings/commission/page";

const GENERATE = process.env.COMMISSION_NOTICE_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.COMMISSION_NOTICE_VISUAL_FIXTURE_DIR;

afterEach(cleanup);

describe.skipIf(!GENERATE)("SCRUM-390 commission notice visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", (locale) => {
    expect(OUT_DIR, "COMMISSION_NOTICE_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    language.locale = locale;
    const table = dictionaries[locale] as Record<string, string>;
    for (const key of ["CommissionMarginNoticeTitle", "CommissionMarginNoticeDesc", "ProfitAmount", "MinProfitLabel"]) {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
    }
    const { container } = render(<CommissionSettingsPage />);
    const html = container.innerHTML;
    expect(html).toContain(table.CommissionMarginNoticeDesc);
    expect(html).toContain(table.MinProfitLabel);
    expect(html).toContain(table.ProfitAmount);
    writeFileSync(resolve(OUT_DIR!, `commission-page-${locale}.html`), html);
    cleanup();
  });
});
