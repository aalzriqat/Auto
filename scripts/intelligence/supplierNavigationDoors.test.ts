import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
/**
 * Golden-master/snapshot pattern (https://vitest.dev/guide/snapshot.html): the fingerprint is a tripwire, not a proof of behaviour.
 * Imported helper bodies stay outside it, and the import list is pinned.
 * Compiler printer/SyntaxKind: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API.
 * Allowlist/default refusal: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 * and https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#deny-by-default.
 * The helper-body scan covers convex/utils/supplierNavigation.ts. Imported
 * helper bodies are outside it; the complete import list and bindings are pinned.
 * A separate recursive non-test Convex caller census pins permission scope text.
 * Syntax-only allowlists deliberately refuse aliases, renamed shapes and new forms
 * until they are reviewed and listed. A reused name cannot bypass the site counts.
 * Every runtime callable, property read and branching form is scanned, including
 * returned properties, optional chains and the error/decoration catch path.
 * Cells are literal decision-table outcomes, not a production-decision oracle.
 * Base-choice/each-choice (Ammann and Offutt, https://cs.gmu.edu/~offutt/softwaretest/edition1/exer-student.pdf) and focused pairwise coverage
 * (https://csrc.nist.gov/pubs/sp/800/142/final) retain the round-six core and vary each new axis against its gates.
 * The fingerprint and form allowlist, not the cross product, close arbitrary predicates over these axes.
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
 axes: {"shape":["cash","financed"],"saleTarget":["local","foreign","deleted","missing"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without","second"],"vehicle":["local","foreign","deleted","missing"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"],"saleStatus":["COMPLETED","CANCELLED"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["cash","local","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","fractional","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","positive-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","negative-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","second","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","fractional","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","positive-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","negative-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","second","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","deleted","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","missing","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","fractional","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","positive-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","negative-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","second","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","fractional","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","positive-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","negative-overflow","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","second","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks local deleted and missing targets for financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","foreign","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","deleted","missing","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","local","valid","CANCELLED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","local","valid","CANCELLED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","foreign","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","with","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","with","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","local","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","foreign","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","deleted","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["financed","missing","missing","without","without","missing","valid","COMPLETED"],"title":"sale lookup checks deleted and missing financed sales across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","local","valid","CANCELLED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","local","valid","CANCELLED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","foreign","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","local","valid","CANCELLED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","with","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","local","valid","CANCELLED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","local","without","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","with","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","foreign","without","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","with","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","with","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","local","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","foreign","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","deleted","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","foreign","missing","without","without","missing","valid","COMPLETED"],"title":"sale lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [
  {"tuple":["cash","local","foreign","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","foreign","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","foreign","missing","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","foreign","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","deleted","missing","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","foreign","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","with","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","with","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","local","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","foreign","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","deleted","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","missing","missing","without","without","missing","valid","COMPLETED"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
 ]
 },
 { name: "sales link gate", kind: "permission", site: "saleSource: VIEW_SALES",
 axes: {"shape":["cash","financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without","second"],"vehicle":["local","foreign","deleted","missing"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"This downstream door is reached only after sale ownership; sale lookup covers foreign, deleted and missing sales. For the earlier vehicle read those sale states yield no source, so its vehicle label is unobservable.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["cash","local","local","with","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","fractional"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","positive-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","local","negative-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","second","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","with","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","fractional"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","positive-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","local","negative-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","second","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["cash","local","local","without","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","fractional"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","positive-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","negative-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","second","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","fractional"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","positive-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","negative-overflow"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","second","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted","valid"],"title":"sales link gate checks local targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing","valid"],"title":"sales link gate checks local targets across every navigation condition"},
 ],
 exemptions: [
  {"tuple":["cash","local","foreign","with","with","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","with","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","with","without","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","with","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","without","without","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","with","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","with","without","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","with","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","local","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","foreign","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","deleted","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","without","without","missing","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
 ]
 },
 { name: "application lookup", kind: "owned", site: "saleSource: applications",
 axes: {"shape":["financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"viewSales":["with","without"],"dealNumber":["with","without","second"],"vehicle":["local","foreign","deleted","missing"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This downstream door is reached only after sale ownership; sale lookup covers foreign, deleted and missing sales. For the earlier vehicle read those sale states yield no source, so its vehicle label is unobservable.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewVehicles":"Sale paths use the vehicle label but never call vehicleSource or supplierVehicleHref; view:vehicles cannot change the sale result.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["financed","local","local","with","with","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","fractional"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","positive-overflow"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","local","negative-overflow"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","second","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","with","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","with","without","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","fractional"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","positive-overflow"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","local","negative-overflow"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","second","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","with","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","without","without","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","with","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","with","without","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","with","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","local","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","foreign","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","deleted","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","without","without","missing","valid"],"title":"application lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","local","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","foreign","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","deleted","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","with","missing","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","local","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","foreign","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","deleted","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","with","without","missing","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","local","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","foreign","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","deleted","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","with","missing","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","local","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","foreign","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","deleted","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","without","without","missing","valid"],"title":"application lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "opening lookup", kind: "owned", site: "sourceFor: openings",
 axes: {"shape":["opening"],"draftTarget":["local","foreign","missing"],"status":["POSTED","PENDING_APPROVAL","REJECTED","VOIDED"],"manageFinance":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated."},
 rows: [
  {"tuple":["opening","local","POSTED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","fractional"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","positive-overflow"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","negative-overflow"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","fractional"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","positive-overflow"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","negative-overflow"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","POSTED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","POSTED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","PENDING_APPROVAL","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","PENDING_APPROVAL","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","REJECTED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","REJECTED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","VOIDED","with","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","missing","VOIDED","without","valid"],"title":"opening lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["opening","foreign","POSTED","with","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","POSTED","without","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","PENDING_APPROVAL","with","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","PENDING_APPROVAL","without","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","REJECTED","with","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","REJECTED","without","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","VOIDED","with","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
  {"tuple":["opening","foreign","VOIDED","without","valid"],"title":"opening lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "opening status gate", kind: "status", site: "sourceFor: POSTED",
 axes: {"shape":["opening"],"draftTarget":["local"],"status":["POSTED","PENDING_APPROVAL","REJECTED","VOIDED"],"manageFinance":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated."},
 rows: [
  {"tuple":["opening","local","POSTED","with","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","fractional"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","positive-overflow"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","negative-overflow"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","fractional"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","positive-overflow"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","negative-overflow"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","with","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","PENDING_APPROVAL","without","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","with","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","REJECTED","without","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","with","valid"],"title":"opening status gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","VOIDED","without","valid"],"title":"opening status gate checks local targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "opening link gate", kind: "permission", site: "sourceFor: MANAGE_FINANCE",
 axes: {"shape":["opening"],"draftTarget":["local"],"status":["POSTED"],"manageFinance":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"Opening obligations have no vehicle; their origin prevents native and expense dispatch.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","viewVehicles":"Opening obligations have no vehicle and never call vehicleSource or supplierVehicleHref. The vehicle permission cannot change this opening result.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"The link gate is reached only after the draft status check accepts POSTED. Opening lookup and status-gate cells exercise every unposted status and null draft result."},
 rows: [
  {"tuple":["opening","local","POSTED","with","valid"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","fractional"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","positive-overflow"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","with","negative-overflow"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","valid"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","fractional"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","positive-overflow"],"title":"opening link gate checks local targets across every navigation condition"},
  {"tuple":["opening","local","POSTED","without","negative-overflow"],"title":"opening link gate checks local targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "expense lookup", kind: "owned", site: "sourceFor: expenses",
 axes: {"shape":["expense"],"expenseTarget":["local","foreign","deleted","missing"],"vehicle":["local","foreign","deleted","missing"],"viewVehicles":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["expense","local","local","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","fractional"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","positive-overflow"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","negative-overflow"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","fractional"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","positive-overflow"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","negative-overflow"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","local","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","local","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","foreign","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","foreign","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","deleted","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","deleted","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","missing","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","deleted","missing","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","local","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","local","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","foreign","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","foreign","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","deleted","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","deleted","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","missing","with","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","missing","missing","without","valid"],"title":"expense lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","foreign","local","with","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","local","without","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","foreign","with","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","foreign","without","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","deleted","with","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","deleted","without","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","missing","with","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","foreign","missing","without","valid"],"title":"expense lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "expense vehicle lookup", kind: "owned", site: "sourceFor: expense vehicles",
 axes: {"shape":["expense"],"expenseTarget":["local"],"vehicle":["local","foreign","deleted","missing"],"viewVehicles":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","shape":"The literal shape fixes this branch; the fixture reads back obligation origin, saleId, expenseId and vehicleId before the query.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["expense","local","local","with","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","fractional"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","positive-overflow"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","with","negative-overflow"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","fractional"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","positive-overflow"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","local","without","negative-overflow"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","with","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","deleted","without","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","with","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","missing","without","valid"],"title":"expense vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["expense","local","foreign","with","valid"],"title":"expense vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["expense","local","foreign","without","valid"],"title":"expense vehicle lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [

 ]
 },
 { name: "native or sale vehicle lookup", kind: "owned", site: "sourceFor: native/sale vehicles",
 axes: {"shape":["native","cash","financed"],"saleTarget":["local"],"applicationTarget":["local","foreign","missing"],"vehicle":["local","foreign","deleted","missing"],"viewSales":["with","without"],"viewVehicles":["with","without"],"dealNumber":["with","without","second"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"sourceFor reads the vehicle before saleSource. A foreign, deleted or missing sale forces source:null, so that vehicle label is unobservable; sale lookup cells cross sale state. Vehicle lookup cells use a local sale and explicitly cross application state.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["native","local","local","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","with","without","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","with","without","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","with","without","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","without","without","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","without","without","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","with","without","without","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","with","without","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","with","without","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","with","without","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["cash","local","local","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","fractional"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","positive-overflow"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","negative-overflow"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","second","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","with","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","with","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","without","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["native","local","local","foreign","without","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","with","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["cash","local","local","foreign","without","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","with","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","local","foreign","without","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","with","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","foreign","foreign","without","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","with","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","with","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","with","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","without","with","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
  {"tuple":["financed","local","missing","foreign","without","without","without","valid"],"title":"native or sale vehicle lookup refuses foreign targets across every navigation condition"},
 ],
 exemptions: [
  {"tuple":["native","local","local","local","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","local","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","foreign","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","deleted","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","local","missing","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","local","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","local","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","foreign","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","foreign","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","deleted","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","deleted","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","foreign","missing","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","foreign","missing","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","local","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","local","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","foreign","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","foreign","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","deleted","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","deleted","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","with","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","with","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","without","with","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["native","local","missing","missing","without","without","with","valid"],"rule":"native-no-number","reason":"Native obligations have no sale and cannot carry a sale dealNumber."},
  {"tuple":["native","local","missing","missing","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","local","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","foreign","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","deleted","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","foreign","missing","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","local","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","foreign","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","deleted","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","with","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","with","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","with","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","without","with","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
  {"tuple":["cash","local","missing","missing","without","without","without","valid"],"rule":"no-application","reason":"This shape has no referenced application; only the local placeholder is meaningful."},
 ]
 },
 { name: "vehicle link gate", kind: "permission", site: "supplierVehicleHref: VIEW_VEHICLES",
 axes: {"shape":["native","expense"],"expenseTarget":["local"],"vehicle":["local"],"viewVehicles":["with","without"],"timestamp":["valid","fractional","positive-overflow","negative-overflow"]},
 axisExemptions: {"role":"row.kind changes AP/AR only; the obligation shape fixes this role and each cell asserts it.","identity":"Convex document ids are mandatory non-null system fields; source ids and fallback labels are asserted against seeded ids.","serialization":"Public error serialization is pinned and scanned separately; successful navigation cells do not enter supplierNavigationFailure.","budget":"The existing decoration exhaustion preserves every computed payable row and complete money totals test checks the caught SupplierReadBudgetExhausted branch and completed money output.","saleTarget":"This opening or expense/native path never enters saleSource and reads no sale. Sale lookup cells cover sale ownership and deletion separately.","applicationTarget":"Opening and expense/native paths do not read an application. Cash paths have no referenced application; the financed path declares its own application axis.","expenseTarget":"Only expense obligations read an expense. Its vehicle/link door is reached only after expense ownership; expense lookup covers foreign, deleted and missing expenses.","draftTarget":"Only opening obligations read a draft. The status gate still evaluates draft?.status after a null owned result; opening lookup cells cover foreign and missing drafts. The link gate requires a local POSTED draft.","vehicle":"supplierVehicleHref is called only for an owned local vehicle. Native/sale and expense vehicle lookup cells cover foreign, deleted and missing vehicles before this gate.","viewSales":"Opening and expense/native paths never enter saleSource; sales permissions cannot change their source or link.","manageFinance":"Only opening obligations read MANAGE_FINANCE; this branch never reaches the opening link.","dealNumber":"Opening and expense/native paths never enter saleSource; no sale deal number is evaluated.","status":"Only opening obligations read draft.status; this branch has no opening draft."},
 rows: [
  {"tuple":["native","local","local","with","valid"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","with","fractional"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","with","positive-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","with","negative-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","without","valid"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","without","fractional"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","without","positive-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["native","local","local","without","negative-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","with","valid"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","with","fractional"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","with","positive-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","with","negative-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","without","valid"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","without","fractional"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","without","positive-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
  {"tuple":["expense","local","local","without","negative-overflow"],"title":"vehicle link gate checks local targets across every navigation condition"},
 ],
 exemptions: [

 ]
 }
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
  throw new Error(`Unsupported navigation ${form}: ${ts.SyntaxKind[node.kind]} at ${source.fileName}:${line}: ${node.getText(source).slice(0, 160)}; ${updateTable}; update SUPPLIER_NAVIGATION_DOORS, CONDITION_AXIS and the named form table`);
}
const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s+/g, "");

function conditionNode(source: ts.SourceFile, node: ts.Node): ts.Node | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement: return (node as ts.IfStatement).expression;
    case ts.SyntaxKind.CatchClause: return (node as ts.CatchClause).variableDeclaration?.name ?? node;
    case ts.SyntaxKind.ConditionalExpression: return (node as ts.ConditionalExpression).condition;
    case ts.SyntaxKind.PrefixUnaryExpression: checkUnaryForm(source, node as ts.PrefixUnaryExpression); return node;
    case ts.SyntaxKind.BinaryExpression: checkBinaryForm(source, node as ts.BinaryExpression); return node;
    case ts.SyntaxKind.PropertyAccessExpression: case ts.SyntaxKind.CallExpression: case ts.SyntaxKind.ElementAccessExpression:
      return (node as ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression).questionDotToken ? node : undefined;
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.AwaitExpression:
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.SpreadAssignment:
    case ts.SyntaxKind.ObjectBindingPattern:
    case ts.SyntaxKind.SourceFile:
    case ts.SyntaxKind.ImportDeclaration:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamedImports:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.ExportKeyword:
    case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.AsyncKeyword:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateSpan:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.PropertyAssignment: case ts.SyntaxKind.ShorthandPropertyAssignment:
    case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.ColonToken:
    case ts.SyntaxKind.QuestionDotToken:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.DotDotDotToken:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TryStatement:
    case ts.SyntaxKind.ThrowStatement:
    case ts.SyntaxKind.EndOfFileToken:
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.InKeyword:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.QuestionQuestionToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.InstanceOfKeyword: return undefined;
    default: unsupported(source, node, "unlisted condition kind; update conditionNode and checkRuntimeForm");
  }
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

const OBJECT_FORMS = [
  "module:{kind:v.union(v.literal(\"VEHICLE\"),v.literal(\"SALE\"),v.literal(\"APPLICATION\"),v.literal(\"EXPENSE\"),v.literal(\"OPENING\")),id:v.string(),label:v.string(),href:v.union(v.string(),v.null()),}",
  "module:{role:v.union(v.literal(\"AP\"),v.literal(\"AR\")),occurredAt:v.union(v.number(),v.null()),counterparty:v.string(),source:v.union(supplierSourceValidator,v.null()),vehicleSource:v.optional(v.union(supplierSourceValidator,v.null())),}",
  "saleSource:{kind:\"SALE\",id:sale._id,label,href:canOpen?`/${args.orgId}/sales/${sale._id}/deal`:null}",
  "saleSource:{kind:\"SALE\",id:sale._id,label,href:null}",
  "saleSource:{kind:\"APPLICATION\",id:app._id,label,href:canOpen?`/${args.orgId}/applications/${app._id}/deal`:null}",
  "vehicleSource:{kind:\"VEHICLE\",id:vehicle._id,label:supplierVehicleLabel(vehicle),href:supplierVehicleHref(args.orgId,vehicle._id,args.permissions)}",
  "sourceFor:{source:null}",
  "sourceFor:{source:{kind:\"OPENING\",id:draft._id,label:obligation.title,href:canOpen?`/${args.orgId}/accounting?section=settings`:null}}",
  "sourceFor:{kind:\"OPENING\",id:draft._id,label:obligation.title,href:canOpen?`/${args.orgId}/accounting?section=settings`:null}",
  "sourceFor:{source:{kind:\"EXPENSE\",id:expense._id,label:expense.title,href:null},vehicleSource:vehicleSource(args,vehicle)}",
  "sourceFor:{kind:\"EXPENSE\",id:expense._id,label:expense.title,href:null}",
  "sourceFor:{source:awaitsaleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)}",
  "sourceFor:{source:vehicleSource(args,vehicle)}",
  "addSupplierRowContext:{role:row.kind===\"PAYABLE\"?\"AP\":\"AR\",occurredAt,counterparty:obligation.sourcedFromName,source:null,vehicleSource:null}",
  "addSupplierRowContext:{...row,context}",
  "addSupplierRowContext:{...section,rows}",
  "module:{SUPPLIER_NAVIGATION_UNAVAILABLE:\"Supplierrecordscouldnotbeloaded.Pleasetryagain.\",SUPPLIER_ATTENTION_UNAVAILABLE:\"Supplierattentioncouldnotbeloaded.Pleasetryagain.\",}",
  "supplierNavigationFailure:{code,message:READ_FAILURE_MESSAGE[code]}",
];
const CALL_ARGUMENT_FORMS = [
  "saleSource:owned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:owned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "vehicleSource:supplierVehicleLabel(vehicle)",
  "vehicleSource:supplierVehicleHref(args.orgId,vehicle._id,args.permissions)",
  "sourceFor:owned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:vehicleSource(args,vehicle)",
  "sourceFor:saleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)",
  "sourceFor:supplierVehicleLabel(vehicle)",
  "addSupplierRowContext:Object.assign(context,awaitsourceFor(ctx,args,obligation))",
  "addSupplierRowContext:sourceFor(ctx,args,obligation)",
];
const AWAIT_FORMS = [
  "owned:awaitreadCached(ctx,cache,id)",
  "saleSource:awaitowned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:awaitowned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:awaitsaleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)",
  "addSupplierRowContext:awaitsourceFor(ctx,args,obligation)",
];
const BINARY_OPERATORS = [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.InstanceOfKeyword];
const NAVIGATION_GLOBALS = ["Number", "Math", "Object", "console"];

function checkBinaryForm(source: ts.SourceFile, node: ts.BinaryExpression) {
  if (!BINARY_OPERATORS.includes(node.operatorToken.kind)) unsupported(source, node.operatorToken, "binary operator; update BINARY_OPERATORS");
}
function checkUnaryForm(source: ts.SourceFile, node: ts.PrefixUnaryExpression) {
  if (node.operator !== ts.SyntaxKind.ExclamationToken) unsupported(source, node, "unary operator; update checkRuntimeForm");
}
function checkCallArguments(source: ts.SourceFile, node: ts.CallExpression, fn: string) {
  const name = compact(node.expression, source);
  if (!CALL_FORMS.includes(`${fn}:${name}`)) unsupported(source, node, "call / permission member; update CALL_FORMS");
  if (["sourceFor", "saleSource", "vehicleSource", "supplierVehicleHref", "supplierVehicleLabel", "owned", "Object.assign"].includes(name) &&
    !CALL_ARGUMENT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "call arguments; update CALL_ARGUMENT_FORMS");
}
function checkObjectForm(source: ts.SourceFile, node: ts.ObjectLiteralExpression, fn: string) {
  if (!OBJECT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "object literal; update OBJECT_FORMS (no permissions or args spread)");
}
function checkAwaitForm(source: ts.SourceFile, node: ts.AwaitExpression, fn: string) {
  const turn = fn === "addSupplierRowContext" && ts.isExpressionStatement(node.parent) &&
    ts.isCallExpression(node.expression) && compact(node.expression.expression, source) === "inTurn";
  if (!turn && !AWAIT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "await site; update AWAIT_FORMS");
}
function checkSpecialForm(source: ts.SourceFile, node: ts.Node, fn: string) {
  const special: Readonly<Record<number, readonly string[]>> = {
    [ts.SyntaxKind.NewExpression]: ['supplierNavigationFailure:newConvexError({code,message:READ_FAILURE_MESSAGE[code]})'],
    [ts.SyntaxKind.TypeOfExpression]: ['supplierNavigationFailure:typeoferror.data'],
    [ts.SyntaxKind.SpreadAssignment]: ['addSupplierRowContext:...row', 'addSupplierRowContext:...section'],
    [ts.SyntaxKind.ElementAccessExpression]: ['supplierNavigationFailure:READ_FAILURE_MESSAGE[code]'],
    [ts.SyntaxKind.ObjectBindingPattern]: ['addSupplierRowContext:{document:obligation,...row}'],
  };
  if (!special[node.kind]?.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "special form; update checkSpecialForm");
}
function identifierChecker(source: ts.SourceFile): ts.TypeChecker {
  // Bind this source with the compiler, including lexical block/parameter scopes.
  // No library or imported body is loaded; those bindings are pinned separately.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}
function checkIdentifier(source: ts.SourceFile, node: ts.Identifier, checker: ts.TypeChecker) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return; // PROPERTY_FORMS pins the entire access.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return; // OBJECT_FORMS pins its name and value.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return; // Binding shape is pinned.
  if (NAVIGATION_GLOBALS.includes(node.text)) return;
  const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
  const declared = symbol?.declarations?.some(declaration => declaration.getSourceFile() === source &&
    [ts.SyntaxKind.Parameter, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.BindingElement, ts.SyntaxKind.FunctionDeclaration,
      ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.TypeAliasDeclaration].includes(declaration.kind));
  if (!declared) unsupported(source, node, "unresolved identifier; update NAVIGATION_GLOBALS or the pinned import/local bindings");
}

function checkRuntimeForm(source: ts.SourceFile, node: ts.Node, fn: string, checker: ts.TypeChecker) {
  checkBarePermissionRead(source, node, fn);
  switch (node.kind) {
    case ts.SyntaxKind.Identifier: checkIdentifier(source, node as ts.Identifier, checker); return;
    case ts.SyntaxKind.BinaryExpression: checkBinaryForm(source, node as ts.BinaryExpression); return;
    case ts.SyntaxKind.PrefixUnaryExpression: checkUnaryForm(source, node as ts.PrefixUnaryExpression); return;
    case ts.SyntaxKind.CallExpression: checkCallArguments(source, node as ts.CallExpression, fn); return;
    case ts.SyntaxKind.PropertyAccessExpression: checkPropertyRead(source, node as ts.PropertyAccessExpression, fn); return;
    case ts.SyntaxKind.ObjectLiteralExpression: checkObjectForm(source, node as ts.ObjectLiteralExpression, fn); return;
    case ts.SyntaxKind.AwaitExpression: checkAwaitForm(source, node as ts.AwaitExpression, fn); return;
    case ts.SyntaxKind.NewExpression: case ts.SyntaxKind.TypeOfExpression: case ts.SyntaxKind.SpreadAssignment:
    case ts.SyntaxKind.ElementAccessExpression: case ts.SyntaxKind.ObjectBindingPattern: checkSpecialForm(source, node, fn); return;
    case ts.SyntaxKind.SourceFile: case ts.SyntaxKind.ImportDeclaration: case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamedImports: case ts.SyntaxKind.ImportSpecifier: case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.VariableStatement: case ts.SyntaxKind.ExportKeyword: case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.VariableDeclaration: case ts.SyntaxKind.FunctionDeclaration: case ts.SyntaxKind.AsyncKeyword:
    case ts.SyntaxKind.Parameter: case ts.SyntaxKind.Block: case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.NullKeyword: case ts.SyntaxKind.ParenthesizedExpression: case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TemplateHead: case ts.SyntaxKind.TemplateSpan: case ts.SyntaxKind.TemplateMiddle: case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.ConditionalExpression: case ts.SyntaxKind.PropertyAssignment: case ts.SyntaxKind.ShorthandPropertyAssignment: case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.ColonToken: case ts.SyntaxKind.QuestionDotToken: case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ExpressionStatement: case ts.SyntaxKind.ArrowFunction: case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.BindingElement: case ts.SyntaxKind.DotDotDotToken: case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TryStatement: case ts.SyntaxKind.CatchClause: case ts.SyntaxKind.ThrowStatement: case ts.SyntaxKind.EndOfFileToken:
    case ts.SyntaxKind.BarBarToken: case ts.SyntaxKind.AmpersandAmpersandToken: case ts.SyntaxKind.InKeyword:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: case ts.SyntaxKind.QuestionQuestionToken:
    case ts.SyntaxKind.LessThanEqualsToken: case ts.SyntaxKind.InstanceOfKeyword: return;
    default: unsupported(source, node, "unlisted runtime kind; update checkRuntimeForm and conditionNode");
  }
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
  throw new Error(`Unsupported navigation syntax: SourceFile at ${source.fileName}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; update SUPPLIER_NAVIGATION_DOORS and the form tables. ${updateTable}`);
}

function checkTypeImports(source: ts.SourceFile, node: ts.Node): void {
  if (ts.isImportTypeNode(node)) unsupported(source, node, "import type; update IMPORT_FORMS");
  ts.forEachChild(node, child => checkTypeImports(source, child));
}
function navigationConditions(source: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const checker = identifierChecker(source);
  const scan: NavigationScan = {functions: [], imports: [], reads: [], arrows: 0};
  const visit = (node: ts.Node, scope = "module"): void => {
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) unsupported(source, node, "import or re-export");
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeParameterDeclaration(node)) { checkTypeImports(source, node); return; }
    const fn = checkCallable(source, node, scope);
    recordNavigationDeclarations(source, node, fn, scan);
    checkPermissionForm(source, node);
    checkRuntimeForm(source, node, fn, checker);
    recordNavigationRead(source, node, fn, scan);
    const condition = conditionNode(source, node);
    if (condition) {
      const key = `${fn}:${compact(condition, source)}`;
      if (!CONDITION_AXIS[key]) unsupported(source, node, `condition ${ts.SyntaxKind[node.kind]}; update CONDITION_AXIS`);
      found.add(key);
    }
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  assertNavigationSyntax(source);
  for (const [name, actual, expected] of [
    ["IMPORT_FORMS", scan.imports, IMPORT_FORMS],
    ["CALLABLES", scan.functions.sort(), [...CALLABLES].sort()],
    ["READ_FORMS", scan.reads.sort(), [...READ_FORMS].sort()],
  ]) if (JSON.stringify(actual) !== JSON.stringify(expected)) unsupported(source, source, `inventory; update ${name}`);
  if (scan.arrows !== 1) unsupported(source, source, "arrow inventory; update checkCallable");
  if (!found.size) unsupported(source, source, "empty condition oracle; update CONDITION_AXIS");
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
    if (site) {
      if (sites.includes(site)) unsupported(source, node, `duplicate source site ${site}; update SUPPLIER_NAVIGATION_DOORS with distinct door identities`);
      sites.push(site);
    }
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  return sites.sort();
}

test("supplier navigation ownership calls and permission gates all have declared door rows", () => {
  // Permanent controls for parser forms that a declaration-only call graph missed.
  for (const [code, condition, form] of [
    ['function sourceFor(sale: {status: string}) { switch (sale.status) { case "X": return null; } }', "sale.status", "unlisted runtime kind; update checkRuntimeForm and conditionNode"],
    ['const gate = (sale: {status: string}) => sale.status === "X"; function sourceFor() { return gate; }', "sale.status", "arrow helper"],
    ['const gate = { check(sale: {status: string}) { return sale.status === "X"; } }; function sourceFor() { return gate.check; }', "sale.status", "object literal; update OBJECT_FORMS (no permissions or args spread)"],
    ['function sourceFor(sale: {status: string}) { const state = sale.status; if (state === "X") return null; }', "sale.status", "property read"],
    ['function sourceFor(sale: {status: string}) { const {status: state} = sale; if (state === "X") return null; }', "sale.status", "special form; update checkSpecialForm"],
    ['function sourceFor(sale: {status: string}) { let state: string; state = sale.status; if (state === "X") return null; }', "sale.status", "binary operator; update BINARY_OPERATORS"],
    ['type Label = string | null; function sourceFor(label: Label) { if (label) return null; }', "nullable:label", "condition IfStatement; update CONDITION_AXIS"],
  ]) {
    const escapedForm = form!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(() => navigationConditions(ts.createSourceFile("probe.ts", code!, ts.ScriptTarget.Latest, true)), condition).toThrow(new RegExp(`Unsupported navigation ${escapedForm}: .* at probe\\.ts:1:`));
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
  expect(new Set(sites).size, `${updateTable}: duplicate source sites (navigationSites reports the node and line)`).toBe(sites.length);
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
});

// Retain the round-six product at the new axes' baselines, then add focused
// base-choice pairs. No production predicate participates in this requirement.
function requiredNavigationTuples(door: Door): string[][] {
  const axes = Object.entries(door.axes);
  let core: string[][] = [[]];
  for (const [axis, values] of axes) {
    expect(values.length, `${door.name}: empty axis ${axis}`).toBeGreaterThan(0);
    expect(new Set(values).size, `${door.name}: duplicate values on ${axis}`).toBe(values.length);
    const baseline = ["timestamp", "saleStatus"].includes(axis) ? values.slice(0, 1) : values.filter(value => axis !== "dealNumber" || value !== "second");
    core = core.flatMap(tuple => baseline.map(value => [...tuple, value]));
  }
  const required = [...core];
  for (const shape of door.axes.shape!) {
    const base: Record<string, string> = Object.fromEntries(axes.map(([axis, values]) =>
      [axis, axis === "shape" ? shape : axis === "dealNumber" && shape === "native" ? "without" : values[0]!]));
    for (const axis of ["timestamp", "dealNumber", "saleStatus"]) {
      const variants = (door.axes[axis] ?? []).filter(value => axis === "dealNumber" ? value === "second" && shape !== "native" : value !== door.axes[axis]![0]);
      for (const value of variants) {
        for (const gate of ["viewSales", "viewVehicles", "manageFinance"].filter(gate => gate in door.axes)) {
          for (const permission of ["without", "with"]) {
            // Hidden sales retain both statuses; a missing sale was read back before deletion.
            const targets = axis === "saleStatus" ? door.axes.saleTarget! : [base.saleTarget!];
            for (const target of targets) {
              const cell = { ...base, [axis]: value, [gate]: permission };
              if ("saleTarget" in base) cell.saleTarget = target;
              required.push(axes.map(([name]) => cell[name]!));
            }
          }
        }
      }
    }
  }
  return [...new Map(required.map(tuple => [JSON.stringify(tuple), tuple])).values()];
}
test("every supplier navigation door covers its round six core and new base choice pairs", () => {
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
});

const NAVIGATION_FINGERPRINTS = [
  {
    "name": "import:convex/values",
    "kind": "ImportDeclaration",
    "hash": "5106e8a966e46428ebbcf36041d101a476f0438ac3692189e523764e9919f244"
  },
  {
    "name": "import:../_generated/dataModel",
    "kind": "ImportDeclaration",
    "hash": "8c150751d0cb726a5d922138a83c77df3958feae59af847ce0aff328cd27801a"
  },
  {
    "name": "import:../_generated/server",
    "kind": "ImportDeclaration",
    "hash": "5b69da67a2b780050ba5bcd4ee4036232776bc178ac9da19a396ec13501b54c4"
  },
  {
    "name": "import:./permissions",
    "kind": "ImportDeclaration",
    "hash": "a4c7b60af30dc07582d703b18d64378c66ecc7798f69764175e31a4b0c20f301"
  },
  {
    "name": "import:./supplierObligationDue",
    "kind": "ImportDeclaration",
    "hash": "a331510388f1a1c9ffdc3598012e74f52613fdd00f59af0a1c4823fd4aa3d148"
  },
  {
    "name": "import:./supplierSettledRows",
    "kind": "ImportDeclaration",
    "hash": "e7c0cdb007b0708b6e5aa7c80d71bb9e1b5d8a560f68f7e191edaff51513f620"
  },
  {
    "name": "import:./supplierReadCache",
    "kind": "ImportDeclaration",
    "hash": "580f60b66be3b64d6cee271ef90475ba5bd27e9e66fea94bb1a134376ae68c78"
  },
  {
    "name": "import:./transactionReadHeadroom",
    "kind": "ImportDeclaration",
    "hash": "cc733012011c8fb16404bee10facd8236b49903cf8e5211357b832d235640716"
  },
  {
    "name": "supplierSourceValidator",
    "kind": "VariableStatement",
    "hash": "0a4bfbda3d1572b6634e79285346df745232df953ee6be60867e6c763b55df4d"
  },
  {
    "name": "supplierRowContextValidator",
    "kind": "VariableStatement",
    "hash": "92673c2ac29a8ef2792130d2ae8d8e521ee8a430eac4a924a336eec24f91383f"
  },
  {
    "name": "Source",
    "kind": "TypeAliasDeclaration",
    "hash": "8cb4154ad9e1b5d0440a1753a98de93a9c64460618f6e4011b05c4c3286d264c"
  },
  {
    "name": "Context",
    "kind": "TypeAliasDeclaration",
    "hash": "784a5261582c596e72c1835b8a654967a43fc551250c34b0c9de333e4c139040"
  },
  {
    "name": "NavigationArgs",
    "kind": "TypeAliasDeclaration",
    "hash": "7aca8dfcbd344dfe9f981218f0a01045965263b03cdb4cc92064a10728462765"
  },
  {
    "name": "owned",
    "kind": "FunctionDeclaration",
    "hash": "67fadd48e9594cfa7bc85007d4d22f3104066fc0df538c86bb2b0ebf3085d3e8"
  },
  {
    "name": "supplierVehicleLabel",
    "kind": "FunctionDeclaration",
    "hash": "b44cd378a7434e46002b533752e73a2c7fd663590c8da842a4378eca0598a259"
  },
  {
    "name": "supplierVehicleHref",
    "kind": "FunctionDeclaration",
    "hash": "0244ecbcfcb6a6347f2cc8e3e87cdb9f80895e3969c12ffac332618221fe4383"
  },
  {
    "name": "saleSource",
    "kind": "FunctionDeclaration",
    "hash": "a4628fe7306d90a16387ee3d3b2989dd7ac0513b7c27980055e64db25c5cbb16"
  },
  {
    "name": "vehicleSource",
    "kind": "FunctionDeclaration",
    "hash": "1302866cdeb998ab09cc064dc8999eb5c4fafce8662014d6157100e7644e25cd"
  },
  {
    "name": "sourceFor",
    "kind": "FunctionDeclaration",
    "hash": "7812496c941d9f17e133d2fb15e6c5a040e8bc12bbe2424f71789ef75cb93846"
  },
  {
    "name": "addSupplierRowContext",
    "kind": "FunctionDeclaration",
    "hash": "df2b0c1c97cce688e2c99cf5d51e532d160a5b7ae722da27b3834c63cd92b51e"
  },
  {
    "name": "READ_FAILURE_MESSAGE",
    "kind": "VariableStatement",
    "hash": "cfc0ef9e4d36568f150f5c12b0969861933e0edda3a5766943b4052eb74901c3"
  },
  {
    "name": "supplierNavigationFailure",
    "kind": "FunctionDeclaration",
    "hash": "17b1463410dd7a424bf750b3c79c7bfbfbb73c54c044d29e513c4e146d6d3174"
  }
];
function navigationStatementName(node: ts.Statement, source: ts.SourceFile): string {
  if (ts.isImportDeclaration(node)) return `import:${(node.moduleSpecifier as ts.StringLiteral).text}`;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => declaration.name.getText(source)).join(",");
  if (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name?.text ?? ts.SyntaxKind[node.kind];
  return ts.SyntaxKind[node.kind];
}
function navigationTokens(node: ts.Node, source: ts.SourceFile): string[] {
  if (ts.isJSDoc(node)) return [];
  if (ts.isToken(node)) return [node.getText(source)];
  return node.getChildren(source).flatMap(child => navigationTokens(child, source));
}
function navigationFingerprint(node: ts.Statement, source: ts.SourceFile): string {
  const printed = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Unspecified, node, source);
  const normalized = ts.createSourceFile(source.fileName, printed, ts.ScriptTarget.Latest, true);
  // Pin source tokens as well: the printer can normalize an omitted semicolon or an escaped identifier.
  // AST tokens preserve literal/template whitespace, while comments and formatting stay outside the hash.
  return createHash("sha256").update(JSON.stringify([navigationTokens(normalized, normalized), navigationTokens(node, source)])).digest("hex");
}

function assertNavigationFingerprints(source: ts.SourceFile) {
  const actual = source.statements.map(node => ({ name: navigationStatementName(node, source),
    kind: ts.isVariableStatement(node) ? "VariableStatement" : ts.SyntaxKind[node.kind], hash: navigationFingerprint(node, source) }));
  const refusals: string[] = [];
  for (let index = 0; index < Math.max(actual.length, NAVIGATION_FINGERPRINTS.length); index++) {
    const expected = NAVIGATION_FINGERPRINTS[index];
    const current = actual[index];
    if (JSON.stringify(current) === JSON.stringify(expected)) continue;
    refusals.push(`Fingerprint ${expected?.name ?? "extra statement"} -> ${current?.name ?? "missing statement"} (${current?.kind ?? expected?.kind}) at ${source.fileName}:${source.getLineAndCharacterOfPosition(source.statements[index]?.getStart(source) ?? source.end).line + 1}; new hash ${current?.hash ?? "MISSING"}. Re-derive the door rows, axes and cells for that function, rerun the mutant runner, then update NAVIGATION_FINGERPRINTS. ${updateTable}`);
  }
  expect(refusals, `Navigation fingerprint review required: ${refusals.join("\n")}`).toStrictEqual([]);
}
test("supplier navigation statement fingerprints require a reviewed door table for every token change", () => {
  assertNavigationFingerprints(parse("convex/utils/supplierNavigation.ts"));
});

// These enclosing statements include auth destructuring, all writes, branches,
// scope creation and both vehicles -> project calls. Hashes are reviewed constants.
const FORWARDING_FINGERPRINTS = [
  {
    "file": "convex/supplierStatement.ts",
    "name": "import:./utils/tenancy",
    "hash": "e36e85a1915b7b3a4e9b84a31e8ea2441edd3b330e1a1470ecbbf4a3eabeffff"
  },
  {
    "file": "convex/supplierStatement.ts",
    "name": "settled",
    "hash": "85ff2fcef110f5d542e317a5b044a9e35de8903321f7c558e666d91bd6a632cf"
  },
  {
    "file": "convex/supplierStatement.ts",
    "name": "outstanding",
    "hash": "e84fa1f7f16f19f24a4d488b95ba9a030bf4f1497e7bb703e88d702781ca90ab"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "import:./utils/tenancy",
    "hash": "e36e85a1915b7b3a4e9b84a31e8ea2441edd3b330e1a1470ecbbf4a3eabeffff"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "vehicles",
    "hash": "3bc0fc56ddf4c03525bc1712ab10c59b49f598b99c840f8c22cf3c18e4d6249e"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "project",
    "hash": "7591f078011da2d81b09b41c7f7a579c7ec5b603dd017b522a3615464c65983b"
  }
];
function assertForwardingFingerprints(): void {
  for (const pin of FORWARDING_FINGERPRINTS) {
    const source = parse(pin.file);
    const node = source.statements.find(statement => navigationStatementName(statement, source) === pin.name);
    const message = `${pin.file}:${pin.name}: permission forwarding fingerprint changed; re-derive role provenance and every caller cell before reviewing this pin. ${updateTable}`;
    expect(node, message).toBeDefined();
    expect(node && navigationFingerprint(node, source), message).toBe(pin.hash);
  }
}
// Complete helper declarations and fixture constants are reviewed tripwires, not correctness proofs.
const RUNNER_FINGERPRINTS = [
  {
    "name": "modules",
    "hash": "fd49d3761efc39499490aaa5a2a7417efae346c683e592dbcba7b69a0f9edbae"
  },
  {
    "name": "NOW",
    "hash": "ae6487bd2fc018a526e87de0723ab23b1a3b6b29ed74b7215a83f2c10b642bec"
  },
  {
    "name": "vehicles",
    "hash": "079e9ff58899e99060e5639b0b62da2ab7cb4d0075aa54f82222fda6c0207771"
  },
  {
    "name": "callerAudits",
    "hash": "f6f323808f532e2862a1efa11630e2b7b37718016ca7e0763250b90e8f4099c4"
  },
  {
    "name": "EXPECTED_CALLER_RECEIPTS",
    "hash": "697f3033d40be2c81209929ae7c111bdc02ba538af8bf3c19592237fe37efde5"
  },
  {
    "name": "afterEach",
    "hash": "3c058576479bcf77e7240d4a593a145fa895513122666e2ad2fead0065f5c90e"
  },
  {
    "name": "beginCallerAssertions",
    "hash": "8cb10404fa5732764c2decf4ddabd577cf52913870d4b1af4843bd91f0cf2bcc"
  },
  {
    "name": "verifyCallerAssertions",
    "hash": "85c342b129e5562f334011bb86ad81d5ea7b0435847f54a0719dbcff270ee98f"
  },
  {
    "name": "assertCallerResult",
    "hash": "b75a023dca3d468185de49ff0951e462865b26367380dfb059c3b36f49f25e92"
  },
  {
    "name": "seed",
    "hash": "4aae6a4ddacc3ee94ac3aa45e971d44b101a67ce256d2e2b22cda553d5ebfbc6"
  },
  {
    "name": "payable",
    "hash": "cc86f7c102f970fc3267124ed6be10ac2e8f6bc3ab76d9cbac327d5c5415d25e"
  },
  {
    "name": "outstanding",
    "hash": "187e607517885707f2f75d82610caa9751eda740851de195c0d38c1598b6cfe7"
  },
  {
    "name": "related",
    "hash": "36519e0b06a2feffff90db21d0785818f196a9531ae04f731c8ff4e068805331"
  },
  {
    "name": "financedSale",
    "hash": "b8e67723c77ed07c3552588babf87f8d42cbf0647bbc273c1229423c5f6a7825"
  },
  {
    "name": "seedViewer",
    "hash": "c614ce5a237a74a0c966fa158e458619784ed0f7f6e39c5bec1b05edc70536e8"
  },
  {
    "name": "hideVehicle",
    "hash": "f5e1bd15f686078027132fad39100356f5c502aadb108352af6034a0f30eb384"
  },
  {
    "name": "expectNoVehicleLabel",
    "hash": "3cf43713277ca9dc08b77631ec63ad65b710817d052d716751300c41990c9b99"
  },
  {
    "name": "expectNoVehicle",
    "hash": "8d18975f65619c1262977e31342dec18d2959596c980763f5b05dce9469b7b9b"
  },
  {
    "name": "expectHiddenSale",
    "hash": "c5d4209c948ec7bf06c1696a669882c19a777092c7b2cf6412fe3283c7159cf5"
  },
  {
    "name": "openingFixture",
    "hash": "2c6404c0b0f8436d4e4800ac7d0fb5c6aee5cf3dc74174e57af4ae26c22daebd"
  },
  {
    "name": "expenseVehicleFixture",
    "hash": "618671deb6b9b2f9d86ed8f7c915eb3f3fe964220aabe5cd7f9d48bd9a4bf488"
  },
  {
    "name": "expectHiddenExpenseVehicle",
    "hash": "13d0c81483a62167e78591d22dd0899d3aa26c6da8a305d259802384eb7134c8"
  },
  {
    "name": "expectHiddenNativeVehicle",
    "hash": "34dd0a0ffb3f48f12973e29de9c89fa1231cf5ef49c052f2888da4fc309df22d"
  },
  {
    "name": "expectHiddenSaleVehicle",
    "hash": "73e5c3abe4170baf2c9c9a03e52e8a4b9e8acf44d87e12421e1a5ce3c63cdf9e"
  },
  {
    "name": "expectedSaleVehicleCell",
    "hash": "8ecd929f681ba0f510e088cfe57d86923390a021522909a3e2612505e63f197a"
  },
  {
    "name": "expectedNativeVehicleCell",
    "hash": "9b666e39c764d5fcb5202977b6026381cc3a0433b5c02d26643a09df77126096"
  },
  {
    "name": "expectVehicleCell",
    "hash": "22ce7eeb7af53aa41bd3aa1affe815f6693dd5a2cc53cbc09ac936964dc4d339"
  },
  {
    "name": "expectUnpostedOpening",
    "hash": "9362e5f2b232cfc1bcb0212e661e168dab49ef943987f9c2410728bbea6693d4"
  },
  {
    "name": "measureHandler",
    "hash": "a1b7062d974e3cfaad06bb0091f708aa9a24389b0e1f319f2108fe3825f01f5d"
  },
  {
    "name": "seedReadBound",
    "hash": "3caa16e63dd9aedc08a1e368fc22a608d34ef9fceafe545ba8207ddfafd7d71f"
  },
  {
    "name": "settleReadBound",
    "hash": "9a22ebf391d6b45f8a4fc8f16cb26abc859c50dfcabea1d20eb4b70c43785892"
  },
  {
    "name": "NAVIGATION_DEAL_NUMBERS",
    "hash": "ca68692ce425ae728f80f13f5528a0159394628de751bbfd079f955cb08b6fe0"
  },
  {
    "name": "NAVIGATION_PERMISSIONS",
    "hash": "5400cedb24582de79a2b7a751701b9b1c339e5b11579449162413fc39627e7ee"
  },
  {
    "name": "navigationPermissions",
    "hash": "9b5a4da7d1e9eb8f7d283079ad0cab0cca0e861189455292648957b3e29e1ca8"
  },
  {
    "name": "assertNavigationTarget",
    "hash": "ed4fb57643969c47d9452ca0d4eb3d3e9aafb74787ffd3296e5aa2f6311ae35e"
  },
  {
    "name": "navigationTargets",
    "hash": "922f2b5c5bac7f9f6041b6336b8237c30312c35bf8ffeb5eb7754249727b374b"
  },
  {
    "name": "seedNavigationOpening",
    "hash": "f0bf8ea5c97b5f390c69152cb86cfd2e07a2e57691e1e3a53dbb06c7433ebc20"
  },
  {
    "name": "seedNavigationCell",
    "hash": "0278e650f9bb6839311e86ffd51d926f2d6736e9e3869178f1cb7fd99e47b256"
  },
  {
    "name": "readBackNavigationIdentity",
    "hash": "ff554aa94a13fc5275d645228a6a20fed325f8025726430a09fe776f0dba0757"
  },
  {
    "name": "readBackNavigationCell",
    "hash": "7c0bec72f56acc054730c7482b29f2066e82063d7669c748acd3422a369743d6"
  },
  {
    "name": "readBackNavigationDocumentFields",
    "hash": "3b0dfb518ce55ef80d32e7c6da6d42ef8b5935138bd914989030799eae86c392"
  },
  {
    "name": "expectedNavigationOutcome",
    "hash": "f45ed39722c82df0bb81eab819fb48957397b26f7fa49215cfd216b59be26c5f"
  },
  {
    "name": "duplicateNavigationObligation",
    "hash": "941dcb7be57905f58e6d1d14a34b86e0bc6ecee338e640ccd6ecda008e1da4c6"
  },
  {
    "name": "duplicateNavigationPayable",
    "hash": "620a7245f81639a0f08fd5172fd44f4fad61620af083704479f4142013f414b8"
  },
  {
    "name": "duplicateNavigationClaim",
    "hash": "3a60396484b796a564cc96995f5c51b3864df24a06ae1bd46dbd3d89b964ece2"
  },
  {
    "name": "assertPartialRecovery",
    "hash": "8777b9616cd01a38f0a0027374f7a08d4e813a4d278d7686f0552c0048aa93e4"
  },
  {
    "name": "validateRelationshipCell",
    "hash": "fdd67f8b1f7dbb1d19854b89e3e1b928bd60fb887786fdc3933645e6a09ca238"
  },
  {
    "name": "seedRelationshipCell",
    "hash": "12b5cc92b6fdbbeef22cb7930f06fde1da5de9858cae46d3dad0f6a9313cc401"
  },
  {
    "name": "relationshipCells",
    "hash": "ff6dbfd788a7cefbf4f07c3b9d0632e56c499664e792f4b447acc736d270536a"
  },
  {
    "name": "relationshipPagination",
    "hash": "524ab181cf1f07ffc52c73fecc23cda5f281af066d6cc188c9faba06d732c028"
  },
  {
    "name": "duplicateRelationship",
    "hash": "6e80d1760e07840292522eeac7c25505d9e04b4d8be5b3dfb909f88b0d4f622e"
  },
  {
    "name": "prepareNavigationState",
    "hash": "a16b9892167005357236956cb49128a4de34aa1c7888c1fd2b2ad0042473a41d"
  },
  {
    "name": "assertNavigationAmounts",
    "hash": "1a08ef4b88d4369a35741a477e0d40acd9432d3800c0564b529253fe8089ce2b"
  },
  {
    "name": "navigationCell",
    "hash": "1af8e6e811505701617559492e3e48d0b9f8a36288e4207c2efa2e7ece44d12d"
  },
  {
    "name": "navigationCells",
    "hash": "051c5eb140381f49e0a0d8d59c231bd2ca7c60df4a25ec0ee26bf9bc9b79edf0"
  },
  {
    "name": "NAVIGATION_PERMISSION_UNIVERSE",
    "hash": "eb5c666845608358095788cb66694f7ab6a21ec2331db1bd9044bdb230b4cc0e"
  },
  {
    "name": "assertAdditionalReceivable",
    "hash": "fec7b556c8dd1f0fe974d0f0e2e8b925bbc5b6d0b31184853c0a035c6e5069dc"
  },
  {
    "name": "distinctNavigationVehicle",
    "hash": "481109e3dca74af508f122fb6ff41e6be11bf2564ebc10c639ccea3e3add1fee"
  },
  {
    "name": "mixedExpectedSections",
    "hash": "9880d9c5902b6cd93b047fa4ce4b4a8987202e09bc4931f9f11e10729f8b8213"
  },
  {
    "name": "mixedNavigationCell",
    "hash": "9801499d8553c1379a1b0c794f7ad8fa0e99bce444b5cb5fd38f0f187759435b"
  },
  {
    "name": "prepareRelationshipVariation",
    "hash": "191f50a76c800653e71fc6bc7f4c2366d8bce04e00431737ee4c753dc8fb9ff8"
  },
  {
    "name": "crossSectionNavigationCell",
    "hash": "3991c529cc9f78ea8e1aa54796c5e499b31ed3ce76b6d14cc5be2e7637ded6fc"
  }
];
const RUNNER_IMPORTS = [
  "b0a008303bd7dd83483384407ff788fe9d9da67029fa2bb37289dd76e3845b21",
  "29f52adfb5477df879b7daf0ebb54ac1d11b20d3a878ba41748f99929f5cc349",
  "56d37a548acb0ca09ce17a1fe75979aa6621e08e4765d7c1d5691e8bf2571fce",
  "1d24588be79419701477735ebf1a15265811f40fbcf64f989fd87bbf3a32428f",
  "801101403874f89a4fb73e5218cfba4663adebde5809f5f260da52b010aadf8a",
  "bc79507e1407facfbd1d26c71d764480a4d79f5b562c4c9234d8d64601a16ea7",
  "2e51ef393b8a135f438084288ba83ebc31b6f0e78e4e06c8726fbe5598635a0e",
  "9cda4ea18978108f13502324effd434f59c3bae61699907d9c403f0d0c4bb47b",
  "7bc02c75159560963e6c480d3908f59f28c8f4acd7e9103254113fa66469c4a7",
  "f041614ce768aa271376dd4353d815be0e7fd58e9f3e68b8f34c3922fb87246a",
  "c8212891ce9be0db845562d22e4ac6547b511081894b088ba8c43c31bb04a6f2"
];
const RUNNER_TYPES = [
  {
    "name": "CallerAudit",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "Seed",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "TargetPermission",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "HiddenState",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationCell",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationOutcome",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationLabel",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationTarget",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "NavigationFixture",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipKind",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipCondition",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipBase",
    "kind": "TypeAliasDeclaration"
  },
  {
    "name": "RelationshipCell",
    "kind": "TypeAliasDeclaration"
  }
];

function runnerStatementName(node: ts.Statement, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return node.name?.text;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => declaration.name.getText(source)).join(",");
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "afterEach") return "afterEach";
}

function runnerRefusal(source: ts.SourceFile, node: ts.Node, reason: string): never {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  throw new Error(`${source.fileName}:${line}: ADMITTED_RUNNER_REFERENCES: ${reason}: ${node.getText(source).slice(0, 160)}; rerun the runner mutants before reviewing this statement`);
}

function runnerRegistration(node: ts.Statement, source: ts.SourceFile): boolean {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  const call = node.expression;
  return ["test", "describe"].includes(call.expression.getText(source)) &&
    call.arguments.length === 2 && ts.isStringLiteral(call.arguments[0]!) &&
    (ts.isArrowFunction(call.arguments[1]!) || ts.isFunctionExpression(call.arguments[1]!));
}

function runnerRoot(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return runnerRoot(node.expression);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return runnerRoot(node.expression);
  if (ts.isCallExpression(node)) return runnerRoot(node.expression);
}

function protectedRunnerTarget(node: ts.Node, protectedNames: ReadonlySet<string>): boolean {
  const name = runnerRoot(node);
  if (name) return protectedNames.has(name);
  // Destructuring writes retain the same prohibition, including nested targets.
  if (ts.isShorthandPropertyAssignment(node)) return protectedNames.has(node.name.text);
  if (ts.isPropertyAssignment(node)) return protectedRunnerTarget(node.initializer, protectedNames);
  if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) return protectedRunnerTarget(node.expression, protectedNames);
  if (ts.isObjectLiteralExpression(node)) return node.properties.some(child => protectedRunnerTarget(child, protectedNames));
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(child => protectedRunnerTarget(child, protectedNames));
  return false;
}

function runnerWriteTarget(node: ts.Node): ts.Node | undefined {
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)) return node.initializer;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return node.left;
  if (ts.isDeleteExpression(node)) return node.expression;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return node.operand;
}

function runnerMember(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}

const RUNNER_HOOKS = ["beforeAll", "beforeEach", "afterAll", "afterEach", "onTestFinished", "onTestFailed", "aroundEach", "aroundAll"];
const RUNNER_EXPECT_MUTATORS = ["extend", "addSnapshotSerializer", "addEqualityTesters", "setState"];
const RUNNER_VI_MUTATORS = ["mock", "doMock", "hoisted"];

function runnerDirectCall(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function allowedRunnerApiValue(node: ts.Identifier, teardown: ts.Statement | undefined): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return true;
  if (RUNNER_HOOKS.includes(node.text)) return node.text === "afterEach" && runnerDirectCall(node) && parent.parent === teardown;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true;
  if (!runnerDirectCall(node)) return false;
  return ["expect", "test", "describe"].includes(node.text);
}

function reviewedRunnerContext(source: ts.SourceFile, node: ts.Node): boolean {
  const statement = ts.findAncestor(node, candidate => ts.isStatement(candidate) && ts.isSourceFile(candidate.parent));
  const name = statement && ts.isStatement(statement) ? runnerStatementName(statement, source) : undefined;
  return name !== undefined && RUNNER_FINGERPRINTS.some(pin => pin.name === name);
}

function sensitiveRunnerMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const owner = runnerRoot(node);
  const member = runnerMember(node);
  if (RUNNER_HOOKS.includes(member ?? "")) return true;
  if (owner === "expect") return !member || RUNNER_EXPECT_MUTATORS.includes(member);
  if (owner === "vi") return !member || RUNNER_VI_MUTATORS.includes(member) ||
    ["spyOn", "stubGlobal"].includes(member) && !runnerDirectCall(node);
  return owner === "test" || owner === "describe";
}

function refuseRunnerApiReference(source: ts.SourceFile, node: ts.Node, teardown: ts.Statement | undefined): void {
  if (ts.isIdentifier(node) && ["expect", "vi", "test", "describe", ...RUNNER_HOOKS].includes(node.text) && !allowedRunnerApiValue(node, teardown)) {
    runnerRefusal(source, node, "a test API value cannot escape through an alias or argument");
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) refuseRunnerMemberReference(source, node);
}

function refuseRunnerMemberReference(source: ts.SourceFile, node: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
  if (sensitiveRunnerMember(node)) runnerRefusal(source, node, "forbidden test API member reference, including aliases and computed members");
  if (runnerRoot(node) === "vi" && !reviewedRunnerContext(source, node)) runnerRefusal(source, node, "vi APIs belong in reviewed pinned helpers");
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "expect") return;
  const member = runnerMember(node);
  if (["any", "arrayContaining", "objectContaining"].includes(member ?? "") && runnerDirectCall(node)) return;
  if (member === "getState" && runnerDirectCall(node) && reviewedRunnerContext(source, node)) return;
  runnerRefusal(source, node, "unreviewed static expect API reference");
}

function refuseRunnerCall(source: ts.SourceFile, node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  protectedNames: ReadonlySet<string>, teardown: ts.Statement | undefined): void {
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const member = runnerMember(callee);
  const rootName = runnerRoot(callee);
  if (rootName && ["test", "describe"].includes(rootName) && member !== rootName) runnerRefusal(source, node, "modified test registrations are forbidden");
  if (member === "eval" || member === "Function") runnerRefusal(source, node, "dynamic execution is outside the runner census");
  if (member && RUNNER_HOOKS.includes(member) && node.parent !== teardown) runnerRefusal(source, node, "only the pinned top-level afterEach is allowed");
  if (runnerRoot(callee) === "expect" && RUNNER_EXPECT_MUTATORS.includes(member ?? "")) {
    runnerRefusal(source, node, "matcher customization is forbidden");
  }
  if (runnerRoot(callee) !== "vi") return;
  if (RUNNER_VI_MUTATORS.includes(member ?? "")) runnerRefusal(source, node, "runner mocks are forbidden");
  if (!["spyOn", "stubGlobal"].includes(member ?? "") || ts.isTaggedTemplateExpression(node)) return;
  const target = node.arguments?.[0];
  if (target && (protectedRunnerTarget(target, protectedNames) || ts.isStringLiteral(target) && protectedNames.has(target.text))) {
    runnerRefusal(source, node, "mocking a protected runner binding is forbidden");
  }
}

function runnerProtectedNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = [...RUNNER_FINGERPRINTS.map(pin => pin.name), ...RUNNER_TYPES.map(pin => pin.name)];
  for (const node of source.statements.filter(ts.isImportDeclaration)) {
    const clause = node.importClause;
    if (clause?.name) names.push(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map(binding => binding.name.text));
  }
  return new Set(names);
}

// Literal per-name admissions below are reviewed with the runner pins. Never infer
// allowed references from the file being measured or renew them to silence a mutant.
const ADMITTED_RUNNER_REFERENCES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "modules": {
    "declaration:seed/value": 1
  },
  "NOW": {
    "declaration:seed/value": 5,
    "declaration:payable/value": 2,
    "declaration:outstanding/value": 1,
    "declaration:financedSale/value": 6,
    "declaration:expectHiddenSale/value": 1,
    "declaration:openingFixture/value": 4,
    "declaration:expenseVehicleFixture/value": 3,
    "declaration:expectHiddenExpenseVehicle/value": 1,
    "declaration:seedReadBound/value": 7,
    "declaration:settleReadBound/value": 6,
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/value": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/value": 1,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/value": 4,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/value": 1,
    "registration:settled rows keep their source context and the actual minor-unit amount/value": 2,
    "registration:P5 opening payable and recovery navigate to the posted opening rather than a vehicle/value": 6,
    "registration:sale and expense sources use existing record screens and supplier economic role/value": 6,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/value": 1,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/value": 1,
    "registration:foreign expense enrichment discloses no source, expense id or title/value": 4,
    "registration:deleted expense enrichment discloses no source, expense id or title/value": 4,
    "registration:foreign opening draft enrichment discloses no source or draft id/value": 5,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/value": 1,
    "declaration:seedNavigationOpening/value": 2,
    "declaration:seedNavigationCell/value": 6,
    "declaration:readBackNavigationCell/value": 1,
    "declaration:duplicateRelationship/value": 2,
    "declaration:navigationCell/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1,
    "declaration:crossSectionNavigationCell/value": 1
  },
  "vehicles": {
    "declaration:related/value": 1,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/value": 2,
    "registration:a distant endCursor cannot widen the relationship read bound/value": 1,
    "declaration:relationshipCells/value": 1
  },
  "callerAudits": {
    "declaration:afterEach/member:length": 2,
    "declaration:afterEach/member:flatMap": 1,
    "declaration:afterEach/value": 1,
    "declaration:afterEach/member:splice": 1,
    "declaration:beginCallerAssertions/member:push": 1
  },
  "EXPECTED_CALLER_RECEIPTS": {
    "declaration:afterEach/value": 1
  },
  "afterEach": {
    "declaration:afterEach/call": 1
  },
  "beginCallerAssertions": {
    "declaration:relationshipCells/call": 1,
    "declaration:navigationCells/call": 1
  },
  "verifyCallerAssertions": {
    "declaration:afterEach/call": 1,
    "declaration:relationshipCells/call": 1,
    "declaration:navigationCells/call": 1,
    "registration:caller assertion helpers reject mismatches and require exactly one real receipt/call": 2
  },
  "assertCallerResult": {
    "declaration:relationshipCells/call": 1,
    "declaration:navigationCell/call": 1,
    "registration:caller assertion helpers reject mismatches and require exactly one real receipt/call": 2,
    "declaration:mixedNavigationCell/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "seed": {
    "declaration:Seed/value": 1,
    "declaration:seedViewer/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1,
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/call": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1,
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 1,
    "registration:two purchase obligations for one vehicle retain distinct stable relationship ids across pages/call": 1,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/call": 1,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/call": 1,
    "registration:settled rows keep their source context and the actual minor-unit amount/call": 1,
    "registration:P5 opening payable and recovery navigate to the posted opening rather than a vehicle/call": 1,
    "registration:sale and expense sources use existing record screens and supplier economic role/call": 1,
    "registration:financed supplier sale links to its same-organization application for a sales viewer/call": 1,
    "registration:financed supplier sale preserves its application label without a link for a viewer without sales/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale for a viewer without sales/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale for a viewer without sales/call": 1,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:foreign expense enrichment discloses no source, expense id or title/call": 1,
    "registration:deleted expense enrichment discloses no source, expense id or title/call": 1,
    "registration:foreign opening draft enrichment discloses no source or draft id/call": 1,
    "registration:missing target permissions preserve labels without links and foreign or deleted targets disclose no label/call": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 1,
    "registration:relationship pages include only linked sourced or owned on-account vehicles, including sold stock/call": 1,
    "registration:relationship bound returns an incomplete page and continuation reaches the remaining vehicle/call": 1,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/call": 1,
    "registration:a distant endCursor cannot widen the relationship read bound/call": 1,
    "registration:invalid stored money keeps the money reader error contract/call": 1,
    "declaration:seedNavigationCell/call": 1
  },
  "payable": {
    "declaration:expectHiddenNativeVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1,
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 1,
    "registration:two purchase obligations for one vehicle retain distinct stable relationship ids across pages/call": 2,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/call": 1,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/call": 3,
    "registration:settled rows keep their source context and the actual minor-unit amount/call": 1,
    "registration:missing target permissions preserve labels without links and foreign or deleted targets disclose no label/call": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 1,
    "registration:relationship pages include only linked sourced or owned on-account vehicles, including sold stock/call": 1,
    "registration:invalid stored money keeps the money reader error contract/call": 1,
    "declaration:seedNavigationCell/call": 2,
    "declaration:mixedExpectedSections/value": 1
  },
  "outstanding": {
    "declaration:expectNoVehicleLabel/value": 1,
    "declaration:expectNoVehicle/value": 1,
    "declaration:expectHiddenSale/call": 1,
    "declaration:expectHiddenExpenseVehicle/call": 1,
    "declaration:expectHiddenNativeVehicle/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1,
    "declaration:expectUnpostedOpening/call": 1,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/call": 2,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/call": 1,
    "registration:P5 opening payable and recovery navigate to the posted opening rather than a vehicle/call": 1,
    "registration:sale and expense sources use existing record screens and supplier economic role/call": 1,
    "registration:financed supplier sale links to its same-organization application for a sales viewer/call": 1,
    "registration:financed supplier sale preserves its application label without a link for a viewer without sales/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale for a viewer without sales/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale for a viewer without sales/call": 1,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:foreign expense enrichment discloses no source, expense id or title/call": 1,
    "registration:deleted expense enrichment discloses no source, expense id or title/call": 1,
    "registration:foreign opening draft enrichment discloses no source or draft id/call": 1,
    "registration:missing target permissions preserve labels without links and foreign or deleted targets disclose no label/call": 3,
    "registration:cash supplier sale keeps its label without a link for a viewer without sales/call": 1,
    "registration:foreign opening draft discloses no source for a viewer without finance management/call": 1,
    "registration:pending opening draft yields no source even for a finance manager/call": 1,
    "registration:posted opening keeps its label without a link for a viewer without finance management/call": 1,
    "registration:expense vehicle keeps its label without a link for a viewer without vehicles/call": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 1,
    "registration:invalid stored money keeps the money reader error contract/call": 1,
    "declaration:navigationCell/call": 1,
    "declaration:mixedNavigationCell/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "related": {
    "registration:two purchase obligations for one vehicle retain distinct stable relationship ids across pages/call": 2,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 1,
    "registration:relationship pages include only linked sourced or owned on-account vehicles, including sold stock/call": 3,
    "registration:relationship bound returns an incomplete page and continuation reaches the remaining vehicle/call": 2,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/call": 1,
    "registration:a distant endCursor cannot widen the relationship read bound/call": 2,
    "declaration:relationshipPagination/call": 1
  },
  "financedSale": {
    "declaration:expectHiddenSale/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectedSaleVehicleCell/value": 1,
    "declaration:expectVehicleCell/call": 1,
    "registration:financed supplier sale links to its same-organization application for a sales viewer/call": 1,
    "registration:financed supplier sale preserves its application label without a link for a viewer without sales/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale for a viewer without sales/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale for a viewer without sales/call": 1,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:cash supplier sale keeps its label without a link for a viewer without sales/call": 1,
    "declaration:NavigationFixture/value": 1,
    "declaration:seedNavigationCell/call": 1
  },
  "seedViewer": {
    "declaration:expectHiddenSale/call": 1,
    "declaration:openingFixture/call": 1,
    "declaration:expenseVehicleFixture/call": 1,
    "declaration:expectHiddenNativeVehicle/call": 1,
    "registration:cash supplier sale keeps its label without a link for a viewer without sales/call": 1
  },
  "hideVehicle": {
    "declaration:expectHiddenExpenseVehicle/call": 1,
    "declaration:expectHiddenNativeVehicle/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1
  },
  "expectNoVehicleLabel": {
    "declaration:expectNoVehicle/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1
  },
  "expectNoVehicle": {
    "declaration:expectHiddenExpenseVehicle/call": 1,
    "declaration:expectHiddenNativeVehicle/call": 1,
    "declaration:expectVehicleCell/call": 1
  },
  "expectHiddenSale": {
    "registration:foreign cash sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:deleted cash sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:foreign financed sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:foreign financed sale enrichment discloses no source for a viewer with sales/call": 1,
    "registration:deleted financed sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:deleted financed sale enrichment discloses no source for a viewer with sales/call": 1
  },
  "openingFixture": {
    "declaration:expectUnpostedOpening/call": 1,
    "registration:foreign opening draft discloses no source for a viewer without finance management/call": 1,
    "registration:pending opening draft yields no source even for a finance manager/call": 1,
    "registration:posted opening keeps its label without a link for a viewer without finance management/call": 1
  },
  "expenseVehicleFixture": {
    "declaration:expectHiddenExpenseVehicle/call": 1,
    "registration:expense vehicle keeps its label without a link for a viewer without vehicles/call": 1
  },
  "expectHiddenExpenseVehicle": {
    "registration:expense keeps its source but hides a foreign vehicle for a viewer without vehicles/call": 1,
    "registration:expense keeps its source but hides a foreign vehicle for a viewer with vehicles/call": 1,
    "registration:expense keeps its source but hides a deleted vehicle for a viewer without vehicles/call": 1,
    "registration:expense keeps its source but hides a deleted vehicle for a viewer with vehicles/call": 1
  },
  "expectHiddenNativeVehicle": {
    "registration:foreign native vehicle yields no source for a vehicle viewer/call": 1,
    "registration:deleted native vehicle yields no source for a vehicle viewer/call": 1
  },
  "expectHiddenSaleVehicle": {
    "registration:local sale label hides its foreign vehicle for a viewer without vehicles/call": 1,
    "registration:local sale label hides its foreign vehicle for a viewer with vehicles/call": 1,
    "registration:local sale label hides its deleted vehicle for a viewer without vehicles/call": 1,
    "registration:local sale label hides its deleted vehicle for a viewer with vehicles/call": 1
  },
  "expectedSaleVehicleCell": {
    "declaration:expectVehicleCell/call": 1
  },
  "expectedNativeVehicleCell": {
    "declaration:expectVehicleCell/call": 1
  },
  "expectVehicleCell": {
    "registration:local native vehicle keeps its label with sales and without vehicles/call": 1,
    "registration:local native vehicle keeps its label without sales and with vehicles/call": 1,
    "registration:foreign native vehicle discloses no source with sales and with vehicles/call": 1,
    "registration:foreign native vehicle discloses no source with sales and without vehicles/call": 1,
    "registration:deleted native vehicle discloses no source with sales and with vehicles/call": 1,
    "registration:deleted native vehicle discloses no source with sales and without vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label with sales and with vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label with sales and without vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its foreign vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its foreign vehicle label without sales and without vehicles/call": 1,
    "registration:cash sale hides its deleted vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its deleted vehicle label without sales and without vehicles/call": 1,
    "registration:financed sale keeps its local vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale keeps its local vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label with sales and without vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label without sales and without vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label with sales and without vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label without sales and without vehicles/call": 1
  },
  "expectUnpostedOpening": {
    "registration:pending approval opening yields no source without finance management/call": 1,
    "registration:rejected opening yields no source with finance management/call": 1,
    "registration:rejected opening yields no source without finance management/call": 1,
    "registration:voided opening yields no source with finance management/call": 1,
    "registration:voided opening yields no source without finance management/call": 1
  },
  "measureHandler": {
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/call": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1,
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 1
  },
  "seedReadBound": {
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/call": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1
  },
  "settleReadBound": {
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1,
    "declaration:prepareNavigationState/call": 2,
    "declaration:mixedNavigationCell/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "NAVIGATION_DEAL_NUMBERS": {
    "declaration:seedNavigationCell/value": 1,
    "declaration:readBackNavigationIdentity/value": 1,
    "declaration:readBackNavigationDocumentFields/value": 1
  },
  "NAVIGATION_PERMISSIONS": {
    "declaration:navigationPermissions/value": 1
  },
  "navigationPermissions": {
    "declaration:seedNavigationCell/call": 1,
    "declaration:readBackNavigationCell/call": 2
  },
  "assertNavigationTarget": {
    "declaration:readBackNavigationCell/call": 1
  },
  "navigationTargets": {
    "declaration:seedNavigationCell/call": 1,
    "declaration:readBackNavigationCell/call": 1
  },
  "seedNavigationOpening": {
    "declaration:seedNavigationCell/call": 1
  },
  "seedNavigationCell": {
    "declaration:seedRelationshipCell/call": 1,
    "declaration:navigationCell/call": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/call": 1,
    "declaration:mixedNavigationCell/call": 2,
    "declaration:crossSectionNavigationCell/call": 2
  },
  "readBackNavigationIdentity": {
    "declaration:seedNavigationCell/call": 1
  },
  "readBackNavigationCell": {
    "declaration:seedRelationshipCell/call": 1,
    "declaration:navigationCell/call": 1,
    "declaration:mixedNavigationCell/call": 2
  },
  "readBackNavigationDocumentFields": {
    "declaration:navigationCell/call": 1
  },
  "expectedNavigationOutcome": {
    "declaration:navigationCell/call": 1,
    "declaration:assertAdditionalReceivable/call": 1,
    "declaration:mixedExpectedSections/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "duplicateNavigationObligation": {
    "declaration:prepareNavigationState/call": 1
  },
  "duplicateNavigationPayable": {
    "declaration:duplicateNavigationObligation/call": 1
  },
  "duplicateNavigationClaim": {
    "declaration:duplicateNavigationObligation/call": 1
  },
  "assertPartialRecovery": {
    "declaration:prepareNavigationState/call": 1
  },
  "validateRelationshipCell": {
    "declaration:relationshipCells/call": 1
  },
  "seedRelationshipCell": {
    "declaration:relationshipCells/call": 1
  },
  "relationshipCells": {
    "registration:relationship query preserves the viewer vehicle permission for sourced and owned rows/call": 1,
    "registration:relationship multi-row large and endCursor pages preserve both viewer gates/call": 1,
    "registration:relationship renamed roles and SOLD status preserve both viewer gates/call": 1,
    "registration:relationship other makes and non-null continuation preserve both viewer gates/call": 1,
    "registration:owned relationships refuse distinct deleted and foreign vehicles beside valid stock/call": 1
  },
  "relationshipPagination": {
    "declaration:relationshipCells/call": 1
  },
  "duplicateRelationship": {
    "declaration:seedRelationshipCell/call": 1
  },
  "prepareNavigationState": {
    "declaration:navigationCell/call": 1
  },
  "assertNavigationAmounts": {
    "declaration:navigationCell/call": 1
  },
  "navigationCell": {
    "declaration:navigationCells/call": 1
  },
  "navigationCells": {
    "registration:settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales/call": 1,
    "registration:settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales/call": 1,
    "registration:settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales/call": 1,
    "registration:settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales/call": 1,
    "registration:settled opening AP preserves the viewer gate and refuses foreign or missing drafts/call": 1,
    "registration:settled opening AR preserves the viewer gate and refuses foreign or missing drafts/call": 1,
    "registration:settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles/call": 1,
    "registration:settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources/call": 1,
    "registration:sale lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:sale lookup checks local deleted and missing targets for financed sales across every navigation condition/call": 1,
    "registration:sale lookup checks deleted and missing financed sales across every navigation condition/call": 1,
    "registration:sale lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:sales link gate checks local targets across every navigation condition/call": 1,
    "registration:application lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:application lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:opening lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:opening lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:opening status gate checks local targets across every navigation condition/call": 1,
    "registration:opening link gate checks local targets across every navigation condition/call": 1,
    "registration:expense lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:expense lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:expense vehicle lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:expense vehicle lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:vehicle link gate checks local targets across every navigation condition/call": 1,
    "registration:settled multi-row AP and AR preserve denied and allowed source links/call": 1,
    "registration:outstanding multi-row AP and AR preserve denied and allowed source links/call": 1,
    "registration:settled partially recovered opening and expense rows preserve denied and allowed viewer gates/call": 1,
    "registration:settled multi-row cross-permission viewers cannot substitute another navigation gate/call": 1,
    "registration:outstanding multi-row cross-permission viewers cannot substitute another navigation gate/call": 1,
    "registration:outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates/call": 1,
    "registration:settled distinct cached vehicle and sale targets preserve every AP and AR context/call": 1,
    "registration:settled distinct cached application expense and opening targets preserve every context/call": 1,
    "registration:settled renamed roles retain denied and admitted navigation gates/call": 1,
    "registration:outstanding distinct cached vehicle and sale targets preserve every AP and AR context/call": 1,
    "registration:outstanding distinct cached application expense and opening targets preserve every context/call": 1,
    "registration:outstanding renamed roles retain denied and admitted navigation gates/call": 1,
    "registration:settled mixed AP and AR keep independent denied and admitted gates/call": 1,
    "registration:outstanding mixed AP and AR keep independent denied and admitted gates/call": 1,
    "registration:settled distinct cached vehicles preserve the denied viewer gate/call": 1,
    "registration:outstanding distinct cached vehicles preserve the denied viewer gate/call": 1
  },
  "NAVIGATION_PERMISSION_UNIVERSE": {
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/value": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/member:filter": 4
  },
  "assertAdditionalReceivable": {
    "declaration:navigationCell/call": 1
  },
  "distinctNavigationVehicle": {
    "declaration:mixedNavigationCell/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "mixedExpectedSections": {
    "declaration:mixedNavigationCell/call": 2,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "mixedNavigationCell": {
    "declaration:navigationCell/call": 1
  },
  "prepareRelationshipVariation": {
    "declaration:seedRelationshipCell/call": 1
  },
  "crossSectionNavigationCell": {
    "declaration:navigationCell/call": 1
  },
  "CallerAudit": {
    "declaration:callerAudits/value": 1,
    "declaration:beginCallerAssertions/value": 2,
    "declaration:verifyCallerAssertions/value": 1,
    "declaration:assertCallerResult/value": 1,
    "declaration:navigationCell/value": 1,
    "registration:caller assertion helpers reject mismatches and require exactly one real receipt/value": 1,
    "declaration:mixedNavigationCell/value": 1,
    "declaration:crossSectionNavigationCell/value": 1
  },
  "Seed": {
    "declaration:payable/value": 1,
    "declaration:outstanding/value": 1,
    "declaration:related/value": 1,
    "declaration:financedSale/value": 1,
    "declaration:hideVehicle/value": 1,
    "declaration:expectNoVehicle/value": 1,
    "declaration:expectedSaleVehicleCell/value": 1,
    "declaration:expectedNativeVehicleCell/value": 1,
    "declaration:measureHandler/value": 1,
    "declaration:seedReadBound/value": 1,
    "declaration:settleReadBound/value": 1,
    "declaration:NavigationFixture/value": 1,
    "declaration:assertNavigationTarget/value": 1,
    "declaration:seedNavigationOpening/value": 1,
    "declaration:seedNavigationCell/value": 1,
    "declaration:relationshipPagination/value": 2,
    "declaration:duplicateRelationship/value": 1,
    "declaration:distinctNavigationVehicle/value": 2,
    "declaration:prepareRelationshipVariation/value": 1
  },
  "TargetPermission": {
    "declaration:seedViewer/value": 1
  },
  "HiddenState": {
    "declaration:hideVehicle/value": 1,
    "declaration:expectHiddenSale/value": 1,
    "declaration:expectHiddenExpenseVehicle/value": 1,
    "declaration:expectHiddenNativeVehicle/value": 1,
    "declaration:expectHiddenSaleVehicle/value": 1
  },
  "NavigationCell": {
    "declaration:navigationPermissions/value": 1,
    "declaration:seedNavigationCell/value": 1,
    "declaration:readBackNavigationIdentity/value": 1,
    "declaration:readBackNavigationCell/value": 1,
    "declaration:readBackNavigationDocumentFields/value": 1,
    "declaration:prepareNavigationState/value": 1,
    "declaration:assertNavigationAmounts/value": 1,
    "declaration:navigationCell/value": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedNavigationCell/value": 1,
    "declaration:crossSectionNavigationCell/value": 1
  },
  "NavigationOutcome": {
    "declaration:expectedNavigationOutcome/value": 1,
    "declaration:navigationCell/value": 1,
    "declaration:navigationCells/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1,
    "declaration:mixedNavigationCell/value": 2,
    "declaration:crossSectionNavigationCell/value": 2
  },
  "NavigationLabel": {
    "declaration:expectedNavigationOutcome/value": 1,
    "declaration:navigationCell/value": 1,
    "declaration:navigationCells/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1,
    "declaration:mixedNavigationCell/value": 2,
    "declaration:crossSectionNavigationCell/value": 2
  },
  "NavigationTarget": {
    "declaration:assertNavigationTarget/value": 1
  },
  "NavigationFixture": {
    "declaration:settleReadBound/value": 1,
    "declaration:navigationTargets/value": 1,
    "declaration:seedNavigationCell/value": 5,
    "declaration:readBackNavigationIdentity/value": 1,
    "declaration:readBackNavigationCell/value": 1,
    "declaration:readBackNavigationDocumentFields/value": 1,
    "declaration:expectedNavigationOutcome/value": 1,
    "declaration:duplicateNavigationObligation/value": 1,
    "declaration:duplicateNavigationPayable/value": 1,
    "declaration:duplicateNavigationClaim/value": 1,
    "declaration:assertPartialRecovery/value": 1,
    "declaration:prepareNavigationState/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1
  },
  "RelationshipKind": {
    "declaration:RelationshipBase/value": 1,
    "declaration:relationshipPagination/value": 1,
    "declaration:duplicateRelationship/value": 1
  },
  "RelationshipCondition": {
    "declaration:RelationshipCell/value": 1,
    "declaration:relationshipPagination/value": 1,
    "declaration:prepareRelationshipVariation/value": 1
  },
  "RelationshipBase": {
    "declaration:RelationshipCell/value": 2
  },
  "RelationshipCell": {
    "declaration:validateRelationshipCell/value": 1,
    "declaration:seedRelationshipCell/value": 1,
    "declaration:relationshipCells/value": 1
  },
  "describe": {
    "registration:supplier navigation by canonical id/call": 1
  },
  "expect": {
    "declaration:afterEach/member:getState": 1,
    "declaration:afterEach/call": 3,
    "declaration:verifyCallerAssertions/call": 1,
    "declaration:assertCallerResult/member:getState": 2,
    "declaration:assertCallerResult/call": 2,
    "declaration:expectNoVehicleLabel/call": 3,
    "declaration:expectNoVehicle/call": 1,
    "declaration:expectHiddenSale/call": 3,
    "declaration:expectHiddenExpenseVehicle/call": 1,
    "declaration:expectHiddenNativeVehicle/call": 1,
    "declaration:expectHiddenSaleVehicle/call": 1,
    "declaration:expectVehicleCell/call": 2,
    "declaration:expectUnpostedOpening/call": 2,
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/call": 2,
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 2,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 2,
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 2,
    "registration:two purchase obligations for one vehicle retain distinct stable relationship ids across pages/call": 4,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/call": 6,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/call": 2,
    "registration:settled rows keep their source context and the actual minor-unit amount/call": 1,
    "registration:P5 opening payable and recovery navigate to the posted opening rather than a vehicle/call": 2,
    "registration:sale and expense sources use existing record screens and supplier economic role/call": 1,
    "registration:sale and expense sources use existing record screens and supplier economic role/member:arrayContaining": 1,
    "registration:sale and expense sources use existing record screens and supplier economic role/member:objectContaining": 7,
    "registration:financed supplier sale links to its same-organization application for a sales viewer/call": 1,
    "registration:financed supplier sale preserves its application label without a link for a viewer without sales/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale without a link/call": 2,
    "registration:financed supplier sale with a deleted application exposes only the local sale without a link/call": 2,
    "registration:financed supplier sale with a foreign application exposes only the local sale for a viewer without sales/call": 2,
    "registration:financed supplier sale with a deleted application exposes only the local sale for a viewer without sales/call": 2,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/call": 3,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/call": 3,
    "registration:foreign expense enrichment discloses no source, expense id or title/call": 3,
    "registration:deleted expense enrichment discloses no source, expense id or title/call": 3,
    "registration:foreign opening draft enrichment discloses no source or draft id/call": 2,
    "registration:missing target permissions preserve labels without links and foreign or deleted targets disclose no label/call": 4,
    "registration:cash supplier sale keeps its label without a link for a viewer without sales/call": 1,
    "registration:foreign opening draft discloses no source for a viewer without finance management/call": 2,
    "registration:pending opening draft yields no source even for a finance manager/call": 2,
    "registration:posted opening keeps its label without a link for a viewer without finance management/call": 1,
    "registration:expense vehicle keeps its label without a link for a viewer without vehicles/call": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 3,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/member:any": 1,
    "registration:relationship pages include only linked sourced or owned on-account vehicles, including sold stock/call": 3,
    "registration:relationship bound returns an incomplete page and continuation reaches the remaining vehicle/call": 5,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/call": 4,
    "registration:a distant endCursor cannot widen the relationship read bound/call": 4,
    "registration:a distant endCursor cannot widen the relationship read bound/member:any": 1,
    "registration:invalid stored money keeps the money reader error contract/call": 2,
    "declaration:assertNavigationTarget/call": 4,
    "declaration:seedNavigationCell/call": 1,
    "declaration:readBackNavigationIdentity/call": 5,
    "declaration:readBackNavigationCell/call": 8,
    "declaration:readBackNavigationDocumentFields/call": 4,
    "declaration:assertPartialRecovery/call": 1,
    "declaration:validateRelationshipCell/call": 7,
    "declaration:relationshipCells/call": 4,
    "declaration:relationshipCells/member:any": 2,
    "declaration:relationshipPagination/call": 4,
    "declaration:assertNavigationAmounts/call": 3,
    "declaration:navigationCells/call": 3,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/call": 2,
    "registration:caller assertion helpers reject mismatches and require exactly one real receipt/call": 5,
    "registration:caller matcher canaries refuse known false strict and partial comparisons/call": 4,
    "declaration:assertAdditionalReceivable/call": 1
  },
  "test": {
    "registration:settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales/call": 1,
    "registration:settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales/call": 1,
    "registration:settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales/call": 1,
    "registration:settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales/call": 1,
    "registration:settled opening AP preserves the viewer gate and refuses foreign or missing drafts/call": 1,
    "registration:settled opening AR preserves the viewer gate and refuses foreign or missing drafts/call": 1,
    "registration:settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles/call": 1,
    "registration:settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources/call": 1,
    "registration:relationship query preserves the viewer vehicle permission for sourced and owned rows/call": 1,
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/call": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1,
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 1,
    "registration:two purchase obligations for one vehicle retain distinct stable relationship ids across pages/call": 1,
    "registration:decoration exhaustion preserves every computed payable row and complete money totals/call": 1,
    "registration:statement rows carry authoritative source, role, timestamp and payee without attaching same-name or legacy rows/call": 1,
    "registration:settled rows keep their source context and the actual minor-unit amount/call": 1,
    "registration:P5 opening payable and recovery navigate to the posted opening rather than a vehicle/call": 1,
    "registration:sale and expense sources use existing record screens and supplier economic role/call": 1,
    "registration:financed supplier sale links to its same-organization application for a sales viewer/call": 1,
    "registration:financed supplier sale preserves its application label without a link for a viewer without sales/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale without a link/call": 1,
    "registration:financed supplier sale with a foreign application exposes only the local sale for a viewer without sales/call": 1,
    "registration:financed supplier sale with a deleted application exposes only the local sale for a viewer without sales/call": 1,
    "registration:foreign sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:deleted sale enrichment discloses no source, sale id or deal number/call": 1,
    "registration:foreign expense enrichment discloses no source, expense id or title/call": 1,
    "registration:deleted expense enrichment discloses no source, expense id or title/call": 1,
    "registration:foreign opening draft enrichment discloses no source or draft id/call": 1,
    "registration:missing target permissions preserve labels without links and foreign or deleted targets disclose no label/call": 1,
    "registration:foreign cash sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:deleted cash sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:foreign financed sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:foreign financed sale enrichment discloses no source for a viewer with sales/call": 1,
    "registration:deleted financed sale enrichment discloses no source for a viewer without sales/call": 1,
    "registration:deleted financed sale enrichment discloses no source for a viewer with sales/call": 1,
    "registration:cash supplier sale keeps its label without a link for a viewer without sales/call": 1,
    "registration:foreign opening draft discloses no source for a viewer without finance management/call": 1,
    "registration:pending opening draft yields no source even for a finance manager/call": 1,
    "registration:posted opening keeps its label without a link for a viewer without finance management/call": 1,
    "registration:expense keeps its source but hides a foreign vehicle for a viewer without vehicles/call": 1,
    "registration:expense keeps its source but hides a foreign vehicle for a viewer with vehicles/call": 1,
    "registration:expense keeps its source but hides a deleted vehicle for a viewer without vehicles/call": 1,
    "registration:expense keeps its source but hides a deleted vehicle for a viewer with vehicles/call": 1,
    "registration:foreign native vehicle yields no source for a vehicle viewer/call": 1,
    "registration:local sale label hides its foreign vehicle for a viewer without vehicles/call": 1,
    "registration:local sale label hides its foreign vehicle for a viewer with vehicles/call": 1,
    "registration:deleted native vehicle yields no source for a vehicle viewer/call": 1,
    "registration:local sale label hides its deleted vehicle for a viewer without vehicles/call": 1,
    "registration:local sale label hides its deleted vehicle for a viewer with vehicles/call": 1,
    "registration:expense vehicle keeps its label without a link for a viewer without vehicles/call": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/call": 1,
    "registration:relationship pages include only linked sourced or owned on-account vehicles, including sold stock/call": 1,
    "registration:relationship bound returns an incomplete page and continuation reaches the remaining vehicle/call": 1,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/call": 1,
    "registration:a distant endCursor cannot widen the relationship read bound/call": 1,
    "registration:invalid stored money keeps the money reader error contract/call": 1,
    "registration:local native vehicle keeps its label with sales and without vehicles/call": 1,
    "registration:local native vehicle keeps its label without sales and with vehicles/call": 1,
    "registration:foreign native vehicle discloses no source with sales and with vehicles/call": 1,
    "registration:foreign native vehicle discloses no source with sales and without vehicles/call": 1,
    "registration:deleted native vehicle discloses no source with sales and with vehicles/call": 1,
    "registration:deleted native vehicle discloses no source with sales and without vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label with sales and with vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label with sales and without vehicles/call": 1,
    "registration:cash sale keeps its local vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its foreign vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its foreign vehicle label without sales and without vehicles/call": 1,
    "registration:cash sale hides its deleted vehicle label without sales and with vehicles/call": 1,
    "registration:cash sale hides its deleted vehicle label without sales and without vehicles/call": 1,
    "registration:financed sale keeps its local vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale keeps its local vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label with sales and without vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its foreign vehicle label without sales and without vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label with sales and with vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label with sales and without vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label without sales and with vehicles/call": 1,
    "registration:financed sale hides its deleted vehicle label without sales and without vehicles/call": 1,
    "registration:pending approval opening yields no source without finance management/call": 1,
    "registration:rejected opening yields no source with finance management/call": 1,
    "registration:rejected opening yields no source without finance management/call": 1,
    "registration:voided opening yields no source with finance management/call": 1,
    "registration:voided opening yields no source without finance management/call": 1,
    "registration:sale lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:sale lookup checks local deleted and missing targets for financed sales across every navigation condition/call": 1,
    "registration:sale lookup checks deleted and missing financed sales across every navigation condition/call": 1,
    "registration:sale lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:sales link gate checks local targets across every navigation condition/call": 1,
    "registration:application lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:application lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:opening lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:opening lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:opening status gate checks local targets across every navigation condition/call": 1,
    "registration:opening link gate checks local targets across every navigation condition/call": 1,
    "registration:expense lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:expense lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:expense vehicle lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:expense vehicle lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup checks local deleted and missing targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup checks remaining local deleted and missing targets across every navigation condition/call": 1,
    "registration:native or sale vehicle lookup refuses foreign targets across every navigation condition/call": 1,
    "registration:vehicle link gate checks local targets across every navigation condition/call": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/call": 1,
    "registration:settled multi-row AP and AR preserve denied and allowed source links/call": 1,
    "registration:outstanding multi-row AP and AR preserve denied and allowed source links/call": 1,
    "registration:settled partially recovered opening and expense rows preserve denied and allowed viewer gates/call": 1,
    "registration:relationship multi-row large and endCursor pages preserve both viewer gates/call": 1,
    "registration:settled multi-row cross-permission viewers cannot substitute another navigation gate/call": 1,
    "registration:outstanding multi-row cross-permission viewers cannot substitute another navigation gate/call": 1,
    "registration:outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates/call": 1,
    "registration:caller assertion helpers reject mismatches and require exactly one real receipt/call": 1,
    "registration:caller matcher canaries refuse known false strict and partial comparisons/call": 1,
    "registration:settled distinct cached vehicle and sale targets preserve every AP and AR context/call": 1,
    "registration:settled distinct cached application expense and opening targets preserve every context/call": 1,
    "registration:settled renamed roles retain denied and admitted navigation gates/call": 1,
    "registration:outstanding distinct cached vehicle and sale targets preserve every AP and AR context/call": 1,
    "registration:outstanding distinct cached application expense and opening targets preserve every context/call": 1,
    "registration:outstanding renamed roles retain denied and admitted navigation gates/call": 1,
    "registration:relationship renamed roles and SOLD status preserve both viewer gates/call": 1,
    "registration:relationship other makes and non-null continuation preserve both viewer gates/call": 1,
    "registration:owned relationships refuse distinct deleted and foreign vehicles beside valid stock/call": 1,
    "registration:settled mixed AP and AR keep independent denied and admitted gates/call": 1,
    "registration:outstanding mixed AP and AR keep independent denied and admitted gates/call": 1,
    "registration:settled distinct cached vehicles preserve the denied viewer gate/call": 1,
    "registration:outstanding distinct cached vehicles preserve the denied viewer gate/call": 1
  },
  "vi": {
    "declaration:afterEach/member:useRealTimers": 1,
    "declaration:seed/member:useFakeTimers": 1,
    "declaration:seed/member:setSystemTime": 1,
    "declaration:measureHandler/member:spyOn": 1
  },
  "makeFunctionReference": {
    "declaration:vehicles/call": 1
  },
  "convexTestWithComponents": {
    "declaration:seed/call": 1
  },
  "seedSupplier": {
    "declaration:seed/call": 3
  },
  "schema": {
    "declaration:seed/value": 1
  },
  "api": {
    "declaration:outstanding/member:supplierStatement": 1,
    "registration:settled rows keep their source context and the actual minor-unit amount/member:supplierStatement": 1,
    "registration:finance without cost gets exactly stock metadata and cannot read statement costs/member:supplierStatement": 1,
    "registration:public readers refuse foreign suppliers, foreign organizations and callers without finance/member:supplierStatement": 1,
    "registration:invalid stored money keeps the money reader error contract/member:supplierStatement": 1,
    "declaration:navigationCell/member:supplierStatement": 1,
    "declaration:mixedNavigationCell/member:supplierStatement": 1,
    "declaration:crossSectionNavigationCell/member:supplierStatement": 1
  },
  "Doc": {
    "declaration:payable/value": 1,
    "declaration:expectUnpostedOpening/value": 1,
    "declaration:NavigationTarget/value": 1,
    "declaration:NavigationFixture/value": 5,
    "declaration:seedNavigationOpening/value": 1,
    "declaration:seedNavigationCell/value": 2
  },
  "outstandingRegistration": {
    "registration:100 rows per family with distinct targets use at most 803 actual gets per outstanding handler/value": 1,
    "registration:100 rows per family sharing targets read each source once across money and decoration/value": 1
  },
  "settledRegistration": {
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/value": 1
  },
  "relationshipRegistration": {
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/value": 1
  },
  "PERMISSIONS": {
    "declaration:NAVIGATION_PERMISSIONS/member:VIEW_SALES": 1,
    "declaration:NAVIGATION_PERMISSIONS/member:VIEW_VEHICLES": 1,
    "declaration:NAVIGATION_PERMISSIONS/member:MANAGE_FINANCE": 1,
    "declaration:navigationPermissions/value": 1,
    "declaration:navigationPermissions/member:VIEW_FINANCE": 1,
    "declaration:navigationPermissions/member:VIEW_COST_PRICE": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/value": 1
  },
  "SYSTEM_KEYS": {
    "declaration:settleReadBound/member:RECEIVABLE_FROM_SUPPLIERS": 2
  }
};

function runnerBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  const namedBinding = ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) ||
    ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent);
  const namedType = ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeParameterDeclaration(parent);
  const namedImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
  return (namedBinding || namedType || namedImport || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent)) && parent.name === node;
}

function runnerPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isImportSpecifier(parent)) return parent.propertyName === node;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return true;
  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) return false;
  return (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node;
}

function runnerStatementBindings(statement: ts.Statement): ts.Identifier[] {
  if (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return statement.name ? [statement.name] : [];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name] : []);
  if (!ts.isImportDeclaration(statement)) return [];
  const bindings: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && runnerBindingIdentifier(node)) bindings.push(node);
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return bindings;
}

function runnerPinnedBindings(source: ts.SourceFile): ReadonlySet<ts.Identifier> {
  const bindings = source.statements.flatMap(runnerStatementBindings);
  const first = new Map<string, ts.Identifier>();
  for (const binding of bindings) if (!first.has(binding.text)) first.set(binding.text, binding);
  return new Set(first.values());
}

function runnerReferenceSite(source: ts.SourceFile, node: ts.Node): string {
  const statement = ts.findAncestor(node, candidate => ts.isStatement(candidate) && ts.isSourceFile(candidate.parent));
  if (statement && ts.isStatement(statement)) {
    const name = runnerStatementName(statement, source);
    if (name) return "declaration:" + name;
  }
  const registration = ts.findAncestor(node, candidate => ts.isCallExpression(candidate) &&
    ["test", "describe", "it"].includes(candidate.expression.getText(source)));
  if (registration && ts.isCallExpression(registration) && ts.isStringLiteral(registration.arguments[0]!)) {
    return "registration:" + registration.arguments[0]!.text;
  }
  return "unreviewed";
}

function runnerReferenceForm(node: ts.Identifier): string {
  if (runnerDirectCall(node)) return "call";
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) return "member:" + node.parent.name.text;
  return "value";
}

function assertRunnerReference(source: ts.SourceFile, node: ts.Identifier, counts: Map<string, number>): void {
  const site = runnerReferenceSite(source, node) + "/" + runnerReferenceForm(node);
  if (ADMITTED_RUNNER_REFERENCES[node.text]?.[site] === undefined) {
    runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES refuses reference ${node.text} at ${site}`);
  }
  if (["navigationCells", "relationshipCells"].includes(node.text) &&
    (!site.startsWith("registration:") || !runnerDirectCall(node))) {
    runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES requires pinned runner ${node.text} as direct registration callee`);
  }
  const key = node.text + "@" + site;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function assertRunnerCallback(source: ts.SourceFile, node: ts.CallExpression): void {
  if (!["test", "describe", "it"].includes(node.expression.getText(source))) return;
  const callback = node.arguments[1];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length !== 0) {
    runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES requires a zero-parameter test/describe/it callback; no context exceptions exist");
  }
}

function runnerLocalSymbol(checker: ts.TypeChecker, root: ts.Node, enclosing?: ts.Node): boolean {
  if (!ts.isIdentifier(root)) return false;
  const symbol = ts.isShorthandPropertyAssignment(root.parent)
    ? checker.getShorthandAssignmentValueSymbol(root.parent) : checker.getSymbolAtLocation(root);
  const declarations = symbol?.declarations ?? [];
  return declarations.some(declaration => declaration.getSourceFile() === root.getSourceFile() &&
    (!enclosing || ts.findAncestor(declaration, candidate => candidate === enclosing) !== undefined));
}

function runnerRootNode(node: ts.Node): ts.Node {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return runnerRootNode(node.expression);
  return node;
}

function refuseNonlocalRunnerWrite(source: ts.SourceFile, checker: ts.TypeChecker, target: ts.Node): void {
  if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
    ts.forEachChild(target, child => refuseNonlocalRunnerWrite(source, checker, child));
    return;
  }
  if (ts.isPropertyAssignment(target)) return refuseNonlocalRunnerWrite(source, checker, target.initializer);
  if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) return refuseNonlocalRunnerWrite(source, checker, target.expression);
  const root = ts.isShorthandPropertyAssignment(target) ? target.name : runnerRootNode(target);
  if (!runnerLocalSymbol(checker, root)) runnerRefusal(source, target, "ADMITTED_RUNNER_REFERENCES refuses mutation of a root not declared in this file");
}

const RUNNER_INTRINSIC_MUTATORS = ["Object.defineProperty", "Object.defineProperties", "Object.assign", "Object.setPrototypeOf",
  "Reflect.set", "Reflect.defineProperty", "Reflect.setPrototypeOf"];
function refuseRunnerIntrinsic(source: ts.SourceFile, checker: ts.TypeChecker, node: ts.CallExpression): void {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES refuses dynamic import()");
  if (!RUNNER_INTRINSIC_MUTATORS.includes(node.expression.getText(source))) return;
  const target = node.arguments[0];
  const enclosing = ts.findAncestor(node, ts.isFunctionLike);
  if (!target || !enclosing || !runnerLocalSymbol(checker, runnerRootNode(target), enclosing)) {
    runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES requires an intrinsic mutator target declared inside its enclosing function");
  }
}

function runnerChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

function assertAdmittedRunnerReferences(source: ts.SourceFile): void {
  const protectedNames = runnerProtectedNames(source);
  const pinned = runnerPinnedBindings(source);
  const counts = new Map<string, number>();
  const checker = runnerChecker(source);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && protectedNames.has(node.text)) {
      if (runnerBindingIdentifier(node)) {
        if (!pinned.has(node)) runnerRefusal(source, node, `ADMITTED_RUNNER_REFERENCES refuses second binding ${node.text}`);
      } else if (!runnerPropertyName(node)) assertRunnerReference(source, node, counts);
    }
    const target = runnerWriteTarget(node);
    if (target) refuseNonlocalRunnerWrite(source, checker, target);
    if (ts.isCallExpression(node)) { assertRunnerCallback(source, node); refuseRunnerIntrinsic(source, checker, node); }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [name, sites] of Object.entries(ADMITTED_RUNNER_REFERENCES)) for (const [site, expected] of Object.entries(sites)) {
    expect(counts.get(name + "@" + site) ?? 0, `ADMITTED_RUNNER_REFERENCES ${name} at ${site}: exact reviewed reference count`).toBe(expected);
  }
}

function refuseRunnerOverrides(source: ts.SourceFile): void {
  const protectedNames = runnerProtectedNames(source);
  const teardown = source.statements.find(node => runnerStatementName(node, source) === "afterEach");
  const visit = (node: ts.Node): void => {
    refuseRunnerApiReference(source, node, teardown);
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) runnerRefusal(source, node, "dynamic execution identifier is forbidden");
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) runnerRefusal(source, node, "classes are forbidden in the behavioural test file");
    const target = runnerWriteTarget(node);
    if (target && protectedRunnerTarget(target, protectedNames)) runnerRefusal(source, node, "write to a protected top-level runner binding");
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) refuseRunnerCall(source, node, protectedNames, teardown);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function assertRunnerFingerprints(source: ts.SourceFile): void {
  refuseRunnerOverrides(source);
  assertAdmittedRunnerReferences(source);
  const imports = source.statements.filter(ts.isImportDeclaration);
  expect(imports.map(node => navigationFingerprint(node, source)), "behavioural runner imports changed; review these statements: " + imports.map(node => node.getText(source)).join(" | ")).toStrictEqual(RUNNER_IMPORTS);
  const declarations: { name: string; node: ts.Statement }[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) || runnerRegistration(node, source)) continue;
    const name = runnerStatementName(node, source);
    if (!name) runnerRefusal(source, node, "unrecognized top-level statement");
    declarations.push({ name, node });
  }
  const types = declarations.filter(({node}) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
  expect(types.map(({name, node}) => ({name, kind: ts.SyntaxKind[node.kind]})), "review the type declaration inventory").toStrictEqual(RUNNER_TYPES);
  const runtime = declarations.filter(({node}) => !ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node));
  expect(runtime.map(declaration => declaration.name), "caller runner helpers: closed declaration set changed; rerun the runner mutants before reviewing these pins")
    .toStrictEqual(RUNNER_FINGERPRINTS.map(pin => pin.name));
  for (const pin of RUNNER_FINGERPRINTS) {
    const node = runtime.find(declaration => declaration.name === pin.name)?.node;
    expect(node && navigationFingerprint(node, source), `${source.fileName}:${pin.name}: runner fingerprint changed; rerun the runner mutants before reviewing this pin`).toBe(pin.hash);
  }
}

function assertCallerReceiptCounts(source: ts.SourceFile): void {
  const counts = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(source) === "EXPECTED_CALLER_RECEIPTS");
  if (!counts || !ts.isVariableStatement(counts)) throw new Error("missing literal EXPECTED_CALLER_RECEIPTS oracle");
  const initializer = counts.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("receipt counts must be a literal object");
  const actual = Object.fromEntries(initializer.properties.map(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isNumericLiteral(property.initializer)) {
      throw new Error("receipt counts require literal title and integer pairs");
    }
    return [property.name.text, Number(property.initializer.text)];
  }));
  const expected = Object.fromEntries(DECLARED_CALLER_CELLS.map(declared => {
    const cells = declared.args[declared.helper === "navigationCells" ? 2 : 0];
    if (!Array.isArray(cells)) throw new Error(declared.title + ": declared cells unavailable");
    return [declared.title, cells.length];
  }));
  // Old door cells also owe receipts; their literal tuples are checked by the door census.
  for (const title of Object.keys(actual as Record<string, unknown>)) {
    if (title in expected) continue;
    const body = literalTestBody(source, title);
    const call = body?.statements[0] && awaitedCallerCall(body.statements[0]);
    const cells = call?.arguments[2];
    if (!cells || !ts.isArrayLiteralExpression(cells)) throw new Error(title + ": receipt oracle has no literal bound cells");
    expected[title] = cells.elements.length;
  }
  expect(actual, "literal receipt counts must match independent declared cells; never renew the cells and declaration together to silence a failure").toStrictEqual(expected);
}


interface DeclaredCallerCells { title: string; helper: string; args: readonly unknown[] }
// Independently declared literal inputs AND outcomes; never populated at test runtime.
const DECLARED_CALLER_CELLS: readonly DeclaredCallerCells[] = [
  {"title":"outstanding distinct cached vehicles preserve the denied viewer gate","helper":"navigationCells","args":["outstanding denied distinct vehicles",["shape","mixTarget","mixState","viewVehicles","validOutcome","validLabel"],[["native","vehicle","local","without","vehicle","vehicle","vehicle","vehicle"],["native","vehicle","deleted","without","vehicle","vehicle","none","none"],["native","vehicle","foreign","without","vehicle","vehicle","none","none"]],"outstanding"]},
  {"title":"settled distinct cached vehicles preserve the denied viewer gate","helper":"navigationCells","args":["settled denied distinct vehicles",["shape","mixTarget","mixState","viewVehicles","validOutcome","validLabel"],[["native","vehicle","local","without","vehicle","vehicle","vehicle","vehicle"],["native","vehicle","deleted","without","vehicle","vehicle","none","none"],["native","vehicle","foreign","without","vehicle","vehicle","none","none"]],"settled"]},
{"title":"settled multi-row cross-permission viewers cannot substitute another navigation gate","helper":"navigationCells","args":["settled cross-permission multi-row caller",["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"],[["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"]],"settled"]},
{"title":"outstanding multi-row cross-permission viewers cannot substitute another navigation gate","helper":"navigationCells","args":["outstanding cross-permission multi-row caller",["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"],[["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"]],"outstanding"]},
{"title":"outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates","helper":"navigationCells","args":["outstanding partial recovery caller",["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"],[["opening","AR","without","without","POSTED","partial","valid","opening","opening"],["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"]],"outstanding"]},
 { title: "settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", helper: "navigationCells", args: ["settled cash sale AP", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", helper: "navigationCells", args: ["settled cash sale AR", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", helper: "navigationCells", args: ["settled application AP", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", helper: "navigationCells", args: ["settled application AR", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled opening AP preserves the viewer gate and refuses foreign or missing drafts", helper: "navigationCells", args: ["settled opening AP", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled opening AR preserves the viewer gate and refuses foreign or missing drafts", helper: "navigationCells", args: ["settled opening AR", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", helper: "navigationCells", args: ["settled native vehicle AP", ["shape","vehicle","viewVehicles","timestamp"], [
  ["native","local","with","valid","vehicle+link","vehicle"],
  ["native","local","without","valid","vehicle","vehicle"],
  ["native","foreign","with","valid","none","none"],
  ["native","deleted","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources", helper: "navigationCells", args: ["settled expense vehicle AR", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","foreign","local","with","valid","none","none"],
  ["expense","deleted","local","with","valid","none","none"],
  ["expense","local","foreign","with","valid","expense","expense"],
  ["expense","local","deleted","with","valid","expense","expense"],
 ], "settled", "AR"] },
 { title: "relationship query preserves the viewer vehicle permission for sourced and owned rows", helper: "relationshipCells", args: [[
    ["SOURCED", "without", "SOURCED", "none"],
    ["SOURCED", "with", "SOURCED", "vehicle"],
    ["OWNED", "without", "OWNED_ON_ACCOUNT", "none"],
    ["OWNED", "with", "OWNED_ON_ACCOUNT", "vehicle"],
  ]] },
 { title: "settled multi-row AP and AR preserve denied and allowed source links", helper: "navigationCells", args: ["settled multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "settled"] },
 { title: "outstanding multi-row AP and AR preserve denied and allowed source links", helper: "navigationCells", args: ["outstanding multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "outstanding"] },
 { title: "settled partially recovered opening and expense rows preserve denied and allowed viewer gates", helper: "navigationCells", args: ["settled partial recovery caller", ["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"], [
  ["opening","AR","without","without","POSTED","partial","valid","opening","opening"],
  ["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],
  ["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],
  ["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"],
 ], "settled"] },
 { title: "relationship multi-row large and endCursor pages preserve both viewer gates", helper: "relationshipCells", args: [[
  ["SOURCED","without","SOURCED","none","multiple"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","multiple"],
  ["SOURCED","without","SOURCED","none","large"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","large"],
  ["SOURCED","without","SOURCED","none","endCursor"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","endCursor"],
  ["SOURCED","with","SOURCED","vehicle","multiple"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","multiple"],
  ["SOURCED","with","SOURCED","vehicle","large"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","large"],
  ["SOURCED","with","SOURCED","vehicle","endCursor"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","endCursor"],
 ]] },
{"title":"settled distinct cached vehicle and sale targets preserve every AP and AR context","helper":"navigationCells","args":["settled mixed vehicle/sale",["shape","mixTarget","mixState","validOutcome","validLabel"],[["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]],"settled"]},
{"title":"settled distinct cached application expense and opening targets preserve every context","helper":"navigationCells","args":["settled mixed application/expense/opening",["shape","mixTarget","mixState","validOutcome","validLabel"],[["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]],"settled"]},
{"title":"settled renamed roles retain denied and admitted navigation gates","helper":"navigationCells","args":["settled renamed caller",["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"],[["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]],"settled"]},
{"title":"outstanding distinct cached vehicle and sale targets preserve every AP and AR context","helper":"navigationCells","args":["outstanding mixed vehicle/sale",["shape","mixTarget","mixState","validOutcome","validLabel"],[["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]],"outstanding"]},
{"title":"outstanding distinct cached application expense and opening targets preserve every context","helper":"navigationCells","args":["outstanding mixed application/expense/opening",["shape","mixTarget","mixState","validOutcome","validLabel"],[["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]],"outstanding"]},
{"title":"outstanding renamed roles retain denied and admitted navigation gates","helper":"navigationCells","args":["outstanding renamed caller",["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"],[["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]],"outstanding"]},
{"title":"relationship renamed roles and SOLD status preserve both viewer gates","helper":"relationshipCells","args":[[["SOURCED","without","SOURCED","none","renamed"],["SOURCED","with","SOURCED","vehicle","renamed"],["OWNED","without","OWNED_ON_ACCOUNT","none","renamed"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","renamed"],["SOURCED","without","SOURCED","none","sold"],["SOURCED","with","SOURCED","vehicle","sold"],["OWNED","without","OWNED_ON_ACCOUNT","none","sold"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","sold"]]]},
{"title":"relationship other makes and non-null continuation preserve both viewer gates","helper":"relationshipCells","args":[[["SOURCED","without","SOURCED","none","otherMake"],["SOURCED","with","SOURCED","vehicle","otherMake"],["OWNED","without","OWNED_ON_ACCOUNT","none","otherMake"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","otherMake"],["SOURCED","without","SOURCED","none","cursor"],["SOURCED","with","SOURCED","vehicle","cursor"],["OWNED","without","OWNED_ON_ACCOUNT","none","cursor"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","cursor"]]]},
{"title":"owned relationships refuse distinct deleted and foreign vehicles beside valid stock","helper":"relationshipCells","args":[[["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-deleted"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-deleted"],["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-foreign"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-foreign"]]]},
{"title":"settled mixed AP and AR keep independent denied and admitted gates","helper":"navigationCells","args":["settled mixed sections",["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"],[["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]],"settled"]},
{"title":"outstanding mixed AP and AR keep independent denied and admitted gates","helper":"navigationCells","args":["outstanding mixed sections",["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"],[["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]],"outstanding"]},
];
function callerLiteral(node: ts.Node, message: string): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(value => callerLiteral(value, message));
  throw new Error(`${message}: caller cells and arguments must be inline literal strings or arrays`);
}
function literalTestBody(source: ts.SourceFile, title: string): ts.Block | undefined {
  const registration = source.statements.filter(ts.isExpressionStatement).map(statement => statement.expression)
    .filter(ts.isCallExpression).find(call => call.expression.getText(source) === "test" &&
      call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === title);
  const callback = registration?.arguments[1];
  return callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body) ? callback.body : undefined;
}
function awaitedCallerCall(statement: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return null;
  return ts.isCallExpression(statement.expression.expression) ? statement.expression.expression : null;
}
function callerCellRegistrationTitles(source: ts.SourceFile): string[] {
  return source.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    const [title, callback] = call.arguments;
    if (call.expression.getText(source) !== "test" || !title || !ts.isStringLiteral(title) || !callback) return [];
    let bound = false;
    const visit = (node: ts.Node): void => {
      if (isExplicitCallerCell(node, source)) bound = true;
      ts.forEachChild(node, visit);
    };
    visit(callback);
    return bound ? [title.text] : [];
  });
}
function isExplicitCallerCell(node: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (node.expression.getText(source) === "relationshipCells") return true;
  const query = node.arguments[3];
  return node.expression.getText(source) === "navigationCells" && query !== undefined && ts.isStringLiteral(query) &&
    ["settled", "outstanding"].includes(query.text);
}

function assertDeclaredCallerCells(source: ts.SourceFile): void {
  expect(callerCellRegistrationTitles(source).sort(), "caller cells: actual and independently declared title sets must match in both directions; never renew the cells and declaration together to silence a failure")
    .toStrictEqual(DECLARED_CALLER_CELLS.map(cell => cell.title).toSorted());
  for (const declared of DECLARED_CALLER_CELLS) {
    const message = `supplier caller / ${declared.title}: executed caller cells must equal the non-empty declared literal cells; never renew the cells and declaration together to silence a failure`;
    const body = literalTestBody(source, declared.title);
    expect(body?.statements.length, message).toBe(1);
    const call = body?.statements[0] && awaitedCallerCall(body.statements[0]);
    expect(call?.expression.getText(source), message).toBe(declared.helper);
    const actual = call?.arguments.map(node => callerLiteral(node, message));
    expect(actual, message).toStrictEqual(declared.args);
    const cells = declared.args[declared.helper === "navigationCells" ? 2 : 0];
    expect(Array.isArray(cells), message + ": cells must be an array").toBe(true);
    if (!Array.isArray(cells)) throw new Error(message);
    expect(cells.length, message + ": declared cells must be non-empty").toBeGreaterThan(0);
  }
}

// SCRUM-943: pin the caller, not just the helper. getText deliberately includes
// the scope's exact initializer so permission re-sourcing needs explicit review.
interface NavigationCaller {
  file: string; caller: string; exportedQuery: string | null; callee: string; arguments: string; scope: string;
}
const NAVIGATION_CALLERS: readonly (NavigationCaller & { tests: readonly string[] })[] = [
  { file: "convex/supplierRelationships.ts", caller: "vehicles", exportedQuery: "vehicles", callee: "project",
    arguments: 'vehicle, "SOURCED", role.permissions', scope: 'role.permissions',
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/supplierRelationships.ts", caller: "vehicles", exportedQuery: "vehicles", callee: "project",
    arguments: 'vehicle, "OWNED_ON_ACCOUNT", role.permissions, payable._id', scope: 'role.permissions',
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AP preserves the viewer gate and refuses foreign or missing drafts", "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", "settled multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AR preserves the viewer gate and refuses foreign or missing drafts", "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources", "settled multi-row AP and AR preserve denied and allowed source links", "settled partially recovered opening and expense rows preserve denied and allowed viewer gates"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["opening link gate checks local targets across every navigation condition", "vehicle link gate checks local targets across every navigation condition", "outstanding multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["sales link gate checks local targets across every navigation condition", "application lookup checks local deleted and missing targets across every navigation condition", "outstanding multi-row AP and AR preserve denied and allowed source links"] },
  { file: "convex/supplierRelationships.ts", caller: "project", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "vehicle.orgId, vehicle._id, permissions", scope: "permissions: readonly string[]",
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows", "relationship multi-row large and endCursor pages preserve both viewer gates"] },
  { file: "convex/utils/supplierNavigation.ts", caller: "vehicleSource", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "args.orgId, vehicle._id, args.permissions", scope: "args: NavigationArgs",
    tests: ["settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", "vehicle link gate checks local targets across every navigation condition"] },
];

function callableNavigationExports(source: ts.SourceFile): string[] {
  const checker = identifierChecker(source);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Cannot enumerate navigation exports. ${updateTable}`);
  // Fail closed on EVERY callable export, regardless of parameter spelling,
  // array aliases, imported scope types or renamed permissions properties.
  // The two non-permission helpers are separately pinned by the original 22 hashes.
  return checker.getExportsOfModule(moduleSymbol).filter(symbol =>
    checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures().length > 0)
    .map(symbol => symbol.name).filter(name => !["supplierVehicleLabel", "supplierNavigationFailure"].includes(name)).sort();
}

function isNavigationModule(source: ts.SourceFile, specifier: ts.Expression): boolean {
  if (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier)) return false;
  const target = ts.resolveModuleName(specifier.text, join(root, source.fileName), CALLER_COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
  return target !== undefined && resolve(target) === resolve(root, "convex/utils/supplierNavigation.ts");
}

function callerCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(`Cannot read caller module-resolution options. ${updateTable}`);
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  if (converted.errors.length) throw new Error(`Cannot parse caller module-resolution options. ${updateTable}`);
  return converted.options;
}
const CALLER_COMPILER_OPTIONS = callerCompilerOptions();

function navigationImportBindings(source: ts.SourceFile, statement: ts.ImportDeclaration, names: readonly string[]): [string, string][] {
  if (!isNavigationModule(source, statement.moduleSpecifier)) return [];
  const imported = statement.importClause?.namedBindings;
  if (!imported) throw new Error(`${source.fileName}: default helper import is unsupported. ${updateTable}`);
  if (ts.isNamespaceImport(imported)) return names.map(name => [`${imported.name.text}.${name}`, name]);
  return imported.elements.flatMap(element => {
    const name = (element.propertyName ?? element.name).text;
    return names.includes(name) ? [[element.name.text, name]] : [];
  });
}

function navigationBindings(source: ts.SourceFile, names: readonly string[]): Map<string, string> {
  for (const statement of source.statements.filter(ts.isExportDeclaration)) {
    if (statement.moduleSpecifier && isNavigationModule(source, statement.moduleSpecifier)) {
      throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1}: review navigation re-export callers and bind their behaviour. ${updateTable}`);
    }
  }
  const own: [string, string][] = source.fileName === "convex/utils/supplierNavigation.ts" ? names.map(name => [name, name]) : [];
  const forwarding: [string, string][] = source.fileName === "convex/supplierRelationships.ts" ? [["project", "project"]] : [];
  return new Map([...own, ...forwarding, ...source.statements.filter(ts.isImportDeclaration).flatMap(statement => navigationImportBindings(source, statement, names))]);
}

function enclosingCaller(node: ts.Node): { caller: string; exportedQuery: string | null } {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return { caller: parent.name?.text ?? "anonymous", exportedQuery: null };
    if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isCallExpression(parent.initializer) &&
      parent.initializer.expression.getText() === "query") {
      return { caller: parent.name.getText(), exportedQuery: parent.name.getText() };
    }
  }
  throw new Error(`Unbound navigation caller at ${node.getSourceFile().fileName}. ${updateTable}`);
}

function scopeDeclaration(source: ts.SourceFile, node: ts.Expression, checker: ts.TypeChecker): string {
  const base = ts.isPropertyAccessExpression(node) ? node.expression : node;
  const declarations = checker.getSymbolAtLocation(base)?.declarations ?? [];
  const declaration = declarations[0];
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return declaration.initializer.getText(source);
  if (declaration && ts.isParameter(declaration)) return declaration.getText(source);
  return node.getText(source); // Inline scopes are pinned too; an unreviewed shape differs from the literal table.
}

function navigationReference(source: ts.SourceFile, node: ts.Node): string {
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return `${node.expression.getText(source)}.${node.argumentExpression.text}`;
  }
  return node.getText(source);
}


function dynamicNavigationTarget(source: ts.SourceFile, node: ts.Node): ts.Expression | undefined {
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (!ts.isCallExpression(node)) return undefined;
  const expression = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword || expression.getText(source) === "require" ||
    ts.isPropertyAccessExpression(expression) && expression.name.text === "require") return node.arguments[0];
  return undefined;
}
function refuseDynamicNavigation(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    const target = dynamicNavigationTarget(source, node);
    if (target && isNavigationModule(source, target)) throw new Error(
      `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: dynamic navigation import/require must become a reviewed static caller. ${updateTable}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function sourceNavigationCallers(source: ts.SourceFile, names: readonly string[]): (NavigationCaller & { line: number })[] {
  refuseDynamicNavigation(source);
  const bindings = navigationBindings(source, names);
  if (!bindings.size) return [];
  const checker = identifierChecker(source);
  const found: (NavigationCaller & { line: number })[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return; // Type queries in generated declarations do not invoke a helper.
    const callee = ts.isCallExpression(node) ? bindings.get(navigationReference(source, node.expression)) : undefined;
    if (callee && ts.isCallExpression(node)) {
      const scope = node.arguments[callee === "addSupplierRowContext" ? 1 : 2];
      if (!scope) throw new Error(`${source.fileName}: missing navigation scope. ${updateTable}`);
      found.push({ file: source.fileName, ...enclosingCaller(node), callee,
        arguments: node.arguments.map(argument => argument.getText(source)).join(", "), scope: scopeDeclaration(source, scope, checker),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    refuseBareNavigationNamespace(source, node, bindings);
    refuseNavigationAlias(source, node, bindings);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function refuseBareNavigationNamespace(source: ts.SourceFile, node: ts.Node, bindings: Map<string, string>): void {
  if (!ts.isIdentifier(node)) return;
  if (![...bindings.keys()].some(name => name.startsWith(`${node.text}.`))) return;
  const parent = node.parent;
  if (ts.isNamespaceImport(parent)) return;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
  if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteral(parent.argumentExpression)) return;
  throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: review computed or aliased navigation namespace ${node.text}. ${updateTable}`);
}

function refuseNavigationAlias(source: ts.SourceFile, node: ts.Node, bindings: Map<string, string>): void {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  if (!bindings.has(navigationReference(source, node))) return;
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isFunctionDeclaration(parent) || ts.isNamespaceImport(parent)) return;
  if (ts.isCallExpression(parent) && parent.expression === node) return;
  throw new Error(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: non-call navigation reference ${node.getText(source)}; review aliases and bind its public-query behaviour. ${updateTable}`);
}

function callerLocation(caller: NavigationCaller): string {
  const source = parse(caller.file);
  const declaration = source.statements.find(statement => {
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === caller.caller;
    return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === caller.caller);
  });
  return `${caller.file}:${source.getLineAndCharacterOfPosition(declaration?.getStart(source) ?? source.end).line + 1}`;
}

function boundCallerCell(node: ts.Node, caller: NavigationCaller): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  if (caller.caller === "project" || caller.caller === "vehicles") return node.expression.text === "relationshipCells";
  if (node.expression.text !== "navigationCells") return false;
  if (caller.caller === "vehicleSource") return node.arguments[1]?.getText().includes('"viewVehicles"') === true;
  const mode = node.arguments[3];
  const query = mode && ts.isStringLiteral(mode) ? mode.text : "outstanding";
  const role = node.arguments[4];
  return query === caller.exportedQuery && (!role || role.getText() === (caller.arguments.endsWith("result.payable") ? '"AP"' : '"AR"'));
}

function testHasCallerCells(source: ts.SourceFile, title: string, caller: NavigationCaller): boolean {
  const body = literalTestBody(source, title);
  if (body?.statements.length !== 1) return false;
  const call = awaitedCallerCall(body.statements[0]!);
  return call !== null && boundCallerCell(call, caller);
}

function assertCallerTests(caller: typeof NAVIGATION_CALLERS[number]): void {
  const file = "convex/supplierNavigation.scrum869.test.ts";
  const source = readFileSync(join(root, file), "utf8");
  const active = listActiveTestRegistrations(source).filter(test => !test.parameterized);
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const location = callerLocation(caller);
  expect(caller.tests.length, `${location}: ${caller.caller} needs behavioural cells. ${updateTable}`).toBeGreaterThan(0);
  for (const title of caller.tests) {
    const message = `${location}: ${caller.caller} / ${caller.arguments} needs active literal behavioural test ${title}. ${updateTable}`;
    expect(active.filter(test => test.title === title).length, message).toBe(1);
    expect(testHasCallerCells(syntax, title, caller), message).toBe(true);
  }
}

function callerPin({ file, caller, exportedQuery, callee, arguments: argumentText, scope }: NavigationCaller): NavigationCaller {
  return { file, caller, exportedQuery, callee, arguments: argumentText, scope };
}

test("supplier navigation caller census pins every permission scope and binds public query behaviour", () => {
  const syntax = parse("convex/supplierNavigation.scrum869.test.ts");
  assertDeclaredCallerCells(syntax);
  assertCallerReceiptCounts(syntax);
  const names = callableNavigationExports(parse("convex/utils/supplierNavigation.ts"));
  expect(names, `Review every permission-taking export and list its callers. ${updateTable}`).toStrictEqual(["addSupplierRowContext", "supplierVehicleHref"]);
  const files = ts.sys.readDirectory(join(root, "convex"), [".ts"], ["**/*.test.ts", "**/*.spec.ts", "**/_generated/**"]);
  expect(files.length, "The recursive Convex caller sweep must not be empty").toBeGreaterThan(0);
  const found = files.flatMap(file => {
    const text = readFileSync(file, "utf8");
    if (!text.includes("supplierNavigation") && !names.some(name => text.includes(name))) return [];
    const source = ts.createSourceFile(relative(root, file).replaceAll("\\", "/"), text, ts.ScriptTarget.Latest, true);
    return sourceNavigationCallers(source, names);
  });
  for (const current of found) expect(NAVIGATION_CALLERS.map(callerPin),
    `${current.file}:${current.line}: added caller or changed scope ${current.caller} / ${current.arguments}. ${updateTable}; add literal cells and a scenario before updating NAVIGATION_CALLERS`)
    .toContainEqual(callerPin(current));
  for (const pin of NAVIGATION_CALLERS.map(callerPin)) {
    expect(found.filter(caller => JSON.stringify(callerPin(caller)) === JSON.stringify(pin)).length,
      `${callerLocation(pin)}: removed or changed caller ${pin.caller} / ${pin.arguments}. ${updateTable}; review its behavioural binding`).toBe(1);
  }
  for (const caller of NAVIGATION_CALLERS) assertCallerTests(caller);
  assertForwardingFingerprints();
  assertCacheFingerprints(parse("convex/utils/supplierReadCache.ts"));
  assertRunnerFingerprints(syntax);
});

test("navigation export census includes renamed arrays and imported scope types", () => {
  const source = ts.createSourceFile("probe.ts", `
    import type { NavigationArgs } from "./imported-scope";
    export function importedScope(args: NavigationArgs): void {}
    export function renamedArray(perms: readonly string[]): void {}
    export function renamedProperty(scope: { grants: string[] }): void {}
  `, ts.ScriptTarget.Latest, true);
  expect(callableNavigationExports(source), "callable exports cannot disappear through noResolve or a permissions rename")
    .toStrictEqual(["importedScope", "renamedArray", "renamedProperty"]);
});

test("navigation census refuses literal dynamic imports and require loaders", () => {
  for (const form of [
    'void import("./utils/supplierNavigation")',
    'require("./utils/supplierNavigation")',
    'void import(`./utils/supplierNavigation`)',
    'require(`./utils/supplierNavigation`)',
    'module.require("./utils/supplierNavigation")',
    'module.require(`./utils/supplierNavigation`)',
    'import navigation = require("./utils/supplierNavigation")',
  ]) {
    const source = ts.createSourceFile("convex/loader-probe.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseDynamicNavigation(source), `dynamic loader cell: ${form}`).toThrow(/dynamic navigation import\/require/);
  }
});

test("caller runner census refuses unlisted statements imports and whole-file overrides", () => {
  const original = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const imports = ts.createSourceFile("runner-imports.ts", original, ts.ScriptTarget.Latest, true).statements
    .filter(ts.isImportDeclaration).map(node => node.getText()).join("\n");
  const forms = [
    'relationshipCells = async () => {};',
    '{ navigationCells = async () => {}; }',
    'class RunnerSetup { static { relationshipCells = async () => {}; } }',
    'test("older body replacement", () => { navigationCells = async () => {}; });',
    'test("nested replacement", () => { function nested() { verifyCallerAssertions = () => {}; } nested(); });',
    'assertCallerResult = () => {}; verifyCallerAssertions = () => {};',
    'test("compound", () => { callerAudits.length += 1; });',
    'test("update", () => { callerAudits.length++; });',
    'test("delete", () => { delete callerAudits[0]; });',
    'test("destructure", () => { ({ navigationCells } = replacement); });',
    'test("class expression", () => { const setup = class {}; });',
    'expect.extend({});',
    'test("alias matcher method", () => { const extendMatcher = expect.extend; extendMatcher({}); });',
    'test("alias matcher owner", () => { const assertionApi = expect; assertionApi.extend({}); });',
    'test("destructured matcher", () => { const { extend } = expect; extend({}); });',
    'describe("alias hook", () => { const hook = afterEach; hook(() => {}); });',
    'test("alias spy", () => { const spy = vi.spyOn; spy(expect, "getState"); });',
    'test("computed matcher", () => { expect["ex" + "tend"]({}); });',
    'test("identity matcher alias", () => { const assertionApi = expect.valueOf(); assertionApi.extend({}); });',
    'test("state alias", () => { const state = expect.getState(); state.currentTestName = "other"; });',
    'describe("called hook alias", () => { afterEach.call(null, () => {}); });',
    'test("chainable vi alias", () => { const utils = vi.useFakeTimers(); utils.stubGlobal("expect", replacement); });',
    'function seed() { const mockModule = vi.mock; mockModule("vitest"); }',
    'function seed() { vi.spyOn(PERMISSIONS, "VIEW_SALES"); }',
    'test("spoof title", () => { expect.setState({ currentTestName: "other" }); });',
    'test("write state", () => { expect.getState().currentTestName = "other"; });',
    'test("matcher inside", () => { expect["addEqualityTesters"]([]); });',
    'expect.addSnapshotSerializer({});',
    'beforeEach(() => expect.extend({}));',
    'test("nested hook", () => { afterAll(() => {}); });',
    'describe("older suite", () => { test.' + 'only("selection", () => {}); });',
    'vi.mock("vitest");',
    'vi.doMock("./supplierStatement");',
    'vi.hoisted(() => {});',
    'vi.spyOn(expect, "getState");',
    'vi.spyOn(callerAudits, "push");',
    'vi.spyOn(PERMISSIONS, "VIEW_SALES");',
    'vi.stubGlobal("expect", replacement);',
    'test("eval", () => { eval("code"); });',
    'test("function constructor", () => { new Function("code"); });',
    'test("tagged function", () => { Function`code`; });',
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("runner-refusal.ts", imports + "\n" + form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow();
  }
  for (const form of ['import "./unreviewed-side-effect";', 'void 0;', ';']) {
    const source = ts.createSourceFile("runner-statement-refusal.ts", original + "\n" + form, ts.ScriptTarget.Latest, true);
    expect(() => assertRunnerFingerprints(source), form).toThrow();
  }
});

test("caller runner census accepts comment-only and whitespace-only controls", () => {
  const original = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  for (const text of ["// formatting control\n" + original, original.replace("function verifyCallerAssertions(", "function   verifyCallerAssertions( ")]) {
    const source = ts.createSourceFile("runner-control.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertRunnerFingerprints(source)).not.toThrow();
  }
});

test("caller receipt oracle rejects a count that disagrees with independently declared cells", () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
    .find(node => node.name.getText(source) === "EXPECTED_CALLER_RECEIPTS");
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("literal count fixture unavailable");
  const first = initializer.properties[0];
  if (!first || !ts.isPropertyAssignment(first) || !ts.isNumericLiteral(first.initializer)) throw new Error("literal count fixture unavailable");
  expect(first.initializer.text, "the first caller declaration has four cells").toBe("4");
  const changed = source.text.slice(0, first.initializer.getStart(source)) + "3" + source.text.slice(first.initializer.end);
  expect(() => assertCallerReceiptCounts(source)).not.toThrow();
  expect(() => assertCallerReceiptCounts(ts.createSourceFile(source.fileName, changed, ts.ScriptTarget.Latest, true)))
    .toThrow(/literal receipt counts must match independent declared cells/);
});

const CACHE_FINGERPRINTS = [
  {
    "name": "createSupplierReadCache",
    "hash": "726b88e82ce936b95ac2a97c2de7da0e89c04489724f154a0e19061643fbfa88"
  },
  {
    "name": "readCached",
    "hash": "9c6e8ba9459ea6cbb07a0021de203bba752846d6496d40ff19e77b8ebe2ceebd"
  }
];
function assertCacheFingerprints(source: ts.SourceFile): void {
  for (const pin of CACHE_FINGERPRINTS) {
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === pin.name);
    expect(node && navigationFingerprint(node, source), "supplier read cache / " + pin.name + ": rerun identity and cache mutants before reviewing this supplier-specific pin").toBe(pin.hash);
  }
}

test("supplier cache fingerprints refuse unreviewed changes to both cache functions", () => {
  const source = parse("convex/utils/supplierReadCache.ts");
  expect(() => assertCacheFingerprints(source)).not.toThrow();
  for (const [name, before, after] of [
    ["createSupplierReadCache", "export function createSupplierReadCache() {", "export function createSupplierReadCache() { void 0;"],
    ["readCached", "  return doc;", "  return null;"],
  ] as const) {
    expect(source.text.includes(before), name + ": source fixture must exist").toBe(true);
    const changed = ts.createSourceFile(source.fileName, source.text.replace(before, after), ts.ScriptTarget.Latest, true);
    expect(() => assertCacheFingerprints(changed), name).toThrow(new RegExp(name));
  }
});

test("caller runner census refuses iteration writes to protected targets", () => {
  const forms = [
    "test(\"for of write\", () => { for (relationshipCells of []) {} });",
    "test(\"for in property write\", () => { for (callerAudits[0] in {}) {} });",
    "test(\"for of destructure write\", () => { for ({ relationshipCells } of []) {} });",
    "test(\"for await write\", async () => { for await (relationshipCells of []) {} });"
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("static-write.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow(/write to a protected top-level runner binding/);
  }
});

test("caller runner census unwraps erased types before checking protected writes", () => {
  const forms = [
    "test(\"prefix assertion write\", () => { (<typeof relationshipCells>relationshipCells) = replacement; });",
    "test(\"satisfies write\", () => { (relationshipCells satisfies typeof relationshipCells) = replacement; });"
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("static-write.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow(/write to a protected top-level runner binding/);
  }
});

test("caller admitted reference table refuses second bindings across callback and declaration forms", () => {
  const original = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const forms = [
    'const relationshipCells = async () => {};',
    'let callerAudits = [];',
    'var EXPECTED_CALLER_RECEIPTS = {};',
    'const { relationshipCells } = replacement;',
    'const { nested: { callerAudits } } = replacement;',
    'function nested(expect: unknown) {}',
    'function nested({ role: callerAudits }: unknown) {}',
    'function relationshipCells() {}',
    'const nested = function assertCallerResult() {};',
    'class verifyCallerAssertions {}',
    'try {} catch (callerAudits) {}',
  ];
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "binding mutation must change the real fixture").not.toBe(original);
    const source = ts.createSourceFile("runner-binding.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertAdmittedRunnerReferences(source), form).toThrow(/ADMITTED_RUNNER_REFERENCES refuses second binding/);
  }
  const importedShadow = original + '\nimport { value as relationshipCells } from "./unreviewed";';
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-import-binding.ts", importedShadow, ts.ScriptTarget.Latest, true)))
    .toThrow(/ADMITTED_RUNNER_REFERENCES refuses second binding relationshipCells/);
});

test("caller admitted reference table closes every registration callback envelope", () => {
  const original = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const title = 'test("relationship query preserves the viewer vehicle permission for sourced and owned rows", async () => {';
  for (const callback of [
    'async (_ctx, relationshipCells = async cells => { callerAudits.push({ expected: cells, asserted: [...cells], message: "forged" }); }) => {',
    'async (_ctx, noOp = () => {}) => {',
    'async function (context) {',
  ]) {
    const text = original.replace(title, title.replace("async () => {", callback));
    expect(text, "callback mutation must change the real fixture").not.toBe(original);
    expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-envelope.ts", text, ts.ScriptTarget.Latest, true)), callback)
      .toThrow(/ADMITTED_RUNNER_REFERENCES requires a zero-parameter/);
  }
  for (const form of ['test("nested", (context) => {});', 'describe("nested", function (context) {});', 'it("nested", (context) => {});']) {
    const source = ts.createSourceFile("envelope.ts", form, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("literal callback fixture unavailable");
    expect(() => assertRunnerCallback(source, statement.expression), form)
      .toThrow(/zero-parameter/);
  }
});

test("caller admitted reference table protects receipt values and global intrinsics by default", () => {
  const original = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const forms = [
    'callerAudits.push({ expected: [], asserted: [], message: "forged" });',
    'const auditAlias = callerAudits;',
    'const countAlias = EXPECTED_CALLER_RECEIPTS;',
    'void typeof callerAudits;',
    'const copy = [...callerAudits];',
    'Object.assign(EXPECTED_CALLER_RECEIPTS, {});',
    'Object.defineProperty(EXPECTED_CALLER_RECEIPTS, "title", { value: 0 });',
    'callerAudits.push = () => 0;',
    'Array.prototype.toSorted = () => [];',
    'Object.is = () => true;',
    'globalThis.reviewFlag++;',
    'delete Array.prototype.toSorted;',
    '({ Array } = replacement);',
    'Object.defineProperties(Array.prototype, {});',
    'Object.setPrototypeOf(Object, {});',
    'Reflect.set(Array.prototype, "toSorted", () => []);',
    'Reflect.defineProperty(Object, "is", { value: () => true });',
    'Reflect.setPrototypeOf(Object, {});',
    'void import("./utils/supplierNavigation");',
  ];
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "reference mutation must change the real fixture").not.toBe(original);
    expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-reference.ts", text, ts.ScriptTarget.Latest, true)), form)
      .toThrow(/ADMITTED_RUNNER_REFERENCES/);
  }
  const local = original.replace(title, title + '\n const local = {}; Object.assign(local, { value: 1 }); Object.defineProperty(local, "other", {value: 2});');
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-local-control.ts", local, ts.ScriptTarget.Latest, true)))
    .not.toThrow();
});
