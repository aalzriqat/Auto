import { assertRuntimeControlForms } from "./navigationProbes";
import { expect } from "vitest";
import { navigationConditions, navigationSites, requiredNavigationTuples } from "./navigationCoverage";
import ts from "typescript";
import { parse, updateTable, root } from "./source";
import { CONDITION_AXIS } from "./navigationSyntax";
import { SUPPLIER_NAVIGATION_DOORS } from "./doorMatrix";
import schema from "../../../convex/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listActiveTestRegistrations } from "../../autoflowInvariantCatalog";
import { assertNavigationFingerprints } from "./navigationPins";

export const checkSupplierNavigationCensusRefusesSwitchArrowAndMethodControls = () => {
  assertRuntimeControlForms([
    ['function sourceFor(sale: {status: string}) { switch (sale.status) { case "X": return null; } }', "sale.status", "unlisted runtime kind; update checkRuntimeForm and conditionNode"],
    ['const gate = (sale: {status: string}) => sale.status === "X"; function sourceFor() { return gate; }', "sale.status", "arrow helper"],
    ['const gate = { check(sale: {status: string}) { return sale.status === "X"; } }; function sourceFor() { return gate.check; }', "sale.status", "object literal; update OBJECT_FORMS (no permissions or args spread)"],
  ]);
};

export const checkSupplierNavigationCensusRefusesAliasBindingWriteAndNullableControls = () => {
  assertRuntimeControlForms([
    ['function sourceFor(sale: {status: string}) { const state = sale.status; if (state === "X") return null; }', "sale.status", "property read"],
    ['function sourceFor(sale: {status: string}) { const {status: state} = sale; if (state === "X") return null; }', "sale.status", "special form; update checkSpecialForm"],
    ['function sourceFor(sale: {status: string}) { let state: string; state = sale.status; if (state === "X") return null; }', "sale.status", "binary operator; update BINARY_OPERATORS"],
    ['type Label = string | null; function sourceFor(label: Label) { if (label) return null; }', "nullable:label", "condition IfStatement; update CONDITION_AXIS"],
  ]);
};

export const checkSupplierNavigationOwnershipCallsAndPermissionGatesRetainEveryDeclaredDoorRow = () => {
  const source = parse("convex/utils/supplierNavigation.ts");
  const conditions = navigationConditions(source);
  for (const condition of conditions) {
    const axes = CONDITION_AXIS[condition];
    expect(axes, `Unmapped navigation condition: ${condition}`).toBeDefined();
    for (const axis of axes!) for (const door of SUPPLIER_NAVIGATION_DOORS) {
      const values = door.axes[axis];
      const reason = door.axisExemptions[axis];
      expect((values?.length ?? 0) >= 2 || (reason?.trim().length ?? 0) > 30,
        `${updateTable}: ${door.name} must declare axis ${axis} for ${condition}, or explain why it cannot change the result`).toBe(true);
    }
  }
  const sites = navigationSites(source);
  expect(new Set(sites).size, `${updateTable}: duplicate source sites (navigationSites reports the node and line)`).toBe(sites.length);
  expect(sites, updateTable).toStrictEqual(SUPPLIER_NAVIGATION_DOORS.map(door => door.site).sort());
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    expect(door.rows.length, door.name).toBeGreaterThan(0);
    const kind = door.site.endsWith(": POSTED") ? "status" : /: (VIEW_|MANAGE_)/.test(door.site) ? "permission" : "owned";
    expect(door.kind, door.site).toBe(kind);
  }
};

export const checkSupplierNavigationSchemaExemptionsRetainBothImpossibleDeletionStates = () => {
  for (const name of ["financeApplications", "openingBalanceDrafts"] as const) {
    const fields = schema.tables[name].validator.fields;
    expect(Object.keys(fields), `${name} only supports hard deletion`).not.toContain("isDeleted");
  }
};

