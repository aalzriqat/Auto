import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
/**
 * SCRUM-941: axes are the coverage oracle; rows cannot silently shrink that oracle.
 * Permissions belong to the door that reads them: saleSource reads view:sales;
 * vehicleSource reads view:vehicles. Expense identity itself reads neither.
 * The combined native/sale lookup includes both permissions even for native rows.
 * Lookup doors use reachable local targets for gates, POSTED drafts for ownership,
 * and local applications for financed sale/vehicle cells. Separate doors test refusals.
 * Missing and schema-impossible states are explicit exemptions below, never silent gaps.
 */
interface Door {
  name: string;
  kind: "owned" | "permission" | "status";
  site: string;
  axes: Readonly<Record<string, readonly string[]>>;
  rows: readonly { tuple: readonly string[]; title: string }[];
  exemptions: readonly { tuple: readonly string[]; reason: string }[];
}

export const SUPPLIER_NAVIGATION_DOORS: readonly Door[] = [
  { name: "sale lookup", kind: "owned", site: "saleSource: sales",
    axes: {shape: ["cash", "financed"], target: ["local", "foreign", "deleted", "missing"], viewSales: ["with", "without"]},
    rows: [
      { tuple: ["cash", "local", "with"], title: "sale and expense sources use existing record screens and supplier economic role" },
      { tuple: ["cash", "local", "without"], title: "cash supplier sale keeps its label without a link for a viewer without sales" },
      { tuple: ["cash", "foreign", "with"], title: "foreign sale enrichment discloses no source, sale id or deal number" },
      { tuple: ["cash", "foreign", "without"], title: "foreign cash sale enrichment discloses no source for a viewer without sales" },
      { tuple: ["cash", "deleted", "with"], title: "deleted sale enrichment discloses no source, sale id or deal number" },
      { tuple: ["cash", "deleted", "without"], title: "deleted cash sale enrichment discloses no source for a viewer without sales" },
      { tuple: ["financed", "local", "with"], title: "financed supplier sale links to its same-organization application for a sales viewer" },
      { tuple: ["financed", "local", "without"], title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
      { tuple: ["financed", "foreign", "with"], title: "foreign financed sale enrichment discloses no source for a viewer with sales" },
      { tuple: ["financed", "foreign", "without"], title: "foreign financed sale enrichment discloses no source for a viewer without sales" },
      { tuple: ["financed", "deleted", "with"], title: "deleted financed sale enrichment discloses no source for a viewer with sales" },
      { tuple: ["financed", "deleted", "without"], title: "deleted financed sale enrichment discloses no source for a viewer without sales" },
    ], exemptions: [
      { tuple: ["cash", "missing", "with"], reason: "readCached returns null for a missing sale with or without ownership filtering." },
      { tuple: ["cash", "missing", "without"], reason: "readCached returns null for a missing sale with or without ownership filtering." },
      { tuple: ["financed", "missing", "with"], reason: "readCached returns null for a missing sale with or without ownership filtering." },
      { tuple: ["financed", "missing", "without"], reason: "readCached returns null for a missing sale with or without ownership filtering." },
    ],
  },
  { name: "sales link gate", kind: "permission", site: "saleSource: VIEW_SALES (cash and financed)",
    axes: {shape: ["cash", "financed"], target: ["local"], viewSales: ["with", "without"]},
    rows: [
      { tuple: ["cash", "local", "with"], title: "sale and expense sources use existing record screens and supplier economic role" },
      { tuple: ["cash", "local", "without"], title: "cash supplier sale keeps its label without a link for a viewer without sales" },
      { tuple: ["financed", "local", "with"], title: "financed supplier sale links to its same-organization application for a sales viewer" },
      { tuple: ["financed", "local", "without"], title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
    ], exemptions: [
    ],
  },
  { name: "application lookup", kind: "owned", site: "saleSource: applications",
    axes: {shape: ["financed"], target: ["local", "foreign", "deleted", "missing"], viewSales: ["with", "without"]},
    rows: [
      { tuple: ["financed", "local", "with"], title: "financed supplier sale links to its same-organization application for a sales viewer" },
      { tuple: ["financed", "local", "without"], title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
      { tuple: ["financed", "foreign", "with"], title: "financed supplier sale with a foreign application exposes only the local sale without a link" },
      { tuple: ["financed", "foreign", "without"], title: "financed supplier sale with a foreign application exposes only the local sale for a viewer without sales" },
      { tuple: ["financed", "missing", "with"], title: "financed supplier sale with a deleted application exposes only the local sale without a link" },
      { tuple: ["financed", "missing", "without"], title: "financed supplier sale with a deleted application exposes only the local sale for a viewer without sales" },
    ], exemptions: [
      { tuple: ["financed", "deleted", "with"], reason: "financeApplications has no isDeleted field; hard deletion is the missing target state." },
      { tuple: ["financed", "deleted", "without"], reason: "financeApplications has no isDeleted field; hard deletion is the missing target state." },
    ],
  },
  { name: "opening lookup", kind: "owned", site: "sourceFor: openings",
    axes: {target: ["local", "foreign", "deleted", "missing"], status: ["POSTED"], manageFinance: ["with", "without"]},
    rows: [
      { tuple: ["local", "POSTED", "with"], title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
      { tuple: ["local", "POSTED", "without"], title: "posted opening keeps its label without a link for a viewer without finance management" },
      { tuple: ["foreign", "POSTED", "with"], title: "foreign opening draft enrichment discloses no source or draft id" },
      { tuple: ["foreign", "POSTED", "without"], title: "foreign opening draft discloses no source for a viewer without finance management" },
    ], exemptions: [
      { tuple: ["deleted", "POSTED", "with"], reason: "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state." },
      { tuple: ["deleted", "POSTED", "without"], reason: "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state." },
      { tuple: ["missing", "POSTED", "with"], reason: "readCached returns null for a missing opening draft with or without ownership filtering." },
      { tuple: ["missing", "POSTED", "without"], reason: "readCached returns null for a missing opening draft with or without ownership filtering." },
    ],
  },
  { name: "opening status gate", kind: "status", site: "sourceFor: POSTED",
    axes: {target: ["local"], status: ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"], manageFinance: ["with", "without"]},
    rows: [
      { tuple: ["local", "POSTED", "with"], title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
      { tuple: ["local", "POSTED", "without"], title: "posted opening keeps its label without a link for a viewer without finance management" },
      { tuple: ["local", "PENDING_APPROVAL", "with"], title: "pending opening draft yields no source even for a finance manager" },
      { tuple: ["local", "PENDING_APPROVAL", "without"], title: "pending approval opening yields no source without finance management" },
      { tuple: ["local", "REJECTED", "with"], title: "rejected opening yields no source with finance management" },
      { tuple: ["local", "REJECTED", "without"], title: "rejected opening yields no source without finance management" },
      { tuple: ["local", "VOIDED", "with"], title: "voided opening yields no source with finance management" },
      { tuple: ["local", "VOIDED", "without"], title: "voided opening yields no source without finance management" },
    ], exemptions: [
    ],
  },
  { name: "opening link gate", kind: "permission", site: "sourceFor: MANAGE_FINANCE",
    axes: {target: ["local"], status: ["POSTED"], manageFinance: ["with", "without"]},
    rows: [
      { tuple: ["local", "POSTED", "with"], title: "P5 opening payable and recovery navigate to the posted opening rather than a vehicle" },
      { tuple: ["local", "POSTED", "without"], title: "posted opening keeps its label without a link for a viewer without finance management" },
    ], exemptions: [
    ],
  },
  { name: "expense lookup", kind: "owned", site: "sourceFor: expenses",
    axes: {target: ["local", "foreign", "deleted", "missing"]},
    rows: [
      { tuple: ["local"], title: "sale and expense sources use existing record screens and supplier economic role" },
      { tuple: ["foreign"], title: "foreign expense enrichment discloses no source, expense id or title" },
      { tuple: ["deleted"], title: "deleted expense enrichment discloses no source, expense id or title" },
    ], exemptions: [
      { tuple: ["missing"], reason: "readCached returns null for a missing expense with or without ownership filtering." },
    ],
  },
  { name: "expense vehicle lookup", kind: "owned", site: "sourceFor: expense vehicles",
    axes: {target: ["local", "foreign", "deleted", "missing"], viewVehicles: ["with", "without"]},
    rows: [
      { tuple: ["local", "with"], title: "sale and expense sources use existing record screens and supplier economic role" },
      { tuple: ["local", "without"], title: "expense vehicle keeps its label without a link for a viewer without vehicles" },
      { tuple: ["foreign", "with"], title: "expense keeps its source but hides a foreign vehicle for a viewer with vehicles" },
      { tuple: ["foreign", "without"], title: "expense keeps its source but hides a foreign vehicle for a viewer without vehicles" },
      { tuple: ["deleted", "with"], title: "expense keeps its source but hides a deleted vehicle for a viewer with vehicles" },
      { tuple: ["deleted", "without"], title: "expense keeps its source but hides a deleted vehicle for a viewer without vehicles" },
    ], exemptions: [
      { tuple: ["missing", "with"], reason: "readCached returns null for a missing expense vehicle with or without ownership filtering." },
      { tuple: ["missing", "without"], reason: "readCached returns null for a missing expense vehicle with or without ownership filtering." },
    ],
  },
  { name: "native or sale vehicle lookup", kind: "owned", site: "sourceFor: native/sale vehicles",
    axes: {shape: ["native", "cash", "financed"], target: ["local", "foreign", "deleted", "missing"], viewSales: ["with", "without"], viewVehicles: ["with", "without"]},
    rows: [
      { tuple: ["native", "local", "with", "with"], title: "statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows" },
      { tuple: ["native", "local", "with", "without"], title: "local native vehicle keeps its label with sales and without vehicles" },
      { tuple: ["native", "local", "without", "with"], title: "local native vehicle keeps its label without sales and with vehicles" },
      { tuple: ["native", "local", "without", "without"], title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
      { tuple: ["native", "foreign", "with", "with"], title: "foreign native vehicle discloses no source with sales and with vehicles" },
      { tuple: ["native", "foreign", "with", "without"], title: "foreign native vehicle discloses no source with sales and without vehicles" },
      { tuple: ["native", "foreign", "without", "with"], title: "foreign native vehicle yields no source for a vehicle viewer" },
      { tuple: ["native", "foreign", "without", "without"], title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
      { tuple: ["native", "deleted", "with", "with"], title: "deleted native vehicle discloses no source with sales and with vehicles" },
      { tuple: ["native", "deleted", "with", "without"], title: "deleted native vehicle discloses no source with sales and without vehicles" },
      { tuple: ["native", "deleted", "without", "with"], title: "deleted native vehicle yields no source for a vehicle viewer" },
      { tuple: ["native", "deleted", "without", "without"], title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
      { tuple: ["cash", "local", "with", "with"], title: "cash sale keeps its local vehicle label with sales and with vehicles" },
      { tuple: ["cash", "local", "with", "without"], title: "cash sale keeps its local vehicle label with sales and without vehicles" },
      { tuple: ["cash", "local", "without", "with"], title: "cash sale keeps its local vehicle label without sales and with vehicles" },
      { tuple: ["cash", "local", "without", "without"], title: "cash supplier sale keeps its label without a link for a viewer without sales" },
      { tuple: ["cash", "foreign", "with", "with"], title: "local sale label hides its foreign vehicle for a viewer with vehicles" },
      { tuple: ["cash", "foreign", "with", "without"], title: "local sale label hides its foreign vehicle for a viewer without vehicles" },
      { tuple: ["cash", "foreign", "without", "with"], title: "cash sale hides its foreign vehicle label without sales and with vehicles" },
      { tuple: ["cash", "foreign", "without", "without"], title: "cash sale hides its foreign vehicle label without sales and without vehicles" },
      { tuple: ["cash", "deleted", "with", "with"], title: "local sale label hides its deleted vehicle for a viewer with vehicles" },
      { tuple: ["cash", "deleted", "with", "without"], title: "local sale label hides its deleted vehicle for a viewer without vehicles" },
      { tuple: ["cash", "deleted", "without", "with"], title: "cash sale hides its deleted vehicle label without sales and with vehicles" },
      { tuple: ["cash", "deleted", "without", "without"], title: "cash sale hides its deleted vehicle label without sales and without vehicles" },
      { tuple: ["financed", "local", "with", "with"], title: "financed sale keeps its local vehicle label with sales and with vehicles" },
      { tuple: ["financed", "local", "with", "without"], title: "financed supplier sale links to its same-organization application for a sales viewer" },
      { tuple: ["financed", "local", "without", "with"], title: "financed sale keeps its local vehicle label without sales and with vehicles" },
      { tuple: ["financed", "local", "without", "without"], title: "financed supplier sale preserves its application label without a link for a viewer without sales" },
      { tuple: ["financed", "foreign", "with", "with"], title: "financed sale hides its foreign vehicle label with sales and with vehicles" },
      { tuple: ["financed", "foreign", "with", "without"], title: "financed sale hides its foreign vehicle label with sales and without vehicles" },
      { tuple: ["financed", "foreign", "without", "with"], title: "financed sale hides its foreign vehicle label without sales and with vehicles" },
      { tuple: ["financed", "foreign", "without", "without"], title: "financed sale hides its foreign vehicle label without sales and without vehicles" },
      { tuple: ["financed", "deleted", "with", "with"], title: "financed sale hides its deleted vehicle label with sales and with vehicles" },
      { tuple: ["financed", "deleted", "with", "without"], title: "financed sale hides its deleted vehicle label with sales and without vehicles" },
      { tuple: ["financed", "deleted", "without", "with"], title: "financed sale hides its deleted vehicle label without sales and with vehicles" },
      { tuple: ["financed", "deleted", "without", "without"], title: "financed sale hides its deleted vehicle label without sales and without vehicles" },
    ], exemptions: [
      { tuple: ["native", "missing", "with", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["native", "missing", "with", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["native", "missing", "without", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["native", "missing", "without", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["cash", "missing", "with", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["cash", "missing", "with", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["cash", "missing", "without", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["cash", "missing", "without", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["financed", "missing", "with", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["financed", "missing", "with", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["financed", "missing", "without", "with"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
      { tuple: ["financed", "missing", "without", "without"], reason: "readCached returns null for a missing vehicle with or without ownership filtering." },
    ],
  },
  { name: "vehicle link gate", kind: "permission", site: "supplierVehicleHref: VIEW_VEHICLES (native and expense)",
    axes: {shape: ["native", "expense"], target: ["local"], viewVehicles: ["with", "without"]},
    rows: [
      { tuple: ["native", "local", "with"], title: "statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows" },
      { tuple: ["native", "local", "without"], title: "missing target permissions preserve labels without links and foreign or deleted targets disclose no label" },
      { tuple: ["expense", "local", "with"], title: "sale and expense sources use existing record screens and supplier economic role" },
      { tuple: ["expense", "local", "without"], title: "expense vehicle keeps its label without a link for a viewer without vehicles" },
    ], exemptions: [
    ],
  },
];

const root = join(__dirname, "..", "..");
const updateTable = "Update scripts/intelligence/supplierNavigationDoors.test.ts and its public-query test rows";

test("supplier navigation ownership calls and permission gates all have declared door rows", () => {
  const source = ts.createSourceFile("supplierNavigation.ts", readFileSync(join(root, "convex/utils/supplierNavigation.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const found = { owned: 0, permission: 0, status: 0 };
  // Count invocations, not helper declarations, comments or quoted examples.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "owned") found.owned += 1;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "includes") {
        const receiver = callee.expression;
        if ((ts.isIdentifier(receiver) && receiver.text === "permissions") ||
          (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "permissions")) found.permission += 1;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status" &&
      ts.isStringLiteral(node.right) && node.right.text === "POSTED") found.status += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declared = { owned: 0, permission: 0, status: 0 };
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    expect(door.rows.length, `${updateTable}: ${door.name} has no rows`).toBeGreaterThan(0);
    declared[door.kind] += 1;
  }
  expect(found, updateTable).toStrictEqual(declared);
});

test("every declared supplier navigation row names one active literal test registration", () => {
  const source = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const registered = listActiveTestRegistrations(source).filter(row => !row.parameterized);
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    for (const row of door.rows) {
      expect(registered.filter(test => test.title === row.title).length,
        `${updateTable}: ${door.name} / ${JSON.stringify(Object.fromEntries(Object.keys(door.axes).map((axis, index) => [axis, row.tuple[index]])))}: ${row.title}`).toBe(1);
    }
  }
});

test("every supplier navigation door covers its full axis cross product", () => {
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    const axes = Object.entries(door.axes);
    expect(axes.length, `${door.name}: no axes`).toBeGreaterThan(0);
    let tuples: string[][] = [[]];
    for (const [axis, values] of axes) {
      expect(values.length, `${door.name}: empty axis ${axis}`).toBeGreaterThan(0);
      expect(new Set(values).size, `${door.name}: duplicate values on ${axis}`).toBe(values.length);
      tuples = tuples.flatMap(tuple => values.map(value => [...tuple, value]));
    }
    const key = (tuple: readonly string[]) => JSON.stringify(tuple);
    const expected = new Set(tuples.map(key));
    const covered = new Set<string>();
    for (const entry of [...door.rows, ...door.exemptions]) {
      const tupleKey = key(entry.tuple);
      expect(expected.has(tupleKey), `${door.name}: undeclared tuple ${tupleKey}`).toBe(true);
      expect(covered.has(tupleKey), `${door.name}: duplicate tuple ${tupleKey}`).toBe(false);
      if ("reason" in entry) expect(entry.reason.trim().length, `${door.name}: empty exemption reason ${tupleKey}`).toBeGreaterThan(0);
      covered.add(tupleKey);
    }
    for (const tuple of tuples) {
      const named = Object.fromEntries(axes.map(([axis], index) => [axis, tuple[index]]));
      expect(covered.has(key(tuple)), `${updateTable}: ${door.name}: missing tuple ${JSON.stringify(named)}`).toBe(true);
    }
  }
});
