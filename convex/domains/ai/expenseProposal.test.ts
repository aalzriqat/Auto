// @vitest-environment node
import { describe, expect, test } from "vitest";
import { decideExpenseOutput, decideExpenseProposal } from "./expenseProposal";

const TODAY = "2026-11-28";

const base = {
  outcome: "expense",
  amount: 120,
  taxAmount: null,
  category: "RENT",
  date: "2026-11-28",
  title: "Office rent",
  notes: null,
  vendorName: null,
  paymentMethod: null,
};

const reply = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...base, ...over });
const NOT_UNDERSTOOD = { kind: "not_understood" };

describe("a valid model answer becomes one proposal", () => {
  test("English message, every optional field present", () => {
    const decision = decideExpenseProposal(
      reply({ taxAmount: 16.5, notes: "November", vendorName: "Al Noor Real Estate", paymentMethod: "BANK_TRANSFER" }),
      TODAY
    );
    expect(decision).toEqual({
      kind: "proposal",
      proposal: {
        amount: 120,
        taxAmount: 16.5,
        category: "RENT",
        date: "2026-11-28",
        title: "Office rent",
        notes: "November",
        vendorName: "Al Noor Real Estate",
        paymentMethod: "BANK_TRANSFER",
      },
    });
  });

  test("null optional fields are left out, not stored as null", () => {
    expect(decideExpenseProposal(reply(), TODAY)).toEqual({
      kind: "proposal",
      proposal: { amount: 120, category: "RENT", date: "2026-11-28", title: "Office rent" },
    });
  });

  // What a model could plausibly return for these messages. The message text is not an input here:
  // the model's reading of it is, and code checks only the result.
  test.each([
    ["Arabic fuel yesterday (دفعت 35 دينار بنزين أمس)", { amount: 35, category: "TRANSPORT", date: "2026-11-27", title: "بنزين" }],
    ["Eastern-Arabic digits (دفعت ٣٥ دينار بنزين)", { amount: 35, category: "TRANSPORT", title: "بنزين" }],
    ["ألف ونص (دفعت ألف ونص ايجار)", { amount: 1500, category: "RENT", title: "إيجار" }],
    ["English yesterday (paid 120 for office rent yesterday)", { amount: 120, category: "RENT", date: "2026-11-27" }],
    ["decimal amount (paid 12.345 for parking)", { amount: 12.345, category: "TRANSPORT", title: "Parking" }],
  ])("%s", (_label, over) => {
    const decision = decideExpenseProposal(reply(over), TODAY);
    expect(decision.kind).toBe("proposal");
  });
});

describe("a message that is not about an expense", () => {
  test("outcome not_expense", () => {
    const text = JSON.stringify({ ...base, outcome: "not_expense", amount: null, category: null, date: null, title: null });
    expect(decideExpenseProposal(text, TODAY)).toEqual({ kind: "not_expense" });
  });
});

describe("any violation is not understood, with no partial proposal", () => {
  test.each([
    ["amount zero", { amount: 0 }],
    ["amount negative", { amount: -5 }],
    ["amount as a string", { amount: "35" }],
    ["amount as an Eastern-Arabic digit string", { amount: "٣٥" }],
    ["amount missing", { amount: null }],
    ["tax above the amount", { taxAmount: 120.01 }],
    ["tax negative", { taxAmount: -1 }],
    ["tax as a string", { taxAmount: "5" }],
    ["category outside the list", { category: "FOOD" }],
    ["category in the wrong case", { category: "rent" }],
    ["prepaid category (needs amortization the assistant does not collect)", { category: "PREPAID" }],
    ["date tomorrow", { date: "2026-11-29" }],
    ["date 367 days back", { date: "2025-11-26" }],
    ["date not a real day", { date: "2026-02-30" }],
    ["date with one-digit month", { date: "2026-1-5" }],
    ["date in Eastern-Arabic digits", { date: "٢٠٢٦-١١-٢٧" }],
    ["date as relative word", { date: "yesterday" }],
    ["date as a number", { date: 1796000000000 }],
    ["empty title", { title: "" }],
    ["blank title", { title: "   " }],
    ["title of 101 characters", { title: "x".repeat(101) }],
    ["notes of 1001 characters", { notes: "n".repeat(1001) }],
    ["vendor of 101 characters", { vendorName: "v".repeat(101) }],
    ["payment method outside the contract", { paymentMethod: "BITCOIN" }],
    ["payment method on account", { paymentMethod: "ON_ACCOUNT" }],
    ["unknown extra key", { status: "PAID" }],
    ["unknown outcome", { outcome: "maybe" }],
  ])("%s", (_label, over) => {
    expect(decideExpenseProposal(reply(over), TODAY)).toEqual(NOT_UNDERSTOOD);
  });

  test.each([
    ["not JSON", "I think you paid 35 dinars"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["an empty object", "{}"],
    ["a bare number", "35"],
  ])("%s", (_label, text) => {
    expect(decideExpenseProposal(text, TODAY)).toEqual(NOT_UNDERSTOOD);
  });

  test("NaN and Infinity cannot be carried by JSON, but the value check refuses them too", () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decideExpenseOutput({ ...base, amount }, TODAY)).toEqual(NOT_UNDERSTOOD);
    }
    expect(decideExpenseOutput({ ...base, taxAmount: Number.NaN }, TODAY)).toEqual(NOT_UNDERSTOOD);
    expect(decideExpenseOutput({ ...base, taxAmount: Number.POSITIVE_INFINITY }, TODAY)).toEqual(NOT_UNDERSTOOD);
  });
});

describe("the date window", () => {
  test("today and exactly 366 days back are accepted", () => {
    expect(decideExpenseProposal(reply({ date: "2026-11-28" }), TODAY).kind).toBe("proposal");
    expect(decideExpenseProposal(reply({ date: "2025-11-27" }), TODAY).kind).toBe("proposal");
  });

  test("the window follows the day the caller passes, not the clock", () => {
    expect(decideExpenseProposal(reply({ date: "2026-03-01" }), "2026-03-01").kind).toBe("proposal");
    expect(decideExpenseProposal(reply({ date: "2026-03-02" }), "2026-03-01").kind).toBe("not_understood");
    // A leap day inside the window counts as a day.
    expect(decideExpenseProposal(reply({ date: "2024-03-01" }), "2025-03-01").kind).toBe("proposal");
    expect(decideExpenseProposal(reply({ date: "2024-02-28" }), "2025-03-01").kind).toBe("not_understood");
  });
});
