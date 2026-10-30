# SCRUM-866: main evidence drift at 56e4f858

This PR clears the original 12 baseline differences and incorporates #726.
The final baseline contains **928 entries**. A native comparison proves the six
reported calls fixed against three current modules; it is not a full current
spec or release authorization. CI supplies no `--current` spec and may still
print these calls as unproven in its deploy-fixes-it line.

## Evidence boundary

- Reviewed source/base: `56e4f8586c978ccf2c570be83f3a23c269b9fdac`.
- CI evidence: [Contract skew run 40990172031](https://github.com/aalzriqat/Auto/actions/runs/40990172031),
  downloaded with `gh run view --log` and `gh run download`.
- Recorded deployed source: `6c71a7654bc8fc11b37b4b57ac52dbb71ecae592`.
  This is the workflow's deployment record, not a source hash read from Convex.
- The historical first-commit workstation-account metadata read addressed
  `https://clever-mockingbird-719.convex.cloud` and reproduced the same 11
  breaking findings at six call sites and the same 12 baseline differences.
- Product code changes in #726 establish supplier-ID provenance in VehicleDialog;
  this follow-up corrects its stale-selection toast in English and Arabic.
  Detector, thresholds, schema, expiry policy and workflows are unchanged.
  This report claims no deployment, production mutation or reviewer-seat certification.

## Twelve differences and their treatment

Historical first-commit evidence (`1e6b7e9b`), before #726:

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
matching the existing debt review window. At that first commit, 1,005 records
were unchanged and the intermediate baseline contained 1,010 entries. The final
count after #726 is 928, as verified below. No bulk expiry extension.

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
After #726: **6 calls, 0 current breaks; 6 fixed, 0 still-failing, 0 unproven**.
The three-module spec is scoped evidence, not a complete current spec for the
global CLI. The temporary diagnostic is not part of the permanent test suite. The rerun
uses the four relocated VehicleDialog call identities shown below.

| callSiteId | functionId | Production failure | Current source / native comparison verdict |
| --- | --- | --- | --- |
| components/applications/cockpit/DealCockpit.tsx:915:5 | financingEconomics:supplierConcessionBasis | Missing function | Public query at financingEconomics.ts:3386; orgId and applicationId validators match. FIXED in native current comparison. |
| components/applications/cockpit/DealCockpit.tsx:3806:17 | financingEconomics:resolveAppraisalGap | supplierGapShareMinor, observedSupplierEntitlementMinor, observedSupplierName undeclared | Current mutation at financingEconomics.ts:3070 declares optional number/number/string. FIXED in native current comparison. |
| components/vehicles/VehicleDialog.tsx:464:17 | vehicles:update | sourcedSupplierId, purchaseSupplierId undeclared | Current update at vehicles.ts:1348 accepts optional suppliers IDs. FIXED: picker/stored-document supplier IDs are recovered by parseSupplierId without casts. |
| components/vehicles/VehicleDialog.tsx:475:17 | vehicleEdits:requestUpdate | payload.sourcedSupplierId undeclared | Current requestUpdate payload accepts optional suppliers ID. FIXED: parseSupplierId preserves the supplier-ID provenance in the request payload. |
| components/vehicles/VehicleDialog.tsx:489:31 | vehicles:create | sourcedSupplierId, purchaseSupplierId undeclared | Current create at vehicles.ts:929 accepts optional suppliers IDs. FIXED: parseSupplierId preserves supplier-ID provenance; the concrete inspection payload type preserves spread proof. |
| components/vehicles/VehicleDialog.tsx:502:17 | vehicleEdits:requestCreate | payload.sourcedSupplierId, payload.purchaseSupplierId undeclared | Current requestCreate at vehicleEdits.ts:148 accepts optional suppliers IDs. FIXED: parseSupplierId preserves supplier-ID provenance; the concrete inspection payload type preserves spread proof. |

## #726 supplier provenance and follow-up

Squashed commit `d17b8e0dbb15157598f23d7c1eada5fbfc992070` adds
`parseSupplierId` and retains IDs supplied only by the picker or stored vehicle.
It recovers the typed ID only when the form string matches that retained ID;
a mismatch refuses submission. There are no supplier-ID casts in these four
calls. Table and tenant validation remain server responsibilities. A concrete
inspection payload type also preserves ID proof across the payload spread.
`VehicleDialog.tsx` changed by **+29 -5** in #726. The PR also extends the
existing `VehicleDialog.buyout.test.tsx` with supplier-provenance cases.

Compared with `1e6b7e9b`, the baseline diff removes **93** records and re-adds
**11** relocated records, a net reduction of **82**: **1,010 → 928** entries.
These are diff record counts, not 93 retired findings: relocation accounts for
the eleven re-additions. This follow-up changes only the mismatch toast to
`SupplierSelectionStale`: “Select the supplier again, then save.” /
“اختر المورد مرة أخرى ثم احفظ.” Both mismatch assertions now expect that key.
The bilingual source is `lib/i18n/domains/vehicles.ts`; it generates both EN
and AR dictionaries. The eleven remaining VehicleDialog entries were refreshed
with `renewBaselineReviewed.mjs --blob-evidence` after reviewing the one-line
toast diff. Their identities, fingerprints, causes, multiplicity and expiry
(2026-12-01) are unchanged. No call-site relocation was needed in this follow-up.

Count commands (PowerShell; rerun at the landing commit):

```powershell
(Get-Content scripts/contractSkew/needs-evidence-baseline.json -Raw | ConvertFrom-Json).entries.Count
# 928
$lines = git diff --unified=0 1e6b7e9b..HEAD -- scripts/contractSkew/needs-evidence-baseline.json
($lines | Select-String '^-      "callSiteId":').Count
# 93
($lines | Select-String '^\+      "callSiteId":').Count
# 11
git diff 1e6b7e9b..d17b8e0d --numstat -- components/vehicles/VehicleDialog.tsx
# 29  5  components/vehicles/VehicleDialog.tsx
```

The native diagnostic is separate proof of these six calls against three
modules only. The production workflow supplies no `--current` spec, so its CI
deploy-fixes-it line may still report these calls unproven. Neither that
workflow gap nor full release certification is closed by this PR.

## Reproduction and verification

The 1,010-entry outputs in this section are historical first-commit results,
not final-head counts. Final follow-up checks are recorded below.

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

Follow-up verification:

```text
pnpm exec vitest run components/vehicles/VehicleDialog lib/i18n/keyCoverage.test.ts --maxWorkers=1
3 files passed; 24 tests passed; exit 0
# Before the toast fix: buyout suite 2 failed / 10 passed, both mismatch keys.
node scripts/contractSkew/checkBaselineIdentity.mjs
928 baseline entries matched; exit 0; backend finding identity not checked
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 56e4f8586c978ccf2c570be83f3a23c269b9fdac
928 renewed entries checked; 0 unrenewed, 0 stale, 0 malformed, 0 missing; exit 0
pnpm exec eslint components/vehicles/VehicleDialog.tsx components/vehicles/VehicleDialog.buyout.test.tsx lib/i18n/domains/vehicles.ts
0 errors, 83 warnings; exit 0
pnpm typecheck
tsc --noEmit; exit 0 (root project excludes convex/)
git diff --check
exit 0
```

The existing buyout tests now assert the stale-selection message for both
supplier mismatch paths. No production mutation, deployment, screen audit,
explorer swarm or full application suite was run for this follow-up. Component
tests do not prove desktop/mobile layout or Arabic RTL rendering.

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
disposable checkout at the final PR head. Download the CI artifact into
`<os.tmpdir()>/scrum866-artifacts40990172031` first, then run
`pnpm exec vitest run scripts/contractSkew/scrum866Diagnostic.test.ts --maxWorkers=1`.
It writes its scoped comparison and rendered argument spec to the temp directory.
Expected output fields: `callCount: 6`, `current.breaking: []`,
`classification.callOutcomes: { fixed: 6, stillFails: 0, unproven: 0 }`.
The assertions establish six calls, zero current breaks and six fixed outcomes. Remove the temporary test afterward.

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
  const relocated = { '442:17': '464:17', '453:17': '475:17', '467:31': '489:31', '480:17': '502:17' };
  for (const finding of sourceReport.breaking) {
    if (finding.file !== 'components/vehicles/VehicleDialog.tsx') continue;
    for (const [before, after] of Object.entries(relocated)) {
      finding.siteId = finding.siteId.replace(':' + before, ':' + after);
    }
  }
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
  const diagnostic = { source: "PR725 follow-up native exportArgs; three modules only; six-call comparison only", callCount: calls.length, current, classification };
  fs.writeFileSync(path.join(os.tmpdir(), "scrum866-six-current.json"), JSON.stringify(diagnostic, null, 2));
  fs.writeFileSync(path.join(os.tmpdir(), "scrum866-three-modules-current.json"), JSON.stringify({ functions }, null, 2));
  console.log(JSON.stringify({ calls: calls.length, breaking: current.breaking, outcomes: classification.callOutcomes, uncertain: classification.uncertain }));
  expect(calls).toHaveLength(6);
  expect(current.breaking).toEqual([]);
  expect(classification.callOutcomes).toEqual({ fixed: 6, stillFails: 0, unproven: 0 });
}, 60_000);
```

Toast wording follows [W3C error identification guidance](https://www.w3.org/WAI/WCAG22/Understanding/error-identification): describe the problem and give a corrective action.

## CI current-spec renderer follow-up, 2026-10-30

Run [41005869681](https://github.com/aalzriqat/Auto/actions/runs/41005869681)
at `43feaa4fe97018182a033c209f16a4a67cfa664a` still classified six calls as
unproven because the workflow supplied no current spec. The follow-up renders
the checked-out commit's callable argument metadata before the credential-bearing
comparison and supplies the existing `--current` option.

`renderCurrentSpec.mjs` discovers source modules using Convex 1.42.1's
`src/bundler/index.ts` entry-point rules. It bundles their namespaces, including
nested modules and re-exports, with the installed Convex dependency's esbuild.
Workspace TypeScript packages are bundled; installed runtime packages remain
external. It reads each registered Query, Mutation and Action's native
`exportArgs()` without invoking handlers. HTTP request bodies remain outside
this control's existing scope. There is no selected function/module list and
no generated API declaration is used as the discovery authority.

The [official function-spec CLI](https://docs.convex.dev/cli/reference/function-spec)
reads deployment metadata, so it would require deploying a preview to inspect
unreleased code. Native serialization avoids that deployment and preview I/O.
The [official validation documentation](https://docs.convex.dev/functions/validation)
describes validator JSON exports. Installed `registration_impl.ts` confirms
`exportArgs()` serializes `asObjectValidator(args).json`; this hook is private,
not a documented public API. Directly importing the published private bundler
fails because its CLI-only dependencies are bundled. Discovery therefore mirrors
the inspected rules and refuses SDK versions other than 1.42.1 pending review.
The [esbuild API](https://esbuild.github.io/api/#packages) documents bundling,
external packages and resolution plugins used here.

Import, serialization, version or structural validation failures publish no
spec and remove stale output. The workflow bounds rendering to 180 seconds and
deletes output on failure or timeout. If any resolved called function is absent
from a supplied current spec, the CLI discards all current evidence and prints
`Current spec unavailable`. It cannot use a partial render to claim a call FIXED.
The classifier, exit-code constants and ALSO PRESENT logic are unchanged. A
current spec refusing the identical argument remains a STANDING_DEFECT; the
existing `stillFails` outcome covers a skew call refused elsewhere by current.

Local proof uses unchanged client/backend sources from `43feaa4f`. The complete
render contains 1,032 callable exports and succeeds on Node 26.4.0 and CI's
Node 22.21.1. The production-fetch CLI exits 7 and prints:

```text
PRODUCTION SKEW — 11 proven, 0 unclassified. Deploy the Convex backend at this commit.
Basis: the same client calls compared against the supplied current spec (0 break(s) there)
callOutcomes: { fixed: 6, stillFails: 0, unproven: 0 }
```

There is no ALSO PRESENT cause, and all 928 baseline entries match without drift.
The downloaded artifact from run 41005869681 contains **only its report**, not
the deployed spec. This is therefore a fresh identity-checked production metadata
read using workstation account auth, plus an assertion that all 11 finding
identities match the saved report, not a replay of an archived deployed spec.
The identity comparison includes function, call site, path, dimension, severity
and detail. No production handler or mutation was invoked.

The node regression suite includes a partial-render control: removing the
called-function guard makes its CLI test fail with `fixed: 1, unproven: 0`;
restoring it yields `fixed: 0, unproven: 1`. Native discovery tests cover nested
exports, aliases, all callable kinds, shared validators, excluded files and
import-failure cleanup.

Follow-up validation:

```text
node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
17 passed, 0 failed, 0 skipped
pnpm exec vitest run scripts/contractSkew/<each test file> --maxWorkers=1
26 files passed; 1,279 tests passed, 1 existing skip, 0 failures
pnpm exec vitest run scripts/intelligence/convexCredentialBoundary.test.ts --maxWorkers=1
15 passed, 0 failures
pnpm typecheck:contract-skew
exit 0; dedicated detector checkJs project
pnpm typecheck
exit 0; root TypeScript project excludes convex/
```

The first whole-suite invocation hit the known CRLF-shebang import failure,
then lost its worker and stalled. After stopping that invocation and locally
normalizing the three shebang files to LF, each of the 26 files ran separately
with one worker. Normalization changes no committed blob. The native renderer's
Node 22.21.1 and Node 26.4.0 outputs have identical SHA-256 hashes. ESLint passes
on the new renderer sources; an initial reserved `module` variable error was
fixed by renaming the local variable to `namespace`. No backend deploy,
production mutation, screen audit or explorer swarm was run.
