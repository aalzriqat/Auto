// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * I1 (SCRUM-1039): the expense assistant is a reader of its own table and a caller of the
 * provider. It must have no way to record an expense or touch the ledger.
 *
 * What this proves: no assistant source file contains one of these literal references or
 * imports one of these modules. What it does not prove: that a future edit could not reach a
 * writer through a new indirection (a helper that itself calls one). The behavioural check
 * (no expense or transaction row after a full run) is in convex/aiAssistant.test.ts.
 */
const CONVEX_DIR = path.resolve(__dirname, "..", "convex");
const DOMAIN_DIR = path.join(CONVEX_DIR, "domains", "ai");
const ASSISTANT_FILES = [
  path.join(CONVEX_DIR, "aiAssistant.ts"),
  ...readdirSync(DOMAIN_DIR)
    .filter((name) => name.startsWith("expenseProposal") && !name.endsWith(".test.ts"))
    .map((name) => path.join(DOMAIN_DIR, name)),
];

const FORBIDDEN_LITERALS = [
  "expenses.create",
  "recordPaidExpenseSideEffects",
  'ctx.db.insert("expenses"',
  'insert("expenses"',
  '"transactions"',
  "ctx.runMutation(api.",
  "api.expenses",
  "internal.expenses",
  "internal.accounting",
  "api.accounting",
  "postJournal",
  "accountingEvents",
];

const FORBIDDEN_IMPORT_FRAGMENTS = ["/expenses", "accounting", "ledger", "journal", "transactions", "postings", "payroll"];

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

describe("the expense assistant has no money writer", () => {
  test("the scan covers the door file and the domain files", () => {
    const names = ASSISTANT_FILES.map((file) => path.basename(file));
    expect(names).toContain("aiAssistant.ts");
    expect(names).toEqual(
      expect.arrayContaining(["expenseProposal.ts", "expenseProposalPrompt.ts", "expenseProposalRequest.ts", "expenseProposalJob.ts"])
    );
  });

  test.each(ASSISTANT_FILES.map((file) => [path.basename(file), file] as const))(
    "%s names no expense, transaction or accounting writer",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      for (const literal of FORBIDDEN_LITERALS) {
        expect(source, `${path.basename(file)} must not contain ${literal}`).not.toContain(literal);
      }
      for (const specifier of importSpecifiers(source)) {
        for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
          expect(specifier, `${path.basename(file)} must not import ${specifier}`).not.toContain(fragment);
        }
      }
    }
  );

  test("every insert names the assistant's own table", () => {
    for (const file of ASSISTANT_FILES) {
      const source = readFileSync(file, "utf8");
      const inserted = [...source.matchAll(/db\.insert\(\s*["']([A-Za-z]+)["']/g)].map((m) => m[1]);
      for (const table of inserted) expect(table).toBe("aiExpenseProposals");
    }
  });
});
