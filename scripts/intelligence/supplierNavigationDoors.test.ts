import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
/**
 * A door's axes are every condition its path evaluates.
 * SCRUM-941: conservatively require every condition in every local callable body
 * for every door; unreachable conditions need explicit reasons.
 * This over-approximation includes sibling branches, arrows, methods and local aliases.
 * Imports and error serialization (supplierNavigationFailure) are outside this file scan.
 * Cells are literal lists independent of the declared cross product, seeded and read back
 * through the public statement query. Missing targets are tested, not ownership mutants.
 */
interface Door {
  name: string;
  kind: "owned" | "permission" | "status";
  site: string;
  axes: Readonly<Record<string, readonly string[]>>;
  axisExemptions: Readonly<Record<string, string>>;
  rows: readonly { tuple: readonly string[]; title: string }[];
  exemptions: readonly { tuple: readonly string[]; reason: string; noDeletedTable?: string }[];
}

export const SUPPLIER_NAVIGATION_DOORS: readonly Door[] = [
  { name: "sale lookup", kind: "owned", site: "saleSource: sales",
    axes: {"shape": ["cash", "financed"], "target": ["local", "foreign", "deleted", "missing"], "viewSales": ["with", "without"], "dealNumber": ["with", "without"], "vehicle": ["local", "hidden"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "viewVehicles": "Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["cash", "local", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "with", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "with", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "without", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "without", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "with", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "with", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "without", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "without", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "local"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "hidden"], "title": "sale lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "local"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "hidden"], "title": "sale lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "sales link gate", kind: "permission", site: "saleSource: VIEW_SALES",
    axes: {"shape": ["cash", "financed"], "target": ["local"], "viewSales": ["with", "without"], "dealNumber": ["with", "without"], "vehicle": ["local", "hidden"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "target": "This link/status gate is reached only after local ownership; foreign, deleted and missing targets are exercised by its lookup door.", "viewVehicles": "Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["cash", "local", "with", "with", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "with", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "local"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "hidden"], "title": "sales link gate checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "application lookup", kind: "owned", site: "saleSource: applications",
    axes: {"shape": ["financed"], "target": ["local", "foreign", "deleted", "missing"], "viewSales": ["with", "without"], "dealNumber": ["with", "without"], "vehicle": ["local", "hidden"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "applicationId must be present to reach the application lookup; cash sales return before it.", "viewVehicles": "Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["financed", "local", "with", "with", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "local"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "hidden"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "local"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "hidden"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "local"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "hidden"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "local"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "hidden"], "title": "application lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "local"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "hidden"], "title": "application lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
      {"tuple": ["financed", "deleted", "with", "with", "local"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "with", "with", "hidden"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "with", "without", "local"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "with", "without", "hidden"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "without", "with", "local"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "without", "with", "hidden"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "without", "without", "local"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
      {"tuple": ["financed", "deleted", "without", "without", "hidden"], "reason": "financeApplications has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "financeApplications"},
    ],
  },
  { name: "opening lookup", kind: "owned", site: "sourceFor: openings",
    axes: {"target": ["local", "foreign", "deleted", "missing"], "status": ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"], "manageFinance": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "Opening origin selects this branch before native/expense/sale dispatch.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "vehicle": "Opening returns before any vehicle lookup.", "viewVehicles": "Opening returns before vehicleSource and supplierVehicleHref."},
    rows: [
      {"tuple": ["local", "POSTED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "POSTED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "PENDING_APPROVAL", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "PENDING_APPROVAL", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "REJECTED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "REJECTED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "VOIDED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "VOIDED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["foreign", "POSTED", "with"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "POSTED", "without"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "PENDING_APPROVAL", "with"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "PENDING_APPROVAL", "without"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "REJECTED", "with"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "REJECTED", "without"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "VOIDED", "with"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "VOIDED", "without"], "title": "opening lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["missing", "POSTED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "POSTED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "PENDING_APPROVAL", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "PENDING_APPROVAL", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "REJECTED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "REJECTED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "VOIDED", "with"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "VOIDED", "without"], "title": "opening lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
      {"tuple": ["deleted", "POSTED", "with"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "POSTED", "without"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "PENDING_APPROVAL", "with"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "PENDING_APPROVAL", "without"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "REJECTED", "with"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "REJECTED", "without"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "VOIDED", "with"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
      {"tuple": ["deleted", "VOIDED", "without"], "reason": "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", "noDeletedTable": "openingBalanceDrafts"},
    ],
  },
  { name: "opening status gate", kind: "status", site: "sourceFor: POSTED",
    axes: {"target": ["local"], "status": ["POSTED", "PENDING_APPROVAL", "REJECTED", "VOIDED"], "manageFinance": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "Opening origin selects this branch before native/expense/sale dispatch.", "target": "This link/status gate is reached only after local ownership; foreign, deleted and missing targets are exercised by its lookup door.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "vehicle": "Opening returns before any vehicle lookup.", "viewVehicles": "Opening returns before vehicleSource and supplierVehicleHref."},
    rows: [
      {"tuple": ["local", "POSTED", "with"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "POSTED", "without"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "PENDING_APPROVAL", "with"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "PENDING_APPROVAL", "without"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "REJECTED", "with"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "REJECTED", "without"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "VOIDED", "with"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "VOIDED", "without"], "title": "opening status gate checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "opening link gate", kind: "permission", site: "sourceFor: MANAGE_FINANCE",
    axes: {"target": ["local"], "status": ["POSTED"], "manageFinance": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "Opening origin selects this branch before native/expense/sale dispatch.", "target": "This link/status gate is reached only after local ownership; foreign, deleted and missing targets are exercised by its lookup door.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "vehicle": "Opening returns before any vehicle lookup.", "viewVehicles": "Opening returns before vehicleSource and supplierVehicleHref.", "status": "Only POSTED reaches the opening link; the opening status door exercises every other status."},
    rows: [
      {"tuple": ["local", "POSTED", "with"], "title": "opening link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "POSTED", "without"], "title": "opening link gate checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "expense lookup", kind: "owned", site: "sourceFor: expenses",
    axes: {"target": ["local", "foreign", "deleted", "missing"], "vehicle": ["local", "hidden"], "viewVehicles": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "expenseId selects this branch before native/sale dispatch.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["local", "local", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "local", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "hidden", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "hidden", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["foreign", "local", "with"], "title": "expense lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "local", "without"], "title": "expense lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "hidden", "with"], "title": "expense lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "hidden", "without"], "title": "expense lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["deleted", "local", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["deleted", "local", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["deleted", "hidden", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["deleted", "hidden", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "local", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "local", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "hidden", "with"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "hidden", "without"], "title": "expense lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "expense vehicle lookup", kind: "owned", site: "sourceFor: expense vehicles",
    axes: {"target": ["local", "foreign", "deleted", "missing"], "viewVehicles": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "shape": "expenseId selects this branch before native/sale dispatch.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "vehicle": "Vehicle visibility is the target axis on this vehicle door; testing it twice would create inconsistent fixtures.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["local", "with"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["local", "without"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["foreign", "with"], "title": "expense vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["foreign", "without"], "title": "expense vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["deleted", "with"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["deleted", "without"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "with"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["missing", "without"], "title": "expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
  { name: "native or sale vehicle lookup", kind: "owned", site: "sourceFor: native/sale vehicles",
    axes: {"shape": ["native", "cash", "financed"], "target": ["local", "foreign", "deleted", "missing"], "viewSales": ["with", "without"], "viewVehicles": ["with", "without"], "dealNumber": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "vehicle": "Vehicle visibility is the target axis on this vehicle door; testing it twice would create inconsistent fixtures.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["native", "local", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "local", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "local", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "local", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "foreign", "with", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["native", "foreign", "with", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["native", "foreign", "without", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["native", "foreign", "without", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["native", "deleted", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "deleted", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "deleted", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "deleted", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "missing", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "missing", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "missing", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "missing", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "local", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "with", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "without", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "with", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "with", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "without", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "foreign", "without", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "deleted", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["cash", "missing", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "local", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "with", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "with", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "with"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "foreign", "without", "without", "without"], "title": "native or sale vehicle lookup refuses foreign targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "deleted", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "with", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "with", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "with"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["financed", "missing", "without", "without", "without"], "title": "native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
      {"tuple": ["native", "local", "with", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "local", "with", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "local", "without", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "local", "without", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "foreign", "with", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "foreign", "with", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "foreign", "without", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "foreign", "without", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "deleted", "with", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "deleted", "with", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "deleted", "without", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "deleted", "without", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "missing", "with", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "missing", "with", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "missing", "without", "with", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
      {"tuple": ["native", "missing", "without", "without", "with"], "reason": "Native obligations have no sale; a present sale dealNumber cannot be seeded."},
    ],
  },
  { name: "vehicle link gate", kind: "permission", site: "supplierVehicleHref: VIEW_VEHICLES",
    axes: {"shape": ["native", "expense"], "target": ["local"], "viewVehicles": ["with", "without"]},
    axisExemptions: {"timestamp": "createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.", "role": "row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.", "identity": "Convex document ids are mandatory non-null system fields, so their presence cannot vary; source ids and fallback labels are asserted against seeded ids.", "target": "This link/status gate is reached only after local ownership; foreign, deleted and missing targets are exercised by its lookup door.", "viewSales": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "dealNumber": "Opening and expense/native paths never enter saleSource; sale labels and sales permissions cannot change this door.", "vehicle": "Vehicle visibility is the target axis on this vehicle door; testing it twice would create inconsistent fixtures.", "status": "Only opening obligations read draft.status; this branch has no opening draft.", "manageFinance": "Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link."},
    rows: [
      {"tuple": ["native", "local", "with"], "title": "vehicle link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["native", "local", "without"], "title": "vehicle link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["expense", "local", "with"], "title": "vehicle link gate checks local deleted and missing targets across every navigation condition"},
      {"tuple": ["expense", "local", "without"], "title": "vehicle link gate checks local deleted and missing targets across every navigation condition"},
    ], exemptions: [
    ],
  },
];


const root = join(__dirname, "..", "..");
const updateTable = "Update scripts/intelligence/supplierNavigationDoors.test.ts and its public-query test rows";
const parse = (file: string) => ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);

// One literal map: an unrecognized condition must fail before any axis exemptions apply.
const CONDITION_AXIS: Readonly<Record<string, string>> = {
  "doc.orgId": "target", "doc.isDeleted": "target", "present:doc": "target",
  "present:sale": "target", "present:app": "target",
  "sale.dealNumber": "dealNumber", "sale.applicationId": "shape", "sale._id": "identity", "app._id": "identity", "vehicle._id": "identity",
  "nullable:vehicleLabel": "vehicle", "nullable:vehicle": "vehicle",
  "draft.status": "status", "obligation.origin": "shape", "obligation.vehicleId": "shape",
  "obligation.expenseId": "shape", "obligation.saleId": "shape",
  "obligation.createdAt": "timestamp", "row.kind": "role", "entry.document": "shape",
  "PERMISSIONS.VIEW_SALES": "viewSales", "PERMISSIONS.VIEW_VEHICLES": "viewVehicles",
  "PERMISSIONS.MANAGE_FINANCE": "manageFinance",
};

function navigationConditions(source: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const nullable = new Set<string>();
  const aliases = new Map<string, Array<ts.Expression | string>>();
  const types = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node.type]));
  const isNullable = (type: ts.TypeNode | undefined, seen = new Set<string>()): boolean => {
    if (!type) return false;
    if (ts.isLiteralTypeNode(type)) return type.literal.kind === ts.SyntaxKind.NullKeyword;
    if (ts.isUnionTypeNode(type)) return type.types.some(child => isNullable(child, seen));
    if (ts.isParenthesizedTypeNode(type)) return isNullable(type.type, seen);
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName.getText(source);
      if (seen.has(name)) return false;
      return isNullable(types.get(name), new Set([...seen, name]));
    }
    return false;
  };
  const index = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
      aliases.set(node.left.text, [...(aliases.get(node.left.text) ?? []), node.right]);
    }
    if (ts.isParameter(node) && (node.questionToken || isNullable(node.type))) nullable.add(node.name.getText(source));
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const add = (name: string, value: ts.Expression | string) => aliases.set(name, [...(aliases.get(name) ?? []), value]);
      if (ts.isIdentifier(node.name)) add(node.name.text, node.initializer);
      if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
        if (!binding.dotDotDotToken && ts.isIdentifier(binding.name)) {
          const property = binding.propertyName ?? binding.name;
          const key = ts.isStringLiteral(property) ? property.text : property.getText(source);
          add(binding.name.text, `${node.initializer.getText(source)}.${key}`);
        }
      }
    }
    ts.forEachChild(node, index);
  };
  index(source);
  const collected = new Set<ts.Node>();
  const collect = (node: ts.Node): void => {
    if (collected.has(node)) return;
    collected.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = node.expression.getText(source);
      if (!["args", "args.cache", "args.permissions", "permissions", "ctx", "Math", "Number"].includes(receiver)) found.add(`${receiver}.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : `[${node.argumentExpression.getText(source)}]`;
      found.add(`${node.expression.getText(source)}.${key}`);
    }
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) {
      if (nullable.has(node.text)) found.add(`nullable:${node.text}`);
      if (["doc", "sale", "app"].includes(node.text)) found.add(`present:${node.text}`);
      for (const dependency of aliases.get(node.text) ?? []) {
        if (typeof dependency === "string") found.add(dependency);
        else collect(dependency);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteral(node.left)) found.add(`${node.right.getText(source)}.${node.left.text}`);
    ts.forEachChild(node, collect);
  };
  // Scan all local bodies, including arrows, methods and unused helpers, so a
  // callable's declaration form cannot hide a condition. Imports are outside this file.
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "supplierNavigationFailure") return;
    if (ts.isConditionalExpression(node)) collect(node);
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node) || ts.isCaseClause(node)) collect(node.expression);
    if (ts.isForStatement(node) && node.condition) collect(node.condition);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) collect(node.operand);
    if (ts.isBinaryExpression(node) && ["??", "&&", "||", "===", "!==", "==", "!=", "<", ">", "<=", ">=", "in", "instanceof"].includes(node.operatorToken.getText(source))) collect(node);
    if (ts.isTemplateExpression(node)) for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
      if (ts.isConditionalExpression(parent)) { collect(node); break; }
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "PERMISSIONS") found.add(node.getText(source));
    if (ts.isElementAccessExpression(node) && node.expression.getText(source) === "PERMISSIONS") collect(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(source.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === "sourceFor"), "navigation source must contain sourceFor").toBe(true);
  expect(found.size, "condition oracle must measure nonempty source").toBeGreaterThan(0);
  return found;
}

function navigationSites(source: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node, fn = ""): void => {
    if (ts.isFunctionDeclaration(node)) fn = node.name?.text ?? "";
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "owned") {
      const cache = node.arguments[2];
      expect(cache && ts.isPropertyAccessExpression(cache), "owned site must name its cache").toBe(true);
      let table = (cache as ts.PropertyAccessExpression).name.text;
      if (table === "vehicles") {
        let expense = false;
        for (let parent = node.parent; parent && !ts.isFunctionDeclaration(parent); parent = parent.parent) {
          if (ts.isIfStatement(parent) && ts.isBinaryExpression(parent.expression) && parent.expression.operatorToken.kind === ts.SyntaxKind.InKeyword &&
            ts.isStringLiteral(parent.expression.left) && parent.expression.left.text === "expenseId" &&
            ts.isIdentifier(parent.expression.right) && parent.expression.right.text === "obligation" &&
            parent.thenStatement.pos <= node.pos && parent.thenStatement.end >= node.end) expense = true;
        }
        table = expense ? "expense vehicles" : "native/sale vehicles";
      }
      sites.push(`${fn}: ${table}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes" &&
      node.arguments.some(arg => ts.isPropertyAccessExpression(arg) && arg.expression.getText(source) === "PERMISSIONS")) {
      sites.push(`${fn}: ${(node.arguments[0] as ts.PropertyAccessExpression).name.text}`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status" && ts.isStringLiteral(node.right) && node.right.text === "POSTED") sites.push(`${fn}: POSTED`);
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  return sites.sort();
}

test("supplier navigation ownership calls and permission gates all have declared door rows", () => {
  // Permanent controls for parser forms that a declaration-only call graph missed.
  for (const [code, condition] of [
    ['function sourceFor(sale: {status: string}) { switch (sale.status) { case "X": return null; } }', "sale.status"],
    ['const gate = (sale: {status: string}) => sale.status === "X"; function sourceFor() { return gate; }', "sale.status"],
    ['const gate = { check(sale: {status: string}) { return sale.status === "X"; } }; function sourceFor() { return gate.check; }', "sale.status"],
    ['function sourceFor(sale: {status: string}) { const state = sale.status; if (state === "X") return null; }', "sale.status"],
    ['function sourceFor(sale: {status: string}) { const {status: state} = sale; if (state === "X") return null; }', "sale.status"],
    ['function sourceFor(sale: {status: string}) { let state: string; state = sale.status; if (state === "X") return null; }', "sale.status"],
    ['type Label = string | null; function sourceFor(label: Label) { if (label) return null; }', "nullable:label"],
  ]) {
    expect(navigationConditions(ts.createSourceFile("probe.ts", code!, ts.ScriptTarget.Latest, true)).has(condition!), condition).toBe(true);
  }
  const source = parse("convex/utils/supplierNavigation.ts");
  const conditions = navigationConditions(source);
  for (const condition of conditions) {
    const axis = CONDITION_AXIS[condition];
    expect(axis, `Unmapped navigation condition: ${condition}`).toBeDefined();
    for (const door of SUPPLIER_NAVIGATION_DOORS) {
      const values = door.axes[axis];
      const reason = door.axisExemptions[axis];
      expect((values?.length ?? 0) >= 2 || (reason?.trim().length ?? 0) > 30,
        `${updateTable}: ${door.name} must declare axis ${axis} for ${condition}, or explain why it cannot change the result`).toBe(true);
    }
  }
  const sites = navigationSites(source);
  expect(new Set(sites).size, "duplicate source sites need distinct door identities").toBe(sites.length);
  expect(sites, updateTable).toStrictEqual(SUPPLIER_NAVIGATION_DOORS.map(door => door.site).sort());
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    expect(door.rows.length, door.name).toBeGreaterThan(0);
    const kind = door.site.endsWith(": POSTED") ? "status" : /: (VIEW_|MANAGE_)/.test(door.site) ? "permission" : "owned";
    expect(door.kind, door.site).toBe(kind);
  }
  // Check schema-impossible exemptions against the schema AST, not prose (SCRUM-941).
  const schema = parse("convex/schema.ts");
  const tables = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      let value = node.initializer;
      while (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) value = value.expression.expression;
      if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "defineTable" &&
        value.arguments[0] && ts.isObjectLiteralExpression(value.arguments[0])) tables.set(node.name.getText(schema), value.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(schema);
  for (const door of SUPPLIER_NAVIGATION_DOORS) for (const exemption of door.exemptions) {
    if (!exemption.reason.includes("has no isDeleted field")) continue;
    expect(exemption.noDeletedTable, exemption.reason).toBeDefined();
    const table = tables.get(exemption.noDeletedTable!);
    expect(table, exemption.reason).toBeDefined();
    const fields = table!.properties.map(prop => {
      if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) throw new Error(`Cannot measure schema fields for ${exemption.noDeletedTable}`);
      return prop.name.text;
    });
    expect(fields, exemption.reason).not.toContain("isDeleted");
  }
});

test("every declared supplier navigation row names one active literal test registration", () => {
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
      seeded.set(title, { door: door.text, axes: strings(axes), tuples: cells.elements.map(strings) });
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
