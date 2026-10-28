/**
 * SCRUM-85 / SCRUM-760 c23812 ruling 9: the organization's currency is the one the
 * owner stored. A screen with no stored currency shows "currency not configured"
 * instead of a number; it never shows a guessed code such as JOD.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useOrgCurrencyState } from "./useOrgCurrencyState";
import { useCurrency } from "./useCurrency";
import { useMoneyDisplay } from "./useMoneyDisplay";
import { useCurrencyFormatter } from "./useCurrencyFormatter";

const fixture = vi.hoisted(() => ({
  settings: undefined as undefined | null | { currency?: string; currencySymbol?: string },
  status: undefined as undefined | null | { configured: boolean; currency: string | null; currencySymbol: string | null },
  statusAsked: false,
  locale: "en",
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (getFunctionName(reference) === "orgSettings:getCurrencyStatus") {
        fixture.statusAsked = args !== "skip";
        return args === "skip" ? undefined : fixture.status;
      }
      throw new Error("Unexpected query in the currency hook test");
    },
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("./useOrgSettings", () => ({ useOrgSettings: () => fixture.settings }));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => fixture.settings }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    locale: fixture.locale,
    isRtl: fixture.locale === "ar",
    t: (key: string) => (key === "CurrencyNotConfigured" ? "Currency not configured" : key),
  }),
}));

beforeEach(() => {
  fixture.settings = undefined;
  fixture.status = undefined;
  fixture.statusAsked = false;
  fixture.locale = "en";
});
afterEach(cleanup);

describe("useOrgCurrencyState", () => {
  test("a stored currency on the settings projection is used, and the status query is not asked", () => {
    fixture.settings = { currency: "USD", currencySymbol: "$" };
    const { result } = renderHook(() => useOrgCurrencyState());
    expect(result.current).toEqual({ status: "configured", code: "USD", symbol: "$" });
    expect(fixture.statusAsked).toBe(false);
  });

  test("while nothing has answered the state is loading, never a currency", () => {
    const { result } = renderHook(() => useOrgCurrencyState());
    expect(result.current).toEqual({ status: "loading" });
  });

  test("a settings projection with no currency defers to the any-member status query", () => {
    fixture.settings = null; // a member without view:settings reads the same as "no row"
    fixture.status = { configured: true, currency: "SAR", currencySymbol: "ر.س" };
    const { result } = renderHook(() => useOrgCurrencyState());
    expect(fixture.statusAsked).toBe(true);
    expect(result.current).toEqual({ status: "configured", code: "SAR", symbol: "ر.س" });
  });

  test("an organization that stored none is unconfigured, not JOD", () => {
    fixture.settings = {};
    fixture.status = { configured: false, currency: null, currencySymbol: null };
    const { result } = renderHook(() => useOrgCurrencyState());
    expect(result.current).toEqual({ status: "unconfigured" });
  });

  test("a blank stored code reads as not configured", () => {
    fixture.settings = { currency: "   " };
    fixture.status = { configured: false, currency: null, currencySymbol: null };
    const { result } = renderHook(() => useOrgCurrencyState());
    expect(result.current).toEqual({ status: "unconfigured" });
  });
});

describe("the currency consumers never invent a code", () => {
  test("useCurrency: unconfigured has no code and formats to the not-configured text", () => {
    fixture.settings = null;
    fixture.status = { configured: false, currency: null, currencySymbol: null };
    const { result } = renderHook(() => useCurrency());
    expect(result.current.code).toBeNull();
    expect(result.current.symbol).toBeNull();
    expect(result.current.configured).toBe(false);
    expect(result.current.displayLabel).toBe("Currency not configured");
    expect(result.current.format(5000)).toBe("Currency not configured");
    expect(result.current.formatCompact(5000)).toBe("Currency not configured");
    expect(result.current.formatLocale(5000, "en-US")).toBe("Currency not configured");
  });

  test("useCurrency: loading shows no label at all (a skeleton, not a currency)", () => {
    const { result } = renderHook(() => useCurrency());
    expect(result.current.code).toBeNull();
    expect(result.current.displayLabel).toBe("");
  });

  test("useCurrency: a stored code is the label", () => {
    fixture.settings = { currency: "EUR", currencySymbol: "€" };
    const { result } = renderHook(() => useCurrency());
    expect(result.current.code).toBe("EUR");
    expect(result.current.displayLabel).toBe("EUR");
    expect(result.current.format(1200)).toBe(`${(1200).toLocaleString()} EUR`);
  });

  test("useMoneyDisplay: unconfigured renders the not-configured text and passes an explicit record currency through", () => {
    fixture.settings = null;
    fixture.status = { configured: false, currency: null, currencySymbol: null };
    const { result } = renderHook(() => useMoneyDisplay());
    expect(result.current.code).toBeNull();
    expect(result.current.format(100)).toBe("Currency not configured");
    expect(result.current.amount(100)).toBe("Currency not configured");
    expect(result.current.label).toBe("Currency not configured");
    // A record that carries its own currency is still displayed in it.
    expect(result.current.format(100, "USD")).toContain("USD");
  });

  test("useCurrencyFormatter: unconfigured returns the not-configured text, loading returns nothing", () => {
    fixture.settings = null;
    fixture.status = { configured: false, currency: null, currencySymbol: null };
    const unconfigured = renderHook(() => useCurrencyFormatter());
    expect(unconfigured.result.current(5000)).toBe("Currency not configured");
    cleanup();
    fixture.status = undefined;
    const loading = renderHook(() => useCurrencyFormatter());
    expect(loading.result.current(5000)).toBe("");
  });
});
