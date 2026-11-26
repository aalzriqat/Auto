import { describe, expect, it } from "vitest";
import {
  DEAL_MONEY_TEST_IDS,
  countDealMoneyElements,
  hasBrokenValueText,
  htmlDirectionMatchesLanguage,
  isAuthHref,
  isAuthPath,
  leavesSafeArea,
} from "./surfaceRules.ts";

const ORIGIN = "http://127.0.0.1:3000";

describe("isAuthPath and isAuthHref", () => {
  it("accepts the Clerk routes with and without a tail", () => {
    for (const p of [
      "/sign-in",
      "/sign-up",
      "/sign-in/",
      "/sign-up/factor-one",
      "/sign-in?x=1",
      "/sign-up#a",
    ]) {
      expect(isAuthPath(p), p).toBe(true);
    }
  });
  it("rejects look-alikes", () => {
    for (const p of [
      "/",
      "/sign-inx",
      "/sign-in-help",
      "/sign",
      "/a/sign-in",
      "sign-in",
    ]) {
      expect(isAuthPath(p), p).toBe(false);
    }
  });
  it("sees through an absolute URL's origin", () => {
    expect(isAuthHref("http://127.0.0.1:3000/sign-in?redirect=/")).toBe(true);
    expect(isAuthHref("https://example.org/sign-up/")).toBe(true);
    expect(isAuthHref("https://example.org/terms")).toBe(false);
    expect(isAuthHref("/privacy")).toBe(false);
  });
});

describe("leavesSafeArea", () => {
  it("refuses auth labels whatever the href", () => {
    for (const label of [
      "Sign in",
      "Sign up",
      "log in",
      "Login",
      "Get started",
    ]) {
      expect(leavesSafeArea("/privacy", label, ORIGIN), label).toBe(true);
    }
  });
  it("refuses links to Clerk pages", () => {
    expect(leavesSafeArea("/sign-in", "Account", ORIGIN)).toBe(true);
    expect(
      leavesSafeArea("http://127.0.0.1:3000/sign-up", "Account", ORIGIN),
    ).toBe(true);
  });
  it("refuses another origin, including a port that only shares a prefix", () => {
    expect(leavesSafeArea("https://example.org/", "Docs", ORIGIN)).toBe(true);
    expect(leavesSafeArea("http://127.0.0.1:30001/", "Docs", ORIGIN)).toBe(
      true,
    );
    expect(leavesSafeArea("mailto:a@b.c", "Mail", ORIGIN)).toBe(true);
  });
  it("allows same-origin, relative, fragment and absent links", () => {
    expect(leavesSafeArea("http://127.0.0.1:3000/terms", "Terms", ORIGIN)).toBe(
      false,
    );
    expect(leavesSafeArea("/terms", "Terms", ORIGIN)).toBe(false);
    expect(leavesSafeArea("#top", "Top", ORIGIN)).toBe(false);
    expect(leavesSafeArea(null, "Open menu", ORIGIN)).toBe(false);
  });
});

describe("htmlDirectionMatchesLanguage", () => {
  it("is true for the two mirrored pairs only", () => {
    expect(htmlDirectionMatchesLanguage("ar", "rtl")).toBe(true);
    expect(htmlDirectionMatchesLanguage("en", "ltr")).toBe(true);
    expect(htmlDirectionMatchesLanguage("ar", "ltr")).toBe(false);
    expect(htmlDirectionMatchesLanguage("en", "rtl")).toBe(false);
    expect(htmlDirectionMatchesLanguage("fr", "ltr")).toBe(false);
    expect(htmlDirectionMatchesLanguage("", "")).toBe(false);
    expect(htmlDirectionMatchesLanguage("en", "")).toBe(false);
  });
});

describe("hasBrokenValueText", () => {
  it("flags a literal broken value as a whole word", () => {
    for (const t of [
      "NaN",
      "Total: NaN",
      "undefined",
      "price undefined JOD",
      "x [object Object] y",
    ]) {
      expect(hasBrokenValueText(t), t).toBe(true);
    }
  });
  it("ignores words that merely contain them and normal copy", () => {
    for (const t of [
      "",
      "Banana",
      "NaNo",
      "undefinedly",
      "Total: 1,250",
      "Object",
    ]) {
      expect(hasBrokenValueText(t), t).toBe(false);
    }
  });
});

describe("countDealMoneyElements", () => {
  const fake = (counts: Record<string, number>) => ({
    querySelectorAll: (selector: string) => ({
      length: counts[/data-testid="([^"]+)"/.exec(selector)?.[1] ?? ""] ?? 0,
    }),
  });
  it("is zero when none of the ids render", () => {
    expect(countDealMoneyElements(fake({}))).toBe(0);
  });
  it("sums every listed id and ignores others", () => {
    const counts = Object.fromEntries(DEAL_MONEY_TEST_IDS.map((id) => [id, 1]));
    expect(countDealMoneyElements(fake({ ...counts, unrelated: 5 }))).toBe(
      DEAL_MONEY_TEST_IDS.length,
    );
    expect(countDealMoneyElements(fake({ "overview-net-profit": 2 }))).toBe(2);
  });
  it("lists the four deal money test ids", () => {
    expect([...DEAL_MONEY_TEST_IDS].sort()).toEqual([
      "deal-commissions-row",
      "deal-financial-overview",
      "overview-net-profit",
      "overview-sale-price",
    ]);
  });
});
