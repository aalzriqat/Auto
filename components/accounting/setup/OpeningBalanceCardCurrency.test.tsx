/**
 * SCRUM-85 (owner ruling SCRUM-760 c23812 ruling 9; SCRUM-85 c23823): the opening-balance form
 * converts typed amounts to minor units under the organization's currency. It must never guess
 * that currency. Before this change the form read `status?.currency ?? "JOD"`, so any state in
 * which the server's currency was not one the product can scale still offered the entry form,
 * and amounts would have been converted under a guessed denomination.
 *
 * Expected values here are literals from the ruling, never read back from the code under test.
 * Evidence boundary: jsdom render with a mocked Convex client only.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const fixture = vi.hoisted(() => ({ values: new Map<string, unknown>() }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" as const }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (!fixture.values.has(name)) throw new Error(`Unexpected subscription: ${name}`);
      return fixture.values.get(name);
    },
    useMutation: () => vi.fn(),
  };
});

import { OpeningBalanceCard } from "./OpeningBalanceCard";

function seed(currency: string | undefined) {
  fixture.values.clear();
  fixture.values.set(
    "accountingCutover:openingBalanceStatus",
    currency === undefined
      ? undefined
      : {
          posted: false, pendingExists: false, pendingDraftId: null,
          canPostDirectly: true, canManageFinance: true,
          canSelectCustomers: true, canSelectEmployees: true, canSelectPartners: true,
          currency,
        }
  );
  fixture.values.set("accountingCutover:postedOpeningAllocationReadback", null);
  fixture.values.set("chartOfAccounts:list", []);
  fixture.values.set("accountingCutover:listOpeningAccountPolicies", []);
  fixture.values.set("bankAccounts:list", []);
}

afterEach(() => { cleanup(); fixture.values.clear(); });

describe("SCRUM-85 c23823: OpeningBalanceCard never guesses the organization currency", () => {
  test("control: a supported currency still offers the entry form", () => {
    seed("JOD");
    render(<OpeningBalanceCard />);

    fireEvent.click(screen.getByRole("button", { name: "OpeningBalanceSet" }));

    expect(screen.getByRole("button", { name: "OpeningBalancePost" })).toBeTruthy();
    expect(screen.queryByText("CurrencyNotConfigured")).toBeNull();
  });

  test.each([
    ["an unsupported code", "XYZ"],
    ["a lowercase code", "jod"],
    ["an empty code", ""],
  ])("%s offers no entry form and shows the localized refusal", (_label, currency) => {
    seed(currency);
    render(<OpeningBalanceCard />);

    expect(screen.queryByRole("button", { name: "OpeningBalanceSet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "OpeningBalancePost" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("CurrencyNotConfigured");
  });

  test("while the status is still loading nothing is rendered (no default currency is shown)", () => {
    seed(undefined);
    const { container } = render(<OpeningBalanceCard />);

    expect(container.textContent).toBe("");
  });
});
