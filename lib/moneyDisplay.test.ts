import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { formatMoneyAmount, formatMoneyDisplay, moneyDisplayLabel, moneyDisplayScale } from "./moneyDisplay";

const NBSP = " ";

describe("the sales wizard's money display policy (SCRUM-684)", () => {
  test("a whole amount shows no decimals", () => {
    expect(formatMoneyDisplay(11_100, "JOD", "en")).toBe(`11,100${NBSP}JOD`);
  });

  test("an amount with fils shows JOD's full three decimals", () => {
    expect(formatMoneyDisplay(316.854, "JOD", "en")).toBe(`316.854${NBSP}JOD`);
    // Padded to the full scale, not trimmed: 316.85 would read as a different figure.
    expect(formatMoneyDisplay(316.85, "JOD", "en")).toBe(`316.850${NBSP}JOD`);
  });

  test("the scale comes from the currency, not a hard-coded two", () => {
    expect(moneyDisplayScale("JOD")).toBe(3);
    expect(moneyDisplayScale("USD")).toBe(2);
    expect(formatMoneyDisplay(10.5, "USD", "en")).toBe(`10.50${NBSP}USD`);
  });

  test("Arabic keeps Western digits and uses the short symbol", () => {
    const shown = formatMoneyDisplay(11_100.5, "JOD", "ar");
    expect(shown).toBe(`11,100.500${NBSP}د.أ`);
    expect(shown).not.toMatch(/[٠-٩]/);
    expect(shown).not.toContain("دينار");
  });

  test("a currency without an Arabic symbol keeps its ISO code", () => {
    expect(moneyDisplayLabel("usd", "ar")).toBe("USD");
  });

  test("float noise below the scale does not grow decimals", () => {
    expect(formatMoneyAmount(0.1 + 0.2, "JOD")).toBe("0.300");
    expect(formatMoneyAmount(11_099.9999, "JOD")).toBe("11,100");
  });

  test("a half-fils result is not pre-rounded down by binary multiplication (Codex MD-2)", () => {
    // 7,680.030 JOD over 60 months: 128.0005, and 128.0005 * 1000 is
    // 128000.49999999999 in binary — rounding that showed "128", a whole
    // figure one fils below the real installment.
    expect(formatMoneyAmount(7680.03 / 60, "JOD")).toBe("128.001");
  });

  test("a value that rounds to zero carries no minus sign", () => {
    expect(formatMoneyAmount(-0.0001, "JOD")).toBe("0");
  });

  test("a server-supplied scale overrides the currency's own", () => {
    expect(formatMoneyAmount(1.5, "JOD", 2)).toBe("1.50");
  });

  test("never renders NaN or Infinity as a figure", () => {
    expect(formatMoneyDisplay(Number.NaN, "JOD", "en")).toBe("—");
    expect(formatMoneyAmount(Number.POSITIVE_INFINITY, "JOD")).toBe("—");
  });

  test("negative amounts keep the sign and the rule", () => {
    expect(formatMoneyDisplay(-250, "JOD", "en")).toBe(`-250${NBSP}JOD`);
  });
});

/**
 * Static guard: the wizard and its print documents format money only through
 * lib/moneyDisplay. A raw toLocaleString picks the browser's digits and a
 * fixed decimal count; the shared useCurrency/useCurrencyFormatter hooks carry
 * the "دينار اردني" label and Arabic-Indic digits this ruling replaced.
 */
describe("wizard money formatting goes through one policy", () => {
  const root = join(__dirname, "..");
  const files = [
    ...walk(join(root, "components/sales/wizard")),
    join(root, "components/sales/QuotePrintTemplate.tsx"),
    join(root, "components/sales/ReceiptVoucherPrintTemplate.tsx"),
  ];

  const banned: Array<[string, RegExp]> = [
    ["raw toLocaleString", /\.toLocaleString\(/],
    ["the translated JOD label", /t\("JOD"/],
    ["the shared useCurrency hook", /from "@\/hooks\/useCurrency"/],
    ["the shared useCurrencyFormatter hooks", /from "@\/hooks\/useCurrencyFormatter"/],
  ];

  test("covers the files it claims to", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const [label, pattern] of banned) {
    test(`no ${label}`, () => {
      const offenders = files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * SCRUM-685/675: the quote/sale dialogs, the consigned settlement preview and the
 * expense form once hard-coded "JOD" / a fixed locale / a "$" label next to a
 * number. They now take the org's currency from useMoneyDisplay.
 */
describe("dialog money display is currency-derived", () => {
  const root = join(__dirname, "..");
  const files = [
    "components/sales/QuoteDialog.tsx",
    "components/sales/SaleDialog.tsx",
    "components/sales/ConsignedSettlementSection.tsx",
    "components/expenses/ExpenseDialog.tsx",
  ];
  const banned: Array<[string, RegExp]> = [
    ["raw toLocaleString", /\.toLocaleString\(/],
    ["a hard-coded JOD suffix", /\}\s*JOD\b|>\s*JOD\s*</],
    ["the USD amount label", /AmountUSD/],
  ];
  for (const [label, pattern] of banned) {
    test(`no ${label}`, () => {
      const offenders = files.filter((f) => pattern.test(readFileSync(join(root, f), "utf8")));
      expect(offenders).toEqual([]);
    });
  }
  test("each file uses useMoneyDisplay", () => {
    const missing = files.filter((f) => !readFileSync(join(root, f), "utf8").includes("useMoneyDisplay"));
    expect(missing).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
