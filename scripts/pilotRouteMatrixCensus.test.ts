import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// PR #696 omitted FC-cheque return in round 1 and custody in round 2.
// Bind the requested module scope to actual registrations, rather than a keyword list.
const MODULES = [
  "financeDealCosts", "customerFinanceCompanyPayments", "financingEconomics",
  "applications", "financeCompanyForward", "sales", "dealCommissions",
  "cashDrawer", "bankAccounts", "accountingCutover", "vehicles",
] as const;
const STORAGE_ONLY = new Set(["vehicles.generateUploadUrl", "vehicles.deleteImage"]);
const ROOT = path.resolve(__dirname, "..");

test("the pilot matrix classifies each public registration in its named module scope exactly once", () => {
  const expected: string[] = [];
  for (const module of MODULES) {
    const file = `convex/${module}.ts`;
    const source = ts.createSourceFile(file, readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const builders = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          !["./functions", "./_generated/server"].includes(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        if (["mutation", "action", "httpAction"].includes((binding.propertyName ?? binding.name).text)) {
          builders.add(binding.name.text);
        }
      }
    }
    expect(builders.size, `${file}: public builder imports must be recognized`).toBeGreaterThan(0);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || !call || !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) || !builders.has(call.expression.text)) continue;
        expected.push(`${module}.${declaration.name.text}`);
      }
    }
  }
  // Each documented storage exception must still be a real registration.
  for (const door of STORAGE_ONLY) expect(expected).toContain(door);
  const moneyDoors = expected.filter(door => !STORAGE_ONLY.has(door)).sort();
  const matrix = readFileSync(path.join(ROOT, "docs/architecture/pilot-route-matrix.md"), "utf8").replace(/\r\n/g, "\n");
  const section = matrix.split("## Normalized Unified Deal classification (F3)\n")[1]?.split("\n## Owner decisions needed")[0];
  expect(section, "the normalized inventory section must exist").toBeDefined();
  const rows = [...(section ?? "").matchAll(/^\| `([\w]+\.[\w]+)` \(`convex\/[^`]+`\) \| (ENABLED|EXCLUDED|OWNER DECISION NEEDED) \| ([^|]+) \|/gm)];
  expect(rows.map(row => row[1]).sort()).toEqual(moneyDoors);
  for (const row of rows) expect(row[3].trim(), `${row[1]} needs a ruling reference`).not.toBe("");
});