export const checkEveryDeclaredSupplierNavigationRowNamesOneActiveLiteralTestRegistration = () => {
  const source = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const registered = listActiveTestRegistrations(source).filter(row => !row.parameterized);
  const syntax = ts.createSourceFile("cells.ts", source, ts.ScriptTarget.Latest, true);
  const seeded = new Map<string, { door: string; axes: string[]; tuples: string[][] }>();
  const strings = (node: ts.Node): string[] => {
    if (!ts.isArrayLiteralExpression(node)) throw new Error("Cells and axes must be inline literal arrays");
    return node.elements.map(value => {
      if (!ts.isStringLiteral(value)) throw new Error("Cell values must be literal strings");
      return value.text;
    });
  };
  const visit = (node: ts.Node, title = ""): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test" &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) title = node.arguments[0].text;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "navigationCells") {
      const [door, axes, cells] = node.arguments;
      if (!door || !ts.isStringLiteral(door) || !axes || !cells || !ts.isArrayLiteralExpression(cells)) throw new Error("Door cells must be literal");
      expect(seeded.has(title), `Duplicate cell list for ${title}`).toBe(false);
      seeded.set(title, { door: door.text, axes: strings(axes), tuples: cells.elements.map(node => {
        const tuple = strings(node);
        const count = strings(axes).length;
        expect(tuple.length, "Every cell requires a literal outcome and label").toBe(count + 2);
        expect(["none", "opening", "opening+link", "expense", "expense+vehicle", "expense+vehicle+link", "vehicle", "vehicle+link", "sale", "sale+link", "application", "application+link"], "Unknown literal outcome").toContain(tuple[count]);
        expect(["none", "opening", "expense", "vehicle", "number+vehicle", "id", "number+id", "second+vehicle", "second+id"], "Unknown literal label").toContain(tuple[count + 1]);
        return tuple.slice(0, count);
      }) });
    }
    ts.forEachChild(node, child => visit(child, title));
  };
  visit(syntax);
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    for (const row of door.rows) {
      expect(registered.filter(test => test.title === row.title).length,
        `${updateTable}: ${door.name} / ${JSON.stringify(Object.fromEntries(Object.keys(door.axes).map((axis, index) => [axis, row.tuple[index]])))}: ${row.title}`).toBe(1);
      const fixture = seeded.get(row.title);
      expect(fixture?.door, row.title).toBe(door.name);
      expect(fixture?.axes, row.title).toStrictEqual(Object.keys(door.axes));
      expect(fixture?.tuples.filter(tuple => JSON.stringify(tuple) === JSON.stringify(row.tuple)).length,
        `${door.name}: unseeded or duplicate tuple ${JSON.stringify(row.tuple)}`).toBe(1);
    }
    const declared = door.rows.map(row => JSON.stringify(row.tuple)).sort();
    const executed = [...seeded.values()].filter(value => value.door === door.name).flatMap(value => value.tuples.map(tuple => JSON.stringify(tuple))).sort();
    expect(executed, `${door.name}: seeded and declared cells differ`).toStrictEqual(declared);
  }
};

export const checkEverySupplierNavigationDoorCoversItsRoundSixCoreAndNewBaseChoicePairs = () => {
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    const axes = Object.entries(door.axes);
    expect(axes.length, `${door.name}: no axes`).toBeGreaterThan(0);
    const tuples = requiredNavigationTuples(door);
    const key = (tuple: readonly string[]) => JSON.stringify(tuple);
    const expected = new Set(tuples.map(key));
    const covered = new Set<string>();
    for (const entry of [...door.rows, ...door.exemptions]) {
      const tupleKey = key(entry.tuple);
      expect(expected.has(tupleKey), `${door.name}: undeclared tuple ${tupleKey}`).toBe(true);
      expect(covered.has(tupleKey), `${door.name}: duplicate tuple ${tupleKey}`).toBe(false);
      if ("reason" in entry) {
        expect(entry.reason.trim().length, `${door.name}: empty exemption reason ${tupleKey}`).toBeGreaterThan(0);
        const named = Object.fromEntries(axes.map(([axis], index) => [axis, entry.tuple[index]]));
        const rules = {
          "native-no-number": named.shape === "native" && ["with", "second"].includes(named.dealNumber!),
          "no-application": ["native", "cash"].includes(named.shape!) && ["foreign", "missing"].includes(named.applicationTarget!),
        };
        expect(rules[entry.rule], `${door.name}: prose exemption cannot replace a feasible cell ${tupleKey}`).toBe(true);
      }
      covered.add(tupleKey);
    }
    for (const tuple of tuples) {
      const named = Object.fromEntries(axes.map(([axis], index) => [axis, tuple[index]]));
      expect(covered.has(key(tuple)), `${updateTable}: ${door.name}: missing tuple ${JSON.stringify(named)}`).toBe(true);
    }
  }
};

export const checkSupplierNavigationStatementFingerprintsRequireAReviewedDoorTableForEveryTokenChange = () => {
  assertNavigationFingerprints(parse("convex/utils/supplierNavigation.ts"));
};
