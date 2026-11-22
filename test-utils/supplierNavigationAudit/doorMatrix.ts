import { saleLookupCells } from "./saleLookupCells";
import { saleLinkCells } from "./saleLinkCells";
import { openingAndExpenseCells } from "./openingAndExpenseCells";
import { vehicleCells } from "./vehicleCells";

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
export interface Door {
 name: string; kind: "owned" | "permission" | "status"; site: string;
 axes: Readonly<Record<string, readonly string[]>>;
 axisExemptions: Readonly<Record<string, string>>;
 rows: readonly {tuple: readonly string[]; title: string}[];
 exemptions: readonly {tuple: readonly string[]; reason: string; rule: "no-application" | "native-no-number"}[];
}

export const SUPPLIER_NAVIGATION_DOORS: readonly Door[] = [
  ...saleLookupCells,
  ...saleLinkCells,
  ...openingAndExpenseCells,
  ...vehicleCells,
];
