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
  {"tuple":["financed","local","local","local","without","with","with","fractional"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","positive-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","with","negative-overflow"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","second","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","local","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","foreign","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","local","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","deleted","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","with","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","with","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","with","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
  {"tuple":["financed","local","missing","missing","without","without","without","valid"],"title":"native or sale vehicle lookup checks local deleted and missing targets across every navigation condition"},
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
// SCRUM-943: pin the caller, not just the helper. getText deliberately includes
// the scope's exact initializer so permission re-sourcing needs explicit review.
interface NavigationCaller {
  file: string; caller: string; exportedQuery: string | null; callee: string; arguments: string; scope: string;
}
const NAVIGATION_CALLERS: readonly (NavigationCaller & { tests: readonly string[] })[] = [
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AP preserves the viewer gate and refuses foreign or missing drafts", "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles"] },
  { file: "convex/supplierStatement.ts", caller: "settled", exportedQuery: "settled", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache: createSupplierReadCache() }",
    tests: ["settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", "settled opening AR preserves the viewer gate and refuses foreign or missing drafts", "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.payable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["opening link gate checks local targets across every navigation condition", "vehicle link gate checks local targets across every navigation condition"] },
  { file: "convex/supplierStatement.ts", caller: "outstanding", exportedQuery: "outstanding", callee: "addSupplierRowContext",
    arguments: "ctx, scope, result.receivable", scope: "{ ...args, permissions: role.permissions, cache }",
    tests: ["sales link gate checks local targets across every navigation condition", "application lookup checks local deleted and missing targets across every navigation condition"] },
  { file: "convex/supplierRelationships.ts", caller: "project", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "vehicle.orgId, vehicle._id, permissions", scope: "permissions: readonly string[]",
    tests: ["relationship query preserves the viewer vehicle permission for sourced and owned rows"] },
  { file: "convex/utils/supplierNavigation.ts", caller: "vehicleSource", exportedQuery: null, callee: "supplierVehicleHref",
    arguments: "args.orgId, vehicle._id, args.permissions", scope: "args: NavigationArgs",
    tests: ["settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", "vehicle link gate checks local targets across every navigation condition"] },
];

function permissionExports(source: ts.SourceFile): string[] {
  const checker = identifierChecker(source);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Cannot enumerate navigation exports. ${updateTable}`);
  return checker.getExportsOfModule(moduleSymbol).filter(symbol =>
    checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures().some(signature => signature.parameters.some(parameter =>
      parameter.name === "permissions" || checker.getTypeOfSymbolAtLocation(parameter, source).getProperty("permissions"))))
    .map(symbol => symbol.name).sort();
}

function isNavigationModule(source: ts.SourceFile, specifier: ts.Expression): boolean {
  if (!ts.isStringLiteral(specifier)) return false;
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
  return new Map([...own, ...source.statements.filter(ts.isImportDeclaration).flatMap(statement => navigationImportBindings(source, statement, names))]);
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

function sourceNavigationCallers(source: ts.SourceFile, names: readonly string[]): (NavigationCaller & { line: number })[] {
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
  if (caller.caller === "project") return node.expression.text === "related";
  if (node.expression.text !== "navigationCells") return false;
  if (caller.caller === "vehicleSource") return node.arguments[1]?.getText().includes('"viewVehicles"') === true;
  const mode = node.arguments[3];
  const query = mode && ts.isStringLiteral(mode) ? mode.text : "outstanding";
  const role = node.arguments[4];
  return query === caller.exportedQuery && (!role || role.getText() === (caller.arguments.endsWith("result.payable") ? '"AP"' : '"AR"'));
}

function testHasCallerCells(source: ts.SourceFile, title: string, caller: NavigationCaller): boolean {
  let found = false;
  const visit = (node: ts.Node, within = false): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "test" &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) within = node.arguments[0].text === title;
    if (within && boundCallerCell(node, caller)) found = true;
    ts.forEachChild(node, child => visit(child, within));
  };
  visit(source);
  return found;
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
  const names = permissionExports(parse("convex/utils/supplierNavigation.ts"));
  expect(names, `Review every permission-taking export and list its callers. ${updateTable}`).toStrictEqual(["addSupplierRowContext", "supplierVehicleHref"]);
  const files = ts.sys.readDirectory(join(root, "convex"), [".ts"], ["**/*.test.ts", "**/*.spec.ts"]);
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
});
