# SCRUM-866: main evidence drift at 56e4f858

This change clears the 12 baseline differences. It does **not** establish the
full deploy-fixes-it proof required by AGENTS.md: four vehicle calls remain
mechanically unproven even against native current argument validators. Do not
use this change as a release authorization.

## Evidence boundary

- Reviewed source/base: `56e4f8586c978ccf2c570be83f3a23c269b9fdac`.
- CI evidence: [Contract skew run 40990172031](https://github.com/aalzriqat/Auto/actions/runs/40990172031),
  downloaded with `gh run view --log` and `gh run download`.
- Recorded deployed source: `6c71a7654bc8fc11b37b4b57ac52dbb71ecae592`.
  This is the workflow's deployment record, not a source hash read from Convex.
- A fresh workstation-account metadata read addressed
  `https://clever-mockingbird-719.convex.cloud` and reproduced the same 11
  breaking findings at six call sites and the same 12 baseline differences.
- No product code, detector, threshold, schema, expiry policy or workflow changes.
  No deployment, mutation, merge or reviewer-seat certification.

## Twelve differences and their treatment

All rows are on the `web` surface. `callSiteId` is the file column followed by
the `line:column` column. These are distinct contract-path findings, not twelve
calls. The relocation helper found **0 safe relocations and 0 refusals** at the
reviewed base. These changes concern payloads, not moved call expressions.

| # | File | line:column | functionId | contractPath | Why it drifts / treatment |
| --- | --- | --- | --- | --- | --- |
| 1 | components/vehicles/VehicleDialog.tsx | 442:17 | vehicles:update | sourcedFromName | Display name destructured out; replaced by supplier ID. Delete obsolete TYPE_UNKNOWN. |
| 2 | components/vehicles/VehicleDialog.tsx | 442:17 | vehicles:update | purchaseSupplierName | Display name destructured out of settlement. Delete obsolete TYPE_UNKNOWN. |
| 3 | components/vehicles/VehicleDialog.tsx | 453:17 | vehicleEdits:requestUpdate | payload.sourcedFromName | Request payload spreads the ID-based ownership fields. Delete obsolete TYPE_UNKNOWN. |
| 4 | components/vehicles/VehicleDialog.tsx | 467:31 | vehicles:create | sourcedFromName | Display name excluded from create payload. Delete obsolete TYPE_UNKNOWN. |
| 5 | components/vehicles/VehicleDialog.tsx | 467:31 | vehicles:create | purchaseSupplierName | ON_ACCOUNT settlement sends purchaseSupplierId. Delete obsolete TYPE_UNKNOWN. |
| 6 | components/vehicles/VehicleDialog.tsx | 480:17 | vehicleEdits:requestCreate | payload.sourcedFromName | Request payload excludes display name. Delete obsolete TYPE_UNKNOWN. |
| 7 | components/vehicles/VehicleDialog.tsx | 480:17 | vehicleEdits:requestCreate | payload.purchaseSupplierName | Request settlement sends purchaseSupplierId. Delete obsolete TYPE_UNKNOWN. |
| 8 | components/suppliers/SupplierSelect.tsx | 155:36 | suppliers:create | idempotencyKey | Mutable ref is opaque to extractor. Read newIdempotencyKey/submitCreate and backend create: string UUID key initialized before call; backend requires string and performs idempotency handling. Add reviewed TYPE_UNKNOWN. |
| 9 | components/sales/wizard/steps/Step1QuoteSetup.tsx | 475:36 | vehicles:createSourced | <root> | New toCreateSourcedArgs helper makes payload opaque to extractor. Read helper, SourceVehicleData and backend createSourced: drops display name, requires supplier ID, forwards typed vehicle fields plus orgId. Add reviewed SHAPE_UNKNOWN for CASH picker call. |
| 10 | components/sales/wizard/steps/Step1QuoteSetup.tsx | 492:43 | vehicles:createSourced | <root> | Same helper/validator review for the financed picker call. Add separate reviewed SHAPE_UNKNOWN. |
| 11 | app/(dashboard)/[orgId]/vehicles/page.tsx | 294:13 | vehicleEdits:resolve | ownership.sourcedSupplierId | Optional typed ownership member is absent from production, so transmission remains unproven. Read handleResolveEdit, chooser and current ownershipDecisionValidator: optional suppliers ID agrees with current source. Add SHAPE_UNKNOWN; production compatibility is not claimed. |
| 12 | app/(dashboard)/[orgId]/vehicles/page.tsx | 294:13 | vehicleEdits:resolve | ownership.purchaseSupplierId | Same review of the optional purchase creditor ID; current source accepts optional suppliers ID. Add SHAPE_UNKNOWN; production compatibility is not claimed. |

The seven removed properties are excluded at construction time; the backend
resolves the submitted supplier IDs to tenant-owned master-row snapshots. The
five additions retain the production report's exact identity, cause,
fingerprint and multiplicity. Each has an individual review statement and
`evidence-blobs` for its client and defining backend file, produced by
`renewBaselineReviewed.mjs --blob-evidence`. Expiry stays at **2026-12-01**,
matching the existing debt review window. The other 1,005 records are unchanged.
Final baseline: **1,010** entries. No bulk renewal.

## Six deploy-proof calls

The production workflow supplies `--deployed-sha` but no `--current` spec.
`classify.mjs` therefore correctly refuses to infer a contract from a changed
`convex/` tree: 0 fixed, 0 still-failing, 6 unproven. This is missing evidence,
not proof of a detector defect. All eleven reported breaking paths have
matching public functions/validators in current source.

For a stronger diagnostic, a temporary one-worker Vitest test imported the real
registered exports from `convex/financingEconomics.ts`, `convex/vehicles.ts` and
`convex/vehicleEdits.ts`; it rendered their native `exportArgs()` and compared
the same six calls extracted from the two client files. It invoked no handler.
Result: **6 calls, 0 current breaks; 2 fixed, 0 still-failing, 4 unproven**.
The three-module spec is scoped evidence, not a complete current spec for the
global CLI. The temporary diagnostic is not part of the permanent test suite.

| callSiteId | functionId | Production failure | Current source / native comparison verdict |
| --- | --- | --- | --- |
| components/applications/cockpit/DealCockpit.tsx:915:5 | financingEconomics:supplierConcessionBasis | Missing function | Public query at financingEconomics.ts:3386; orgId and applicationId validators match. FIXED in native current comparison. |
| components/applications/cockpit/DealCockpit.tsx:3806:17 | financingEconomics:resolveAppraisalGap | supplierGapShareMinor, observedSupplierEntitlementMinor, observedSupplierName undeclared | Current mutation at financingEconomics.ts:3070 declares optional number/number/string. FIXED in native current comparison. |
| components/vehicles/VehicleDialog.tsx:442:17 | vehicles:update | sourcedSupplierId, purchaseSupplierId undeclared | Current update at vehicles.ts:1348 accepts optional suppliers IDs. No current break; both ID values remain TYPE_UNKNOWN, hence UNPROVEN. |
| components/vehicles/VehicleDialog.tsx:453:17 | vehicleEdits:requestUpdate | payload.sourcedSupplierId undeclared | Current requestUpdate payload accepts optional suppliers ID. No current break; ID value remains TYPE_UNKNOWN, hence UNPROVEN. |
| components/vehicles/VehicleDialog.tsx:467:31 | vehicles:create | sourcedSupplierId, purchaseSupplierId undeclared | Current create at vehicles.ts:929 accepts optional suppliers IDs. No current break; both values remain TYPE_UNKNOWN, hence UNPROVEN. |
| components/vehicles/VehicleDialog.tsx:480:17 | vehicleEdits:requestCreate | payload.sourcedSupplierId, payload.purchaseSupplierId undeclared | Current requestCreate at vehicleEdits.ts:148 accepts optional suppliers IDs. No current break; both values remain TYPE_UNKNOWN, hence UNPROVEN. |

The four vehicle calls cast form values to `Id<"suppliers">`. Such a cast is not
runtime validation or a proof that an opaque value belongs to that table. The
existing comparator preserves that uncertainty. Suppressing these findings or
treating a baseline review as ACCEPTED would weaken the control. No product
mismatch was found in the inspected current contracts; runtime success and full
value provenance remain unproved. SCRUM-711 remains open for that proof.
This refusal is intentional and already covered by
`assertionProvenance.test.ts`: direct, conditional, aliased, destructured and
spread assertions cannot manufacture same-table ID evidence. The form schema
itself declares the supplier IDs as optional strings in `vehicle.schema.ts`.

## Reproduction and verification

Install was started first: `pnpm install --frozen-lockfile`, exit 0 (pnpm
10.28.1, Node 26.4.0; CI pins pnpm 11.13.0 and Node 22.21.1).

CI's invocation is:

```sh
node scripts/contractSkew/cli.mjs --mode production --json skew-report.json --deployed-sha 6c71a7654bc8fc11b37b4b57ac52dbb71ecae592
```

The bare local invocation reports UNAVAILABLE because CI environment identity
and read-key variables are absent. With the expected deployment supplied it
still reports UNAVAILABLE without a credential rung. The existing documented
workstation fallback successfully reads production metadata using account auth:

```sh
# Set CONVEX_DEPLOYMENT=prod:clever-mockingbird-719 in this process only.
node scripts/contractSkew/cli.mjs --mode production --allow-workstation --expect-deployment clever-mockingbird-719 --json <temp-report> --deployed-sha 6c71a7654bc8fc11b37b4b57ac52dbb71ecae592
```

Before: exit 7, 11 breaks, 12 EVIDENCE DRIFT differences, 6 unproven calls.
Evaluating the downloaded report with the unchanged baseline evaluator also
reproduced all 12 differences before editing; after review it matches all 1,010
entries with zero differences. The fresh production-metadata rerun exits 7 with
11 breaks, 1,010 matched entries, zero drift and no ALSO PRESENT cause. It still
reports six unproven calls because no full current spec was supplied. Remaining
command results are recorded in the PR.

Completed local checks:

```text
node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
14 passed, 0 failed, 0 skipped; exit 0

node scripts/contractSkew/checkBaselineIdentity.mjs
1010 baseline entries matched; exit 0 (backend finding identity not checked)

node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 56e4f8586c978ccf2c570be83f3a23c269b9fdac
1010 renewed checked; 0 unrenewed, 0 stale, 0 malformed, 0 missing; exit 0

pnpm typecheck:contract-skew
tsc -p scripts/contractSkew/tsconfig.json --noEmit; exit 0
```

The detector typecheck checks its `.mjs` and TypeScript sources; it is not a
Convex platform or backend typecheck. No backend source changed. The first
full Vitest run had 25 files pass, one import failure in `authorToolsCli.test.ts`,
1,220 passing tests and one existing skip. This is the documented Windows
CRLF-shebang import failure. Local LF normalization of the three shebang files
changes no committed blob; no source diff is included for it. The corrected
full suite passes all 26 files: 1,279 passed, one existing skip, exit 0. A prior literal-glob Vitest filter
collected no files and exited 1; the actual 26-file invocation uses
`pnpm exec vitest run scripts/contractSkew --maxWorkers=1`.

No new regression test is claimed: the change is evidence data and this report;
the detector's existing refusal behavior remains unchanged. The four outstanding
value-provenance obligations and missing full current spec prevent the release
exception from being certified here.

## Source references

- [Official Convex function-spec CLI](https://docs.convex.dev/cli/reference/function-spec)
  reads deployment metadata; it does not render arbitrary local source.
- Native argument serialization was checked in installed Convex 1.42.1
  `src/server/impl/registration_impl.ts`: `exportArgs` serializes
  `asObjectValidator(functionDefinition.args).json`. This is also the repo's
  existing `sharedValidator.test.ts` proof boundary.
- [Git ls-tree](https://git-scm.com/docs/git-ls-tree) documents the committed
  blob identities used by the existing renewal tool. Worktree CRLF hashes were
  not substituted for git blobs.
- [TypeScript assertions](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
  are erased at compilation; they provide no runtime validation. The
  [Convex validation guidance](https://docs.convex.dev/functions/validation)
  recommends server argument validation independently of TypeScript types;
  this repository requires it.

## Reproduce the scoped native diagnostic

Save the following as `scripts/contractSkew/scrum866Diagnostic.test.ts` in a
disposable checkout at the reviewed base. Download the CI artifact into
`<os.tmpdir()>/scrum866-artifacts40990172031` first, then run
`pnpm exec vitest run scripts/contractSkew/scrum866Diagnostic.test.ts --maxWorkers=1`.
It writes its scoped comparison and rendered argument spec to the temp directory.
Expected output fields: `callCount: 6`, `current.breaking: []`,
`classification.callOutcomes: { fixed: 2, stillFails: 0, unproven: 4 }`.
The assertions establish six calls and zero current breaks; the written
classification must also be inspected. Remove the temporary test afterward.

```ts
// Temporary local diagnostic; removed before staging.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, test } from "vitest";
import * as vehicles from "../../convex/vehicles";
import * as vehicleEdits from "../../convex/vehicleEdits";
import * as financingEconomics from "../../convex/financingEconomics";
import { extractClientCalls } from "./clientPaths.mjs";
import { compareContracts } from "./compare.mjs";
import { classifyBreaking } from "./classify.mjs";

test("inspect the six skew calls against native current validators", () => {
  const sourceReport = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "scrum866-artifacts40990172031/contract-skew-report/skew-report.json"), "utf8"));
  const sites = new Set<string>(sourceReport.breaking.map((f: { siteId: string }) => f.siteId));
  const files = [...new Set<string>(sourceReport.breaking.map((f: { file: string }) => f.file))].map((file) => path.resolve(file));
  const extracted = extractClientCalls(files, path.resolve("tsconfig.json"));
  const calls = extracted.calls.filter((call: { siteId: string }) => sites.has(call.siteId)).map((call: object) => ({ ...call, surface: "web" }));
  const modules = { vehicles, vehicleEdits, financingEconomics };
  const functions = Object.entries(modules).flatMap(([module, exports]) => Object.entries(exports).flatMap(([name, fn]) => {
    if (typeof fn !== "function" || !("exportArgs" in fn) || typeof fn.exportArgs !== "function") return [];
    return [{ identifier: `${module}.js:${name}`, functionType: "isQuery" in fn ? "Query" : "isMutation" in fn ? "Mutation" : "Action", visibility: { kind: "isPublic" in fn ? "public" : "internal" }, args: JSON.parse(fn.exportArgs()) }];
  }));
  const current = compareContracts(calls, { functions });
  const classification = classifyBreaking(sourceReport.breaking, { currentResult: current });
  const diagnostic = { source: "56e4f858 native exportArgs; three modules only; six-call comparison only", callCount: calls.length, current, classification };
  fs.writeFileSync(path.join(os.tmpdir(), "scrum866-six-current.json"), JSON.stringify(diagnostic, null, 2));
  fs.writeFileSync(path.join(os.tmpdir(), "scrum866-three-modules-current.json"), JSON.stringify({ functions }, null, 2));
  console.log(JSON.stringify({ calls: calls.length, breaking: current.breaking, outcomes: classification.callOutcomes, uncertain: classification.uncertain }));
  expect(calls).toHaveLength(6);
  expect(current.breaking).toEqual([]);
}, 60_000);
```
