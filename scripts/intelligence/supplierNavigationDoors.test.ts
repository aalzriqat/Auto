// @vitest-environment node
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
// Files stay unchanged during one test process. Share their syntax trees read-only;
// each injected probe below still parses its own distinct source text.
const parsedSources = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  const cached = parsedSources.get(file);
  if (cached) return cached;
  // Bypass Vitest module mocks: setup must not serve an old source image to its own guard.
  const source = ts.createSourceFile(file, process.getBuiltinModule("fs").readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  parsedSources.set(file, source);
  return source;
}

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

function assertRuntimeControlForms(forms: readonly (readonly [string, string, string])[]): void {
  if (forms.length === 0) throw new Error("assertRuntimeControlForms requires non-empty forms");
  for (const [code, condition, form] of forms) {
    const escapedForm = form!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(() => navigationConditions(ts.createSourceFile("probe.ts", code!, ts.ScriptTarget.Latest, true)), condition).toThrow(new RegExp(`Unsupported navigation ${escapedForm}: .* at probe\\.ts:1:`));
  }
}

function assertSecondBindingForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertSecondBindingForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "binding mutation must change the real fixture").not.toBe(original);
    const source = ts.createSourceFile("runner-binding.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertAdmittedRunnerReferences(source), form).toThrow(expectedMessage);
  }
}

function assertReferenceForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertReferenceForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "reference mutation must change the real fixture").not.toBe(original);
    expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-reference.ts", text, ts.ScriptTarget.Latest, true)), form)
      .toThrow(expectedMessage);
  }
}

function assertIntrinsicForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertIntrinsicForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    const source = ts.createSourceFile("runner-intrinsic-admission.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertAdmittedRunnerReferences(source), form).toThrow(expectedMessage);
  }
}

test("supplier navigation census refuses switch arrow and method controls", () => {
  assertRuntimeControlForms([
    ['function sourceFor(sale: {status: string}) { switch (sale.status) { case "X": return null; } }', "sale.status", "unlisted runtime kind; update checkRuntimeForm and conditionNode"],
    ['const gate = (sale: {status: string}) => sale.status === "X"; function sourceFor() { return gate; }', "sale.status", "arrow helper"],
    ['const gate = { check(sale: {status: string}) { return sale.status === "X"; } }; function sourceFor() { return gate.check; }', "sale.status", "object literal; update OBJECT_FORMS (no permissions or args spread)"],
  ]);
});

test("supplier navigation census refuses alias binding write and nullable controls", () => {
  assertRuntimeControlForms([
    ['function sourceFor(sale: {status: string}) { const state = sale.status; if (state === "X") return null; }', "sale.status", "property read"],
    ['function sourceFor(sale: {status: string}) { const {status: state} = sale; if (state === "X") return null; }', "sale.status", "special form; update checkSpecialForm"],
    ['function sourceFor(sale: {status: string}) { let state: string; state = sale.status; if (state === "X") return null; }', "sale.status", "binary operator; update BINARY_OPERATORS"],
    ['type Label = string | null; function sourceFor(label: Label) { if (label) return null; }', "nullable:label", "condition IfStatement; update CONDITION_AXIS"],
  ]);
});

test("supplier navigation ownership calls and permission gates retain every declared door row", () => {
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
});

test("supplier navigation schema exemptions retain both impossible deletion states", () => {
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
    "hash": "1a1b612d1353dfa11e28c6b01577b7d54716a8fe6a6000cd2c18abdd44212dc7"
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
    "hash": "a1ebfd3ad76092c3aa79fbfc0704da2440dcc68fe81d58094f6c2661b47f70d9"
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
    "hash": "71cfcd69ddb61e82545bf7f71018e47f1a05c7583cafa3a1c9018363730452d4"
  },
  {
    "name": "seedReadBound",
    "hash": "8e38490669d485be2ca3efe2e0ffadbfe5e3005b9f8b13b8ecd911a06188d805"
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
    "hash": "45cca5ed5f2d56f0cb003f383a54c89da6e78cf62dd746fdec4dbc803007c7ef"
  },
  {
    "name": "seedMixedPhase",
    "hash": "21dd30977a883d8b05d569c8a6138803ad9c2126df8e47c994fff1fc7be8c051"
  },
  {
    "name": "assertMixedPhaseReads",
    "hash": "98401dee4cdd262b0fc76a91f0cac8b2e067dcca19b63e2a682dd0a645772ce2"
  },
  {
    "name": "mixedPhaseExpected",
    "hash": "357f94c3b5d164d876d338314459781c74bbfee9e88b87d161d1e9479f9960a2"
  },
  {
    "name": "mixedNavigationPhase",
    "hash": "79b982169106ac0d709a90d04c7aebb9576516532b367e7c5792cb66a515ad43"
  },
  {
    "name": "mixedNavigationCell",
    "hash": "7faaf25211fe1346bfe4d259fe654cc78d355568ad9de97a880fc668a26084de"
  },
  {
    "name": "prepareRelationshipVariation",
    "hash": "191f50a76c800653e71fc6bc7f4c2366d8bce04e00431737ee4c753dc8fb9ff8"
  },
  {
    "name": "crossSectionNavigationCell",
    "hash": "3991c529cc9f78ea8e1aa54796c5e499b31ed3ce76b6d14cc5be2e7637ded6fc"
  },
  {
    "name": "settledFamilyReadBound",
    "hash": "413497cf207a21e3763a05e2dc5da3b9c3e1ead5ea9e5df525d28052e3259786"
  }
];
const RUNNER_IMPORTS = [
  "b1a5edf634bcc077ef81fdb1587e535896ad62843795de051344e2bae784913c",
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

const READ_BOUND_FIXTURE_HOOKS: readonly { group: string; hash: string }[] = [
  {
    "group": "distinct outstanding read fixture",
    "hash": "91a40e38ed4d8e77531a8cef469c55b5036cb617aa58787964a05a972babdd2b"
  },
  {
    "group": "distinct settled read fixture",
    "hash": "1ef49284bfaff83124585767666ed5b6be188cda709c693a2c8a4ba35efa6546"
  },
  {
    "group": "distinct settled read fixture",
    "hash": "db90f7b6708d3a54bb5cc6a8179b501d4e1c8d4418123383fb7ad802fdf90416"
  }
];

function reviewedRunnerFixtureHook(source: ts.SourceFile, node: ts.Node): boolean {
  const statement = node.parent;
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "beforeAll" ||
    !statement || !ts.isExpressionStatement(statement)) return false;
  const group = ts.findAncestor(node, ancestor => ts.isCallExpression(ancestor) && ancestor.expression.getText(source) === "describe");
  const title = group && ts.isCallExpression(group) ? group.arguments[0] : undefined;
  return !!title && ts.isStringLiteral(title) && READ_BOUND_FIXTURE_HOOKS.some(pin =>
    title.text === pin.group && navigationFingerprint(statement, source) === pin.hash);
}

