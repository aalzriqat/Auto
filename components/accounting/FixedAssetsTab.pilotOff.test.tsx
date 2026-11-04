/**
 * SCRUM-810: the fixed-asset lifecycle is OFF for the pilot (SCRUM-560, owner ruling
 * c23812 #4), and the server refuses capitalize, impair and dispose. The tab must
 * therefore not offer them. The register and each asset's event history are reads
 * and stay available.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { assertPilotCertifyingConfig } from "@/test-utils/pilotConfigParity";

const stubs = vi.hoisted(() => ({
  t: (key: string): string => key,
  assets: [] as unknown[],
}));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => stubs.t(key), isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ code: "JOD" }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number, digits = 0) => `${n.toFixed(digits)} JOD`,
}));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: stubs.assets, status: "Exhausted", loadMore: () => {} }),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));

import { FixedAssetsTab } from "./FixedAssetsTab";

const asset = {
  _id: "a1",
  _creationTime: 0,
  orgId: "org1",
  name: "Workshop lift",
  purchaseDate: Date.UTC(2026, 0, 5),
  purchaseValue: 5000,
  costMinor: 5_000_000,
  accumulatedDepreciationMinor: 0,
  status: "ACTIVE",
};

beforeAll(() => assertPilotCertifyingConfig());
afterEach(() => {
  cleanup();
  stubs.assets = [];
  stubs.t = (key) => key;
});

describe.each([
  ["en", commonEn],
  ["ar", commonAr],
] as const)("FixedAssetsTab under the pilot switch (%s)", (_name, locale) => {
  const word = (key: string) => (locale as Record<string, string>)[key] ?? key;

  test("offers no lifecycle action and says why, but keeps the register and history", () => {
    stubs.t = word;
    stubs.assets = [asset];
    render(<FixedAssetsTab />);

    expect(screen.queryByRole("button", { name: word("CapitalizeNewAsset") })).toBeNull();
    expect(screen.queryByRole("button", { name: word("ImpairAsset") })).toBeNull();
    expect(screen.queryByRole("button", { name: word("DisposeAsset") })).toBeNull();

    expect(screen.getByRole("status").textContent).toBe(word("ServerError_FIXED_ASSET_LIFECYCLE_DISABLED"));
    expect(screen.getByText("Workshop lift")).toBeTruthy();
    expect(screen.getByRole("button", { name: word("ViewEvents") })).toBeTruthy();
  });

  test("an empty register still explains that fixed assets are off", () => {
    stubs.t = word;
    render(<FixedAssetsTab />);
    expect(screen.getByRole("status").textContent).toBe(word("ServerError_FIXED_ASSET_LIFECYCLE_DISABLED"));
    expect(screen.queryByRole("button", { name: word("CapitalizeNewAsset") })).toBeNull();
  });
});
