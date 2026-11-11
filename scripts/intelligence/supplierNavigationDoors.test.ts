import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
/**
 * Closed-world scan boundary: convex/utils/supplierNavigation.ts only. Imported
 * helper bodies are outside it; the complete import list and bindings are pinned.
 * Syntax-only allowlists deliberately refuse aliases, renamed shapes and new forms
 * until they are reviewed and listed. A reused name cannot bypass the site counts.
 * Every runtime callable, property read and branching form is scanned, including
 * returned properties, optional chains and the error/decoration catch path.
 * Cells are literal decision-table outcomes, not a production-decision oracle.
 * Pairwise mutations complement the full feasible axis products; this is not MC/DC certification.
 * Design: ISTQB CTFL 4.0.1 decision tables; NIST ACTS; NASA MC/DC guidance;
 * OWASP Authorization Cheat Sheet (deny by default); TypeScript compiler API;
 * stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/.
 */
interface Door {
 name: string; kind: "owned" | "permission" | "status"; site: string;
 axes: Readonly<Record<string, readonly string[]>>;
 axisExemptions: Readonly<Record<string, string>>;
 rows: readonly {tuple: readonly string[]; title: string}[];
 exemptions: readonly {tuple: readonly string[]; reason: string; rule: "no-application" | "native-no-number"}[];
}
export const SUPPLIER_NAVIGATION_DOORS: readonly Door[] = [
 { name: "sale lookup", kind: "owned", site: "saleSource: sales",
 axes: {"shape":["cash","financed"],"saleTarget":["local","foreign","deleted","missing"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without"],"vehicle":["local","foreign","deleted","missing"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["cash","local","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","local"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","foreign"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","deleted"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","missing"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","local"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","foreign"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","deleted"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","missing"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
  {"tuple":["cash","local","foreign","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
]},
 { name: "sales link gate", kind: "permission", site: "saleSource: VIEW_SALES",
 axes: {"shape":["cash","financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without"],"vehicle":["local","foreign","deleted","missing"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"This downstream door is reached only after sale ownership; sale lookup covers foreign, deleted and missing sales. For the earlier vehicle read those sale states yield no source, so its vehicle label is unobservable.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["cash","local","local","with","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing"],"title":"sales link gate checks local targets across every navigation condition"},
], exemptions: [
  {"tuple":["cash","local","foreign","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","local"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","foreign"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","deleted"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","missing"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
]},
 { name: "application lookup", kind: "owned", site: "saleSource: applications",
 axes: {"shape":["financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without"],"vehicle":["local","foreign","deleted","missing"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This downstream door is reached only after sale ownership; sale lookup covers foreign, deleted and missing sales. For the earlier vehicle read those sale states yield no source, so its vehicle label is unobservable.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["financed","local","local","with","with","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
]},
 { name: "opening lookup", kind: "owned", site: "sourceFor: openings",
 axes: {"shape":["opening"],"draftTarget":["local","foreign","missing"],"status":["POSTED","PENDING_APPROVAL","REJECTED","VOIDED"],"manageFinance":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated."},
 rows: [
  {"tuple":["opening","local","POSTED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","foreign","POSTED","with"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","POSTED","without"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","PENDING_APPROVAL","with"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","PENDING_APPROVAL","without"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","REJECTED","with"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","REJECTED","without"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","VOIDED","with"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","VOIDED","without"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","missing","POSTED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","POSTED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","PENDING_APPROVAL","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","PENDING_APPROVAL","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","REJECTED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","REJECTED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","VOIDED","with"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","VOIDED","without"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
]},
 { name: "opening status gate", kind: "status", site: "sourceFor: POSTED",
 axes: {"shape":["opening"],"draftTarget":["local"],"status":["POSTED","PENDING_APPROVAL","REJECTED","VOIDED"],"manageFinance":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated."},
 rows: [
  {"tuple":["opening","local","POSTED","with"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","with"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","without"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","with"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","without"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","with"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","without"],"title":"opening status gate checks local targets across every navigation condition"},
], exemptions: [
]},
 { name: "opening link gate", kind: "permission", site: "sourceFor: MANAGE_FINANCE",
 axes: {"shape":["opening"],"draftTarget":["local"],"status":["POSTED"],"manageFinance":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"The link gate is reached only after the draft status check accepts POSTED. Opening lookup and status-gate cells exercise every unposted status and null draft result."},
 rows: [
  {"tuple":["opening","local","POSTED","with"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without"],"title":"opening link gate checks local targets across every navigation condition"},
], exemptions: [
]},
 { name: "expense lookup", kind: "owned", site: "sourceFor: expenses",
 axes: {"shape":["expense"],"expenseTarget":["local","foreign","deleted","missing"],"vehicle":["local","foreign","deleted","missing"],"viewVehicles":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["expense","local","local","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","foreign","local","with"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","local","without"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","foreign","with"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","foreign","without"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","deleted","with"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","deleted","without"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","missing","with"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","missing","without"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","deleted","local","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","local","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","foreign","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","foreign","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","deleted","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","deleted","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","missing","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","missing","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","local","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","local","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","foreign","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","foreign","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","deleted","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","deleted","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","missing","with"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","missing","without"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
]},
 { name: "expense vehicle lookup", kind: "owned", site: "sourceFor: expense vehicles",
 axes: {"shape":["expense"],"expenseTarget":["local"],"vehicle":["local","foreign","deleted","missing"],"viewVehicles":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["expense","local","local","with"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","with"],"title":"expense vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","local","foreign","without"],"title":"expense vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","local","deleted","with"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","without"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","with"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","without"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
]},
 { name: "native or sale vehicle lookup", kind: "owned", site: "sourceFor: native/sale vehicles",
 axes: {"shape":["native","cash","financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"vehicle":["local","foreign","deleted","missing"],"viewSales":["with","without"],"viewVehicles":["with","without"],"dealNumber":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"sourceFor reads the vehicle before saleSource. A foreign, deleted or missing sale forces source:null, so that vehicle label is unobservable; sale lookup cells cross sale state. Vehicle lookup cells use a local sale and explicitly cross application state.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["native","local","local","local","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","with","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","with","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","without","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","without","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","with","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","with","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","without","with"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","without","without"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","with"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","without"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
], exemptions: [
  {"tuple":["native","local","local","local","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","with","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","with","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","without","with","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","without","without","with"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","with","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","with","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","without","with"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","without","without"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
]},
 { name: "vehicle link gate", kind: "permission", site: "supplierVehicleHref: VIEW_VEHICLES",
 axes: {"shape":["native","expense"],"expenseTarget":["local"],"vehicle":["local"],"viewVehicles":["with","without"]},
 axisExemptions: {"timestamp":"createdAt changes occurredAt only; this door decorates source, with the seeded timestamp asserted separately.","role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"supplierVehicleHref is called only for an owned local vehicle. Native/sale and expense vehicle lookup cells cover foreign, deleted and missing vehicles before this gate.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["native","local","local","with"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","without"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","with"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","without"],"title":"vehicle link gate checks local targets across every navigation condition"},
], exemptions: [
]},
];
const root = join(__dirname, "..", "..");
const updateTable = "Update scripts/intelligence/supplierNavigationDoors.test.ts and its public-query test rows";
const parse = (file: string) => ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);

const CALLABLES = [
  "owned",
  "supplierVehicleLabel",
  "supplierVehicleHref",
  "saleSource",
  "vehicleSource",
  "sourceFor",
  "addSupplierRowContext",
  "supplierNavigationFailure"
];
const IMPORT_FORMS = [
  "import{ConvexError,v,typeInfer}from\"convex/values\";",
  "importtype{Doc,Id}from\"../_generated/dataModel\";",
  "importtype{QueryCtx}from\"../_generated/server\";",
  "import{PERMISSIONS}from\"./permissions\";",
  "importtype{ObligationKind}from\"./supplierObligationDue\";",
  "importtype{SupplierObligation}from\"./supplierSettledRows\";",
  "import{readCached,SupplierReadBudgetExhausted,typeCachedTable,typeSupplierReadCache}from\"./supplierReadCache\";",
  "import{inTurn}from\"./transactionReadHeadroom\";"
];
const PROPERTY_FORMS = [
  "module:v.object",
  "module:v.union",
  "module:v.literal",
  "module:v.string",
  "module:v.null",
  "module:v.number",
  "module:v.optional",
  "owned:doc.orgId",
  "owned:doc.isDeleted",
  "supplierVehicleLabel:vehicle.year",
  "supplierVehicleLabel:vehicle.make",
  "supplierVehicleLabel:vehicle.model",
  "supplierVehicleHref:permissions.includes",
  "supplierVehicleHref:PERMISSIONS.VIEW_VEHICLES",
  "saleSource:args.orgId",
  "saleSource:args.cache.sales",
  "saleSource:args.cache",
  "saleSource:args.permissions.includes",
  "saleSource:args.permissions",
  "saleSource:PERMISSIONS.VIEW_SALES",
  "saleSource:sale.dealNumber",
  "saleSource:sale._id",
  "saleSource:sale.applicationId",
  "saleSource:args.cache.applications",
  "saleSource:app._id",
  "vehicleSource:vehicle._id",
  "vehicleSource:args.orgId",
  "vehicleSource:args.permissions",
  "sourceFor:obligation.origin",
  "sourceFor:args.orgId",
  "sourceFor:args.cache.openings",
  "sourceFor:args.cache",
  "sourceFor:obligation.openingBalanceDraftId",
  "sourceFor:draft?.status",
  "sourceFor:args.permissions.includes",
  "sourceFor:args.permissions",
  "sourceFor:PERMISSIONS.MANAGE_FINANCE",
  "sourceFor:draft._id",
  "sourceFor:obligation.title",
  "sourceFor:args.cache.expenses",
  "sourceFor:obligation.expenseId",
  "sourceFor:args.cache.vehicles",
  "sourceFor:obligation.vehicleId",
  "sourceFor:expense._id",
  "sourceFor:expense.title",
  "sourceFor:obligation.saleId",
  "addSupplierRowContext:section.rows",
  "addSupplierRowContext:Number.isSafeInteger",
  "addSupplierRowContext:obligation.createdAt",
  "addSupplierRowContext:Math.abs",
  "addSupplierRowContext:row.kind",
  "addSupplierRowContext:obligation.sourcedFromName",
  "addSupplierRowContext:Object.assign",
  "addSupplierRowContext:rows.push",
  "supplierNavigationFailure:error.data",
  "supplierNavigationFailure:console.error"
];
const CALL_FORMS = [
  "module:v.object",
  "module:v.union",
  "module:v.literal",
  "module:v.string",
  "module:v.null",
  "module:v.number",
  "module:v.optional",
  "owned:readCached",
  "supplierVehicleHref:permissions.includes",
  "saleSource:owned",
  "saleSource:args.permissions.includes",
  "vehicleSource:supplierVehicleLabel",
  "vehicleSource:supplierVehicleHref",
  "sourceFor:owned",
  "sourceFor:args.permissions.includes",
  "sourceFor:vehicleSource",
  "sourceFor:saleSource",
  "sourceFor:supplierVehicleLabel",
  "addSupplierRowContext:inTurn",
  "addSupplierRowContext:Number.isSafeInteger",
  "addSupplierRowContext:Math.abs",
  "addSupplierRowContext:Object.assign",
  "addSupplierRowContext:sourceFor",
  "addSupplierRowContext:rows.push",
  "supplierNavigationFailure:console.error"
];
const READ_FORMS = [
  "owned:readCached(ctx,cache,id)",
  "saleSource:owned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:owned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)"
];
const CONDITION_AXIS : Readonly<Record<string, readonly string[]>> = {
  "owned:!doc||!(\"orgId\"indoc)||doc.orgId!==orgId": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!doc||!(\"orgId\"indoc)": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!doc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!(\"orgId\"indoc)": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"orgId\"indoc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:doc.orgId!==orgId": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"isDeleted\"indoc&&doc.isDeleted": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"isDeleted\"indoc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "supplierVehicleHref:permissions.includes(PERMISSIONS.VIEW_VEHICLES)": [
    "viewVehicles"
  ],
  "saleSource:!sale": [
    "saleTarget"
  ],
  "saleSource:sale.dealNumber": [
    "dealNumber"
  ],
  "saleSource:vehicleLabel??sale._id": [
    "vehicle",
    "identity"
  ],
  "saleSource:!sale.applicationId": [
    "shape"
  ],
  "saleSource:canOpen": [
    "viewSales"
  ],
  "saleSource:!app": [
    "applicationTarget"
  ],
  "vehicleSource:vehicle": [
    "vehicle"
  ],
  "sourceFor:\"origin\"inobligation&&obligation.origin===\"OPENING\"": [
    "shape"
  ],
  "sourceFor:\"origin\"inobligation": [
    "shape"
  ],
  "sourceFor:obligation.origin===\"OPENING\"": [
    "shape"
  ],
  "sourceFor:draft?.status!==\"POSTED\"": [
    "draftTarget",
    "status"
  ],
  "sourceFor:draft?.status": [
    "draftTarget",
    "status"
  ],
  "sourceFor:canOpen": [
    "manageFinance"
  ],
  "sourceFor:!(\"vehicleId\"inobligation)": [
    "shape"
  ],
  "sourceFor:\"vehicleId\"inobligation": [
    "shape"
  ],
  "sourceFor:\"expenseId\"inobligation": [
    "shape"
  ],
  "sourceFor:!expense": [
    "expenseTarget"
  ],
  "sourceFor:\"saleId\"inobligation&&obligation.saleId": [
    "shape"
  ],
  "sourceFor:\"saleId\"inobligation": [
    "shape"
  ],
  "sourceFor:vehicle": [
    "vehicle"
  ],
  "addSupplierRowContext:Number.isSafeInteger(obligation.createdAt)&&Math.abs(obligation.createdAt)<=8.64e15": [
    "timestamp"
  ],
  "addSupplierRowContext:Math.abs(obligation.createdAt)<=8.64e15": [
    "timestamp"
  ],
  "addSupplierRowContext:row.kind===\"PAYABLE\"": [
    "role"
  ],
  "addSupplierRowContext:error": [
    "budget"
  ],
  "addSupplierRowContext:!(errorinstanceofSupplierReadBudgetExhausted)": [
    "budget"
  ],
  "addSupplierRowContext:errorinstanceofSupplierReadBudgetExhausted": [
    "budget"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"&&error.data!==null&&\"code\"inerror.data": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"&&error.data!==null": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"": [
    "serialization"
  ],
  "supplierNavigationFailure:errorinstanceofConvexError": [
    "serialization"
  ],
  "supplierNavigationFailure:typeoferror.data===\"object\"": [
    "serialization"
  ],
  "supplierNavigationFailure:error.data!==null": [
    "serialization"
  ],
  "supplierNavigationFailure:\"code\"inerror.data": [
    "serialization"
  ]
};
function unsupported(source: ts.SourceFile, node: ts.Node, form: string): never {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  throw new Error(`Unsupported navigation ${form}: ${ts.SyntaxKind[node.kind]} at ${source.fileName}:${line}: ${node.getText(source).slice(0, 160)}`);
}
const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s+/g, "");

function conditionNode(node: ts.Node): ts.Node | undefined {
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCaseClause(node)) return node.expression;
  if (ts.isConditionalExpression(node)) return node.condition;
  if (ts.isForStatement(node)) return node.condition;
  if (ts.isCatchClause(node)) return node.variableDeclaration?.name ?? node;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return node;
  if (ts.isBinaryExpression(node) && ["??", "||", "&&", "??=", "||=", "&&=", "in", "instanceof", "===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(node.operatorToken.getText())) return node;
  if ((ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node)) && node.questionDotToken) return node;
  return undefined;
}

function checkPermissionForm(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const receiver = node.expression.expression;
  const text = compact(receiver, source);
  if (!text.includes("permissions")) return;
  if (!["permissions", "args.permissions"].includes(text) || node.expression.name.text !== "includes" || node.arguments.length !== 1) unsupported(source, node, "permission read (only permissions.includes(PERMISSIONS.NAME))");
  const permission = node.arguments[0]!;
  if (!ts.isPropertyAccessExpression(permission) || !ts.isIdentifier(permission.expression) || permission.expression.text !== "PERMISSIONS") unsupported(source, node, "permission argument (requires PERMISSIONS.NAME; no string literal)");
  return permission.name.text;
}

function checkCallable(source: ts.SourceFile, node: ts.Node, fn: string): string {
  if (ts.isFunctionDeclaration(node)) {
    if (!node.name || !CALLABLES.includes(node.name.text)) unsupported(source, node, "function declaration");
    return node.name.text;
  }
  if (ts.isArrowFunction(node)) {
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.expression.getText(source) !== "inTurn" || call.arguments[1] !== node || compact(node.parameters[0]!, source) !== "entry") unsupported(source, node, "arrow helper");
  }
  if (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) unsupported(source, node, "local callable");
  return fn;
}

function checkPermissionArrayRead(source: ts.SourceFile, node: ts.PropertyAccessExpression, fn: string) {
  if (node.name.text !== "permissions") return;
  const parent = node.parent;
  const includes = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "includes";
  const forward = fn === "vehicleSource" && ts.isCallExpression(parent) && parent.expression.getText(source) === "supplierVehicleHref" && parent.arguments[2] === node;
  if (!includes && !forward) unsupported(source, node, "permission array read (only includes or the listed vehicleSource forwarding site)");
}

function checkPropertyRead(source: ts.SourceFile, node: ts.PropertyAccessExpression, fn: string) {
    checkPermissionArrayRead(source, node, fn);
    if (node.name.text === "db") unsupported(source, node, "document read ctx.db");
    if (!PROPERTY_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "property read");
}

function checkBarePermissionRead(source: ts.SourceFile, node: ts.Node, fn: string) {
  if (!ts.isIdentifier(node) || node.text !== "permissions" || fn !== "supplierVehicleHref") return;
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) return;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "includes") return;
  unsupported(source, node, "permission array binding / read");
}

function checkRuntimeForm(source: ts.SourceFile, node: ts.Node, fn: string) {
  checkBarePermissionRead(source, node, fn);
  if (ts.isSpreadElement(node)) unsupported(source, node, "permission / array spread");
  if (ts.isNewExpression(node) && node.expression.getText(source) !== "ConvexError") unsupported(source, node, "constructor / permission collection");
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) unsupported(source, node, "iteration branch");
  if (ts.isElementAccessExpression(node) && !(fn === "supplierNavigationFailure" && compact(node, source) === "READ_FAILURE_MESSAGE[code]")) unsupported(source, node, "element access / branch truth table");
  if (ts.isPropertyAccessExpression(node)) checkPropertyRead(source, node, fn);
  if (ts.isObjectBindingPattern(node) && compact(node, source) !== "{document:obligation,...row}") unsupported(source, node, "destructured binding");
  if (ts.isCallExpression(node) && !CALL_FORMS.includes(`${fn}:${compact(node.expression, source)}`)) unsupported(source, node, "call / permission member");
}

type NavigationScan = {imports: string[]; functions: string[]; reads: string[]; arrows: number};
function recordNavigationDeclarations(source: ts.SourceFile, node: ts.Node, fn: string, scan: NavigationScan) {
    if (ts.isImportDeclaration(node)) {
      if (!IMPORT_FORMS.includes(compact(node, source))) unsupported(source, node, "import");
      if (scan.imports.includes(compact(node, source))) unsupported(source, node, "duplicate import");
      scan.imports.push(compact(node, source));
    }
    if (ts.isFunctionDeclaration(node)) { if (scan.functions.includes(fn)) unsupported(source, node, "duplicate function declaration"); scan.functions.push(fn); }
    if (ts.isArrowFunction(node)) { if (scan.arrows > 0) unsupported(source, node, "duplicate arrow helper"); scan.arrows++; }
}
function recordNavigationRead(source: ts.SourceFile, node: ts.Node, fn: string, scan: NavigationScan) {
    if (ts.isCallExpression(node) && ["owned", "readCached"].includes(node.expression.getText(source))) {
      const key = `${fn}:${compact(node, source)}`;
      if (!READ_FORMS.includes(key) || scan.reads.filter(read => read === key).length >= READ_FORMS.filter(read => read === key).length) unsupported(source, node, "document read owned/readCached site");
      scan.reads.push(key);
    }
}
function assertNavigationSyntax(source: ts.SourceFile) {
  const diagnostic = ts.transpileModule(source.text, {fileName: source.fileName, reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext}}).diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  if (!diagnostic) return;
  const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
  throw new Error(`Unsupported navigation syntax: SourceFile at ${source.fileName}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}

function navigationConditions(source: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const scan: NavigationScan = {functions: [], imports: [], reads: [], arrows: 0};
  const visit = (node: ts.Node, scope = "module"): void => {
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) unsupported(source, node, "import or re-export");
    if (ts.isTypeNode(node)) { ts.forEachChild(node, child => visit(child, scope)); return; }
    const fn = checkCallable(source, node, scope);
    recordNavigationDeclarations(source, node, fn, scan);
    checkPermissionForm(source, node);
    checkRuntimeForm(source, node, fn);
    recordNavigationRead(source, node, fn, scan);
    const condition = conditionNode(node);
    if (condition) {
      const key = `${fn}:${compact(condition, source)}`;
      if (!CONDITION_AXIS[key]) unsupported(source, node, `condition ${ts.SyntaxKind[node.kind]}`);
      found.add(key);
    }
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  assertNavigationSyntax(source);
  expect(scan.imports, "Unsupported navigation import list (imported helpers are outside the scan boundary)").toStrictEqual(IMPORT_FORMS);
  expect(scan.functions.sort(), "Unsupported navigation callable inventory").toStrictEqual([...CALLABLES].sort());
  expect(scan.arrows, "Unsupported navigation arrow helper inventory").toBe(1);
  expect(scan.reads.sort(), "Unsupported navigation document read site (only listed owned/readCached function+table sites)").toStrictEqual([...READ_FORMS].sort());
  expect(found.size, "condition oracle must measure nonempty source").toBeGreaterThan(0);
  return found;
}

function isExpenseVehicleRead(node: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isFunctionDeclaration(parent); parent = parent.parent) {
    if (!ts.isIfStatement(parent) || parent.thenStatement.pos > node.pos || parent.thenStatement.end < node.end) continue;
    const condition = parent.expression;
    if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteral(condition.left) && condition.left.text === "expenseId") return true;
  }
  return false;
}

function navigationSite(source: ts.SourceFile, node: ts.Node, fn: string): string | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "owned") {
    const cache = node.arguments[2];
    expect(cache && ts.isPropertyAccessExpression(cache), "owned site must name its cache").toBe(true);
    const table = (cache as ts.PropertyAccessExpression).name.text;
    const vehicleTable = isExpenseVehicleRead(node) ? "expense vehicles" : "native/sale vehicles";
    return `${fn}: ${table === "vehicles" ? vehicleTable : table}`;
  }
  const permission = checkPermissionForm(source, node);
  if (permission) return `${fn}: ${permission}`;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status" && ts.isStringLiteral(node.right) && node.right.text === "POSTED") return `${fn}: POSTED`;
  return undefined;
}

function navigationSites(source: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node, scope = ""): void => {
    const fn = ts.isFunctionDeclaration(node) ? node.name?.text ?? "" : scope;
    const site = navigationSite(source, node, fn);
    if (site) sites.push(site);
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  return sites.sort();
}

test("supplier navigation ownership calls and permission gates all have declared door rows", () => {
  // Permanent controls for parser forms that a declaration-only call graph missed.
  for (const [code, condition, form] of [
    ['function sourceFor(sale: {status: string}) { switch (sale.status) { case "X": return null; } }', "sale.status", "condition SwitchStatement"],
    ['const gate = (sale: {status: string}) => sale.status === "X"; function sourceFor() { return gate; }', "sale.status", "arrow helper"],
    ['const gate = { check(sale: {status: string}) { return sale.status === "X"; } }; function sourceFor() { return gate.check; }', "sale.status", "local callable"],
    ['function sourceFor(sale: {status: string}) { const state = sale.status; if (state === "X") return null; }', "sale.status", "property read"],
    ['function sourceFor(sale: {status: string}) { const {status: state} = sale; if (state === "X") return null; }', "sale.status", "destructured binding"],
    ['function sourceFor(sale: {status: string}) { let state: string; state = sale.status; if (state === "X") return null; }', "sale.status", "property read"],
    ['type Label = string | null; function sourceFor(label: Label) { if (label) return null; }', "nullable:label", "condition IfStatement"],
  ]) {
    expect(() => navigationConditions(ts.createSourceFile("probe.ts", code!, ts.ScriptTarget.Latest, true)), condition).toThrow(new RegExp(`Unsupported navigation ${form}: .* at probe\\.ts:1:`));
  }
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
  // These two schema-impossible deletion states are checked unconditionally.
  for (const exemption of [
    { reason: "financeApplications has no isDeleted field; hard deletion is the missing target state.", noDeletedTable: "financeApplications" },
    { reason: "openingBalanceDrafts has no isDeleted field; hard deletion is the missing target state.", noDeletedTable: "openingBalanceDrafts" },
  ]) {
    expect(exemption.noDeletedTable, exemption.reason).toBeDefined();
    const name = exemption.noDeletedTable;
    const table = tables.get(name);
    expect(table, exemption.reason).toBeDefined();
    const fields = table!.properties.map(prop => {
      if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) throw new Error(`Cannot measure schema fields for ${name}`);
      return prop.name.text;
    });
    expect(fields, `${name} has no isDeleted field`).not.toContain("isDeleted");
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
      seeded.set(title, { door: door.text, axes: strings(axes), tuples: cells.elements.map(node => {
        const tuple = strings(node);
        const count = strings(axes).length;
        expect(tuple.length, "Every cell requires a literal outcome and label").toBe(count + 2);
        expect(["none", "opening", "opening+link", "expense", "expense+vehicle", "expense+vehicle+link", "vehicle", "vehicle+link", "sale", "sale+link", "application", "application+link"], "Unknown literal outcome").toContain(tuple[count]);
        expect(["none", "opening", "expense", "vehicle", "number+vehicle", "id", "number+id"], "Unknown literal label").toContain(tuple[count + 1]);
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
      if ("reason" in entry) {
        expect(entry.reason.trim().length, `${door.name}: empty exemption reason ${tupleKey}`).toBeGreaterThan(0);
        const named = Object.fromEntries(axes.map(([axis], index) => [axis, entry.tuple[index]]));
        const rules = {
          "native-no-number": named.shape === "native" && named.dealNumber === "with",
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
});