function runnerDirectCall(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function allowedRunnerApiValue(source: ts.SourceFile, node: ts.Identifier, teardown: ts.Statement | undefined): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return true;
  if (RUNNER_HOOKS.includes(node.text)) return runnerDirectCall(node) &&
    (node.text === "afterEach" && parent.parent === teardown || reviewedRunnerFixtureHook(source, parent));
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
  if (ts.isIdentifier(node) && ["expect", "vi", "test", "describe", ...RUNNER_HOOKS].includes(node.text) && !allowedRunnerApiValue(source, node, teardown)) {
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
  if (member && RUNNER_HOOKS.includes(member) && node.parent !== teardown && !reviewedRunnerFixtureHook(source, node)) runnerRefusal(source, node, "only pinned teardown and scoped fixture hooks are allowed");
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
    "declaration:seedMixedPhase/value": 1,
    "declaration:mixedNavigationPhase/value": 1,
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
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
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
    "declaration:seedNavigationCell/call": 1,
    "declaration:seedMixedPhase/call": 1,
    "declaration:settledFamilyReadBound/call": 1,
    "registration:distinct outstanding read fixture/call": 1,
    "registration:distinct settled read fixture/call": 1
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
    "declaration:seedNavigationCell/call": 2
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
    "declaration:mixedNavigationPhase/call": 1,
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
    "registration:owned relationships sharing a vehicle spend one vehicle get per call/call": 1,
    "declaration:mixedNavigationPhase/call": 1,
    "declaration:settledFamilyReadBound/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1
  },
  "seedReadBound": {
    "registration:100 rows per family sharing targets read each source once across money and decoration/call": 1,
    "declaration:settledFamilyReadBound/call": 1,
    "registration:distinct outstanding read fixture/call": 1,
    "registration:distinct settled read fixture/call": 1
  },
  "settleReadBound": {
    "declaration:prepareNavigationState/call": 2,
    "declaration:mixedNavigationPhase/call": 1,
    "declaration:crossSectionNavigationCell/call": 1,
    "declaration:settledFamilyReadBound/call": 1,
    "registration:distinct settled read fixture/call": 1
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
    "declaration:readBackNavigationCell/call": 2,
    "declaration:seedMixedPhase/call": 1
  },
  "assertNavigationTarget": {
    "declaration:readBackNavigationCell/call": 1
  },
  "navigationTargets": {
    "declaration:seedNavigationCell/call": 1,
    "declaration:readBackNavigationCell/call": 1,
    "declaration:assertMixedPhaseReads/call": 2,
    "declaration:assertMixedPhaseReads/value": 2
  },
  "seedNavigationOpening": {
    "declaration:seedNavigationCell/call": 1
  },
  "seedNavigationCell": {
    "declaration:seedRelationshipCell/call": 1,
    "declaration:navigationCell/call": 1,
    "registration:supplier navigation denied and admitted fixtures pin the full permission complement for every link gate/call": 1,
    "declaration:seedMixedPhase/call": 2,
    "declaration:crossSectionNavigationCell/call": 2
  },
  "readBackNavigationIdentity": {
    "declaration:seedNavigationCell/call": 1
  },
  "readBackNavigationCell": {
    "declaration:seedRelationshipCell/call": 1,
    "declaration:navigationCell/call": 1,
    "declaration:seedMixedPhase/call": 2
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
    "declaration:prepareNavigationState/call": 1,
    "declaration:seedMixedPhase/call": 1
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
    "declaration:seedMixedPhase/call": 1,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "mixedExpectedSections": {
    "declaration:mixedPhaseExpected/call": 2,
    "declaration:crossSectionNavigationCell/call": 1
  },
  "seedMixedPhase": {
    "declaration:assertMixedPhaseReads/value": 1,
    "declaration:mixedPhaseExpected/value": 1,
    "declaration:mixedNavigationPhase/call": 1
  },
  "assertMixedPhaseReads": {
    "declaration:mixedNavigationPhase/call": 1
  },
  "mixedPhaseExpected": {
    "declaration:mixedNavigationPhase/call": 1
  },
  "mixedNavigationPhase": {
    "declaration:mixedNavigationCell/call": 1
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
  "settledFamilyReadBound": {
    "registration:100 settled payable rows with distinct targets preserve totals within 303 actual gets/call": 1,
    "registration:100 settled receivable rows with distinct targets preserve totals within 303 actual gets/call": 1,
    "registration:100 settled recovery rows with distinct targets preserve totals within 203 actual gets/call": 1
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
    "registration:distinct outstanding read fixture/value": 1,
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
    "declaration:prepareRelationshipVariation/value": 1,
    "registration:distinct settled read fixture/value": 1
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
    "declaration:seedMixedPhase/value": 1,
    "declaration:mixedPhaseExpected/value": 1,
    "declaration:mixedNavigationPhase/value": 1,
    "declaration:mixedNavigationCell/value": 1,
    "declaration:crossSectionNavigationCell/value": 1
  },
  "NavigationOutcome": {
    "declaration:expectedNavigationOutcome/value": 1,
    "declaration:navigationCell/value": 1,
    "declaration:navigationCells/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1,
    "declaration:mixedPhaseExpected/value": 2,
    "declaration:mixedNavigationPhase/value": 1,
    "declaration:mixedNavigationCell/value": 1,
    "declaration:crossSectionNavigationCell/value": 2
  },
  "NavigationLabel": {
    "declaration:expectedNavigationOutcome/value": 1,
    "declaration:navigationCell/value": 1,
    "declaration:navigationCells/value": 1,
    "declaration:assertAdditionalReceivable/value": 1,
    "declaration:mixedExpectedSections/value": 1,
    "declaration:mixedPhaseExpected/value": 2,
    "declaration:mixedNavigationPhase/value": 1,
    "declaration:mixedNavigationCell/value": 1,
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
    "declaration:mixedExpectedSections/value": 1,
    "declaration:seedMixedPhase/value": 3,
    "declaration:assertMixedPhaseReads/value": 1
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
    "registration:supplier navigation by canonical id/call": 1,
    "registration:distinct outstanding read fixture/call": 1,
    "registration:distinct settled read fixture/call": 1
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
    "declaration:assertAdditionalReceivable/call": 1,
    "declaration:assertMixedPhaseReads/call": 4,
    "declaration:mixedNavigationPhase/call": 1,
    "declaration:settledFamilyReadBound/call": 2,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 2
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
    "registration:100 settled payable rows with distinct targets preserve totals within 303 actual gets/call": 1,
    "registration:100 settled receivable rows with distinct targets preserve totals within 303 actual gets/call": 1,
    "registration:100 settled recovery rows with distinct targets preserve totals within 203 actual gets/call": 1,
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
    "registration:outstanding distinct cached vehicles preserve the denied viewer gate/call": 1,
    "registration:100 settled rows per family with distinct targets use at most 803 actual gets per handler/call": 1
  },
  "vi": {
    "declaration:afterEach/member:useRealTimers": 1,
    "declaration:seed/member:useFakeTimers": 1,
    "declaration:seed/member:setSystemTime": 1,
    "declaration:measureHandler/member:spyOn": 1,
    "declaration:seedMixedPhase/member:setSystemTime": 1
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
    "declaration:mixedNavigationPhase/member:supplierStatement": 1,
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
    "registration:100 rows per family sharing targets read each source once across money and decoration/value": 1,
    "declaration:mixedNavigationPhase/value": 1
  },
  "settledRegistration": {
    "declaration:mixedNavigationPhase/value": 1,
    "declaration:settledFamilyReadBound/value": 1,
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
  },
  "beforeAll": {
    "registration:distinct outstanding read fixture/call": 1,
    "registration:distinct settled read fixture/call": 2
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

function runnerErasedWrapper(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion | ts.SatisfiesExpression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
}

function runnerIntrinsicName(node: ts.Node): string | undefined {
  if (runnerErasedWrapper(node)) return runnerIntrinsicName(node.expression);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  const owner = runnerRoot(node.expression);
  const member = runnerMember(node);
  const name = `${owner}.${member}`;
  return RUNNER_INTRINSIC_MUTATORS.includes(name) ? name : undefined;
}

function runnerInvocation(node: ts.Node): ts.CallExpression | undefined {
  const parent = node.parent;
  if (runnerErasedWrapper(parent) && parent.expression === node) return runnerInvocation(parent);
  return ts.isCallExpression(parent) && parent.expression === node ? parent : undefined;
}

function refuseRunnerIntrinsicReference(source: ts.SourceFile, node: ts.Node): void {
  if (runnerIntrinsicName(node) && !runnerInvocation(node)) {
    runnerRefusal(source, node, "intrinsic mutator reference must remain a direct call with a reviewed local target");
  }
}

function refuseRunnerIntrinsic(source: ts.SourceFile, checker: ts.TypeChecker, node: ts.CallExpression): void {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) runnerRefusal(source, node, "ADMITTED_RUNNER_REFERENCES refuses dynamic import()");
  if (!runnerIntrinsicName(node.expression)) return;
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
    refuseRunnerIntrinsicReference(source, node);
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
  const registrations: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "test" &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title) registrations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const callback = registrations.length === 1 ? registrations[0]?.arguments[1] : undefined;
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

function assertCallerTests(caller: typeof NAVIGATION_CALLERS[number], syntax: ts.SourceFile,
  active: readonly ReturnType<typeof listActiveTestRegistrations>[number][]): void {
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
  const active = listActiveTestRegistrations(syntax.text).filter(test => !test.parameterized);
  for (const caller of NAVIGATION_CALLERS) assertCallerTests(caller, syntax, active);
  assertForwardingFingerprints();
  assertCacheFingerprints(parse("convex/utils/supplierReadCache.ts"));
});

test("supplier navigation caller sweep enumerates every recursive production caller", () => {
  const names = callableNavigationExports(parse("convex/utils/supplierNavigation.ts"));
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
});

test("supplier navigation runner declarations retain reviewed imports bindings and bodies", () => {
  assertRunnerFingerprints(parse("convex/supplierNavigation.scrum869.test.ts"));
});

test("caller fixture hook pins reject changed setup bodies", () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const changed = source.text.replace("prepared = fixture;", "prepared = undefined;");
  expect(changed).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, changed, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
  const unsettled = source.text.replace("await settleReadBound(preparedSettled);", "return;");
  expect(unsettled).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, unsettled, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
  const moved = source.text.replace('describe("distinct settled read fixture"', 'describe("unreviewed fixture scope"');
  expect(moved).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, moved, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
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
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
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
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
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

test("caller admitted reference table refuses variable second bindings", () => {
  assertSecondBindingForms([
    'const relationshipCells = async () => {};',
    'let callerAudits = [];',
    'var EXPECTED_CALLER_RECEIPTS = {};',
  ], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
});

test("caller admitted reference table refuses destructured and parameter second bindings", () => {
  assertSecondBindingForms([
    'const { relationshipCells } = replacement;',
    'const { nested: { callerAudits } } = replacement;',
    'function nested(expect: unknown) {}',
  ], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
});

test("caller admitted reference table refuses function second bindings", () => {
  assertSecondBindingForms([
    'function nested({ role: callerAudits }: unknown) {}',
    'function relationshipCells() {}',
    'const nested = function assertCallerResult() {};',
  ], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
});

test("caller admitted reference table refuses class catch and import second bindings", () => {
  assertSecondBindingForms([
    'class verifyCallerAssertions {}',
    'try {} catch (callerAudits) {}',
  ], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const importedShadow = original + '\nimport { value as relationshipCells } from "./unreviewed";';
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-import-binding.ts", importedShadow, ts.ScriptTarget.Latest, true)))
    .toThrow(/ADMITTED_RUNNER_REFERENCES refuses second binding relationshipCells/);
});

test("caller admitted reference table closes every registration callback envelope", () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
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
    const call = statement.expression;
    expect(() => assertRunnerCallback(source, call), form)
      .toThrow(/zero-parameter/);
  }
});

test("caller admitted reference table refuses receipt writes aliases and typeof", () => {
  assertReferenceForms([
    'callerAudits.push({ expected: [], asserted: [], message: "forged" });',
    'const auditAlias = callerAudits;',
    'const countAlias = EXPECTED_CALLER_RECEIPTS;',
    'void typeof callerAudits;',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller admitted reference table refuses receipt spreads and mutation methods", () => {
  assertReferenceForms([
    'const copy = [...callerAudits];',
    'Object.assign(EXPECTED_CALLER_RECEIPTS, {});',
    'Object.defineProperty(EXPECTED_CALLER_RECEIPTS, "title", { value: 0 });',
    'callerAudits.push = () => 0;',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller admitted reference table refuses global assignments updates and deletion", () => {
  assertReferenceForms([
    'Array.prototype.toSorted = () => [];',
    'Object.is = () => true;',
    'globalThis.reviewFlag++;',
    'delete Array.prototype.toSorted;',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller admitted reference table refuses intrinsic rebinding and object mutators", () => {
  assertReferenceForms([
    '({ Array } = replacement);',
    'Object.defineProperties(Array.prototype, {});',
    'Object.setPrototypeOf(Object, {});',
    'Reflect.set(Array.prototype, "toSorted", () => []);',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller admitted reference table refuses reflect mutators and dynamic imports", () => {
  assertReferenceForms([
    'Reflect.defineProperty(Object, "is", { value: () => true });',
    'Reflect.setPrototypeOf(Object, {});',
    'void import("./utils/supplierNavigation");',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller admitted reference table admits direct local object mutation controls", () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const local = original.replace(title, title + '\n const local = {}; Object.assign(local, { value: 1 }); Object.defineProperty(local, "other", {value: 2});');
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-local-control.ts", local, ts.ScriptTarget.Latest, true)))
    .not.toThrow();
});

test("caller intrinsic admissions refuse literal and parenthesized global mutators", () => {
  assertIntrinsicForms([
    'Object["defineProperty"](Array.prototype, "reviewSlot", { value: 1 });',
    '(Object.defineProperty)(Array.prototype, "reviewSlot", { value: 1 });',
    '(Object).defineProperty(Array.prototype, "reviewSlot", { value: 1 });',
    'Reflect["set"](Array.prototype, "reviewSlot", 1);',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller intrinsic admissions refuse wrapped mutators aliases and call escapes", () => {
  assertIntrinsicForms([
    'Object["defineProperties"](Array.prototype, {});',
    '(Reflect.setPrototypeOf)(Array.prototype, {});',
    'const mutate = Object.defineProperty; mutate(Array.prototype, "reviewSlot", { value: 1 });',
    'Object.defineProperty.call(null, Array.prototype, "reviewSlot", { value: 1 });',
  ], /ADMITTED_RUNNER_REFERENCES/);
});

test("caller intrinsic admissions admit direct local literal member controls", () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const local = original.replace(title, title + '\n const local = {}; (Object["assign"])(local, { value: 1 }); Reflect["set"](local, "other", 2);');
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-local-intrinsic.ts", local, ts.ScriptTarget.Latest, true)))
    .not.toThrow();
});

// Whole statements include nested callbacks, helper bodies, and module effects.
// This extends navigationFingerprint; no JavaScript mutation-spelling blacklist.
const EXECUTABLE_CLOSURE: readonly { file: string; hashes: readonly string[]; textHash: string }[] = [
  {
    "file": "convex/supplierNavigation.scrum869.test.ts",
    "hashes": [
      "b1a5edf634bcc077ef81fdb1587e535896ad62843795de051344e2bae784913c",
      "29f52adfb5477df879b7daf0ebb54ac1d11b20d3a878ba41748f99929f5cc349",
      "56d37a548acb0ca09ce17a1fe75979aa6621e08e4765d7c1d5691e8bf2571fce",
      "1d24588be79419701477735ebf1a15265811f40fbcf64f989fd87bbf3a32428f",
      "801101403874f89a4fb73e5218cfba4663adebde5809f5f260da52b010aadf8a",
      "bc79507e1407facfbd1d26c71d764480a4d79f5b562c4c9234d8d64601a16ea7",
      "2e51ef393b8a135f438084288ba83ebc31b6f0e78e4e06c8726fbe5598635a0e",
      "9cda4ea18978108f13502324effd434f59c3bae61699907d9c403f0d0c4bb47b",
      "7bc02c75159560963e6c480d3908f59f28c8f4acd7e9103254113fa66469c4a7",
      "f041614ce768aa271376dd4353d815be0e7fd58e9f3e68b8f34c3922fb87246a",
      "c8212891ce9be0db845562d22e4ac6547b511081894b088ba8c43c31bb04a6f2",
      "fd49d3761efc39499490aaa5a2a7417efae346c683e592dbcba7b69a0f9edbae",
      "ae6487bd2fc018a526e87de0723ab23b1a3b6b29ed74b7215a83f2c10b642bec",
      "079e9ff58899e99060e5639b0b62da2ab7cb4d0075aa54f82222fda6c0207771",
      "dd50a8a0c72cb76b207b861f2e0096331d30151fd98fac65921f0de474b78110",
      "f6f323808f532e2862a1efa11630e2b7b37718016ca7e0763250b90e8f4099c4",
      "697f3033d40be2c81209929ae7c111bdc02ba538af8bf3c19592237fe37efde5",
      "3c058576479bcf77e7240d4a593a145fa895513122666e2ad2fead0065f5c90e",
      "8cb10404fa5732764c2decf4ddabd577cf52913870d4b1af4843bd91f0cf2bcc",
      "85c342b129e5562f334011bb86ad81d5ea7b0435847f54a0719dbcff270ee98f",
      "b75a023dca3d468185de49ff0951e462865b26367380dfb059c3b36f49f25e92",
      "4aae6a4ddacc3ee94ac3aa45e971d44b101a67ce256d2e2b22cda553d5ebfbc6",
      "9124a7e4f2e36d23cd9a6790a5f3479997367fc1c464bbfe838075aab037dc4a",
      "cc86f7c102f970fc3267124ed6be10ac2e8f6bc3ab76d9cbac327d5c5415d25e",
      "187e607517885707f2f75d82610caa9751eda740851de195c0d38c1598b6cfe7",
      "36519e0b06a2feffff90db21d0785818f196a9531ae04f731c8ff4e068805331",
      "b8e67723c77ed07c3552588babf87f8d42cbf0647bbc273c1229423c5f6a7825",
      "ce6233112cdc1fa004a93220793559fd9f9437b9a9a179bf11690c8067313972",
      "a1dd027e4be556c48924d2074d6429248e4b66103f9fe2322915b840b8a10a64",
      "c614ce5a237a74a0c966fa158e458619784ed0f7f6e39c5bec1b05edc70536e8",
      "f5e1bd15f686078027132fad39100356f5c502aadb108352af6034a0f30eb384",
      "3cf43713277ca9dc08b77631ec63ad65b710817d052d716751300c41990c9b99",
      "8d18975f65619c1262977e31342dec18d2959596c980763f5b05dce9469b7b9b",
      "c5d4209c948ec7bf06c1696a669882c19a777092c7b2cf6412fe3283c7159cf5",
      "2c6404c0b0f8436d4e4800ac7d0fb5c6aee5cf3dc74174e57af4ae26c22daebd",
      "1a1b612d1353dfa11e28c6b01577b7d54716a8fe6a6000cd2c18abdd44212dc7",
      "13d0c81483a62167e78591d22dd0899d3aa26c6da8a305d259802384eb7134c8",
      "34dd0a0ffb3f48f12973e29de9c89fa1231cf5ef49c052f2888da4fc309df22d",
      "a1ebfd3ad76092c3aa79fbfc0704da2440dcc68fe81d58094f6c2661b47f70d9",
      "8ecd929f681ba0f510e088cfe57d86923390a021522909a3e2612505e63f197a",
      "9b666e39c764d5fcb5202977b6026381cc3a0433b5c02d26643a09df77126096",
      "22ce7eeb7af53aa41bd3aa1affe815f6693dd5a2cc53cbc09ac936964dc4d339",
      "9362e5f2b232cfc1bcb0212e661e168dab49ef943987f9c2410728bbea6693d4",
      "71cfcd69ddb61e82545bf7f71018e47f1a05c7583cafa3a1c9018363730452d4",
      "8e38490669d485be2ca3efe2e0ffadbfe5e3005b9f8b13b8ecd911a06188d805",
      "9a22ebf391d6b45f8a4fc8f16cb26abc859c50dfcabea1d20eb4b70c43785892",
      "a31db8dc1170a54afff9c0f3d05c1e2731745147fb0222d986633f45da8b5031",
      "4484697f5aad170bd25b385e58ecd47872c1680a598b8ac78ae1a6dcec99e19b",
      "f8eaa21a0fafc0eb0181e7d88cae85524773c253943f5cfcdb95a95b91b03dfc",
      "ac2176d4d5c2c7a0e29c2145a4b4e7fb261fead8972839f0df32c6c0ab871f1c",
      "e1aa484a9b6c129c66574a994d6eea3e75b35dab1179e5a489d042f64e1a9bb6",
      "7a3e766a21803c2628dd6898e22cebbe1736bd68c1b63876fce3ea30448ac39c",
      "f9bc897421de26748dc19f20c889a5d965d02024cd3bbcc3bad18fba25301518",
      "99ba08f5f018a23761e6ac5892d32f764a9d6ca881bfbae148aadf0fab88c590",
      "0cc43942cab6253d02f70a78efd3d974ccc2fb530cef65c68a4b1751546fd6b1",
      "70b6304e5b5580b9c6b12a7e25e4e55a84838b2119094b63d7c507a6e2628ab7",
      "4035f7bf688856cc72df226fc3e6024df22cf186d54cbad8a41e60fde3751e96",
      "9a8db53a5f95ef1bd52659971371d15cf1930b5793e231afff178876ee9840a6",
      "4ec1252e3cc632d80021c5bd9e4ce8f6cf70a9507d50b85597aad62702ed95a5",
      "13f9b6e310d7d1eeba0e855b7435f03dcd14530e1aa28dbcbf59e886a84f5079",
      "bfb9637f364fc13eb9708d460523ff2507757e112669c30089a6a2fcfaffe0df",
      "ca68692ce425ae728f80f13f5528a0159394628de751bbfd079f955cb08b6fe0",
      "5400cedb24582de79a2b7a751701b9b1c339e5b11579449162413fc39627e7ee",
      "9b5a4da7d1e9eb8f7d283079ad0cab0cca0e861189455292648957b3e29e1ca8",
      "ed4fb57643969c47d9452ca0d4eb3d3e9aafb74787ffd3296e5aa2f6311ae35e",
      "922f2b5c5bac7f9f6041b6336b8237c30312c35bf8ffeb5eb7754249727b374b",
      "f0bf8ea5c97b5f390c69152cb86cfd2e07a2e57691e1e3a53dbb06c7433ebc20",
      "0278e650f9bb6839311e86ffd51d926f2d6736e9e3869178f1cb7fd99e47b256",
      "ff554aa94a13fc5275d645228a6a20fed325f8025726430a09fe776f0dba0757",
      "7c0bec72f56acc054730c7482b29f2066e82063d7669c748acd3422a369743d6",
      "3b0dfb518ce55ef80d32e7c6da6d42ef8b5935138bd914989030799eae86c392",
      "f45ed39722c82df0bb81eab819fb48957397b26f7fa49215cfd216b59be26c5f",
      "941dcb7be57905f58e6d1d14a34b86e0bc6ecee338e640ccd6ecda008e1da4c6",
      "620a7245f81639a0f08fd5172fd44f4fad61620af083704479f4142013f414b8",
      "3a60396484b796a564cc96995f5c51b3864df24a06ae1bd46dbd3d89b964ece2",
      "8777b9616cd01a38f0a0027374f7a08d4e813a4d278d7686f0552c0048aa93e4",
      "784e8067bbd1abba64107432edba320d57db7ec95a791a3e36d8786ea8c82a43",
      "17a4b5b244f6b2867d72054b8972c1300ebb210bd014d710695725f48c238812",
      "cea72b46e45d60ea9234e89d41abc2a45eb30c6df996cc5d47a7e2473b49cbce",
      "641b6e01e4492ba8234a44979c234814cd268b84ebed1f86b2c7b7c4f2d68b5a",
      "fdd67f8b1f7dbb1d19854b89e3e1b928bd60fb887786fdc3933645e6a09ca238",
      "12b5cc92b6fdbbeef22cb7930f06fde1da5de9858cae46d3dad0f6a9313cc401",
      "ff6dbfd788a7cefbf4f07c3b9d0632e56c499664e792f4b447acc736d270536a",
      "524ab181cf1f07ffc52c73fecc23cda5f281af066d6cc188c9faba06d732c028",
      "6e80d1760e07840292522eeac7c25505d9e04b4d8be5b3dfb909f88b0d4f622e",
      "a16b9892167005357236956cb49128a4de34aa1c7888c1fd2b2ad0042473a41d",
      "1a08ef4b88d4369a35741a477e0d40acd9432d3800c0564b529253fe8089ce2b",
      "1af8e6e811505701617559492e3e48d0b9f8a36288e4207c2efa2e7ece44d12d",
      "051c5eb140381f49e0a0d8d59c231bd2ca7c60df4a25ec0ee26bf9bc9b79edf0",
      "8f6045960a24bc3fa865d3b559158ca9a451c1d59ed44a072c65614b175860c7",
      "0c5ce7bc715e41a26a4dfd657de38c767cc93be4672b2880a1f4ef739a60a9c5",
      "752bed98f247446b513966085c3979790717c24e1b73d15e213473bc9145186b",
      "fbcc0fb397ac83850567f6b7101d405b1a03d1efcd3e9a7e17a57d063d9fcfcb",
      "ee55b3f56a39464d4114a3f2332e7c4474af87df12618b33f17a62608d656ec2",
      "5c755b74ad63f0aba78a8aadd4536df9fa33d4f437b70062d33cd2952a1d62f2",
      "77fee5d50e3fa89493a99940f7c4df152d47e196b99c762a36f37a91ec5a98e3",
      "d6d574f22a1c1c2d311fed80611454712061d2bc2843c6a539ebbabdb184f8dc",
      "c407a8716d4f9f1b2c4d522618a6fcb817ff7e41a484dca8966a4529d8cb2ae2",
      "841cc8263d34d3cfc1d515884015c11ab2dda9e2d9fa6d364c1981bbfa8d5de0",
      "8abe57ec522054d90531a5869601e1b65260309391c9a69ace579510da96604b",
      "51838e134d89c21f167bb1d4b27fdb51b75e7ad1377096c11c2cc216f2eb2d4a",
      "7fc3b56b275d157529c81735fdaedbd0755f2bc80ea06441d2aaa6dfddceb584",
      "97d8783d8c0b3f6d7abede9738cc7f0e56ff220dda2f4010140fa8112a3d31a4",
      "2251e7ffb861193806c97871d6876bfb6ca634ea77be2cfc6c1091729d5e9e79",
      "8c6424e1fbe8ea49d4cb33e8676b556f5f26f527d94f0108591971bbe20ebc06",
      "6394fae4a98324f1ebc3220308db6d9674ea2e5a9dddeff59dec6195b6665682",
      "4d38c32a6012c08f30914f592e6a2d9457d9ba6eac9aeb8e163ea2442a9fd521",
      "af3d972933c06488bb85395a56cdfe30f858e610f18cc00799e491963c99857e",
      "eb5c666845608358095788cb66694f7ab6a21ec2331db1bd9044bdb230b4cc0e",
      "1c7a19b461302cde824501f770f0c2261400fb583aeb6364edc7901801b956e6",
      "e299e7834512429f1e4264e92a9b1685d498988dfb89daad1a1bdcc118027d50",
      "cc714051b3867275a1171a0d055eac20594a9900b2ef78c6f8cf807339786344",
      "080958805809231243e62e8f723b3a4599d45444c95224d7b1514f7fca243a09",
      "b9473c7fd529552886ce316c681161e7126b157b1c18499dd616f98181142c92",
      "66ceec3e05cb1c40310a25fdf8db614e12a97cc9dd27fe030c10979127673e12",
      "e4204fcffbbc894feb7df5a6c25b79c804b17f9596f42bfc116c74f66ac8a972",
      "203c391288535adfe4d7757d5301c451925698bf962c264e1fd49bf483c00796",
      "74ec29f9f5ab28eb72efb8ee585e0b2152b1f32c2ec3f80911124fb02281e78e",
      "64adfe22fd77b58e4d7e57918b6238a894f5b9410ebee4408b27ac3f3925b4d4",
      "fec7b556c8dd1f0fe974d0f0e2e8b925bbc5b6d0b31184853c0a035c6e5069dc",
      "481109e3dca74af508f122fb6ff41e6be11bf2564ebc10c639ccea3e3add1fee",
      "45cca5ed5f2d56f0cb003f383a54c89da6e78cf62dd746fdec4dbc803007c7ef",
      "21dd30977a883d8b05d569c8a6138803ad9c2126df8e47c994fff1fc7be8c051",
      "98401dee4cdd262b0fc76a91f0cac8b2e067dcca19b63e2a682dd0a645772ce2",
      "357f94c3b5d164d876d338314459781c74bbfee9e88b87d161d1e9479f9960a2",
      "79b982169106ac0d709a90d04c7aebb9576516532b367e7c5792cb66a515ad43",
      "7faaf25211fe1346bfe4d259fe654cc78d355568ad9de97a880fc668a26084de",
      "191f50a76c800653e71fc6bc7f4c2366d8bce04e00431737ee4c753dc8fb9ff8",
      "dfc2d5bc3f382d344a47cdcef0a6e04e0a5e592633b7af4b816a613a529f480b",
      "92a5616cdf38a1b7cd6ea8a28df8c256a1b65591a18be9be4fbd2b5e0617605c",
      "09721c90b6913525fdc9e74cf944a0eaf805178421f2d30dfd88ce9cb47573b4",
      "97a110975d04e3ff079dbde2a8d31a432fce86b7bef6b1b4c4c64df1ad17df99",
      "7d051eee5510b618eb89fc4f3909748e418a103506f7dccce136c7cce8642e63",
      "cc54bd068276aaf0e9c1ac5c8749f8327880738d6c5556f74666c0ea67258a67",
      "0f3ec5ddb0b4cf5f60b83ffc7e4839665420a245726e6f075a694b9fda9fdcf3",
      "06e6658daecb64dfa181bb1d3da37e4d01e27fdd01c0784f4b0e51b3631de602",
      "30b497b8594aa3fb7fb4f2b8ffd87b8d7ae7ce659b7593e9606224c168858a2c",
      "3991c529cc9f78ea8e1aa54796c5e499b31ed3ce76b6d14cc5be2e7637ded6fc",
      "903f99d4144620c82251787d6eaf79f8ebe430d5db81b19b470b3c33ac0057c6",
      "2d313df9a57af6a03f8fa8adcc45d6a689a022320ac0e8cfdfce5de10aa9802c",
      "342948e47a95b944953c82f8eb484e188ff99a5d6e1d6b8bd4e6e0f164cf5f6d",
      "08c6ee2954fc7db69338ac6167046de1df052d3e81e6233b6fcec3b71b346e33",
      "413497cf207a21e3763a05e2dc5da3b9c3e1ead5ea9e5df525d28052e3259786",
      "1ec68cec30e52b650436978d662ae552686d03fa7405a0c2ee1651f9eba3185b"
    ],
    "textHash": "7909fe1b2658d7cb3c968b24943187fcce8bf6968f2d933c49770271d78af4c1"
  },
  {
    "file": "scripts/intelligence/supplierNavigationDoors.test.ts",
    "hashes": [
      "7caa58c01dc1ed03aacfcec5637fd21bb3d6062f8531da710b7579befe5346e0",
      "93599ac1bc1a10d378f14c5cffa692674017d54e49723fa9c6c042b4a8cdf4dc",
      "66c4354c7f5c2c2c14854f5c9d09f75d7bfd95322f363c10f15ac987f0cd31f1",
      "43f97a8c202312e7f0e8cbd5731512eed08cb127c0a86c9f21ec160fca18e160",
      "248d401c44afb296bee2f5fd117db9f47a430d3c5cff9935ac24548a54a253bb",
      "0a51a4c62213d303acc91c036ca088a12882510ad0581ca9ec4a2af276652a6d",
      "66ba5c6013fae6ede90a9c25b7d4dc6e810028e6c5e0947ef362f0a6fab377c7",
      "55d91a0b9596d4fa2313e855f03d5a27895dee7bb5900c197ff3a686da88fea8",
      "025b8073cd5dc2ec4303b91125882c6b5e4d59f9ac97ebee1ab7a7bdce755151",
      "395c169f55425a3381ac506d076c6c3997067fe39299ec8720ec01d90b8dd38c",
      "03d603a3552b8d11b1470414f414b68bafd3964ba755e4ce434b2ab6cd685309",
      "2e52210897e7976384b908832b3b5f6127c90105bc275f91d9277f97879070b5",
      "63ac09f1910e741b9add59dafb00943f9c632d32e6248fa42c366ac2450fc13c",
      "7c8afa58b0763aa81420ce5b3e170a0173196f6de9631b509b5371136bc4aaaa",
      "b33d7c157608a2962b3f85e862d855cb0f746568acfada4f84a93e5d3c42a90c",
      "2e0534b283f858abad175d51501ff950cc01b0336e4ea443b20ebbb240f8ca65",
      "3b5a73d0c60c2d3fc178ff922d693c39af52c8980f15f9080da4b86e0345f073",
      "fea1c881862e8e06cd6377d36bb96e46e33702682794c7162fb213b5144d0988",
      "accd63a822495a230c9ee2ffe3571dbd5d1dcd392f424cdd13d6e74bac4b8bba",
      "62bd6143c48d07ea63bf65bd4db7cf7dabadddc9f9f418ca5314be722a9456f7",
      "94247938a12c88a06c0562c8169ad149640b7e6025f231d1ed111894d0844c3c",
      "90ddb5bf9ad6e3ef36f70c267afbcd49fff063badd96cd0205ad59db3231a280",
      "6f665d1a9e8731e15d1b5f6f0dfe8e1340d18f920fa2f689125627aefa217435",
      "f94e76179996387b1b35f380456ae61ceb36b3dede3b23b823483d745b4e5088",
      "fb0b8274298af728aa09bca783cc317d160295bfad45d30f19b7bea7ade61f2b",
      "6407c6b6146bd1f889d57a6827fc142825774ccae24c46e20f48139a585df691",
      "c9766a6e9582dfd29f41c791b09018dc14f346ed7ea50d9ec24e4bdfc633d43d",
      "00782b2814880eb1094339132cdc772e7f42aa67415bfa9a648410f9476be7c3",
      "817cbd36b1fe15072072309542ee007dbc6dfe7268661dbce67f316307ef3b89",
      "06fae8bd0aace372d9dcc248c31b86d9ee25ac1f618cdf1eb265c75a599df525",
      "2661571d9ced58cfc5ec4920ea3f8e8d7df83b91d55de419c77545f41482f048",
      "9bcc0548295f347bca2cd83e4f060f618c8a14bfc21220a4ef8f296b440e393f",
      "d8bb9e69b00c1302148508629f012bb2b5a0c56a54aa9c4daef733f3950f15be",
      "863a6bc155ff0ec75c3df124fd80d9ac10d7a5c4003593753ca83edeecc8805b",
      "becdbca817a3cfb5e5e341070bb58e4bf45d9734230dad4cfd74794f720aea8b",
      "84df2c334be509a9668788e4ceedaf86e4e9fc47309c93bf6dedd9be7a672647",
      "70eec31a165451628d42738c68d33d5213ad89fb9542dbbcac07c5556ed6725b",
      "5e4364e400b0d5f1e7142a970425bf27ffcec50ca088f8e9dd0e284520cde541",
      "25469bad5836a66943bc086ff858bb181aa25e12d88500a49daab7fdb2925f13",
      "4932e4476a0cc519e92c6c24516032a90901abb7a92d9763fa22890c657650a7",
      "b448238f2c3fccc13d26312ebd3416dc8fd660900a7b914e5533a2e5dc330a0f",
      "db3ec81975bbbfeac53ee8aa916e824ea19cd3b7b5c200550e20a284df69db0a",
      "99188bb76339dff1d6ddad8c9cfb45f9f34df9586c9cae486d065a45b0fcdd47",
      "22c376e495c6b3a3308c4582577add36d706bfc89cb88fe738aee5897f28138c",
      "62e8ccebc43f6865151d83f965c7b8fc9aa1463cbadead775f639a37c94647e1",
      "7c0434f5ba69b82e1303d397005f848697d67f387c5f6e8986d74625955c7e53",
      "bee9b3d533bbbd8923b3c84b96bcef59f86f5591491daba0b6abedecd1f5374e",
      "7b68c3aa05cbaaee5dae9b8d247947ca826e30b08f8b4a3bc0ecea51d2ee34f3",
      "9a65382abb7a7251fbad8af04655d1579dd84c10bbd9dc3e89d4ec0756069614",
      "a873ac5cffff1d05cd7b111a5cb75b2e85932ac6c83d9dbeeb72dacb107ca944",
      "9b25143fae33d3d3914593bdb238f5cbc30d6506fe6aef6d946a212f05f90689",
      "ceeb69da23ee5e35ed952488adfde19198245c9cb4ea5a4009097a61b3c408b9",
      "6e1540c9f84d885260e8e12fab1cd96e605069adca055da8f41b16fb8b54a740",
      "afef48ead15d2ebe3f14f7e2e88c7560d03523185e6859f997b4f8053e5467d1",
      "4220c0bd06bb966f319b4c06423b37db63f734d78970358bdf4462fbc1852b31",
      "04615fbfd259a817d50e5c898ac09e21a86c64de662701234e2b38fc64d8707b",
      "e1dc906b6c1e8d12e97f58d6deae48d5b3f2955d7613d45ab9a778cd65f9e7a0",
      "9b86c86598c9a4c23bdfdf11a4618cf6a637fa311b3ebf9540c78ad3936a48d4",
      "a2c7875d8b16df21f96cdb66bc2ac1322bd92b3b8bd067d92fcc493afb3eb783",
      "b96d31510a049d3f9a328d0fa2a6b420949f25666f0a1d060313035e9aea87f7",
      "0b674d0fd072d9e845559c1dfae5ea88d56df9f3bcd37602f181204155c08b4a",
      "ae5d5de90c5e7a255ac7760c8918b71eae301ef29274d9c41711503a68beb778",
      "16e9884f18e4cf418700108b907f3b6dadb343b5b80e9d81890a12416ce1aa6f",
      "15b34f9df68ed5883937adf9e8f613192aab5f8a57ea92798be1950d0ecf6c21",
      "7bb2a3c3b85a4126975863b8b5d186976b4c3e3cec122220b0a88f58ea35e86d",
      "810af104e263db75a163277e6378099940cd4aed5ed6e49fa2f2589c57b2a43b",
      "a6f0caac91a3136b817455136d32c8024a7b23b10c2e4ad756f630a5fa7df6a5",
      "e9748a2c2fb59975219796b23d814c0167e2c55e672721f39c90838a34bd7c67",
      "56d00b751579300484e411a4c3d53745dd93aad449bba74a4fdeebeb5636009b",
      "09029555df6dc01050c97bc442659ba139f1436a32c2f3c85edb4a2a4c753c78",
      "c424d8490b89677e374faeddbdcb65bca99a4483086515fa770552418ffce677",
      "5cd0485d17d999586032a4f406ba2ead32584380f54adbc8952e661bb76f073c",
      "bd8db4e3cb37899914a8daf0480cd3a087f77295295e36215af293976a67bb85",
      "b07fc79812562c8a8770f4ce1f7ebd6f6ca0ef53771c0470d9e366f16b3ba14b",
      "232fb937bbf67f5cbe3df39d8bfa2b404c1a0d0d763d181fd46eaf0c0a055eef",
      "8e390eec10f9ed61639cb60d597c07592951e91b28c40c67a4afb83985e50c34",
      "081178283d783bc677632957f26d86209770db08bb41f16e3b284cd222845239",
      "b8e68f015766e4a2ed11c0da7aa2f9f284abb436d182a1661884816e6da6239f",
      "81198cf924cfbf0ed0a9f6b6e412d8d2c50f4297b40954bdd8c4737798faa236",
      "a9139bcf88c0dc6c673bb6432d94c861f45e96ac1ed710edb8ab6f4c3de6e750",
      "747ec13570fcd7b50c1e404f53047cb620fa2692ea9d67de8e8c140d1982043e",
      "7d958b12014db54c82d9e7dd9248e89620b1d7d1627ca97f4b84117e1ac5f970",
      "c34f779564e4521e70bdafafdc31d6a1bba1e4372e2b6d8907ba3881dc250b84",
      "9d2ae6399cda189eadd17c90e6d49b5bff34cf7ec25e9762cabf1f298293e2af",
      "cf3bf36ea12dbfafd778df4475de5e0b777166c964a0db8241699601de83e28b",
      "536e82afc15a2a1719d686f3678710143bced0b4a6325fa26197945def3b4b59",
      "7fb78ea040975854d1f425a4aebd67cfa80ef916faf3b4bed89e1d153714c637",
      "179d5429abe643f5f71ce7071e3780daf7f6f5137ae2a66757ec33a10bc86d27",
      "404d5ce498cf13316558439cb8610640576cfc0d32d2a00bdd592ad55be60ad5",
      "b7fb1157d3c3fdb4504178f02198f7138d5fe5d61ff8da85656f623b16e94828",
      "6e5ce0d0d86f26d366e8f8faa34738cabdc8856b08f89e066c4f834fb46c6f3e",
      "3c653e107e71b4d7d420f22b431793e979bbdfc9f8d5643234665dba10197b4d",
      "ea19e74b45662dddcc80238e2ca8199c604763cfb900ef2c29b75f8e09400c03",
      "fb99d8966e4fa9b21df1556494d63fc9129a7320ab83fdb028283cd0ddb1ba7b",
      "5293a958304e669fb993c0b85a9fc9502b32fc121041bc8f1f74dc15c4b178ba",
      "80d44095c3e7a90f85be48fbf594aac479af2cf2af0940ea223bc7b251f65edd",
      "030775cd0ffa5bf19365cc72351e8169cdaeda959a8fd2657dcb94e9ec2e5ae1",
      "e9ea0d2601f4a4632112e3c5dffb243da311eda53da8e60b3251b5cb7cd9dd31",
      "96ce6405c2b995108d04b2bc960ce47b131060e686ee40a74c36c511e3b470ce",
      "c88ea760c3769ed0d42599255f57f3d94ff66d5b5f4dfab15fae3a78c0f8ef23",
      "2161df12918e81495262880fbf920cc0a902b222b31c661b3282a12d09dfa660",
      "bc10dbb4660dd3ee6b134fd0b59815d1050d6dbb51a3dcf3ea37cdf265699450",
      "b86808f6dc693fcdf81a0654da2ed50e583b4b194fddf03558ee1c58be03d94c",
      "426f44660a6b7b2ca7b7a11699cb4f53a6edf656f75534fa3ad6ad5ddab3e196",
      "8f59384487062f378428220b0e2668962c9a54f9440d13c7e06865a98635d0ae",
      "3c7ac8a1fb999df9f444338fd15863e2a957b88c702c7e677174844cc488dbb3",
      "03bc579e3b8ae698cb53b9c61c32abb7a850bfdbdb5e5d685132089e2c8d3334",
      "39e78c0b51af2a21b8f3d4f23f3aa28390502d1e961b41cff2bc087b6a3ad31d",
      "e59f371ad330a9f5a16ac8648b27506e0905704f05f54b0fc8c6fe829470a600",
      "16d39c69fc0cf3c3c8a6e576c88c893a8f460b727f6c93d31c7751c9264d4c61",
      "d20c2586524c545f23eae33e9dca9f0e134019392ff3872c6bea63ef5937729c",
      "8e158f462670731d1f3e4f6f6ad9a3411bc3e4bafb45f721d6003745677af0df",
      "bda7862e51df4f780f507063517f34dbd976694e3083957f02c577827d3bff2c",
      "84bcf241f3a6ce8331b07964b325b79a06d50b3f2fb8fe96b1e3cb3178437b71",
      "3626d1367893e977ef6296658609d7518b4e4f4b38bae3bb52fbb7f2034aba5f",
      "9aeb6acef8e1b9360993c4be6c946cb6485284b9d498e43b750d8af001443274",
      "7cd0627f6e0a95a29ee28bb8464563aa08a4c9a9d0ab49d4745fd12b893278a9",
      "42c114681160ae13b6b3d8d819f6741542c20b0d75c9ef3d67e9298a6d7b508a",
      "9376097116ad2b620e1b7b7f1d29e68c335efb8e0ac69bc3695c5850136fff46",
      "acb360ba68a2f50955f0bc51f166f9a2b2de29916940721e4c2005ae950603f6",
      "024fdc960e1ef054413f8f35d9fc85a7f9f3865d7897933291b094688016cc44",
      "26b9f41cfddb35c9593a062d7086ecc01f86043b23cb14b6bea41b1cc9b05525",
      "ff92e8dcbbcc5ecfd4ca7c2da9111ebfc38829d8a44037e40d594b0b8286af36",
      "f14cde840333b393805e5e0f714f641ebf651f5700540cc8c7287d999e546f69",
      "b3e1b6bc8bf61f3ba65c19a6c96eada7be2788bc73099e17c1381cdc688c2770",
      "2b92dd7a1bd233543a85c860d0a6b1a3686813ba5f7f724a07a12796e21c3d47",
      "9adc74eb285ab5dc4ac69fcb8034a9a541ea46be1b9d89803ec0ebf709ff7c54",
      "e3db30c772bc56e743983e4ed9d06c911e90cba5c0aaace2f5ce8ff9c84a9cd6",
      "b6f159925666f7c50e0eb11b109b1cf93bd768f881bbebd7a09519ffd548255c",
      "bb4cdb37ee0e18e77474bf32cbe1bd277d2e776621a36b7ebd91570ddb5a41f5",
      "106b68fb45acc2f3786ee59d6dd03986c14f788f16c2247fa8ea2d03fc8d1932",
      "819ef76f7380f81b5f10459be297c74048bc0a3ef14056fcf51fc09c830b9424",
      "63356d774ac17313955aac3001efcc3812cb29d976c348a7b290e24f58e83298",
      "9311127e0a94a7f97e35bbd9aa5b7b97dce2fe767b7ec15e42363d9d6e95e34a",
      "aae71ed7c7c8a90edadac57ff449e92e41c7a8da8fb0870c38945cfaf657e27f",
      "c66cd13f785c5cb47e0af726607bf7c41483e66063a2fba43ade68c04698bae0",
      "3f4208fb3015d6fe37c09cc5a98570bdae5e63fdae28930cf3522a34c2425822",
      "242450233d7dfc5bd14af79e1bce59dd94e93ff9007afbc34efc945ab89f99ba",
      "88a08237bcc8fdcc157e744220e97ca835131e42ea80498a880104d99561d51e",
      "6758a229a61851f498756eccd3ec1715f4ffa6cad7d19d5cb1c2fae5f91221c3",
      "e095226d21c504ec3ff9a63f25d50bf45031d0eaf40733ddb34f63d62bf062a8",
      "0b68959183d7b445d215346635fa20b6f06eb770a6dbdf963d06bcc1fee41afe",
      "db0aafe9c7f3b1773c6f9fe666a9b61870b13bb51e0b4a4cba25fdcac47ded71",
      "79a6287f7bff7ac8bb922b0cda50c731858d1819530881f03d72dc0543e5a585",
      "4fd4b3897c0a464a42c2d8e93f8b709bba71e96e357ce029cb78e471d526b17f",
      "9f24f6caffc2147b431e260ce2415f556967c9fa420716b94dbfd7ee442782f9",
      "eccf0762723f396ce5dbdbc516fc5b795543a4375eecc2e3de78ca5469653e21",
      "e74c944012574e81904dd97e2711c5517bd272f9f4f34d9cd98856f693c7caa5",
      "d04d57691fbee646f2301305f1164b50814aee161029890d5af65ec6f40d526b",
      "b170cb0d48cc25ad112a9e53a11a99a7ea2431b23033afad59e286da767b5dd2",
      "55152aec428b909f2d95b87aa77cfc2cb153c47caeda09b97ba92c25fef65dee",
      "9c84dbaa2e10066322b317bc7add1162f4d10ce9b4444104bd9a4373f57b00a9",
      "e6f19e67b14b65f56c7cc651deeeaff954a1489e8bb265143cd11ecea448b0bb",
      "af5e3f30b34c786507251fba921bd6936516218f9577397a04155a27a52db74d",
      "043e021fca07e58f3de235c5107b59c6f9b7e7779847300722d348398cd27c2a",
      "e5fe6c40ce940c2bfaaaec73e7cad4d25e6e07ffb37ecb5ce3947c9f8120341b",
      "d872c362caafa449db035bf864804714659e1e6755a24791620e6b8b193b72e7",
      "05b55b154454b2f54dbbf581542d53cadb87ecf5217c0d6916605bf07c416522",
      "00d79f9f3ea79a9b93782ee9a913bf99b62a84c06c6f458dfcaba8497031e5f9",
      "1c83a930cdc15b0d4088162a5cbad1e2062681d5104d31f095ae3d6f460ccfbf",
      "a600f457a59eed5bf65c9c5ee343c25f3b6a8d696887019aec452282f0d69a1b",
      "4547fccc60562bf84b9d2ff5115f6d679f4aa949722fca589ef4072990add293",
      "37b5b1fb39dc793c827dd3f2ebf35c14cb9e42b441eac68e5ebf247e3c6b059a",
      "6b49d89b94657ae230a2f095687da47000f94626d73491eeb22e22f9a3bd81fc",
      "41c7d5d0799eef8527180a30bdaf2461b8767eef80bfd90b99d6fca623b76ec8",
      "bce62b82b25bc264c7a367dc2f8fd40dd072ed2600f2693aad393c6a8b22063e",
      "71e724b06a2da64a0aec7c8aa62b6a2b79532260520bd317abf43b90c3687ff1",
      "8374d8b4ed23fa4df41e41a8d1f1ebfafcbd2fcb70e0a6f793bb888777eaf3ec",
      "5cd33b64197111d37e0934153e0f49c2cbdd643730e869ff6dc65b0977aafb09",
      "4a0650b912d17b302d16d40f7f90e9995a872f232cdf956cc5e44f9287853648",
      "560d40b6169d4066f8602b7e4f732f41b418286ab4672702d0f893e3166eb676",
      "4d4ab1ffce1f962e7d4e15795502a3966c04e918a6f198b0664e49aa779e7699",
      "62e04f9d6cd0becf1ed241aa6987b2fd64dde8c994beca39ab7453cc8c1ddc5c",
      "8fe8e1a410606856392fd73b871cbbdb8875c91ef2c49b9a0cd453e24aacceb2",
      "92016f3d783e34872171ebfeabc65676f6d4927f09c401775af0c9847d12ed3c",
      "38c90de05f8fa928964c53e519faad19ddbe88321223082578f78a96e23355d2",
      "b32d597a468fd699e92882d7456a92e9632533fa66b6dbe471b6cf17d620cc75",
      "4a7453229f96654e4010dff9424185aeb154a59a64460658afd7aaf21ef5f1fd",
      "866c89fc062fbf9dac4da47449634b7eef18d7ab60e396a3df2272612f4c6752",
      "4030d0619411a0cd2ad8b39bcde71590a436c0c5d534bdde3b27b6add2124627",
      "c821d02e9d7a8d57d105e671f82244099ef5526ce8add0555a07356608dbfac6",
      "3cc0d8c421ae4f64ea74719edcf274072da49dea6f8d2327a5ecf7ebac939da0",
      "e3f7df1052db08a47e998410c121ee82fbb5653a695b18ff315730bac6a71707",
      "c67fc4f83a61029ccb82d7396630b5ac4e07de9a0415747428b7f7234bef539f",
      "8789aa925df4239806634dad91ac70ba8729f3c6fe4fb8cb432b4f491230297f",
      "3c92718af87a417367fa63e4f6b81ad85c7cf7bcb3428b4622f04bece055f8e0",
      "2eff43081214eda9d853784c747188953f988d35728b419c626d0fb0518e3ed8",
      "2230cf6575dd03e739e15cddb975827ecf8fac35f287dc2a4bd8fd9153b9d9bd",
      "fccda79b1c729ffdf85e271e2a9fe503862b5b0e8465e05ef5f637776cccb172",
      "be43b07a7852628a964e069501720c1f5bf160d9068177699556aa30d73f3347",
      "fd1d1e462dadf256f2df4cfccbf08b8db92698f0ba8a45acab58a18d290b783c",
      "7a2aea97d9fb7274f39f7e9c9bd66e5bfe8865a6a160e2aa4d2dabc3c82fa8d1",
      "80ee6da7c31dc6c6fb43b7a3fefc290aa8c9e078031fa0e8f0ebc4492e4d9bc1",
      "87ff6f65f38e4d006ff641da52d346a9fdfc402e01e9ecfea823f136442faefb",
      "649b4f0af22698bb79044c8829f3bdc07aa458b8bf2f4d47044993a5fa07bb61",
      "90e3886baf0b9adabd0345c4d819d9dc8219c135aa34fca8a22e1d8d25c3d800",
      "c8573b819f6174ef5519a662f1f4488304c93bcd78a7b481ab836c381d86fa0d",
      "1e223ac00088b789b5aed8df9077fe05221ffab7795235ef8f767278b1925209",
      "48d2ccfd9f170647fa493db6bcc6c5f2edc5d1900c148a14c178d33042e8f820",
      "397f3e1709a9d83bc1645b62685fdd16ee5dac7173e2e36ee1dbc508f77e02d6",
      "c06fb80db29cc82cf232d4ed52e38662b335c79249261837249d80cf1223f441",
      "727011778cf864067d7cafb9f27e0427b38e2120a831db305d436a43c9104c42",
      "e93cdbee82c7b83a1cf1b00396c566d35e7543120a9a3e28273d647f8735b843",
      "b5c3bb7c7acf5bad842100f5015b23d2bfd9cde66139b0cdc83f25b7fadb6bde",
      "e77be44478d5c6036c37721b133fa17427f85fee4443c5e869c3c68cf7894cd1",
      "5c404fdcfa85bddb8ff14865e6de2300cfee910c4b6a8d2c9a11372da5bebcf0",
      "d74b04d064c52683d8c36ef3656cbd421c99f69569038ecd14e1c98fa22df008",
      "4d91070d9a687d7d3cc8c7f4733b56404a7d5ae414ab1f1763c2dacb2a79df98",
      "a6a4e77aafaf5af3a90de57ceed2e756e5ed2a630fb5fb8088b53f4991496fbe",
      "2ab141ce4b02f14868d7fe33cac4d61ddc1ccc805957aaf2db862e6cfcc7e0e5",
      "526ea21e375b1f770cf6d0dc0ff6f53d849ef46d550391a70d6ae159915d1e3b",
      "b83f9b5f8d60c7d71e2748a238c31d19ae56c83e51321e2e16f0d8eeb116f09c",
      "aac5a5315711de2b0e36235888bce7b95862f9e8d429809113b49b14251343c1",
      "3225515843251dceed3d1f333099d722317ddfc48dd22bf47b144bfab47f7099",
      "4c8580571cf45beb8b9363c6b90e0e08af65adc8ff9b2f58cfa108a04a560474",
      "28c446469aabcc2e5d4803c3d3c6758906907488adb9bca5ef84b8d282e2fe66",
      "eab02b6deaa83a81cc9a8974a93a05535b74830b9201dfcf4bd2f871ae404d57",
      "bf1c02514ecffba15192fdb07aa7f253d87785abc30222e040718a6425e0ef59",
      "319b58002087e170a64a37e9057f871aeb2e4473fe946b1432204fa93788cec5",
      "c48eb5d0e910789af5743a6c07dfc981d1f7314fe310ce7c0dc063539f3adc16",
      "5c5db16771afa6c152a9af87f92f26b956c0244449c10e1861a0f95a638e2dd1",
      "5f38c55e436e5ed37b7f2e1b5857d6d14b6afcc6eb6e17f30fd9f36a0986b5ca",
      "8b98fde35a19803f36d11f5f1269512b3915c01f8eece96b3ff70c5a961f4e4b"
    ],
    "textHash": "01e4393741f19004c3f7a31e77b8f3abab422c9a08f2a3e0511776b04f6ee61b"
  },
  {
    "file": "vitest.setup.ts",
    "hashes": [
      "08b609cb606a923e2832d0fe761f0af5938f9cdf687889caf79b10e7c8b6a958",
      "7fc90cde75639336b58953e04a5d3319b630e569cb7012a67dc772ba127d30b9"
    ],
    "textHash": "2edc656e3eedb9e9675dde451e8995168f31e0bad7e48a901b87b677dcc49b18"
  },
  {
    "file": "vitest.config.ts",
    "hashes": [
      "445b8a1c71c64684b9b0a9775c8ad0e6f5246dc7d0b7ce27b7585894a6b67a54",
      "651c4a14147ff7c44219633838e55baf1515bf09cb61cc615a7a62ad01894050",
      "32703a31ffca39c3a9e82762509c8d464c160f8089c7f25823e8a4f9e90136b2"
    ],
    "textHash": "5e9fcb434970b528d7a38093f1da5f05d15c7d516812e043f7f6507fa9ae0b90"
  },
  {
    "file": "convex/utils/tenancy.test.ts",
    "hashes": [
      "123246578280708cd0acb9c85f394ffc9343eac7013ded262bd8fa46a0ec209e",
      "8ce5c8ffb51956c4ba8eabfd6a54b2ad127de67344ed95baafa5b4be3b92a1a5",
      "429dff152a578012c808c8c4825865345047c6623ad65d4344e5080c7b0ab92c",
      "6a437b2b5c2301be28fac2186e63d7de81cd7e4fd75a048d03b09d71abefbae0",
      "166cec6cc97d22b4eb9c95438ca10abb82defa12fa031dcd0c6ba9c5c530e0d9",
      "f4909bd67ca705359bcaf1702d7ddcaefbb180a56da74c4a9247cdce9d014c2b",
      "2c989a47eb7a82394fc1c4288347d04fc14852ea2cb61347ef1288b79e3f7cb1",
      "23fe57c83f95f9110912f793038736f8ec7d29dfd8d2411b41cc1ab88da50037",
      "5b69da67a2b780050ba5bcd4ee4036232776bc178ac9da19a396ec13501b54c4",
      "8e90dd17183e16f03425b8e6002746c087bf8f11f10a792b30789fb0096a8673",
      "10cf7e489602e8543c60fc069532ce0dfa7eccf2c12f2facb720268e9a68bddd",
      "f3a35a8c83778e573a05b15de7d4afa9945b8e68c4e3767675edbbd5baff9ab5",
      "21486866dc3d4c65a1aa8ac01ee7b753234f0072e7d4bc8e55d88d037500e90a",
      "72106b111e44e05353c5343c25d4328dec661ed9ca14ba0af9d763aa0434fe8a",
      "ea88574e9aebd3a6bcc03c298a91eb027d37c0450da54c52d5fdf1056ed261e7",
      "3c4bb60c10e516cc666126862ff42d327eb15d20640d8e1594cc4e32e3c13857",
      "75890203b908a6afa01ad4dc68f8747e831adfa5f233cab616d97a7863615db6",
      "a447468f9ca433ef9a46aa72d1aad99f9d486e57f7636ecf946723276cfd681c",
      "b2fc4e95f6b453fb905cbb9084d7da38300ddd8a8d227c0f7ca80b8ff03ad14c",
      "1b1f3fac8d794ed53a564eb60f2d471a6dedcb483a778c2d043d8aba6f199527",
      "bc81d567e817df451245f5be1dade5360d78b7251e369677877dd6d7b2063148",
      "51254e238dc9ca7089489af77df33f27e19e32895db1dc635ac82afb85e06e3d",
      "d574349632a7585e58580642797a55805af2a4f59ef609755882df1fc416cc0a",
      "88e9c8aeb5105bf5a492a3c23f8d8d4251c56c302a5a28ac31ada4290644af0d",
      "206d9c9640098aa4e7fc9c084c38f58871bbcf2b9786f9995a3258ec37bcde21",
      "8fae430bd996a1bcb1f6767901ea069ea06191f2e8724d552aa094d53c05be56",
      "db5b73c509e93771510a2ccbb58cfb6e8d6f1a6cb064baf481c897383b52cfc4",
      "f8c1908eff5fbcb27786c57df593ea2c6123f7a23a435010f00066f03fbd8a38",
      "46e8ee2db47b4d729f6dce722ff1bd71df4d27c603e463c3b26937708a5baf62",
      "7fa8a0aca4ce42443f31099143f4070242c79961a88d10a558e04a168ce21d95",
      "5f22755e3d00fd87824a5716690f0c89795841a0eedfbbf733214ede671df276",
      "67afd1a82948bbe809048133263d3f37478f8a45580b483c2430e4dc26490dee",
      "daba1b1b23c87cb1815d471ed8d5273965de952634b4108b8da7f2ab148240d0",
      "4f2828cdc446e0c30f8081c22e0dda7cd21d7e7b5bfb66c7522cdf146d6f3e8e",
      "d1ec9035cadbf8cb5214b059123834b36598e02d88a4e9032e8df4d64a0d824d",
      "41ffdf721f135d2da3999db2e21d98e1b0bde496070a70c8d3317621555f301e"
    ],
    "textHash": "f546a8fcd8bd739adc44da7ffdf1879871e73529e3531e07ec5a42fea72ef9e0"
  },
  {
    "file": "test-utils/convexTest.ts",
    "hashes": [
      "85a43eb8ab5a8656d9cee2946bc5f02cd0a0b586accb9f432e4dc402ba517d8c",
      "ea802a0cd94dff0cbde442576319b7d76d625d6e3ab0ebf3e6302b9bce47e8f6",
      "20423104ffb2e4ce8a73fddf73fd96d440a21409d932ba5f0e2a1f79c62d4835",
      "3f222378332078b21998824a7b95a744cfd434722438d6fecd41122f66aaf0cf",
      "04e60d7de3a0d31e51df5216ea31814047328afefa97f0074140c226c268bf76",
      "5f09fb95b36d3609504bcde209a04f6443a997486ff5d6ecf3dca37ddfe855c6",
      "ad107b2c17b7692aa980b1b676948c1d7d6d5c3e9455320f323a1bbafe6c0c2d",
      "f75034bf6b1de220a90712cc8fbde7e8a88ad60f530d0cb9e542e03b95483fd1",
      "e6e960fe4ccd7b7946182f6f71f4f456cb101d29204d50850031260650a66b59",
      "dc923a144d62e197d473dcb5b03b737e216ca3c4a6947b7b0dbfd77614a56873",
      "e821d809dfc9e5765fb663acfc44cfbc03b266093cb9d470f0e26ec45b446406",
      "872a5ab1b532d15564a795d95d398961331fb9fd74609ac189fa5987bef3fd1c",
      "e30824569c32433e06d34726a5a243b48d8274786ca8e95f8eddd695f9cd616b",
      "634821ad5030099519084ef37f9376e398fe4050eabea74d96f8980d9a284ffe",
      "d81078727a127ae3b0b20a82565cccef6799f1d5bb3b38360cf6c1cedfee769f",
      "3af97353be3f3b02a61f12fbded20834fcdba95febaefb443acc1e9a93df0e29",
      "17c53797978b561a1a7dca640b60f6a57ea0988ea74c2ad61a03944472f3b91c",
      "129e93fdd05052819ba707f907252f8e8126f60f2424d9919cbfd2fd0db908ea",
      "e177769379915a4ff2990b6259153505d6009b2c43bcf092088acbd0b499190b",
      "4131eb0cbf1572b72dd7ff79397e729d401a9ef80f30f39c7309686c55b3574b",
      "e942299c4abbe8ff60d898e988465091f39e3e5eea6c3572b3c23cc0f52a0dbd",
      "1b686b40d1cd402321545c684aeca596d457a9fb05ec5bd145046e45c8178945"
    ],
    "textHash": "09e8a1fec9558b8d17e8653935fd3127257b3d13197d946bab15fad155f86f4b"
  },
  {
    "file": "test-utils/supplierFixture.ts",
    "hashes": [
      "e6e960fe4ccd7b7946182f6f71f4f456cb101d29204d50850031260650a66b59",
      "9e8806dbd580813e026168225574fc820facd98fe4541d0fe9940c8433702fb8",
      "eae939397098eb0e52d36bfdd4b2ff1a25748affa0125715678f2138a9ff1163",
      "4b6b2b91e1e7e0a0c545c6bd45f7706c0b020cc58f73882c81a6fbad844080b0",
      "88b834496af4d1c1b1b991ec7754624d6bff3167bb3777ec69e73b3c79431fad",
      "278ec2016cb4a5a173e01e94a9e3265834f6bf89e3a18bbe189804d59f76371a",
      "7130e5ce97c6d456fdf1541459b4d70ded03bff98860381d8037cfff911c4174",
      "ddc8147e82d9f3fdd2dd3688e78479f3a2400acafd8b8f2be22054f8926e09f1"
    ],
    "textHash": "84481560c1d94a8a724aab62b14087a86098249575ff3507c64609f52e8af59e"
  },
  {
    "file": "scripts/autoflowInvariantCatalog.ts",
    "hashes": [
      "82a38977e02743011efd43a4ab595d6abb1912380cad198c377ee2d922d3b0ad",
      "651c4a14147ff7c44219633838e55baf1515bf09cb61cc615a7a62ad01894050",
      "43f97a8c202312e7f0e8cbd5731512eed08cb127c0a86c9f21ec160fca18e160",
      "8bfef1154eee5121d5dffaa5facea6fa1a1070b5a398489e72846eaf70ff5952",
      "f8759dccbfe12ead7dc98abd606f8e697f6a285cf0d33157c2087dd8c2f26255",
      "9cb70855204734412e8e3152bf7149e10ca988a5ac1017d0b8d9e447ef9cb919",
      "ad5c36bf397f9e1a6e39c9e6fe8f3c9a7ed23a4bfd687cb453103cd98c13a1b6",
      "648c338dde7b96ccbb811f98853a00100575341f82070c444cf544251c588c7d",
      "9e3d6357b5c8b2deeee7510905ff2d0358db2598dd121cba101b70fe6f15180c",
      "3a341e3764c984b0bc1483b343a4dc8b39012ba219b88613a347c3c4953dc917",
      "a85d64ad80682cd43010cda81afbd653d6db499aea65b5f26da83d2bb1c25e5a",
      "e2b36a87a4e6d5183f1b2a8745bef3a24a3d109aec88cd59800d8ceb894bfdb9",
      "df9782db30930496fefb17b37fa4a6d06380132f5c5520f5f644147380020be8",
      "2645696be6bd589c5451c0e739126278c28946951c6de417b2e161907e7a1d1d",
      "0609dd42c7824d16075e915bd49cd2c29ee603220d9faeb19f2a10be0825f166",
      "1fb34172bc79b4a0ee8ca41b35daff9a66af9243e4f4d7cb08e88abed976ba20",
      "83eab3d00f5867380874debe8c877229ce420b19ab43aef051b2e1b3f1b704a3",
      "98af500cd7727a341d71c1ed9f6215a269bf7e6ff0c9760dd1a4bc1923d47720",
      "d670aece6f5e1937b3834338a62ac314f53e034ecd3ba9699d3e68e0ab657037",
      "2dc74b196fd80f36968c1505be691a1721b574e82ad88bc29bf0fd23e767c368",
      "46e19e43d43b78817d34c76afdd729cf29e722180e068747cc9474c77c1065a3",
      "03b778ae1ce573e11592f1fbd04fec33d24ef57bc052864c0c25109a3717d2d7",
      "05ddfef7ac18c601ffb36e5e351958f823f9e0a8bcfbe61e24b88e3f31f44f96",
      "9a164fab80dc3d1f05daf77919720c1459a79f81f28246df82eb8670cb77f9f1",
      "d38ef6e565358845f8ab17f34537b2acbb380766bafa8cf1f33da090ae5e037d",
      "649b965f33f84009453bcec167f4d3d65df4a63005956f39b08cde00e6c6f4ea",
      "0dd993b5fc1cfa750c1e10c9f20132a53476277feced2841b61d79514a0c9814",
      "35ed1e28c1c640216719669ce98563ca105f71b8eaf746390dcd1b3195bdf042",
      "04c1fe556c25a56d40fe719768a46d21744fe5c4d7ba2bbb8bc2a0849363a8ec",
      "dd2ee21c5b58e8fe3ad78988ab4432d624dd534f5e6345a20e7b59e10ccb318b",
      "46b36c8ddeb703fba395a89fd26c51e9cdbf691e4f199dd7e196688336d15846",
      "d79d60406a152856dd47fceff71e01717b867d4687ced1152055b3b2d20b8d1d",
      "674d425e57d4b57306002c2a00be9ad32b88d5e5f757458eb2728cb61aef9135",
      "a76a0d15a09fb0f08743c071f61eaca54cde9327bd1b46f2aaebf4e474f254d0",
      "ab4d0158a119c76ef406b5cbfcac1f57ae4e1f3f1eeb061cccd1c718d91b352d",
      "9e7dff8269065cfd03ebd3a40625ea2fb61e3da225a44a4f1c1406616c92bdf3",
      "92cf601093bbfef6a3aa4fdd2ceb46b0aa91686110386e35d85bee09a5a1cd58",
      "b2b6628997ea4a6a29225bf4dcc8c4396afb9614b9d9abd1bf44bf8fddc4f881",
      "e2a3bd51b4c41fc004a0ada70895fe8eea210dd335c93e790754580e1b351dc2",
      "c60fb1e9fd50e06f86e29198937d263b2064bb8d9f4b6f787aec96c4fd465f4a",
      "64b46092b429e42faefd4bd8e1c57dc9fc7045f841da32eef7947a7abb215329",
      "e2f9ed049f556460db2dab3ee39e3484c822daca314446253e668e533d69e93c",
      "5fbf3afed8d33a0e7ae0687a27e92e322136b96a1acfbb531e5f2312f79570a2",
      "7c67c142321c90498baac01d6da1fcc04985b2d4b6045c77ecbcee9959471943",
      "813ea4fd87b8fed49bb6d990ab697a32438e94bcd27fa2b19356e63b1549996c",
      "41c2648946b46ce0bb0145c460a316e496c291d8b9820897bfd6bf35c7c82f0b",
      "1bb4a25a36cf3a7cb59c48db0c270f8f64496d64c8acda6eb387a8807ed922ef",
      "faf44ca4bd5705fbbe2ba6d919fb0b729024430cf068cb9a44b3dfae42987564",
      "04e39c356ed3dcd845c9ba1cedd4c80fdaa2c6871241e04be18aad7c0d8420ee",
      "8bf9201932a35384aaf179cfde15eeb0eb86edce86c90947118fa1aceaefa3ae",
      "8a7e78ee9f49476ec88db4fa4fd29a52b026e7a2980a5304a1e1b085721aec7d",
      "34947836b680a501605f86923eca04a3a7a0f4e5c10b45c9d8fa990959146eaf",
      "578e26882b9aa5da451f80c83c76926d1967e88afca539d367dea75e1cb6760f",
      "e929818cc85c61e4fb13635ab0d68ada9519ea65538065444bb3e3a729661923",
      "caef545c259face28de13588d82a5165e0ff2debeb4c857a6ed17575abc7fd88",
      "ea552965bba2a799b0d57ca02c471e03d042d6fa113be27fa884b7bbcdbbaf99",
      "6ef2edc62ceac655c523ff5207169eefcae37af0cb38466c000ccf46ec1ea6ed",
      "76f54e6090aaf0b8bbef04d5e1132b03e025347ba51fca2dd6e7815913952a14",
      "d3491090e6bc4d66e98e2c8dfd48386ee4ee4409c82940ed79d1b61b417bc011",
      "ae842715f51c7d533158fa0da78e91174fdacb1693dd9fede011adabb9d885ac",
      "a2440b445e6a0eb038ff5c45a8c489e226f1ab46cfeb0a33a9b24695e41411be",
      "9bf7f0cd88cdb482aa43f2d1b785fb3f26cc5ce72e2218fd383003a786bf2778",
      "c07d9820f42207cfbfab3758ba3aa186864875a89cb45197dccf1e5807fe6ac1",
      "86cc27a0c0b4df4f2429b30fdad77735bc99d58aa3eb7746f2159705fb97f6be",
      "4fad6188acba496f0018b384f0c65f89658ea4ff7cfb6d7fbf97ad5f747ce971",
      "e5ea1ca7d7eb65c38173d857069ecfc2128ae4ecb590aed62e977c69568b2523",
      "891b3663247c22783427044695f7f6c160446c5865f66964cb903ff079713cd5",
      "1becfc55788afae6ee33e9a04b8c09b25decb717dc3e80cc5854ab858ca3da3d",
      "88cea47fdfe6a30673fdc3c360ef7ddabdd6ff831d3bc7d44678485fc9f9d140",
      "969f2a7e321641acea53be2aebc38b26795a0a40fc559b79fba80430fd1b454c"
    ],
    "textHash": "ece6cabdde504a72fa6375d77319088c12d85e2e4682efb082cd8144b491e03b"
  },
  {
    "file": "convex/utils/supplierReadCache.test.ts",
    "hashes": [
      "4002d4b5306a8b9b595c8174d7584b2cf8ded3f3c28fd25888549ccbe6acda2c",
      "eb0ea457ff06c67c1122a6767d28e35c1070a2f0fa43126a66cf966ae4793e06",
      "23fe57c83f95f9110912f793038736f8ec7d29dfd8d2411b41cc1ab88da50037",
      "8ce5c8ffb51956c4ba8eabfd6a54b2ad127de67344ed95baafa5b4be3b92a1a5",
      "429dff152a578012c808c8c4825865345047c6623ad65d4344e5080c7b0ab92c",
      "61245e889ba5d38e171e16ad27d4733bda541a52f54e632f67edb855dbd97a21",
      "a13fc247067e204a2e43238fc83da136eb9a2567bc7fe7cd8b41437bf3d5a352",
      "86dca55716135e4aca270adb702160bd1ed42a7d77b7421c2962989f1eb7b57c",
      "9b6653fcc1fed1b926306b1c4f80dfdf12f51df574e6caf867335d022846c95d",
      "b25f25dc771c0d9b1af545ba567ff8459dc66d6c5b54405e9253b2ab6c493fcd",
      "6e5efbdf0fbd80c08b5d0d4ef4c5c81b22ffd94e7b5337f60ff0d6cc49b157b8",
      "072670d9fce2d2e229da00f38ce7dd4abde820bf3a304b8519eebf2f4a5a1c4a",
      "20f4706831e5b770c408e9a2396ef0ff1677d6d70958d409fbd6eb7b1d71ec22",
      "61fe168b0101fa8ec43ade860d8e6d633c09b62167a02d3cb562ed650f7e39a8",
      "ea7c347261d40087d6def138e3d0ff01786eff3118d09cc810d830358c0fa26b",
      "833d83810a299aa298321bfca60d92e41f9954a4afa21070888ea25a8cabc1ae"
    ],
    "textHash": "4938b1b92c5319f52651a5bb1c5b82b7d2da6aad74f9815d9d238038dc362844"
  }
];

function closureStatements(source: ts.SourceFile, file: string): readonly ts.Statement[] {
  if (file !== "scripts/intelligence/supplierNavigationDoors.test.ts") return source.statements;
  const table = assertClosurePinLiteral(source);
  return source.statements.filter(node => node !== table);
}

function assertClosurePinLiteral(source: ts.SourceFile): ts.Statement {
  const statements = source.statements.filter(node => navigationStatementName(node, source) === "EXECUTABLE_CLOSURE");
  const statement = statements[0];
  if (statements.length !== 1 || !statement || !ts.isVariableStatement(statement) ||
    statement.declarationList.flags !== ts.NodeFlags.Const || statement.declarationList.declarations.length !== 1) {
    throw new Error("EXECUTABLE_CLOSURE must be one const literal table");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) throw new Error("EXECUTABLE_CLOSURE must be a literal array");
  if (initializer.elements.length === 0) throw new Error("EXECUTABLE_CLOSURE requires non-empty pins");
  const files = new Set<string>();
  for (const entry of initializer.elements) {
    if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 3) throw new Error("EXECUTABLE_CLOSURE requires file, hashes and textHash literals");
    const fields = new Map<string, unknown>();
    for (const property of entry.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error("EXECUTABLE_CLOSURE refuses executable properties");
      fields.set(property.name.text, callerLiteral(property.initializer, "EXECUTABLE_CLOSURE"));
    }
    const file = fields.get("file");
    const hashes = fields.get("hashes");
    const textHash = fields.get("textHash");
    if (typeof file !== "string" || files.has(file) || !Array.isArray(hashes) || hashes.length === 0 ||
      typeof textHash !== "string" || !/^[a-f0-9]{64}$/.test(textHash) ||
      hashes.some((hash: unknown) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error("EXECUTABLE_CLOSURE requires unique files and non-empty SHA-256 literals");
    }
    files.add(file);
  }
  return statement;
}

function closureText(source: ts.SourceFile, file: string): string {
  if (file !== "scripts/intelligence/supplierNavigationDoors.test.ts") return source.text;
  const table = assertClosurePinLiteral(source);
  return source.text.slice(0, table.getStart(source)) + "<REVIEWED_LITERAL_PIN_TABLE>" + source.text.slice(table.end);
}

function assertStatementClosure(source: ts.SourceFile, file: string): void {
  // Git checkouts differ by line endings; ECMAScript normalizes CRLF in templates.
  // Keep every other token/escape and the existing fingerprint implementation.
  source = ts.createSourceFile(source.fileName, source.text.replaceAll("\r\n", "\n"), ts.ScriptTarget.Latest, true);
  if (resolve(root, source.fileName) !== resolve(root, file)) throw new Error("EXECUTABLE_CLOSURE source identity mismatch");
  assertLoaderDirectives(source, file);
  const pin = EXECUTABLE_CLOSURE.find(entry => entry.file === file);
  const statements = closureStatements(source, file);
  if (!pin || pin.hashes.length === 0 || statements.length !== pin.hashes.length) {
    throw new Error(file + ": EXECUTABLE_CLOSURE has missing or unpinned statements; review the executable inventory");
  }
  // Comments can instruct Vitest, Vite or the compiler. Pin them as input too.
  if (createHash("sha256").update(closureText(source, file)).digest("hex") !== pin.textHash) {
    throw new Error(file + ": EXECUTABLE_CLOSURE source text changed; review comments and compiler directives as well as statements");
  }
  for (const [index, statement] of statements.entries()) {
    // Direct comparison deliberately does not trust a matcher the file could alter.
    if (navigationFingerprint(statement, source) !== pin.hashes[index]) {
      const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
      throw new Error(file + ":" + line + ": EXECUTABLE_CLOSURE changed statement " + index + "; review the body and rerun integrity mutants before updating its literal pin");
    }
  }
}

function assertLoaderDirectives(source: ts.SourceFile, file: string): void {
  // Vitest 4.1.9 detectCodeBlock scans raw test text, including quoted strings.
  // The exact regex categories below include environment options and module tags.
  const prefix = "// @" + "vitest-environment node\n";
  const nodeSuite = ["convex/supplierNavigation.scrum869.test.ts", "scripts/intelligence/supplierNavigationDoors.test.ts"].includes(file);
  const text = nodeSuite && source.text.startsWith(prefix) ? source.text.slice(prefix.length) : source.text;
  if (file.endsWith(".test.ts") && (/@(?:vitest|jest)-(?:environment|pool)\b/.test(text) ||
    new RegExp("(//|\\*)\\s*@" + "module-tag\\b").test(text))) {
    throw new Error(file + ": EXECUTABLE_CLOSURE refuses unreviewed loader directives");
  }
}

test("executable closure pins every behavioural statement including unbound callbacks", () => {
  expect(() => assertStatementClosure(parse("convex/supplierNavigation.scrum869.test.ts"), "convex/supplierNavigation.scrum869.test.ts")).not.toThrow();
});

test("executable closure pins every census statement including its own checks", () => {
  assertClosurePinLiteral(parse("scripts/intelligence/supplierNavigationDoors.test.ts"));
  expect(() => assertStatementClosure(parse("scripts/intelligence/supplierNavigationDoors.test.ts"), "scripts/intelligence/supplierNavigationDoors.test.ts")).not.toThrow();
});

test("executable closure pins suite setup and its configured entry points", () => {
  expect(() => assertStatementClosure(parse("vitest.setup.ts"), "vitest.setup.ts")).not.toThrow();
  expect(() => assertStatementClosure(parse("vitest.config.ts"), "vitest.config.ts")).not.toThrow();
});

test("census form helpers refuse empty evidence instead of passing vacuously", () => {
  expect(() => assertRuntimeControlForms([])).toThrow(/non-empty forms/);
  expect(() => assertSecondBindingForms([], /unused/)).toThrow(/non-empty forms/);
  expect(() => assertReferenceForms([], /unused/)).toThrow(/non-empty forms/);
  expect(() => assertIntrinsicForms([], /unused/)).toThrow(/non-empty forms/);
});

function assertClosureInsertions(forms: readonly string[]): void {
  if (forms.length === 0) throw new Error("closure probes require non-empty forms");
  const file = "convex/supplierNavigation.scrum869.test.ts";
  const original = parse(file).text;
  const anchor = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const changed = original.replace(anchor, anchor + "\n" + form);
    expect(changed, "closure probe must alter an executable body").not.toBe(original);
    expect(() => assertStatementClosure(ts.createSourceFile(file, changed, ts.ScriptTarget.Latest, true), file), form).toThrow(/EXECUTABLE_CLOSURE/);
  }
}

test("executable closure refuses intrinsic indirection without knowing its spelling", () => {
  assertClosureInsertions([
    'Object.getPrototypeOf([]).toSorted = () => [];',
    'Reflect.get(Object, ["define", "Property"].join(""))(Object, "is", { value: () => true });',
    '({}).constructor.defineProperties(Object, { is: { value: () => true } });',
  ]);
});

function assertClosureLineEndings(file: string): void {
  const source = parse(file).text;
  const lf = source.replaceAll("\r\n", "\n");
  for (const text of [lf, lf.replaceAll("\n", "\r\n")]) {
    expect(() => assertStatementClosure(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file), file + ": equivalent checkout line endings").not.toThrow();
  }
}

test("behavioural executable closure accepts LF and CRLF checkouts", () => {
  assertClosureLineEndings("convex/supplierNavigation.scrum869.test.ts");
});

test("census executable closure accepts LF and CRLF checkouts", () => {
  assertClosureLineEndings("scripts/intelligence/supplierNavigationDoors.test.ts");
});

function authorizationConditions(source: ts.SourceFile, name: string): string[] {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error("Authorization condition inventory missing " + name);
  const conditions: string[] = [];
  const add = (kind: string, node: ts.Node) => conditions.push(name + "/" + kind + ":" + navigationTokens(node, source).join(" "));
  const visit = (node: ts.Node): void => {
    authorizationControl(source, node);
    if (ts.isIfStatement(node)) add("if", node.expression);
    if (ts.isConditionalExpression(node)) add("ternary", node.condition);
    if (ts.isBinaryExpression(node)) for (const decision of authorizationBinaryDecisions(node)) add(decision.kind, decision.node);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) add("negation", node);
    // PLAN_GATE_LABELS selects refusal text, not admission; the helper pin covers it.
    if (ts.isElementAccessExpression(node) && navigationTokens(node, source).join("") !== "PLAN_GATE_LABELS[gate]") add("lookup", node);
    if (ts.isReturnStatement(node) && node.expression && declaration.type &&
      (declaration.type.kind === ts.SyntaxKind.BooleanKeyword || ts.isTypePredicateNode(declaration.type)) &&
      ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.expression.kind)) add("return", node.expression);
    if (ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression) &&
      ["filter", "every"].includes(node.parent.expression.name.text)) add("predicate-" + node.parent.expression.name.text, node.body);
    ts.forEachChild(node, visit);
  };
  for (const parameter of declaration.parameters) if (parameter.initializer) visit(parameter.initializer);
  visit(declaration.body);
  return conditions;
}

function authorizationBinaryDecisions(node: ts.BinaryExpression): readonly { kind: string; node: ts.Node }[] {
  const operator = node.operatorToken.kind;
  if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(operator)) {
    return [{ kind: "logical", node }, ...authorizationAtoms(node).map(atom => ({ kind: "atom", node: atom }))];
  }
  if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(operator)) {
    return [{ kind: "comparison", node }];
  }
  if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(operator)) return [{ kind: "conditional-binary", node }];
  return [];
}

function authorizationAtoms(node: ts.Node): readonly ts.Node[] {
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return [...authorizationAtoms(node.left), ...authorizationAtoms(node.right)];
  }
  return [node];
}

function authorizationControl(source: ts.SourceFile, node: ts.Node): void {
  if (ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isWithStatement(node) ||
    ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
    throw new Error(source.fileName + ": unreviewed authorization control " + ts.SyntaxKind[node.kind]);
  }
  const reviewedLookup = ts.isElementAccessExpression(node) &&
    ["PLANS[planId]", "PLANS[planId].gates[gate]", "PLAN_GATE_LABELS[gate]"].includes(navigationTokens(node, source).join(""));
  if (ts.isOptionalChain(node) || (ts.isElementAccessExpression(node) && !reviewedLookup) ||
    (ts.isNewExpression(node) && !["Set", "ConvexError"].includes(node.expression.getText(source)))) {
    throw new Error(source.fileName + ": unreviewed authorization control " + ts.SyntaxKind[node.kind]);
  }
}

const AUTH_CONDITION_PAIRS: readonly (readonly [condition: string, pairs: readonly (readonly [string, string])[]])[] = [
  [
    "requireTenantAuth/if:! org",
    [
      [
        "ordinary",
        "missing-org"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! org",
    [
      [
        "ordinary",
        "missing-org"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:org . suspended",
    [
      [
        "ordinary",
        "suspended"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:! membership",
    [
      [
        "ordinary",
        "missing-membership"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! membership",
    [
      [
        "ordinary",
        "missing-membership"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:membership . offboardingStatus",
    [
      [
        "ordinary",
        "pending"
      ],
      [
        "ordinary",
        "retrying"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:! role",
    [
      [
        "ordinary",
        "missing-role"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! role",
    [
      [
        "ordinary",
        "missing-role"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:requiredPermissions . length > 0 && ! isSystemOwnerRole ( role )",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/logical:requiredPermissions . length > 0 && ! isSystemOwnerRole ( role )",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/atom:requiredPermissions . length > 0",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/atom:! isSystemOwnerRole ( role )",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/comparison:requiredPermissions . length > 0",
    [
      [
        "empty-no-requirement",
        "empty-required"
      ],
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! isSystemOwnerRole ( role )",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "requireTenantAuth/predicate-filter:! role . permissions . includes ( p )",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/negation:! role . permissions . includes ( p )",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/if:missing . length > 0",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "requireTenantAuth/comparison:missing . length > 0",
    [
      [
        "ordinary",
        "empty-required"
      ],
      [
        "ordinary",
        "one-missing"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/if:! grantId",
    [
      [
        "ordinary",
        "live-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/negation:! grantId",
    [
      [
        "ordinary",
        "live-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/if:! grant || grant . revokedAt || grant . expiresAt <= Date . now ( )",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/logical:! grant || grant . revokedAt || grant . expiresAt <= Date . now ( )",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/atom:! grant",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/atom:grant . revokedAt",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/atom:grant . expiresAt <= Date . now ( )",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/logical:! grant || grant . revokedAt",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/atom:! grant",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/atom:grant . revokedAt",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/negation:! grant",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/comparison:grant . expiresAt <= Date . now ( )",
    [
      [
        "live-query",
        "missing-query"
      ],
      [
        "live-query",
        "revoked-query"
      ],
      [
        "live-query",
        "expired-query"
      ],
      [
        "live-query",
        "boundary-query"
      ],
      [
        "live-mutation",
        "missing-mutation"
      ],
      [
        "live-mutation",
        "revoked-mutation"
      ],
      [
        "live-mutation",
        "expired-mutation"
      ],
      [
        "live-mutation",
        "boundary-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/if:! isMutationCtx ( ctx )",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/negation:! isMutationCtx ( ctx )",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/ternary:args . requiredPermissions . length > 0",
    [
      [
        "live-mutation",
        "empty-audit-label"
      ]
    ]
  ],
  [
    "enforceImpersonationGrant/comparison:args . requiredPermissions . length > 0",
    [
      [
        "live-mutation",
        "empty-audit-label"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/if:! role || role . isDeleted",
    [
      [
        "classifier-null",
        "classifier-owner"
      ],
      [
        "flagged",
        "deleted-flagged"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/logical:! role || role . isDeleted",
    [
      [
        "classifier-null",
        "classifier-owner"
      ],
      [
        "flagged",
        "deleted-flagged"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/atom:! role",
    [
      [
        "classifier-null",
        "classifier-owner"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/atom:role . isDeleted",
    [
      [
        "flagged",
        "deleted-flagged"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/negation:! role",
    [
      [
        "classifier-null",
        "classifier-owner"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/if:role . isSystemOwnerRole === true",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/comparison:role . isSystemOwnerRole === true",
    [
      [
        "flagged",
        "missing-flag-empty"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/if:role . isSystemOwnerRole === false",
    [
      [
        "legacy-full",
        "false-full"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/comparison:role . isSystemOwnerRole === false",
    [
      [
        "legacy-full",
        "false-full"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/return:role . name === SYSTEM_OWNER_ROLE_NAME && holdsTheFrozenOwnerSet ( role . permissions )",
    [
      [
        "legacy-full",
        "legacy-wrong-name"
      ],
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/logical:role . name === SYSTEM_OWNER_ROLE_NAME && holdsTheFrozenOwnerSet ( role . permissions )",
    [
      [
        "legacy-full",
        "legacy-wrong-name"
      ],
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/atom:role . name === SYSTEM_OWNER_ROLE_NAME",
    [
      [
        "legacy-full",
        "legacy-wrong-name"
      ],
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/atom:holdsTheFrozenOwnerSet ( role . permissions )",
    [
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "isSystemOwnerRole/comparison:role . name === SYSTEM_OWNER_ROLE_NAME",
    [
      [
        "legacy-full",
        "legacy-wrong-name"
      ],
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "holdsTheFrozenOwnerSet/if:permissions . length < PRE_413_OWNER_FALLBACK_PERMISSIONS . length",
    [
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "holdsTheFrozenOwnerSet/comparison:permissions . length < PRE_413_OWNER_FALLBACK_PERMISSIONS . length",
    [
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "holdsTheFrozenOwnerSet/return:PRE_413_OWNER_FALLBACK_PERMISSIONS . every ( ( permission ) => permissionSet . has ( permission ) )",
    [
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "holdsTheFrozenOwnerSet/predicate-every:permissionSet . has ( permission )",
    [
      [
        "legacy-full",
        "legacy-short"
      ],
      [
        "legacy-full",
        "legacy-wrong"
      ]
    ]
  ],
  [
    "requireAuth/if:! identity",
    [
      [
        "ordinary-query",
        "no-identity-query"
      ],
      [
        "ordinary",
        "no-identity-mutation"
      ]
    ]
  ],
  [
    "requireAuth/negation:! identity",
    [
      [
        "ordinary-query",
        "no-identity-query"
      ],
      [
        "ordinary",
        "no-identity-mutation"
      ]
    ]
  ],
  [
    "requireAuth/if:! user",
    [
      [
        "ordinary-query",
        "missing-user-query"
      ],
      [
        "ordinary",
        "missing-user-mutation"
      ]
    ]
  ],
  [
    "requireAuth/negation:! user",
    [
      [
        "ordinary-query",
        "missing-user-query"
      ],
      [
        "ordinary",
        "missing-user-mutation"
      ]
    ]
  ],
  [
    "requireAuth/if:user . disabled",
    [
      [
        "ordinary-query",
        "disabled-user-query"
      ],
      [
        "ordinary",
        "disabled-user-mutation"
      ]
    ]
  ],
  [
    "isMutationCtx/return:\"insert\" in ctx . db",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "isMutationCtx/comparison:\"insert\" in ctx . db",
    [
      [
        "live-query",
        "live-mutation"
      ]
    ]
  ],
  [
    "requireOwnedRow/if:! doc || ( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "missing-supplier"
      ],
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/logical:! doc || ( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "missing-supplier"
      ],
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/atom:! doc",
    [
      [
        "local-supplier",
        "missing-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/atom:( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/negation:! doc",
    [
      [
        "local-supplier",
        "missing-supplier"
      ]
    ]
  ],
  [
    "requireOwnedRow/comparison:( doc as { orgId ? : Id < \"organizations\" > } ) . orgId !== orgId",
    [
      [
        "local-supplier",
        "foreign-supplier"
      ]
    ]
  ],
  [
    "requireFeature/if:await hasPlanFeature ( ctx , orgId , gate )",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "hasPlanFeature/lookup:PLANS [ planId ] . gates [ gate ]",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "hasPlanFeature/lookup:PLANS [ planId ]",
    [
      [
        "enterprise-plan",
        "free-plan"
      ]
    ]
  ],
  [
    "getOrgPlan/if:! sub",
    [
      [
        "enterprise-plan",
        "no-subscription"
      ]
    ]
  ],
  [
    "getOrgPlan/negation:! sub",
    [
      [
        "enterprise-plan",
        "no-subscription"
      ]
    ]
  ],
  [
    "getOrgPlan/if:sub . status !== \"active\"",
    [
      [
        "enterprise-plan",
        "expired-plan"
      ]
    ]
  ],
  [
    "getOrgPlan/comparison:sub . status !== \"active\"",
    [
      [
        "enterprise-plan",
        "expired-plan"
      ]
    ]
  ]
];

function authLiteralRows(source: ts.SourceFile): readonly (readonly unknown[])[] {
  const statement = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(source) === "AUTH_DECISION_ROWS");
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("Missing literal AUTH_DECISION_ROWS");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) throw new Error("Missing auth decision rows");
  const rows = callerLiteral(initializer, "AUTH_DECISION_ROWS");
  if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => !Array.isArray(row) || row.length !== 9)) throw new Error("Non-empty literal auth decision rows required");
  return rows;
}

function assertAuthorizationPairs(source: ts.SourceFile): void {
  const rows = authLiteralRows(source);
  const ids = rows.map(row => row[0]);
  expect(new Set(ids).size, "auth row ids must be unique").toBe(rows.length);
  for (const helper of AUTH_HELPER_CONTRACTS) for (const id of helper.killRows) {
    expect(ids, helper.name + ": behavioural kill row must exist and execute").toContain(id);
  }
  for (const [condition, pairs] of AUTH_CONDITION_PAIRS) {
    expect(pairs.length, condition + ": missing literal outcome pair").toBeGreaterThan(0);
    for (const [leftId, rightId] of pairs) {
      const left = rows.find(row => row[0] === leftId);
      const right = rows.find(row => row[0] === rightId);
      if (!left || !right) throw new Error(condition + ": missing paired auth row");
      expect([left[7], left[8]], condition + ": paired literal outcomes must differ").not.toStrictEqual([right[7], right[8]]);
    }
  }
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertAuthDecisionRows") {
      const values = node.arguments[0] && callerLiteral(node.arguments[0], "executed auth rows");
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Auth row execution requires literal ids");
      calls.push(...values);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls.toSorted(), "every auth row must execute exactly once in literal registrations").toStrictEqual([...ids].sort());
}

interface AuthorizationHelper {
  file: string;
  source: ts.SourceFile;
  declaration: ts.FunctionDeclaration;
  name: string;
}

const AUTH_HELPER_CONTRACTS: readonly { file: string; name: string; hash: string; killRows: readonly string[] }[] = [
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireTenantAuth",
    "hash": "dda8e0f54a12b1104dfd810a9f14c63f655fa3fbc4835c1f4d061dc52f3e52e9",
    "killRows": [
      "ordinary",
      "empty-required"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireAuth",
    "hash": "4a23d5e2e4cbeb99b1d1745ee3cc7db0ad6b1c5e2e2272f539e676cce382413e",
    "killRows": [
      "ordinary-query",
      "no-identity-query",
      "missing-user-query",
      "disabled-user-query",
      "disabled-user-mutation"
    ]
  },
  {
    "file": "convex/utils/errors.ts",
    "name": "throwAppError",
    "hash": "f569f7c702d5539bbddef83bb0e1bc47920f867e6671520cf7a6651df50cac63",
    "killRows": [
      "disabled-user-query",
      "missing-user-query"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "name": "isSystemOwnerRole",
    "hash": "4a00524573bbe24dbbe562cddf1582d5161383f03573a54bac3242cb4a7821fc",
    "killRows": [
      "legacy-full",
      "false-full",
      "deleted-flagged"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "name": "holdsTheFrozenOwnerSet",
    "hash": "4be0c7835b3d0ed33087fed48bac1fdcf8fea8a32d5dd8af1b67a16e16f7e303",
    "killRows": [
      "legacy-full",
      "legacy-duplicate"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "enforceImpersonationGrant",
    "hash": "f9996eb8d69ef8134916dcbcbf113974e3dc9fe4b47be6d176f82f43ca1c6d66",
    "killRows": [
      "missing-query",
      "revoked-query",
      "boundary-mutation",
      "live-mutation"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "isMutationCtx",
    "hash": "44479e4535580cf90a356c1edcbccafedf2f4aa113e3818d4e0955346404f942",
    "killRows": [
      "live-query",
      "live-mutation"
    ]
  },
  {
    "file": "convex/utils/auditLog.ts",
    "name": "writeAuditLog",
    "hash": "caa90bed8944c20c0163ca86920fd0f7363cbb8d8a22ed39be06491743086795",
    "killRows": [
      "live-query",
      "live-mutation",
      "empty-audit-label"
    ]
  },
  {
    "file": "convex/utils/tenancy.ts",
    "name": "requireOwnedRow",
    "hash": "9f0dd1a5adcef54418a6e468157879bfc2184ef7c78fd5878213d4e0bad0f52f",
    "killRows": [
      "local-supplier",
      "missing-supplier",
      "foreign-supplier"
    ]
  },
  {
    "file": "convex/subscriptions.ts",
    "name": "requireFeature",
    "hash": "0e9ddad7cc7c3bd12c640ed29f388c14642899995ed4ce86ee712df296559224",
    "killRows": [
      "enterprise-plan",
      "free-plan"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "name": "hasPlanFeature",
    "hash": "aacb0d0f516afea65afe5463392649818f819bb954ca6565a6bd0cde0d1bd4ad",
    "killRows": [
      "enterprise-plan",
      "free-plan"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "name": "getOrgPlan",
    "hash": "c7362c04f0c4abaae34f9d74087ad14d4a2b8397a29469500a19d7b744f619dc",
    "killRows": [
      "enterprise-plan",
      "no-subscription",
      "expired-plan"
    ]
  }
];

const AUTH_MODULE_INITIALIZERS: readonly { file: string; hashes: readonly string[] }[] = [
  {
    "file": "convex/utils/tenancy.ts",
    "hashes": [
      "8d58acef59fbadf646b260154742396961195be2bc19fdf0dbbd9a67350a9051",
      "8d4dc1ea5bb90e2b26b00d6c32be2f663de02c085b5acc9b9a4461976d4cf946",
      "805f295a7374c9017a1ccf092f0d0618311781e906a7644c5e2c131ea4dcd737",
      "714c7f35bdbad8d988523562503554d38cc1180d03ae709bd9091b37e233c8cd",
      "bfd08f4c7b77640fe896a31b8237d624b36ead56493ddf28aba94b73e4070d7d",
      "58a0d4d4cad8b7c2dfff6776f03974e5d5558a819aee59e9db37d1f5a509d96e",
      "dc4daa21a63c6829391c088d5d7e8e79fb659cfef5e786625666660957a2ac04"
    ]
  },
  {
    "file": "convex/utils/errors.ts",
    "hashes": [
      "805f295a7374c9017a1ccf092f0d0618311781e906a7644c5e2c131ea4dcd737",
      "91a91e3839e1e7bee4ed458d44318a6c7cb38d14f286bfad29dd6f6513a2fcff"
    ]
  },
  {
    "file": "convex/utils/permissions.ts",
    "hashes": [
      "01f99c9e668d4ac697f8cb3a192dd2bc983c6ae1f9d2691cfbb04326ab3f0383",
      "7b167e2fde5073fb500bb8f9a6eb898d9a34811e3fa2c4f2499c0f7fc5ac60ec",
      "8d3a474879ca972656bd9577ffb12ca354154ef38de6ded1bccde35d5a102e0b",
      "1a9ed4a736bdf8cfdcd319bc666464a93b2d1db976060b0874a2eeb56f3796f4",
      "7282ed2a43092bfe298619a76488ea8cdaa59575c7834046d1ee32dab9781716",
      "8491ae69627ad84858664c9354e53893086d4517ae9eba69765073df15a8d867",
      "bd8a3fb6f0777319634c1916b24e12949d87f5bdce71827dbe0427a8ec623bb9",
      "3faddb3af18be7a9589d10d251a309ccdbc26b583673b035e90a3ed21cf69818",
      "55acf83315f7c6a8cf56304243e29c0a174003ae347ab59647fcced40aeecc7f",
      "c97862b491f53bce0eb051be0cad9909dd492ca80c905ebf101bf7dc7a169675",
      "f51da5c30092bfb655ef96cc23feea645fc0a811520e43949160204dab4a76ef",
      "1ac74a14117e8964cb85da661e647abcadcea1add99887df7a37f9394e6b3792",
      "8f30576c2c9ef5b8783fe584d9ba3ed29da593bf6b04465a81762f98ec87837c",
      "a76a38eaec7b3a17feffed43f814b6256aa7e503c902d91b6b530b405a31b978"
    ]
  },
  {
    "file": "convex/utils/auditLog.ts",
    "hashes": [
      "2575aa40738f31640c0b00397a7626f5299a443872e3d07406b3bfa83e779f0e",
      "b1e6cf92c958edc7ea4625983d94539615cb7696c40e1c70549b444345819021"
    ]
  },
  {
    "file": "convex/subscriptions.ts",
    "hashes": [
      "4c6873cadae704cacee340892151d567863f487a1396ca420fa8cbf0e1ec079b",
      "f7e94cf7a7d23049ff2e00096f078b08d2172b5871102978e0bb32e2425e34c0",
      "d5c910c321cb5c59228b73a9ab249f23b12de23d4d0992edd80d8edfb3240fbd",
      "1467fa23bb00f11c8331e4f01be0c52b349b3cf18b63fc9850ce58f95637b5f0",
      "a060d2c24f1dba6e5152b9fd4eabc074fbfda19430d440ac2149f2810ba9ddd8",
      "c749a5007b90f4da050848cc537dfa2d68291000f7278944c8dc13b6dcfdb7a4",
      "02abb3f89916bd28f393d9c3eac2c4f5d4d45efbe4da46552e1e170a2365ffea",
      "65b26b96e24eeed802db5e437d49862398cb82179db0320a49354c1c8cf0c346",
      "b9fe05d8137d2136bc896b33d09890d22da606182492a639247eae39d5e4cd96",
      "319f9b7fd29667c59c5fd69aea74a5e7c57ccd1016cc42604d509b57babe76fd",
      "35a0f19d9dcc3c5882ec3ca3c968dd71ebba5860983215c4386e88df76ad0f6d",
      "c89fda3e449f5176a7ec9dc9a924a61c6551492663c27484a83cb6d6a9236c75",
      "ed1459756a409cf7b13e949df3d5a0c48b1cafbde54bbcc0300a9ba30a1c2bff",
      "19cb4bf54a190d58eb4eb4951ce6a8714773388d8e6dfa42cb0f46bae358e5e8",
      "fe71d758929bbe875d3e8cc976f8c1b7ea241ec7bd9742751e5899602a13da1c",
      "e52746ab290f640fbeb5a968902dbe1f8de2efe3fb1549aa994eb989cffc3ec3",
      "67c892c86045a11a9389387d387b88cfc2e90de29d6678438ec9daaae05ec4ec",
      "1236f00e7199d58380d1a474e00b0ff84c6387d54dec6208bab8ab657645c2e5",
      "86dfd25bb894df429e7ecc93e4590b3c948e30c020691f5bba5ce644bb0d1d7d",
      "d598afa00d13e39e2d7292a022152b2211e54b2707f5f9a2c75804ba52b27b05",
      "2f4a276a51488b5c448799325850da3460feaae9152b12192ad5b8ebcfd4b144",
      "669c31fd76a98da05f8ba1184ddc07d27c6c01f9241dcbb9bf99ea3650edf98d",
      "61b7c857af16597ee0a463e0b2cc5dd082fd48933aca6d46808ba5de6ac30949",
      "b758cbda57965d282a168eb825686ffc9eb4cc4cb3ba6d78d5e5602196219261",
      "31cc9127d2bbda05fb8281ffbf51e07335f947ecc656abd71aca4d8cc534c3bc",
      "ca085afe6b8180e68ad217cac2a7c2ad715c3386e1213f9b297964a3452724b2",
      "d2954fc6d88ffe8e0bfe40bfcf2ab08b3bbc40f70756c573742e3946c8895448",
      "083b4c2ed6f541c30bf7c2c4bb7279aad3150a9a5f06f6c55da1be3e9256bd27",
      "dfbc4032db5a939fdc5941ad07443ab05677411d39bafb30171db66c8d55c7a1",
      "5a633ca89a967de6c90016fc946f77285faa7d557044952ce0c894de30f8e9eb",
      "48f83776acbaf2e027fcdadcb8adad11c40ac2de7aa2c07dc49307ac10014d15",
      "8a99c690c74e4466b93f580c293f4cdf53f134cfaae98c8e39dbf16ccbbd399a"
    ]
  },
  {
    "file": "convex/utils/subscriptionFeatures.ts",
    "hashes": [
      "8bb803d1c621ad664d29dd7e75939dffe04fdd20cbe555a09351e61d8b617990",
      "5e6eb3566941f2f8793157561cfdbf32465b0146c69bbccff0e296997cd9431b",
      "068ae0f181472c2c7629ccb7eabedd7738c60d3256e588d7734698f9f41be093"
    ]
  }
];

function authorizationInitializers(source: ts.SourceFile): readonly ts.Statement[] {
  return source.statements.filter(node => !ts.isFunctionDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node));
}

function authorizationProgram(sources: readonly ts.SourceFile[]): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const files = new Map(sources.map(source => {
    const file = resolve(root, source.fileName).replaceAll("\\", "/");
    return [file, ts.createSourceFile(file, source.text, ts.ScriptTarget.Latest, true)] as const;
  }));
  const host = ts.createCompilerHost(options);
  const key = (file: string) => resolve(file).replaceAll("\\", "/");
  host.getSourceFile = file => files.get(key(file));
  host.fileExists = file => files.has(key(file));
  host.readFile = file => files.get(key(file))?.text;
  const program = ts.createProgram([...files.keys()], options, host);
  if (program.getSyntacticDiagnostics().length > 0) throw new Error("Unparseable authorization graph");
  return program;
}

function authorizationFunction(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): ts.FunctionDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const target = symbol.flags === ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of target.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = authorizationFunction(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
}

function authorizationHelpers(sources: readonly ts.SourceFile[]): AuthorizationHelper[] {
  const program = authorizationProgram(sources);
  const checker = program.getTypeChecker();
  const helpers: AuthorizationHelper[] = [];
  const seen = new Set<ts.FunctionDeclaration>();
  const visit = (declaration: ts.FunctionDeclaration): void => {
    if (seen.has(declaration)) return;
    seen.add(declaration);
    const source = declaration.getSourceFile();
    const name = declaration.name?.text;
    if (!name || !declaration.body) throw new Error("Unnamed authorization helper");
    helpers.push({ file: relative(root, source.fileName).replaceAll("\\", "/"), source, declaration, name });
    authorizationCalls(declaration, checker, visit);
  };
  const roots = new Map(NAVIGATION_CALLERS.filter(caller => caller.exportedQuery !== null)
    .map(caller => [caller.file + ":" + caller.exportedQuery, caller]));
  for (const rootCaller of roots.values()) {
    const source = program.getSourceFile(resolve(root, rootCaller.file).replaceAll("\\", "/"));
    const entry = source?.statements.find(node => ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(declaration => declaration.name.getText(source) === rootCaller.exportedQuery));
    if (!entry) throw new Error("Missing authorization query root " + rootCaller.exportedQuery);
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = authorizationFunction(node.expression, checker);
        if (target && /\/(?:utils\/(?:tenancy|permissions)|subscriptions)\.ts$/.test(target.getSourceFile().fileName)) visit(target);
      }
      ts.forEachChild(node, scan);
    };
    scan(entry);
  }
  if (helpers.length === 0) throw new Error("Authorization graph must reach helpers from public queries");
  return helpers;
}

function authorizationCalls(body: ts.Node, checker: ts.TypeChecker, visit: (declaration: ts.FunctionDeclaration) => void): void {
  const boundaries = ["ctx.auth.getUserIdentity", "ctx.db.query", "ctx.db.get", "ctx.db.insert", "Date.now", "Number"];
  const methods = ["withIndex", "unique", "eq", "filter", "includes", "every", "has", "join"];
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = authorizationFunction(node.expression, checker);
      if (target) visit(target);
      else if (!boundaries.includes(navigationTokens(node.expression, node.getSourceFile()).join("")) &&
        !(ts.isPropertyAccessExpression(node.expression) && methods.includes(node.expression.name.text))) {
        throw new Error("authorization condition inventory changed: unreviewed call " + node.expression.getText());
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(body);
}

function assertAuthorizationConditionInventory(tenancy: ts.SourceFile, permissions: ts.SourceFile): void {
  const helpers = authorizationHelpers(authorizationSources(tenancy, permissions));
  const actual = helpers.flatMap(helper => authorizationConditions(helper.source, helper.name));
  expect(actual.toSorted(), "authorization condition inventory changed; add a literal pair with different expected outcomes before reviewing the condition").toStrictEqual(AUTH_CONDITION_PAIRS.map(([condition]) => condition).sort());
  expect(helpers.map(helper => helper.file + ":" + helper.name).sort(), "Every reached helper needs a behavioural kill contract").toStrictEqual(AUTH_HELPER_CONTRACTS.map(helper => helper.file + ":" + helper.name).sort());
  for (const helper of helpers) {
    const contract = AUTH_HELPER_CONTRACTS.find(pin => pin.file === helper.file && pin.name === helper.name);
    expect(navigationFingerprint(helper.declaration, helper.source), helper.name + ": authorization helper changed; rerun its behavioural mutant before renewing the pin").toBe(contract?.hash);
    expect(contract?.killRows.length, helper.name + ": missing behavioural kill").toBeGreaterThan(0);
  }
  const modules = new Map(helpers.map(helper => [helper.file, helper.source]));
  expect([...modules.keys()].sort(), "Every authorization module needs initialization pins").toStrictEqual(AUTH_MODULE_INITIALIZERS.map(pin => pin.file).sort());
  for (const [file, source] of modules) {
    const pin = AUTH_MODULE_INITIALIZERS.find(entry => entry.file === file);
    expect(authorizationInitializers(source).map(node => navigationFingerprint(node, source)), file + ": authorization module initialization changed").toStrictEqual(pin?.hashes);
  }
}

function authorizationSources(tenancy = parse("convex/utils/tenancy.ts"), permissions = parse("convex/utils/permissions.ts")): ts.SourceFile[] {
  return [tenancy, permissions, ...["convex/utils/errors.ts", "convex/utils/auditLog.ts", "convex/subscriptions.ts",
    "convex/utils/subscriptionFeatures.ts", "convex/supplierStatement.ts", "convex/supplierRelationships.ts"].map(file => parse(file))];
}

test("authorization condition census requires distinguishing literal row pairs for every evaluated decision", () => {
  assertAuthorizationConditionInventory(parse("convex/utils/tenancy.ts"), parse("convex/utils/permissions.ts"));
  assertAuthorizationPairs(parse("convex/utils/tenancy.test.ts"));
});

test("authorization condition census refuses unlisted branches and changed predicate forms", () => {
  const tenancy = parse("convex/utils/tenancy.ts");
  const permissions = parse("convex/utils/permissions.ts");
  const newBranch = tenancy.text.replace("  return { user, membership, role };", '  if (role.name === "Unpaired") return { user, membership, role };\n  return { user, membership, role };');
  const changedPredicate = permissions.text.replace("PRE_413_OWNER_FALLBACK_PERMISSIONS.every(", "PRE_413_OWNER_FALLBACK_PERMISSIONS.some(");
  expect(newBranch).not.toBe(tenancy.text);
  expect(changedPredicate).not.toBe(permissions.text);
  expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, newBranch, ts.ScriptTarget.Latest, true), permissions)).toThrow(/condition inventory changed/);
  expect(() => assertAuthorizationConditionInventory(tenancy, ts.createSourceFile(permissions.fileName, changedPredicate, ts.ScriptTarget.Latest, true))).toThrow(/condition inventory changed/);
  const comparisonAsData = tenancy.text.replace("  return { user, membership, role };", '  const choice = Number(role.name === "Unpaired");\n  return { user, membership, role };');
  expect(comparisonAsData).not.toBe(tenancy.text);
  expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, comparisonAsData, ts.ScriptTarget.Latest, true), permissions)).toThrow(/condition inventory changed/);
  const nullishChoice = tenancy.text.replace("  return { user, membership, role };", '  const choice = role.name ?? "Unpaired";\n  return { user, membership, role };');
  expect(nullishChoice).not.toBe(tenancy.text);
  expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, nullishChoice, ts.ScriptTarget.Latest, true), permissions)).toThrow(/condition inventory changed/);
  for (const statement of ['const choice = role?.name;', 'const choice = role.permissions[0];', 'const choice = new Map();']) {
    const changed = tenancy.text.replace("  return { user, membership, role };", statement + "\n  return { user, membership, role };");
    expect(changed).not.toBe(tenancy.text);
    expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, changed, ts.ScriptTarget.Latest, true), permissions)).toThrow(/unreviewed authorization control/);
  }
});

function assertReservedClosureInsertion(file: string): void {
  const source = parse(file);
  for (const form of [
    'const EXECUTABLE_CLOSURE = console.info("SCRUM943_INSERTION");',
    'const ORDINARY_PROBE = console.info("SCRUM943_INSERTION");',
    'export { test as hiddenTest } from "vitest";',
    'const holder = { ["effect"]: console.info("SCRUM943_INSERTION") };',
  ]) {
    const changed = ts.createSourceFile(file, source.text + "\n" + form, ts.ScriptTarget.Latest, true);
    expect(() => assertStatementClosure(changed, file), file + ": only the owning literal table can be exempt").toThrow(/EXECUTABLE_CLOSURE/);
  }
}

test("closure refuses reserved-name insertion in the behavioural suite", () => {
  assertReservedClosureInsertion("convex/supplierNavigation.scrum869.test.ts");
});

test("closure refuses a second pin table in the census suite", () => {
  assertReservedClosureInsertion("scripts/intelligence/supplierNavigationDoors.test.ts");
});

test("closure refuses reserved-name insertion in setup", () => {
  assertReservedClosureInsertion("vitest.setup.ts");
});

test("closure refuses reserved-name insertion in config", () => {
  assertReservedClosureInsertion("vitest.config.ts");
});

test("closure pins imported fixture and census helper implementations", () => {
  for (const file of ["test-utils/convexTest.ts", "test-utils/supplierFixture.ts", "scripts/autoflowInvariantCatalog.ts"]) {
    assertStatementClosure(parse(file), file);
    assertReservedClosureInsertion(file);
  }
});

test("closure pins the cache behavioural oracle", () => {
  const file = "convex/utils/supplierReadCache.test.ts";
  assertStatementClosure(parse(file), file);
  assertReservedClosureInsertion(file);
});

test("closure pins the authentication behavioural oracle and refuses loader comments", () => {
  const file = "convex/utils/tenancy.test.ts";
  assertStatementClosure(parse(file), file);
  assertReservedClosureInsertion(file);
  for (const suite of ["convex/supplierNavigation.scrum869.test.ts", "scripts/intelligence/supplierNavigationDoors.test.ts", file]) {
    for (const directive of ["vitest-environment node", 'jest-environment-options {"url":"https://example.test"}', "vitest-pool threads", "module-tag hidden"]) {
      const text = "// @" + directive + "\n" + parse(suite).text;
      expect(() => assertStatementClosure(ts.createSourceFile(suite, text, ts.ScriptTarget.Latest, true), suite)).toThrow(/loader directives/);
    }
  }
});

test("closure refuses setup masking config inheritance and computed configuration", () => {
  for (const [file, form] of [
    ["vitest.setup.ts", 'vi.mock("node:fs", () => ({ readFileSync: () => "old source" }));'],
    ["vitest.setup.ts", 'Object.defineProperty(process, "getBuiltinModule", { value: () => ({}) });'],
    ["vitest.config.ts", 'export { default } from "./other.config";'],
    ["vitest.config.ts", 'const inherited = { extends: "./other.config.ts" };'],
    ["vitest.config.ts", 'const config = { ["setup" + "Files"]: ["./other.setup.ts"] };'],
  ]) {
    const source = parse(file!);
    expect(() => assertStatementClosure(ts.createSourceFile(file!, source.text + "\n" + form, ts.ScriptTarget.Latest, true), file!)).toThrow(/EXECUTABLE_CLOSURE/);
  }
});

test("closure refuses compiler annotations inside pinned statements", () => {
  const file = "vitest.setup.ts";
  const source = parse(file);
  const text = source.text.replace('import("@testing-library/react")', 'import(/* @vite-ignore */ "@testing-library/react")');
  expect(text).not.toBe(source.text);
  expect(() => assertStatementClosure(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file)).toThrow(/EXECUTABLE_CLOSURE/);
});

const EXECUTION_INPUTS: readonly { file: string; hash: string }[] = [
  {
    "file": "package.json",
    "hash": "c2d4fa017a96e339f0d55637d34b183f30d03a50329749a972aa0d57bf7032b7"
  },
  {
    "file": "pnpm-lock.yaml",
    "hash": "561307b7b119a00b52319d7438e72922227a3ab34311b4185bcdb84edf2b3f73"
  },
  {
    "file": "pnpm-workspace.yaml",
    "hash": "8601944fc002d43f358407183e3b72ef1db695feaff3eea8e1c4b860c275b9d7"
  },
  {
    "file": "tsconfig.json",
    "hash": "b15e17e569303d2a798ee15a2b17017f43aebd08776a4c7b21afd8b755cda8b6"
  },
  {
    "file": "convex/tsconfig.json",
    "hash": "da06ccd21d118b2b5f6dec67b124ca861e790e0b5ef1ea7f173ac8712c1bb93e"
  },
  {
    "file": "patches/expo-sharing.patch",
    "hash": "0eddd9192c3a88ec6dbc7a5ea7425cf4e1e0b759b9d9c296a2fd22c60ca12b3a"
  },
  {
    "file": "patches/query-string@7.1.3.patch",
    "hash": "fe47b885269a14c517ab79b9f7e5d0b46666cf13e5a80856685262c20aa00da5"
  }
];

function assertExecutionInput(file: string, text: string): void {
  const pin = EXECUTION_INPUTS.find(entry => entry.file === file);
  const actual = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
  if (!pin || pin.hash !== actual) throw new Error(file + ": EXECUTABLE_CLOSURE execution input changed");
}

function assertConfigNames(files: readonly string[]): void {
  const configs = files.filter(file => /^(?:vite|vitest)\.(?:config|workspace)\.(?:[cm]?[jt]s|json)$/.test(file) ||
    /^(?:\.npmrc|\.?pnpmfile\.[cm]?js)$/.test(file));
  expect(configs.toSorted(), "EXECUTABLE_CLOSURE refuses alternate configuration and install hooks").toStrictEqual(["vitest.config.ts"]);
}

test("closure pins module resolution installation and config discovery inputs", () => {
  const filesystem = process.getBuiltinModule("fs");
  expect(EXECUTION_INPUTS.length).toBeGreaterThan(0);
  assertConfigNames(filesystem.readdirSync(root));
  for (const pin of EXECUTION_INPUTS) {
    const text = filesystem.readFileSync(join(root, pin.file), "utf8");
    assertExecutionInput(pin.file, text);
    expect(() => assertExecutionInput(pin.file, text + "\n ")).toThrow(/execution input changed/);
  }
  for (const name of ["vitest.config.mts", "vitest.workspace.ts", "vite.config.js", ".pnpmfile.cjs", ".npmrc"]) {
    expect(() => assertConfigNames(["vitest.config.ts", name])).toThrow(/alternate configuration/);
  }
});

test("authorization census follows authentication and context classification decisions", () => {
  const tenancy = parse("convex/utils/tenancy.ts");
  const permissions = parse("convex/utils/permissions.ts");
  for (const [before, after] of [
    ['if (user.disabled)', 'if (user.disabled && identity.subject !== "auth-decision")'],
    ['return "insert" in ctx.db;', 'return false;'],
  ]) {
    const changed = tenancy.text.replace(before!, after!);
    expect(changed).not.toBe(tenancy.text);
    expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, changed, ts.ScriptTarget.Latest, true), permissions)).toThrow();
  }
});

function authorizationMutation(name: string, before: string, after: string): ts.SourceFile {
  const source = parse("convex/utils/tenancy.ts");
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error("Missing mutation target " + name);
  const text = declaration.getText(source);
  if (!text.includes(before)) throw new Error("Missing authorization control anchor " + name);
  return ts.createSourceFile(source.fileName, source.text.slice(0, declaration.getStart(source)) +
    text.replace(before, after) + source.text.slice(declaration.end), ts.ScriptTarget.Latest, true);
}

test("authorization graph resolves local aliases and refuses unreviewed helper bodies", () => {
  const alias = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);",
    "const authenticate = requireAuth; const user = await authenticate(ctx);");
  expect(authorizationHelpers(authorizationSources(alias)).map(helper => helper.name)).toContain("requireAuth");
  expect(() => assertAuthorizationConditionInventory(alias, parse("convex/utils/permissions.ts"))).toThrow(/authorization helper changed/);
  const wrapper = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", "const authenticate = extraAuth; const user = await authenticate(ctx);");
  const extra = ts.createSourceFile(wrapper.fileName, wrapper.text + "\nfunction extraAuth(ctx: QueryCtx) { return requireAuth(ctx); }", ts.ScriptTarget.Latest, true);
  expect(authorizationHelpers(authorizationSources(extra)).map(helper => helper.name)).toContain("extraAuth");
  expect(() => assertAuthorizationConditionInventory(extra, parse("convex/utils/permissions.ts"))).toThrow(/Every reached helper/);
});

test("authorization graph refuses reexports computed calls and module initialization writes", () => {
  const permissions = parse("convex/utils/permissions.ts");
  const source = parse("convex/utils/tenancy.ts");
  const changed = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", "const user = await importedAuth(ctx);");
  const reexport = ts.createSourceFile(source.fileName, 'import { requireAuth as importedAuth } from "./unreviewed-auth-reexport";\n' + changed.text, ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(reexport, permissions)).toThrow(/unreviewed call/);
  const computed = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", 'const user = await ({ requireAuth })["requireAuth"](ctx);');
  expect(() => assertAuthorizationConditionInventory(computed, permissions)).toThrow();
  const overwritten = ts.createSourceFile(source.fileName, source.text + "\nrequireAuth = async ctx => null as never;", ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(overwritten, permissions)).toThrow(/initialization changed/);
  const unparseable = ts.createSourceFile(source.fileName, source.text + "\n/*", ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(unparseable, permissions)).toThrow(/Unparseable authorization graph/);
});

test("main settled combined-family completeness and totals assertions remain at least as strong", () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const title = "100 settled rows per family with distinct targets use at most 803 actual gets per handler";
  const registrations = listActiveTestRegistrations(source.text);
  expect(registrations.map(entry => entry.title), "main's combined AR plus recovery completeness contract must execute").toContain(title);
  const body = literalTestBody(source, title);
  const assertions = body?.statements.filter(ts.isExpressionStatement).filter(statement =>
    statement.expression.getFirstToken(source)?.getText(source) === "expect");
  expect(assertions?.map(statement => navigationFingerprint(statement, source)), "main 029386d9b: preserve both original literal totals, completeness and exact 803-get assertions").toStrictEqual([
    "8028f9c6b24c6f585f6b422e22e1871a79818fa5c9528bf14224e606ce881b14",
    "4d837509e766c2ad09711bc14c7d032cc6d7005daacaf2f575208cf8f6b78840",
  ]);
});
