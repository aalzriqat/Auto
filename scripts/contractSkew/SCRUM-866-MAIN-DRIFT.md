# SCRUM-866: main evidence drift at 56e4f858

**Current remediation, 2026-10-30:** each entry loads in a fresh, explicitly
capped child process. Every load-time env read refuses that entry. Native
function constructors are guarded. Global completeness remains. The final
section supersedes historical shared-realm and finite-env-sampling descriptions.

The original baseline PR cleared 12 differences and incorporated #726.
The final baseline contains **928 entries**. A native comparison proves the six
reported calls fixed against three current modules; it is not a full current
spec or release authorization. The PR now adds current-spec rendering to CI;
the earlier results below remain historical evidence for their named revisions.

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

Count commands (PowerShell; rerun at the landing commit). Note (SCRUM-873): the baseline was one file,
`scripts/contractSkew/needs-evidence-baseline.json`, when these counts were taken. It is now a directory of
shards, `scripts/contractSkew/needs-evidence-baseline/`, one per client file. The commands below
still work against any revision up to 446368ae0 (the last one that held the single file) if `HEAD` is replaced by that
revision; at later revisions load the shards with `loadShardedBaseline` in `baselineShards.mjs`.

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
and detail. No application handler or production mutation was invoked.

The node regression suite includes a partial-render control: removing the
called-function guard makes its CLI test fail with `fixed: 1, unproven: 0`;
restoring it yields `fixed: 0, unproven: 1`. Native discovery tests cover nested
exports, aliases, all callable kinds, shared validators, excluded files and
import-failure cleanup.

Follow-up validation:

```text
node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
18 passed, 0 failed, 0 skipped
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

The read-only Claude review's configuration concern was resolved by removing
the root `tsconfig` override, letting esbuild select each source file's config.
All 1,032 rendered entries remain byte-identical. The final node run also adds
a complete-current CLI control and an unsupported-SDK-version refusal check.
The 26-file Vitest result above predates this renderer-only follow-up; the final
18-test node suite, detector typecheck and new-source lint were rerun afterward.

Its proposed credential-ordering violation was rejected after checking the
actual rule: `convexCredentialBoundary.test.ts` orders credentials before
**candidate-controlled** execution. This workflow has no PR trigger and evaluates
trusted main, as this task requires. A live GitHub read confirmed the
`contract-skew-prod-read` environment's custom branch policy admits only the
`main` branch. Separate steps share a runner and are not a sandbox; the design
does not claim isolation from compromised trusted-main code or dependencies.
No formal review-seat certificate is claimed.

## PR #727 Sonar remediation, 2026-10-30

The native renderer now separates namespace-source generation, registered-export
metadata and module discovery into named functions. Templates are no longer
nested, and path separator replacement uses `replaceAll` with a string. The
explicit sort comparator preserves the original UTF-16 string ordering instead
of depending on the host locale. All 1,032 exports remain byte-identical to the
pre-refactor render (SHA-256
`844db08d79c7ed7435b428782d3ec2bc82ac00e8cc8189b3087de01becd2e404`).

The CLI reuses `baselineFile.mjs`'s `resolveInside` helper for its output,
parent directory and temporary path. It rejects lexical and real-path escapes
before filesystem mutation. The parent check covers a missing output beneath
a directory junction. Safe stale files are removed, and temporary creation uses
`wx` so a dangling file symlink or competing entry cannot redirect the write.
Failure returns non-success and the comparison continues without current
evidence. Neither Sonar configuration nor a workflow changed in this follow-up.

`renderCurrentSpec.test.ts` adds real SDK/filesystem Vitest coverage alongside
the retained Node tests: complete metadata, callable kinds and aliases, sort
order and discovery exclusions, failed imports/registration/validators, SDK
refusal, partial-current rejection, missing-current UNPROVEN, output traversal,
junctions, stale cleanup and exclusive temporary creation. The path regression
failed before the fix (expected exit 1, received 0). The temporary-file race
regression also failed before exclusive creation (expected 1, received 0).

Final local results:

```text
pnpm exec vitest run scripts/contractSkew/renderCurrentSpec.test.ts --maxWorkers=1 --coverage --coverage.include=scripts/contractSkew/currentSpec.mjs --coverage.include=scripts/contractSkew/renderCurrentSpec.mjs --coverage.reportsDirectory=node_modules/.cache/scrum866-sonar-coverage
20 passed, 0 failed, 0 skipped
Lines 86/88 (97.72%); statements 98/102 (96.07%)
Branches 55/58 (94.82%); functions 17/18 (94.44%)
currentSpec.mjs: lines 61/62 (98.38%)
renderCurrentSpec.mjs: lines 25/26 (96.15%)

pnpm exec vitest run scripts/contractSkew/<each test file> --maxWorkers=1
27 files passed; 1299 tests passed, 1 existing skip, 0 failed
node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
18 passed, 0 failed, 0 skipped
pnpm exec vitest run scripts/intelligence/convexCredentialBoundary.test.ts --maxWorkers=1
15 passed; workflow unchanged, no fingerprint re-pin
pnpm typecheck:contract-skew
exit 0; dedicated detector checkJs project
pnpm typecheck
exit 0; root project excludes convex/
pnpm exec eslint scripts/contractSkew/currentSpec.mjs scripts/contractSkew/renderCurrentSpec.mjs scripts/contractSkew/renderCurrentSpec.test.ts
exit 0, no warnings
git diff --check
exit 0
```

The unchanged client/backend sources are still those at `43feaa4f`. A fresh
workstation-account production metadata read, with expected deployment identity
`clever-mockingbird-719`, returns exit 7: 11 proven breaks, 0 unclassified,
`{ fixed: 6, stillFails: 0, unproven: 0 }`, no other cause and zero baseline
drift. All 11 finding records equal the previously saved live report. A separate
saved-spec replay agrees. No handlers, production mutations or deploy ran.

Advisory Standards and Spec inspections closed their findings: imported values
use `unknown` with narrowing, and temporary files use exclusive creation. These
are advisory inspections, not certification seats. Local cached SonarJS rules
reproduce both S3776 findings, S4624 and S7781 before the fix and report zero
after. The typed local S2871 adapter failed internally, so it provides no verdict;
the explicit comparator, deterministic-order test and full-output equality are
the local evidence for sorting. The cloud quality gate must run on the pushed
head; local coverage is scoped to the two renderer files, not a cloud gate claim.
Windows file-symlink creation is unavailable (`EPERM`); directory-junction and
exclusive-creation controls ran. The full Vitest run used per-file processes
and local LF normalization of two unchanged shebang files, preserving their git
blobs and restoring their checkout line endings afterward.

Design sources: Sonar's [S3776](https://rules.sonarsource.com/javascript/RSPEC-3776/),
[S4624](https://rules.sonarsource.com/javascript/RSPEC-4624/),
[S7781](https://rules.sonarsource.com/javascript/RSPEC-7781/) and
[S2871](https://rules.sonarsource.com/javascript/RSPEC-2871/) documentation was
read from the cached official JavaScript plugin's rule HTML because the public
rule site was unavailable. The [S8707 rule metadata](https://sonarcloud.io/api/rules/show?organization=aalzriqat&key=jssecurity%3AS8707)
was reachable, but its full description was unavailable. Its requested
resolve/relative pattern is the existing confinement helper's documented
contract. Node documents [path.resolve and path.relative](https://nodejs.org/api/path.html#pathrelativefrom-to)
and [exclusive file flags](https://nodejs.org/api/fs.html#file-system-flags).

## Seat 2 deployment-equivalence remediation, 2026-10-30

Finding ACCEPTED; proposed fix ADOPTED and extended to runtime-dependent globals.
The original renderer could falsely report FIXED for the NODE_ENV example. The
new regressions initially produced 7 failures and 20 passes, including that
example, package-export resolution and both patched-SDK configuration sources.

The renderer now calls the installed Convex 1.42.1
`dist/cjs/bundler/debugBundle.js` `innerEsbuild` entry point, rather than copying
its esbuild options. Source authority inspected in the installed package:

- `src/bundler/debugBundle.ts:16-97`: ESM, target esnext, browser/node platform,
  convex/module conditions, splitting, production NODE_ENV define, tree shaking,
  minification, automatic JSX and the isolate async-hooks shim.
- `src/bundler/index.ts:95-107` and `src/cli/lib/components/definition/bundle.ts:674-723`:
  isolate/node groups, native server-only/WASM plugins, node chunk directory and
  default empty extra conditions. The external-package plugin is a resolution
  no-op with an empty allowlist; a configured nonempty allowlist or custom
  functions directory refuses the render instead of approximating that path.
- `src/server/impl/registration_impl.ts:172-181` and the registration builders:
  exportArgs reads the args definition and serializes the SDK validator. It does
  not invoke the handler; handlers are separately captured on registration.

Every entry is evaluated from the emitted ESM bytes using `vm.SourceTextModule`
and a linker that can only load emitted chunks. Each entry/pass has fresh module
state and a fresh context. No host package or Node builtin is loaded by the
evaluator. Node's `--experimental-vm-modules` flag is required; without it the
renderer refuses. The workflow's only execution change is adding that flag to
the existing credential-free, timeout-bounded main render step. The credential
test first failed its fingerprint, then the pin was updated with that exact
justification. Vitest's documented `execArgv` enables the same flag in test
workers. No Sonar threshold, coverage exclusion or credential grant changed.

Evaluation receives a process.env Proxy that refuses reads, enumeration,
membership, descriptors and writes. A second native bundle probes accesses
before Convex's production NODE_ENV constant folding: source property accesses
through process become globalThis.process accesses, which the production define
does not erase. Only the unchanged production bundle supplies metadata, and both
passes must succeed. Denials are latched, so a caught read still invalidates the
entry. Handler-only environment reads remain eligible because handlers never run.

Date construction/reads, including timezone-dependent Date.parse, randomness,
crypto, performance, locale inputs, import.meta and dynamic imports refuse
evaluation. Unknown globals, including `typeof File`/`Buffer`, also latch a
refusal instead of silently changing a branch. Language intrinsics stay in the
same realm; instanceof has a regression control. The advisory review exposed
these additional refusal cases. Its four missing-global/clock/ESM finding classes
were rechecked against the final mechanism and closed, without claiming a seat.
This is conservative evaluation of trusted main, not a security sandbox or a
Convex-runtime certification. Unsupported runtime features supply no evidence.

The official sources checked were [Convex bundling](https://docs.convex.dev/functions/bundling),
[validation](https://docs.convex.dev/functions/validation),
[runtimes](https://docs.convex.dev/functions/runtimes),
[Node VM](https://nodejs.org/api/vm.html) and
[Vitest execArgv](https://vitest.dev/config/execargv). Bundling and evaluation are
different evidence boundaries; no deployment runtime was executed here.

### Final repository proof

Client/backend sources still equal `43feaa4f`: `git diff --name-only 43feaa4f --
convex app components packages lib apps/mobile` is empty. The final native ESM
render retains **39 registered exports** and refuses **179 modules**. Compared
with the previous 1,032-export render, **993 exports have no current evidence**.
The first refusal is Zod's unknown global for 174 modules, unknown require for
4 modules, and an external import for 1 module. The complete module/reason list
is retained as `unavailableModules` in the rendered JSON.

All three target modules, `vehicles.ts`, `vehicleEdits.ts` and
`financingEconomics.ts`, refuse through the dependency's load-time read of
`globalThis.__zod_globalConfig` in installed `zod/v4/core/core.js:135-136`.
`convex/utils/env.ts:2` imports Zod. The recorded first refusal is a global-state
read, not a process.env read at a target module line. No exception was added for
Zod and no backend/dependency source was changed to obtain a green proof.

The existing completeness guard is unchanged. It finds 643 called functions
missing and discards all current evidence. Both the saved-spec replay and a
fresh identity-checked production metadata read through `--allow-workstation`
exit **7**, with **11 unclassified findings**, **0 proven current fixes**, and:

```text
callOutcomes: { fixed: 0, stillFails: 0, unproven: 6 }
```

All eleven finding identities equal the saved original report. All 928 baseline
entries match, with zero drift and no additional cause. The existing wording
says deploying is a likely remedy but explicitly says the six calls are not
proven fixed. This change does not authorize deployment. A first live attempt
without the explicit workstation option exited 3, UNAVAILABLE; adding the
documented workstation option allowed the read. No handler or mutation ran.

### Validation outputs

- 27 contract-skew Vitest files ran individually with `--maxWorkers=1`:
  1,324 passed, 1 existing skip, zero failures. This sweep had 45 renderer tests.
  The final renderer suite adds six descriptor/enumeration controls and two
  native runtime-selection refusals: 53/53 pass.
- Final renderer plus credential-boundary coverage run: **68/68 pass**;
  source lines **190/193 = 98.44%**, branches 94.26%, functions 93.87%.
  Added executable renderer lines versus a4952c4e: **126/127 = 99.21%** from
  zero-context diff hunks intersected with LCOV DA records. This is local added-line
  evidence, not a cloud Sonar verdict.
- `node --experimental-vm-modules --test --test-concurrency=1
  scripts/contractSkew/*.test.mjs`: **20 passed, zero failed/skipped**.
- Credential boundary: **15/15 pass**; only the justified render-flag pin changed.
- `pnpm typecheck:contract-skew`: exit 0, detector checkJs project.
  `pnpm typecheck`: exit 0, root project excluding convex/.
- Changed-file ESLint: exit 0. Repository `pnpm lint`: exit 0, zero errors and
  4,350 existing warnings. No lint configuration changed.

The initial author-tools run reproduced the known Windows CRLF-shebang import
failure with zero tests. The 27-file sweep used temporary LF normalization of
the two unchanged shebang files; their original bytes were restored afterward.
The final Node suite needs the VM flag; child renderer invocations explicitly
carry it. All commands were bounded; test workers were limited to one.

Local runtime is Node 26.4.0. The workflow's Node 22.21.1 execution, new-head cloud
Sonar/CI, formal /simplify and independent certification seats remain unverified
in this implementer session. No screen audit, explorer swarm, merge, backend
deployment or production data mutation is claimed. The original six-FIXED proof
must not be carried forward as certification of this renderer.

## Recorded environments and differential evaluation, 2026-10-30

### Source finding and bounded design

Installed Zod **4.6.6** does not cause the first refusal through an environment
variable. Its emitted `v4/core/core.js:135–136` reads
`globalThis.__zod_globalConfig`, initializes it when absent and exports the
shared configuration object. It controls parsing configuration, including the
JIT switch (`v4/core/schemas.js:1194`, `util.js:220`), memoization and error
customization. `v4/core/registries.js:50–51` similarly initializes
`globalThis.__zod_globalRegistry`, the shared schema metadata registry.
These are global object properties, not `process.env` keys.

The source therefore requires one adjustment to the proposed design: each
evaluation explicitly starts those two properties absent, in the fresh VM
realm, and permits their initialization. An additional world starts the config
as an empty object. App references to either property refuse statically.
Other unknown globals and the existing clock, randomness, locale, dynamic
import, import-meta and external-module refusals remain in place. This is no
claim about preexisting configuration in a long-lived deployment runtime.

The environment Proxy records string keys read through property access,
membership and descriptors, and counts enumeration. It receives no workstation
environment values. Environment or process mutations, including caught writes,
refuse the entry. Symbol keys are unsupported and refuse. Errors still discard
evidence, including errors that occur only in a differential world.

The TypeScript compiler API inspects app inputs before tree shaking and
constant folding. A top-level process reference, environment read in a
registration object, or unsupported global-object capture refuses evidence
from that entry. Function bodies are deferred. The native esbuild metafile
traces each entry's repository-local import closure, including symlinked
workspace packages. Each platform retains its own graph, so a Node conditional
export cannot overwrite the isolate's dependencies. `node_modules` libraries
use differential evaluation instead. Unsupported global captures and process
references can conservatively refuse app code even when its args are stable.

The probe bundle preserves environment reads through Convex's production
`NODE_ENV` define. For each entry, a fresh empty world records keys. All recorded
keys are then grouped and receive each of `production`, `development`, `test`,
`true`, `false`, `1`, `0`, the empty string and one random UUID string. Another
world enumerates those keys with undefined values. Enumeration with no recorded
keys also gets one synthetic key, so `Object.keys(process.env).length` is not
silently certified from two empty enumerations. A newly reached key in a later
world refuses the module, rather than leaving that key untested. More than
32 keys also refuses. The maximum is **13 evaluations per entry**, including
the fresh-config control and the unchanged deployment bundle. An entry without
environment observations needs three evaluations. The unchanged production
bundle alone supplies published metadata.

Full registration records, including native `exportArgs()` JSON and export
presence, are compared. A changed function loses its evidence while an unchanged
sibling can remain eligible. Native Convex bundling, the SDK version pin,
patched-SDK refusal, credential boundary and partial-current completeness check
are unchanged.

Design sources: the [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
documents AST traversal, and [esbuild metafiles](https://esbuild.github.io/api/#metafile)
identify resolved input dependencies. The [Convex bundling documentation](https://docs.convex.dev/functions/bundling)
and installed Convex 1.42.1 `src/bundler/debugBundle.ts:16–97` establish the native
options and production define. [Zod 4.6.6 core source](https://github.com/colinhacks/zod/blob/v4.6.6/packages/zod/src/v4/core/core.ts)
and the installed emitted files above establish its global initialization.
[Node VM documentation](https://nodejs.org/api/vm.html) defines fresh contexts,
ESM linking and evaluation timeouts; VM evaluation is not a security sandbox.

### Repository proof and exact refusals

The client and backend source trees still equal `43feaa4f`:
`git diff --name-only 43feaa4f -- convex app components packages lib apps/mobile`
is empty. Across **329 discovered modules**, the render reports:

| Measurement | Result |
| --- | ---: |
| Modules refused statically | 0 |
| Functions refused by differential comparison | 0 |
| Total VM evaluations | 629 |
| Retained registered exports | 39 |
| Modules refused by unchanged runtime guards | 179 |
| Of those: `unavailable global navigator` | 174 |
| Of those: `unavailable global require` | 4 |
| Of those: `external module` | 1 |

The local render took approximately **10 seconds**, including native bundle
construction. It uses up to four native esbuild builds (deployment and probe
for each of two runtime groups). No backend I/O or handler invocation occurs
in rendering. These are measured local counts, not a CI or deployment-runtime
performance claim. Module diagnostics retain the recorded keys, enumeration
counts, evaluations and function-specific differential refusals.

The next real refusal is `zod/v4/core/util.js:224`:
`typeof navigator !== "undefined"` followed by the Cloudflare user-agent check.
This is Zod's `allowsEval` JIT capability check, reached while constructing
schemas. The global guard latches that access even when `typeof` masks the
thrown exception. It was retained rather than granting an unproven runtime
global. All six calls consequently remain unproven:

| Call | Exact module refusal |
| --- | --- |
| `financingEconomics:supplierConcessionBasis` | `financingEconomics.ts`: unavailable global `navigator`, Zod `util.js:224` |
| `financingEconomics:resolveAppraisalGap` | `financingEconomics.ts`: same refusal |
| `vehicles:update` | `vehicles.ts`: same refusal |
| `vehicleEdits:requestUpdate` | `vehicleEdits.ts`: same refusal |
| `vehicles:create` | `vehicles.ts`: same refusal |
| `vehicleEdits:requestCreate` | `vehicleEdits.ts`: same refusal |

The completeness check finds **643 called functions absent** and discards the
entire partial spec. Both the saved deployed-spec replay and a fresh,
identity-checked workstation-account production metadata read exit **7**, with
11 unclassified findings and `{ fixed: 0, stillFails: 0, unproven: 6 }`.
The eleven finding identities equal the original saved report across function,
call site, path, dimension, severity and detail. All **928 baseline entries**
match; drift, coverage gaps and additional causes are empty. No release pass,
deployment, production mutation or independent seat certification is claimed.

Reproduction uses the existing saved proof files in `node_modules/.cache/scrum866-proof`:

```powershell
node --experimental-vm-modules scripts/contractSkew/renderCurrentSpec.mjs node_modules/.cache/scrum866-proof/current-differential.json
node scripts/contractSkew/cli.mjs --mode production --spec node_modules/.cache/scrum866-proof/deployed.json --current node_modules/.cache/scrum866-proof/current-differential.json --json node_modules/.cache/scrum866-proof/report-differential.json --deployed-sha 6c71a7654bc8fc11b37b4b57ac52dbb71ecae592
# expected comparison exit: 7, six UNPROVEN
```

### Residual risk

Differential sampling is finite evidence, not a proof for every environment.
A library that branches on an exact secret value outside the sample set can
evade it. Grouping keys also misses mixed-value conditions such as
`A === "production" && B === "development"`, even though both values occur
individually in the sample set. Dynamic keys reached in tested worlds refuse;
keys hidden behind an untested value remain outside the observation. The static
audit is conservative syntax analysis, not whole-program alias or call-flow
verification. Fresh Zod configuration and module initialization do not establish
long-lived runtime state, concurrency or deployment equivalence. These limits
must accompany any later use of this metadata as evidence.

### Validation of this follow-up

```text
pnpm exec vitest run scripts/contractSkew/<each test file> --maxWorkers=1
27 files passed; 1,358 tests passed, zero failed, 1 existing skipped

pnpm exec vitest run scripts/contractSkew/renderCurrentSpec.test.ts scripts/intelligence/convexCredentialBoundary.test.ts --maxWorkers=1 --coverage --coverage.include=scripts/contractSkew/currentSpec.mjs --coverage.include=scripts/contractSkew/renderCurrentSpec.mjs --coverage.include=scripts/contractSkew/metadataBundle.mjs --coverage.reportsDirectory=node_modules/.cache/scrum866-differential-coverage
94 passed (79 renderer, 15 credential boundary), zero failures/skips
Source lines 271/277 = 97.83%; functions 65/73 = 89.04%
Added executable source lines versus 7f3c9d9c: 95/96 = 98.96%

node --experimental-vm-modules --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
22 passed, zero failed/skipped

pnpm typecheck:contract-skew
exit 0; dedicated detector checkJs project, including .mjs
pnpm typecheck
exit 0; root project excludes convex/
pnpm lint
exit 0; zero errors, 4,350 existing warnings
pnpm exec eslint scripts/contractSkew/currentSpec.mjs scripts/contractSkew/metadataBundle.mjs scripts/contractSkew/currentSpec.test.mjs scripts/contractSkew/renderCurrentSpec.test.ts
exit 0; zero warnings
git diff --check
exit 0
```

Added-line coverage intersects zero-context diff hunks against LCOV DA records
for the two changed renderer source files. It is local measured coverage, not
a new-head Sonar verdict. The first coverage attempt passed 75 tests but failed
the unchanged 85% function threshold (84.84%); additional mutation, key-budget
and newly reached-key controls exercise the previously untested safety paths.
The final coverage command exits zero with every configured threshold met.

The initial seven added controls failed against the previous implementation.
The platform-specific graph regression also failed before its fix. Five
process/environment mutation controls failed before mutation traps were added.
Node end-to-end controls now prove the fixture-library conditional is UNPROVEN
and the library with an irrelevant environment read is FIXED. The existing
normal-case and conditional-export controls remain green.

The 27-file sweep uses separate one-worker processes and temporarily normalizes
three unchanged Windows shebang files to LF, then restores their exact original
bytes in a finally block. None is in this change. Advisory read-only inspection
identified the per-platform graph, captured-global alias and process-mutation
gaps. Their fixes were inspected for closure; this is not a reviewer seat or a
formal simplify run. New-head cloud CI/Sonar and independent certification are
pending. Product code, credential policy and workflow files are unchanged in
this follow-up. The pilot, screen audit and explorer swarm were not certified.

## Runtime capability follow-up at 92c6d0d3 (2026-10-30)

The evaluator now records `navigator`, `navigator.userAgent`, `Function`,
`eval`, and Zod global-configuration reads. It compares native `exportArgs()`
records in fresh realms with `navigator` absent, a `Cloudflare-Workers` user
agent, a `Mozilla/5.0` user agent, and an `EvalError` from `new Function` (and
`eval`). An unchanged registration retains evidence; a changed registration
loses it. A throwing module evaluation still stops publication of a partial
render. The existing process/environment static audit, native Convex bundler,
SDK pin and patch refusal, and global completeness check were not relaxed.

[Convex's runtime documentation](https://docs.convex.dev/functions/runtimes)
describes the default V8 runtime and its supported web APIs, but does not
explicitly specify `navigator` or string code generation. The installed
Convex 1.42.1 SDK source (`node_modules/convex/src/bundler/debugBundle.ts`)
defines the native bundle construction but does not contain the hosted V8
runtime. The [open-source runtime setup](https://github.com/get-convex/convex-backend/blob/main/npm-packages/udf-runtime/src/setup.ts)
and [miscellaneous globals setup](https://github.com/get-convex/convex-backend/blob/main/npm-packages/udf-runtime/src/00_misc.ts)
do not install `navigator` or remove the V8 `Function` intrinsic. Those backend
links are current main, not a pinned hosted-runtime revision; the exact
production global set remains unverified. Both absent-navigator Function
outcomes are sampled, so the evidence comparison does not depend on choosing
one code-generation policy. The Node [VM documentation](https://nodejs.org/api/vm.html)
defines the local context's code-generation setting; that setting is not a
claim about Convex production.

The full render required `--max-old-space-size=6144`: the first run at Node's
4 GB default crashed after repeated contexts. With the bounded worlds it
completed **1,944 VM evaluations**, retained **1,008 registered exports** and
left **6 modules unavailable**:

| Module | Exact refusal |
| --- | --- |
| `changelog.ts` | `clock` |
| `collectionReminderActions.ts`, `pushSend.ts`, `socialPosting.ts`, `whatsappSend.ts` | `unavailable global require` |
| `email.ts` | `external module` |

All six target exports are present in that rendered JSON. The unchanged
completeness check nevertheless reports **6 called functions absent** (among
the remaining unavailable modules) and discards the whole current spec. The
saved deployed-spec replay exits **7** with 11 unclassified breaks, 928 matched
baseline entries, zero drift, and
`{ fixed: 0, stillFails: 0, unproven: 6 }`. This is the `SUPPLIED_FILE`
diagnostic path, not a production-credential read or release authorization. Product
sources remain byte-identical to `43feaa4f` under
`git diff --name-only 43feaa4f -- convex app components packages lib apps/mobile`.
The six target calls are still **UNPROVEN**, so no further refusal or
completeness gate was changed to obtain a FIXED classification.

Regressions established that a library branching args on
`navigator.userAgent` or `new Function` loses function evidence, while probes
unrelated to its args keep evidence; an error in a capability world stops the
render. The new controls failed on the previous throwing navigator guard.
The focused Vitest plus credential-boundary run passed **100/100** with
`--maxWorkers=1`; V8 coverage measured **24/26 = 92.31%** of added executable
source lines against `92c6d0d3`. The Node suite passed **22/22** with
`--test-concurrency=1`. Detector and root TypeScript checks passed; the root
check excludes `convex/`. `pnpm lint` exited 0 with 0 errors and 4,350 existing
warnings. The full contract-skew Vitest sweep passed 26 files and 1,305 tests,
with one existing skip, but exited 1 because `authorToolsCli.test.ts` failed
to import on the documented Windows CRLF shebang issue (zero tests collected
from that file). That failure was not attributed to this change or suppressed.

Residual risks: sampling cannot rule out branches on other user-agent strings,
mixed runtime/environment conditions, or a preinitialized long-lived global.
The local VM is not a hosted Convex runtime certification. The 4 GB crash also
means the default Node heap is insufficient for this full local render; this
follow-up did not change the runner's memory policy. The six unavailable
modules and the whole-spec completeness refusal still block the pilot proof.

## Completeness investigation after d347da9b, 2026-10-30

This section supersedes the preceding capability follow-up's current-result
claims. The implementation started at
`d347da9b7fac440521aa29ecb2e8229b454ef6c7`, on
`claude/scrum866-skew-current-spec` in `C:/tmp/auto-curspec`. No product code,
classifier, exit code, baseline, ALSO PRESENT logic or deployment changed.

### Six-module diagnosis and native Node bundling

| Module | Runtime directive | Exact initial refusal and source |
| --- | --- | --- |
| `convex/changelog.ts` | No `use node`; default runtime | `clock`, from `releaseAt` at line 295 calling `Date.UTC(year, month - 1, day, 12, sequence, 0)` while constructing historical entries. |
| `convex/collectionReminderActions.ts` | `"use node"` | `unavailable global require`, at the native Node shared chunk's esbuild helper `typeof require < "u" ? require : ...`, before library initialization. |
| `convex/pushSend.ts` | `"use node"` | The same `unavailable global require` probe in the native Node shared chunk. |
| `convex/socialPosting.ts` | `"use node"` | The same `unavailable global require` probe in the native Node shared chunk. |
| `convex/whatsappSend.ts` | `"use node"` | The same `unavailable global require` probe in the native Node shared chunk. |
| `convex/email.ts` | `"use node"` | `external module` during linking. Line 6 imports `createHash` from `node:crypto`, which Node bundling preserves as an external builtin import. |

The Node modules were **already bundled for Node**, not the default runtime.
`bundleForMetadata` calls the installed Convex 1.42.1 `innerEsbuild` with
`platform: "node"`, `chunksFolder: "_deps/node"`, native server-only and WASM
plugins, and the SDK's production define, conditions and splitting defaults.
This matches `node_modules/convex/src/cli/lib/components/definition/bundle.ts:700-712`
and `src/bundler/debugBundle.ts:16-97`. The SDK's outer `bundle` also installs
`createExternalPlugin`; inspection of `src/bundler/external.ts:70-110` establishes
that with this project's empty external-package allowlist it returns no resolver
override. Importing that published private outer helper directly fails on its
unshipped CLI dependency `fetch-retry`; the existing native inner path remains.
No replacement bundler, browser rebundling or host package loading was added.

These five Node modules use supported Convex features, but the conservative
metadata evaluator cannot supply their Node capabilities without expanding its
evidence boundary. They retain their refusals. No `require`, builtin import,
environment, clock, locale or randomness denial was removed to load them.
[Convex's runtime documentation](https://docs.convex.dev/functions/runtimes#nodejs-runtime)
defines `use node` and the runtime split. Bundling compatibility and the ability
to evaluate a bundle without host inputs are separate properties.

`Date.UTC` was a renderer false refusal. The
[ECMAScript algorithm](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.utc)
converts supplied numeric arguments to a timestamp without reading the clock
or host timezone. The evaluator now supplies its same-realm native `Date.UTC`.
`Date.now`, `Date.parse`, Date calls and Date construction remain denied.
The failing-first fixture uses `Date.UTC(2020, 0, 1)` as a literal validator and
requires `1577836800000`; it failed with `clock` before the correction. The
existing clock, parsing and constructor refusal controls still pass. The native
module is now evaluated unchanged; its historical dates were not replaced.

### Per-function independence failed; retain the global rule

The requested soundness condition was tested, not assumed. Native esbuild
bundles the runtime's entries together and emits shared chunks. Each entry and
world gets its own VM context, `SourceTextModule` instances and linker cache.
Shared output is stored as immutable source strings. A permanent fixture proves
that a failed entry can mutate a shared validator before refusal without
changing the independently evaluated good entry. The fixture asserts that the
two entries actually import the same emitted chunk. This agrees with
[esbuild's splitting model](https://esbuild.github.io/api/#splitting).

However, `metadataContext` injects host constructors including `TextEncoder`
by reference. Contextification does not clone supplied objects, as described
in the [Node VM documentation](https://nodejs.org/api/vm.html#vmcreatecontextcontextobject-options).
The permanent Node regression demonstrates:

```text
good.ts alone:
  args.label = TextEncoder.__scrum866HostIsolationProbe ? string : number
  renders number
aaBad.ts, evaluated first:
  TextEncoder.__scrum866HostIsolationProbe = true
  Date.now() -> clock refusal; no aaBad metadata
good.ts afterward:
  renders string, identically in every sampled world
```

The fixture cleans the host property in `finally`. An advisory read-only agent
also independently reproduced contamination with an ordinary thrown import
error while the proposed per-module catch was present. This is an ordinary
property write, with no VM escape. Fresh chunks alone do not establish isolation.

Under the owner's explicit instruction, **the global completeness rule remains
unchanged**. The per-function implementation and per-module exception catch were
removed. An unavailable called function discards all current evidence. Unknown
module errors, bundler failure, SDK/patch refusal, invalid metadata and zero
registered functions still refuse publication of the whole spec. CLI diagnostics
now list unavailable module paths and the number of called functions without
current evidence, including zero.

The contamination fixture calls both modules and requires
`{ fixed: 0, stillFails: 0, unproven: 2 }`. Mutation-checking the actual proposed
per-function rule makes it report `{ fixed: 1, stillFails: 0, unproven: 1 }`,
which fails the regression. A second killed mutant substitutes zero for native
`Date.UTC`, and the timestamp fixture rejects it. Mutation source bytes were
restored from saved copies, not git checkout. Import-failure and systemic
bundler-failure fixtures also prove stale-output deletion and two UNPROVEN calls
when the workflow has no current file to supply.

**Residual limitation:** the retained called-function completeness check is
not a general host-isolation fix. A failed **uncalled** helper, or another
successfully evaluated module, could mutate shared host objects while every
called export remains present. The new fixture proves the guard's behavior for
its called failed module, not containment of every possible host mutation.
Per-function certification needs real per-world host-state isolation and its
own reviewed change. The measured FIXED outcomes below do not certify isolation,
the hosted runtime, or pilot readiness. Finite environment/capability sampling,
mixed conditions and long-lived global state remain limitations too.

### Runner memory

The starting workflow did not set `--max-old-space-size`. This change adds
`--max-old-space-size=6144` to the credential-free renderer invocation and updates
the credential-boundary fingerprint for that one-token addition. Triggers,
permissions, credential steps, timeout and cleanup stay unchanged. The
[GitHub public-runner specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)
lists 16 GB RAM for `ubuntu-latest`. A 6144 MiB V8 old-space limit is below that
capacity; it is not a limit on total process RSS. No CI peak-RSS measurement is
claimed. Local execution uses Node 26.4.0; the workflow pins Node 22.21.1.

### Final execution record

Product source identity was rechecked with
`git diff --name-only 43feaa4f -- convex app components packages lib apps/mobile`:
empty. The native render reports **329 discovered modules, 1,949 evaluations,
1,017 registered exports, five unavailable Node modules**, zero static refusals
and zero differential function refusals. The CLI reports **zero called functions
without evidence**. The five remaining modules are the Node rows above.

Reproduction on this worktree:

```powershell
node --max-old-space-size=6144 --experimental-vm-modules scripts/contractSkew/renderCurrentSpec.mjs node_modules/.cache/scrum866-proof/current-global-final.json
# exit 0
node scripts/contractSkew/cli.mjs --mode production --spec node_modules/.cache/scrum866-proof/deployed.json --current node_modules/.cache/scrum866-proof/current-global-final.json --json node_modules/.cache/scrum866-proof/report-global-final.json --deployed-sha 6c71a7654bc8fc11b37b4b57ac52dbb71ecae592
# exit 7
```

This is **SUPPLIED_FILE evidence**, using the saved deployed-spec file, not a
fresh authenticated production read. The existing global completeness check
now passes because the changelog exports render. All six target calls are
FIXED by the detector: `financingEconomics:supplierConcessionBasis`,
`financingEconomics:resolveAppraisalGap`, `vehicles:update`, `vehicles:create`,
`vehicleEdits:requestUpdate`, and `vehicleEdits:requestCreate`.

```text
callOutcomes: { fixed: 6, stillFails: 0, unproven: 0 }
11 proven deployed-spec breaks, 0 unclassified, 0 current-spec breaks
1065 client sites found and resolved, 0 unresolved
928 baseline matches, 0 drift, no ALSO PRESENT cause
```

Validation on the follow-up source:

```text
pnpm exec vitest run scripts/contractSkew/<each test file> --maxWorkers=1
27 files passed; 1367 passed; 1 existing skip; zero failed files

pnpm exec vitest run scripts/contractSkew/renderCurrentSpec.test.ts scripts/intelligence/convexCredentialBoundary.test.ts --maxWorkers=1 --coverage --coverage.include=scripts/contractSkew/currentSpec.mjs --coverage.include=scripts/contractSkew/renderCurrentSpec.mjs --coverage.include=scripts/contractSkew/metadataBundle.mjs --coverage.reportsDirectory=node_modules/.cache/scrum866-global-coverage
103 passed (88 renderer, 15 credential boundary), zero failed/skipped
Source lines 284/292 = 97.26%; functions 67/77 = 87.01%

node --experimental-vm-modules --test --test-concurrency=1 scripts/contractSkew/*.test.mjs
24 passed; zero failed/skipped

pnpm typecheck:contract-skew
exit 0; dedicated detector checkJs project, including .mjs
pnpm typecheck
exit 0; root project excludes convex/
pnpm lint
exit 0; zero errors, 4350 existing warnings
Changed-source/test ESLint: exit 0, zero warnings
git diff --check: exit 0
```

The full sweep temporarily normalized three shebang files to LF for the known
Windows import issue, then restored their exact bytes in `finally`. The two
unchanged author-tool files have no diff. The initial lint run found the newly
introduced reserved local name `module` in two diagnostic loops. Renaming those
locals to `unavailable` made the rerun pass. The credential fingerprint test
first failed after the old-space option changed and passed after the reviewed
one-token workflow change was pinned.

Added instrumentable production lines versus `d347da9b` measure **5/5 = 100%**:
four CLI diagnostic lines and one renderer diagnostic line. Renderer LCOV was
combined with native `NODE_V8_COVERAGE` from the Node fixture's child CLI
processes, converted with installed `v8-to-istanbul` 9.3.0, then intersected with
zero-context diff hunks. The `Date.UTC` trap is code inside a VM source string
and has no source-file LCOV DA record; its behavioral proof is the failing-first
literal assertion and killed wrong-value mutant. It is not included silently
in the instrumentable-line denominator. These are local measurements, not a
cloud Sonar verdict.

One full render during concurrent validation reported a transient module
evaluation failure for `validations/vehicles.ts`; isolated diagnosis succeeded.
After restoring the original unexpected-error boundary, the final full render
completed with only the five Node refusals above. No timeout or error guard was
relaxed. CI runtime, memory and timing still need the workflow's own evidence.

Advisory Standards and Spec passes inspected the fallback and its scope. The
host-contamination finding is VALIDATED; the proposed per-function fix is
REJECTED under the explicit soundness fallback. These passes are not independent
certification seats. Formal simplify, new-head cloud Sonar/CI, screen audit,
explorer swarm, merge, deployment and production verification remain unverified.

## Linux CI follow-up at 846a491b

CI uses Node **22.21.1**, while the earlier Windows checks used Node 26.4.0.
Two independent failures were reproduced without changing the assertions:

- The workflow's `node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs`
  omitted the VM flag. Its direct renderer calls failed with
  `Native ESM metadata evaluation requires --experimental-vm-modules`.
- Under WSL Ubuntu 24.04 with Node 22.21.1 and the flag enabled, the five existing
  library capability cases produced **1 failed / 4 passed**. The failing case was
  `("navigator" in globalThis) ? {} : { label: v.string() }`. A minimal VM probe
  showed that returning the contextified sandbox as `globalThis` bypasses the
  Proxy's `has` trap and returns false even in the navigator-present world.
  Node 26.4.0 returns true in that world, explaining the earlier local pass.
  The same minimal probe on Windows Node 22.21.1 also returns false before the
  fix and reaches `has` afterward, isolating the runtime-version difference.

The VM now exposes a separate Proxy over the same backing object and traps as
`globalThis`. Membership reaches the recording `has` trap on both versions;
same-realm intrinsics, denial latching and global completeness remain intact.
The existing assertion still expects `["capability:read"]` for the unstable
validator. Cleanup warnings also occur in the passing unwritable-output test;
they were not the cause of the capability failure.

Both the CI node-test step and the credential-free Contract skew renderer use
step-local `NODE_OPTIONS` for `--experimental-vm-modules`. The renderer retains
its 6144 MiB old-space limit. Vitest already supplies the flag through
`test.execArgv`. The credential fingerprint first failed **1 / 15**, then was
re-pinned for the reviewed flag relocation. No credential-bearing step changed.

Official references checked for this decision:

- [Node 22.21.1 SourceTextModule](https://nodejs.org/download/release/v22.21.1/docs/api/vm.html#class-vmsourcetextmodule)
  explicitly requires the flag.
- [Node 22.21.1 VM flag](https://nodejs.org/download/release/v22.21.1/docs/api/cli.html#--experimental-vm-modules)
  enables ESM support in `node:vm`.
- [Node contextification](https://nodejs.org/download/release/v22.21.1/docs/api/vm.html#what-does-it-mean-to-contextify-an-object)
  documents the wrapper and its global-object quirks. The precise membership
  difference above is executed evidence, not a guarantee inferred from the docs.

WSL validation uses a disposable copy and minimal pinned test dependencies,
not a full frozen-lockfile installation. All **88 renderer tests pass**, including
all five capability cases. Its node suite passes **24/24**, using exactly the
workflow's `NODE_OPTIONS=--experimental-vm-modules` and single-concurrency command.
Windows Node 26.4.0 also passes that node command **24/24** and the credential
boundary **15/15**. The full one-worker contract-skew Vitest sweep passes all
**27 files, 1,367 tests, one existing skip**. The initial broad Windows batch
encountered the documented CRLF shebang import problem and was stopped. The
file-by-file rerun temporarily normalized the same three shebang files already
listed above and restored their original bytes in `finally`; they have no diff.
The WSL credential-boundary run also passes **15/15**.
Detector checkJs and root typechecks pass; the root excludes
`convex/`. Lint exits zero with 4,350 existing warnings and zero errors.

The follow-up full native render still produces **1,017 exports / 1,949
evaluations**, with the same five unavailable Node modules. The 43feaa4f product
source diff is empty. The saved-spec replay exits 7 with **6 FIXED, zero
still-failing, zero UNPROVEN**, 11 proven breaks, zero evidence drift and zero
coverage-incomplete entries. The saved deployed spec remains SUPPLIED_FILE
evidence. This change does not claim production
runtime parity, independent seat certification, or pilot readiness. New-head
Linux CI is checked after pushing; no merge or deployment is authorized here.


## PR #727 Sonar remediation: native ESM process worlds (2026-10-30)

The implementation based on `9e25dbc6` replaces VM string evaluation with
`execFile(process.execPath, fixedArgs)`, without a shell. Each world loads all
eligible modules through native `import()` of confined temporary file URLs.
Only emitted files can resolve through the synchronous import hook. Each child
has a 1024 MiB old-space cap, 30-second timeout and bounded output. Worlds run
serially to bound aggregate memory. Independent native bundler passes use
`Promise.all`; entry imports remain sequential because their probe records,
denial latch and module cache share the world's state.

The child installs the recording environment proxy and supported runtime probes
before any bundled import. Unsupported globals, navigator descriptors, generated
code results and callable reflection latch refusals, even when caught. Empty
Function/eval capability checks remain supported without executing supplied code.
Supported lazy web globals initialize before Buffer is denied. Direct setup tests
use descriptor copies of the host object; the production caller passes actual
`globalThis`. The host Math object is preserved.

The SDK version pin, native Convex bundler, static app-input refusal, declared SDK
patch refusal and global completeness check remain. Modules still share objects
inside a world. A missing called function discards all current evidence. Process
isolation prevents those objects from contaminating the parent or another world;
this evaluates trusted source and is not a security sandbox.

Removed `--experimental-vm-modules` from the workflows, Node tests and Vitest.
The credential workflow pin changes for that flag removal only; the parent heap,
triggers, grants, checkout, credential steps, timeouts and output paths remain.

Local evidence:

- Node 22.21.1 full contract-skew sweep: 27 files, 1,376 passed, one existing skip.
  Three pre-existing CRLF shebang files were temporarily normalized and restored
  by the bounded file-by-file runner. They have no content diff.
- Combined native metadata/setup coverage run: 111 passed with one worker.
  Direct setup tests subsequently pass 15 cases, with 93.33% line coverage.
- CI-like LCOV measures 328/395 added executable source lines against `43feaa4f`,
  or 83.04%, before the final two setup assertions increased measured coverage.
  This includes unmeasured child-runner lines as zero; it is not a Sonar verdict.
- CI's Node command, `node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs`,
  passes 24/24 on Node 22.21.1. Credential boundary passes 15/15.
- Root `pnpm typecheck` and detector `pnpm typecheck:contract-skew` pass. The root
  project excludes `convex/`; the detector project checks these `.mjs` files.
- Full lint passes with zero errors and 4,350 existing warnings; changed-file lint
  passes. No suppression or Sonar configuration changes are used.
- Local Sonar-equivalent checks reproduce all 14 original issues and report zero
  on the fixed runtime files. The npm SonarJS rules plus the cached official
  analyzer's external rules cover the syntax rules; ESLint `no-await-in-loop`
  checks the S9382 condition. Separate typed copies reproduce S2871 and S4043
  before the fix and zero after. This is scoped local analyzer evidence.
- Actual Node 22 native rendering produces 1,017 exports, five unavailable Node
  modules, zero static refusals and zero differential function refusals. The saved
  43feaa4f proof still reports 6 FIXED, zero still-failing, zero UNPROVEN, 11 proven
  breaks and zero coverage-incomplete entries. It remains SUPPLIED_FILE evidence,
  not a fresh production read. Product source identity against 43feaa4f is intact.

Failing-first checks caught parent TextEncoder contamination and fabricated
Function/eval results. Advisory Standards/Spec review reproduced unsupported
bare-global and navigator-descriptor regressions and verified their corrections.
These are advisory checks, not formal seat certification of the eventual head.
CI and SonarCloud must be checked after pushing. No merge or deploy is performed.

Design references:

- [Node child_process.execFile](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processexecfilefile-args-options-callback): direct executable invocation, timeout and output bounds.
- [Node dynamic import](https://nodejs.org/docs/latest-v22.x/api/esm.html#import-expressions) and [file URLs](https://nodejs.org/docs/latest-v22.x/api/esm.html#file-urls): native ESM loading.
- [Node module.registerHooks](https://nodejs.org/docs/latest-v22.x/api/module.html#moduleregisterhooksoptions): synchronous loader hooks available since Node 22.15.0.
- Sonar [S1523](https://sonarsource.github.io/rspec/#/rspec/S1523/javascript), [S9382](https://sonarsource.github.io/rspec/#/rspec/S9382/javascript), [S3776](https://sonarsource.github.io/rspec/#/rspec/S3776/javascript), [S2871](https://sonarsource.github.io/rspec/#/rspec/S2871/javascript) and [S4043](https://sonarsource.github.io/rspec/#/rspec/S4043/javascript).
  The documentation pages were blocked by robots rules. Live official rule
  metadata was retrieved with the SonarCloud rules API and the local rule
  implementations were executed; unavailable prose is not claimed as checked.


### Cloud analysis follow-up

At `23b2db62c1ed5a65edd24107e13caa15d45bf116`, Tests run
[41047893526](https://github.com/aalzriqat/Auto/actions/runs/41047893526)
passed every job. Its completed Linux type-check log records 24 Node tests passed,
zero failed. Sonar run
[41050580841](https://github.com/aalzriqat/Auto/actions/runs/41050580841)
closed all 14 original findings but refused the gate: S8707 on the child's argv
input path, two S5906 matcher findings, and combined new-code coverage 79.0%.
The cloud measured line coverage 82.92% and branch coverage 73.67%; the combined
metric is a separate condition and was not replaced by the local line metric.

The child now reads only `world.json` from its parent's exclusive cwd. Its argv
cannot choose an input path; the parent passes no variable input argument.
Executed old/new controls prove both directions: an extra path cannot override a
present fixed file, and cannot supply a fallback when the fixed file is missing.
Both controls fail with the old implementation and pass with the correction.
Two permanent regressions exercise the real child process.

Dedicated instance matchers replace the generic assertions. Direct tests use the
actual pinned Convex SDK registrations to verify kind, visibility, validators,
ordinary-export exclusion and refusal of malformed registrations without calling
handlers. This measures native metadata extraction in the existing CI collector,
with no Sonar configuration change. The combined focused coverage run passes
114 tests before the two input-path cases were added; the four scoped native/path
cases then pass. CI-like PR new-line coverage is now 340/395 = 86.08%. The direct
setup suite passes 15 cases with 93.33% line coverage. Both typechecks, full lint
and the exact Node 22 command pass again; the saved proof remains 6 FIXED.
S5906's local implementation also reports zero; S8707's cloud taint engine is
not available locally, so its closure still requires the next cloud analysis.

References: [Node execFile cwd/args](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processexecfilefile-args-options-callback),
[Sonar S8707](https://sonarsource.github.io/rspec/#/rspec/S8707/javascript),
[Sonar S5906](https://sonarsource.github.io/rspec/#/rspec/S5906/typescript).


## PR #727 review remediation at 98689acc (2026-10-30)

### Isolation model and official sources

Convex analyzes one `to_analyze` module in a fresh V8 context. Checked backend
[db914cf0, analyze.rs:283](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/crates/isolate/src/environment/analyze.rs#L283)
calls `get_or_create_fresh_context` before `run_analyze(..., to_analyze)` at line
287. The 1.42.1-era source has the same model at
[50920350, analyze.rs:282](https://github.com/get-convex/convex-backend/blob/50920350f3b85a39bfe518a369f2fd087f3bf4cf/crates/isolate/src/environment/analyze.rs#L282).
This is the latest analyze.rs commit before the npm registry's 1.42.1 publication
(2026-06-29 21:50:08 UTC), an era comparison rather than a claim that the SDK pins
a deployed backend revision. Both source files were fetched and read. Imports of
one entry share its realm; unrelated entries do not. Both old host-contamination
test expectations now match this model. Global completeness remains independent.

The renderer uses four concurrent lanes by default, configurable with
`renderCurrentSpec.mjs <output> --concurrency <1-16>`. Each evaluation uses
`execFile(process.execPath, ["--max-old-space-size=256", fixedHelper])`, an exclusive
temporary cwd, fixed world.json, no shell, a 30-second timeout and 32 MiB output
bound. Guards install before importing exactly one entry. Emitted bytes remain
native and import resolution confined. All lanes settle before cleanup, even on
systemic failure. Children receive no copied host env; an explicit coverage run
may pass only the output-only NODE_V8_COVERAGE path. App code sees guarded process.

A worker implementation was rejected in advisory review: the parent's V8 heap
flag overrides Worker resourceLimits even with empty execArgv and env. The
workflow's 6144 MiB parent setting defeated the worker cap. Child arguments
provide an independent 256 MiB old-space setting; that number is not total RSS.
See [Worker resourceLimits](https://nodejs.org/api/worker_threads.html#new-workerfilename-options),
[execFile options](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processexecfilefile-args-options-callback)
and [Node old-space option](https://nodejs.org/docs/latest-v22.x/api/cli.html#--max-old-space-sizesize-in-mib).

Finite env sampling is removed. Property reads, membership, descriptors,
enumeration, prototype/extensibility inspection and writes latch entry-wide
refusal even when caught. No SDK, Zod or NODE_ENV allowlist exists. Convex permits
[deployment-specific env values](https://docs.convex.dev/production/environment-variables#using-environment-variables-in-dev-and-prod-deployments).
Function, AsyncFunction, GeneratorFunction and AsyncGeneratorFunction prototype
constructors are guarded before import. Calls and Reflect.construct record a
probe and refuse. Global Function/eval stand-ins still support empty capability
checks; non-empty source/generated results refuse. Navigator, empty-code and Zod
worlds remain when their probes are recorded. Clocks/entropy refuse directly and
need no samples.

### Findings and failing-first evidence

| Finding | Before correction | After correction |
| --- | --- | --- |
| REGION=eu outside samples | library export published; missing-evidence assertion fails | env read refuses entry |
| Unrelated TextEncoder mutation | alone number; combined incorrectly string | both number |
| Refused first entry reads FEATURE_FLAG | cached library lets good.js:read publish | each entry independently reads env and refuses |
| Shared args corrupted before Date.now | corrected string expectation fails on old renderer | sibling string remains intact |
| Date.now(); corrupt() | already isolated-correct string; not an independently reproduced defect under Convex's model | retained ordering control |
| Four native constructors, direct and Reflect.construct | eight cases publish caught constructor use | eight refuse and record Function.constructor |
| Env prototype/extensibility reflection (advisory) | two caught reads publish evidence | both refuse |

`renderCurrentSpec.test.ts` first red run: **11 failed, 2 passed**. Separate
TextEncoder red run: **1 failed**, expected number but received string. Env
reflection red run: **2 failed**. These exercise the real native bundler/loader.
The first TextEncoder fixture lacked discovery's required module syntax; it was
corrected before accepting its red evidence. A passing control is not claimed as
a failing reproduction. The tests also preserve benign capability-probe FIXED,
navigator-branch UNPROVEN and global completeness after an absent called export.

### Full-render measurement and saved-spec proof

Single Windows Node 26.4.0 renders with parent old-space 6144 MiB measured
**10.695 seconds before** and **71.693 seconds after** process isolation. The
after run included concurrent local validation; these are elapsed measurements,
not a controlled performance comparison or Linux CI timing. The timed path
includes native bundling, temporary writes, actual child imports/metadata reads
and cleanup. The job timeout is 20 minutes. Both renders completed with 1,017
exports and the same five unavailable Node modules: collectionReminderActions,
email, pushSend, socialPosting and whatsappSend. The after render performed
1,349 evaluations with zero env keys/enumerations, zero static refusals and zero
differential refusals. SDK/Zod imports needed no exception.

Product source identity against 43feaa4f remains intact across convex, app,
components, packages, lib and apps/mobile. Saved deployed-spec replay using
current-isolation-final.json exits **7**: **6 FIXED, 0 stillFails, 0 UNPROVEN**,
11 revision-skew breaks, zero evidence drift/coverage-incomplete causes and no
ALSO PRESENT. This is SUPPLIED_FILE evidence using existing deployed.json, not a
fresh production read or release approval.

The native bundler, static app-input refusal, patched-SDK refusal, version pin,
use-node path, systemic failure refusal and global completeness rule remain.
No workflow, classifier, exit code or ALSO PRESENT rule changed. Validation and
new-head CI results are recorded in the PR. Formal seats must re-review the new
head; advisory Standards/Spec checks are not those seats. No merge/deploy occurs.


### Local validation of the remediation

- Full one-worker contract-skew sweep: 28 files, 1,416 passed, zero failed, one
  pre-existing fetchSpec skip. The known Windows CRLF shebang issue was handled
  by the existing bounded file-by-file runner, which temporarily normalizes the
  same three scripts and restores their exact bytes in finally; no script diff.
  A combined all-files coverage attempt was stopped during collection; it is not
  passing evidence. The full sweep itself completed successfully.
- Focused renderer/setup/credential-boundary run: 152 passed. Its scoped coverage
  command exits nonzero against the repository-wide 90% line/statement and 85%
  function thresholds: 87.28% lines, 84.96% statements, 76.92% functions. The child
  helper is zero in the parent-only LCOV. Thresholds were not overridden.
- PR-added source lines against 43feaa4f in those five renderer files measure
  350/400 = 87.5% from that LCOV, counting unmeasured helper lines as zero. This
  scoped local number excludes unchanged-in-this-remediation cli.mjs; the actual
  whole-PR Sonar result is checked separately, never inferred from this number.
- Exact CI Node command `node --test --test-concurrency=1 scripts/contractSkew/*.test.mjs`:
  26 passed, zero failed/skipped, including benign-probe FIXED, navigator-branch
  UNPROVEN and whole-spec completeness.
- Root `pnpm typecheck` and `pnpm typecheck:contract-skew` pass. The root excludes
  convex/; the latter checks detector .mjs files. Changed-file ESLint passes.
  Cached official SonarJS/native analyzer rules plus no-await-in-loop report no
  issues in the changed runtime/renderer files. No suppression/config changes.
- Advisory Standards/Spec rechecks closed the worker-heap and env-reflection
  findings. An executed equivalent capped child under a 6144 MiB parent reports
  369,098,752 bytes total V8 heap (352 MiB), unlike the rejected worker's 6 GiB.
  This corroborates child flag separation, not total RSS or production parity.

The standalone code-review claim remains limited to this implementing session's
self-review and the named advisory rechecks. Formal review seats remain pending.


The fixed-input regression retains both original branches: a valid fixed cwd
input ignores an invalid extra CLI path, and missing cwd input refuses rather
than reading that path. Both pass after adapting the payload to one entry.
The exact 26-test Node command also passes on Windows Node 22.23.4.

Final Node 22.23.4 focused rerun, including both fixed-input branches: **153
passed** (120 renderer, 18 setup, 15 credential boundary), exit zero.


### Constructor reflection closure after 30aa8548

The first remediation's Tests workflow passed, and its Sonar check passed with
82.0% new-code coverage. An advisory read during that wait reproduced a further
constructor-guard problem: replacing native data properties with accessors made
the guard's descriptor observable. The following correction supersedes that
head's constructor implementation and the prior local final counts.

- Constructor get/set now latch refusal immediately. The native configurable
  flag stays true: deletion removes the replacement and cannot recover the
  removed native constructor. A permanent control preserves the actual true
  deletion result. Assignments and descriptor definitions refuse rather than
  publishing synthetic accessor/data conversion results.
- Object/Reflect descriptor and definition APIs fence the four guarded prototype
  identities. Legacy lookup/definition paths refuse constructor and opaque keys,
  including inherited lookups. Ordinary-object reflection delegates normally.
- New Proxy and Proxy.revocable refuse those prototype targets, including the
  descriptor-retrieved revocable factory, so aliases cannot forward around the
  identity fence. Ordinary proxies and revocable-factory identity are preserved.
- A realm-private WeakSet tracks synthetic code-generation probes and guarded
  method wrappers. Native Function.prototype.toString refuses their source,
  which is renderer code rather than deployment metadata. Ordinary function
  source still delegates. A synchronous native-intrinsic unit test restores all
  original descriptors and global Proxy in finally.

Additional failing-first real-render evidence: **12 descriptor cases failed**;
**5 redefinition cases failed**; **3 Proxy-alias cases failed**; the original
method-source case failed, then **2 Function/eval source cases failed** while the
method-source control passed after its correction. Independent native controls
confirmed the descriptor/deletion/set results. Formal seat certification remains
pending; advisory closure is not certification.

References: ECMAScript [property-descriptor conversion](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-validateandapplypropertydescriptor)
and [Proxy forwarding](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-proxy-object-internal-methods-and-internal-slots-getownproperty-p).
The earlier Convex analyzer citation and per-entry isolation model remain.

Final local Node 22.21.1 focused run: **185 passed** (151 renderer, 19 setup,
15 credential boundary). Exact CI Node command passes **26/26**. Detector checkJs,
root typecheck and changed-file ESLint pass; the root excludes convex/. Scoped
parent-only coverage is **89.67% lines**, 87.24% statements, 81.30% functions, so
that scoped coverage command still exits nonzero at repository-global thresholds.
No threshold/configuration was overridden. It covers **89/97 = 91.75%** of this
remediation's added executable lines against 98689acc, and **391/435 = 89.89%** of
PR-added executable lines in the five renderer files against 43feaa4f. These
numbers count the unmeasured child helper as zero and exclude cli.mjs; they are
not the whole-PR Sonar result.

Final full-render measurement: **10.695s before -> 92.109s after** on Windows
Node 26.4.0, single elapsed runs subject to concurrent workstation load. The binding
limit is the render step's `timeout 180s` at `.github/workflows/contract-skew.yml:113`,
not the 20-minute job timeout. Seat 1 measured 57 to 119 seconds on Linux with
two or four CPUs and varying concurrent load. No limit is lowered or raised here.
Current-alias-final.json records 329 entries, 1,349 evaluations,
zero env keys/enumerations, the same five unavailable Node modules and 1,017
exports. All complete registration records equal the before-render records.
The final saved-spec replay still exits **7**, with **6 FIXED, 0 stillFails,
0 UNPROVEN**, zero evidence drift/incomplete coverage and no ALSO PRESENT.
This remains supplied-file evidence, not production verification.

The previous cloud's only open minor issue, S6353, requested `\d` instead of
`[0-9]` in the concurrency flag regex. That equivalent ASCII-digit form is fixed
without changing accepted arguments or exit behavior. No NOSONAR, Sonar config,
workflow, credential pin, classifier or global completeness change is used.
New-head CI and Sonar are checked after the follow-up push.

## 2026-10-30 curspec10: historical observation remediation

This section records uncommitted work after both seats reviewed 62b0cdc7. It is
not a completed remediation, a review certificate, or evidence for a new PR head.

At 62b0cdc7, both requested Math reproductions report `{fixed:1, stillFails:0,
unproven:0}` with zero unavailable modules. The new Error.stack and abort-event
tests also falsely report FIXED. An original-head snapshot with an exported
function confirms an empty-message Error is counted as zero unavailable modules.
The same snapshot exposes the constructibility gap: `new Math.random()` throws
before the old arrow target's Proxy construct trap, yet publishes `label`.

The working fix has one callable/host observation guard, constructible denial
bridges, stable Date.now and console identities, fresh empty Function probes,
captured guard intrinsics, and guarded Proxy aliases. Console execution refuses
because the real runtime inspects arguments. Host web API execution refuses
instead of importing Node-specific event/clock behavior. Zod creates its actual
realm-local singleton; the renderer no longer seeds synthetic Zod objects.

The new runtime matrix checks 189 caught observation attempts from library
modules, with zero static refusals. It passes alongside native identity and
ordinary-registration controls. Named Node tests passed 33/33 before the final
matrix expansion, and the three expanded matrix/identity/empty-Error cases pass.
Direct Vitest globals tests pass 20/20. A concurrent 182-test Vitest run suffered
timeouts; a renderer-only retry passed 144/148 and its four timed-out cases all
passed in a focused five-case run. Detector checkJs and changed-file ESLint pass
at the checked working states; final validation remains pending.

The development render retained 1,017 registrations and five unavailable modules
over 1,349 evaluations. It took 582.375 seconds on Windows Node 26.4.0 under
substantial concurrent workstation load. This is one elapsed run, not evidence
that the 180-second Linux workflow limit is sufficient. No limit was changed.
Its pre-merge supplied-file replay reports six FIXED, zero stillFails/UNPROVEN,
exit 7 and no ALSO PRESENT. Seat 1's mutate.mjs gives zero FIXED/six UNPROVEN
without current evidence or after removing vehicles:create, and five FIXED/one
stillFails when both specs lack purchaseSupplierId. Seat 1's probes.mjs was run;
the requested env/constructor/host cases refuse and the shared-args ordering
control retains string. Locale and microtask probe outputs were observed, not
independently certified against the hosted runtime.

`git merge origin/main` cleanly integrated main 09abccc14fb8243dcf7ce0c40d815260a616125c.
The local merge commit is fe8652983dec52b6812f0af4f71020ee241f444d and ends with
the requested Co-Authored-By trailer. Post-merge identity check matches 928 entries.
The implementation remains uncommitted and unpushed; new-head CI is unavailable.

### Historical Error decision, superseded below

Literal refusal of Error.prototype prevents the installed Convex 1.42.1 SDK from
defining ConvexError during import. A standalone strict-prototype probe reproduces
that refusal. A mutable Error.prepareStackTrace hook is also insufficient because
module code can remove it. The current hook is interim and must not be shipped
as complete. The owner has been asked whether to preserve the unchanged native
Error.prototype for inheritance while refusing other Error reflection, mutation
and stack inputs. Dependent implementation and final publication await that ruling.

Sources checked: pinned Convex [Math/environment setup](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/00_misc.ts),
[Error stack setup](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/errors.ts),
[event timestamp](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/02_event.ts),
[console inspection](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/02_console.ts),
[V8 stack hooks](https://v8.dev/docs/stack-trace-api), and
[ECMAScript ProxyCreate](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-proxycreate).
The installed SDK's dist/esm/values/errors.js was read directly. No fresh hosted
runtime comparison, final seat certificate, or pilot-readiness claim is made.

## 2026-10-30 curspec11: corrected Error boundary

The coordinator's corrected A–E decision supersedes the pending choice above.
No Error facade, additional source rewriting, or infrastructure change is used.

The expected shape is the realm's native eight Error constructors and their
prototypes, with one exception. Convex's pinned
[errors.ts:20–23](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/errors.ts#L20)
assigns `Error.prepareStackTrace`. The renderer uses the same assignment form.
Each expected attribute, writable, enumerable and configurable, is true because
that assignment reaches ECMAScript's
[OrdinarySetWithOwnDescriptor](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetwithowndescriptor)
and [CreateDataProperty](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-createdataproperty).
Node 26 already owns a non-enumerable formatter, so the renderer removes that
host hook before assignment. A fresh-vm descriptor comparison checks every own
key and descriptor of all 16 native objects, masking only the formatter value.
`captureStackTrace` and `stackTraceLimit` remain native and unchanged.

The renderer's formatter latches UNPROVEN when invoked. Convex documents its
lazy invocation at errors.ts:21–22 and calls `performOp("error/stack", frameData)`
at [line 48](https://github.com/get-convex/convex-backend/blob/db914cf06e2b06ee985646611b9e12ed7a770318/npm-packages/udf-runtime/src/errors.ts#L48).
[V8's stack API](https://v8.dev/docs/stack-trace-api#customizing-stack-traces)
also specifies the formatter hook. Tests cover ordinary Error.stack and native
captureStackTrace formatting, including a caught refusal.

After entry import and after native metadata extraction, captured native
operations compare constructor bindings, own descriptors and key order,
prototype identity, extensibility, and the renderer formatter identity.
Any residue refuses the entry. Fresh children prevent it reaching the next entry.
Writes that are restored without formatting may register, matching the approved
fresh-context model. Native inheritance and ConvexError remain usable.
The own-state comparison follows ECMAScript's
[ordinary internal methods](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinary-object-internal-methods-and-internal-slots).

The static check refuses any emitted module text containing `prepareStackTrace`,
including imported chunks. The source-mapped file and line inputs appear in
errors.ts:29–31 and feed the formatter at line 48. The literal check is a
conservative coordinator requirement, not a proof of general equivalence.
**Residual risk:** a computed property name can replace the hook, format a stack,
and restore the hook before the residue check. This remains open for the seats
to rate; it is not closed by this change. ECMAScript's
[computed property access](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-property-accessors-runtime-semantics-evaluation)
evaluates an expression to obtain the property key, so a literal-text check
cannot establish that property is never accessed.

Failing-first evidence: the corrected descriptor expectation failed on Node's
non-enumerable host hook; lasting residue and transitive replace-format-restore
also published incorrectly. After the first implementation, an advisory review
found that entry-controlled array iteration could skip descriptor comparisons.
The permanent regression failed by publishing `error52.js:read`. Bounded index
loops now refuse that mutation. The reviewer independently re-ran the probe.
The 53-case residue matrix includes that case. Native name assignments that
cannot change a non-writable field were replaced by actual descriptor writes.

Final named Node checks: 37 passed, zero failed or skipped, with
`--test-concurrency=1`. These include 189 caught observation attempts, ordinary
controls, restored mutation, inheritance, and publication/completeness controls.
The named renderer, globals and credential-boundary Vitest files pass 183 tests
with `--maxWorkers=1`. A later direct formatter-identity assertion passes all
20 globals tests. Detector-specific `pnpm typecheck:contract-skew` and changed-file
ESLint pass. This is detector checkJs, not a Convex backend typecheck. The baseline
identity check matches 928 entries and does not certify backend finding identity.

Seat 1's probes.mjs was re-run. Env, constructor, host-stack and event-clock
probes refuse. The Date.now-before-corrupt control preserves string; an empty
Error is unavailable; the infinite-loop probe times out at the existing 30 seconds.
Locale and microtask outputs remain observed, without hosted-runtime certification.

The final full current-tree render takes **75.038 seconds**, one Windows Node
26.4.0 run, four child lanes, 1,017 registrations, 1,365 evaluations and nine
unavailable modules. Four added unavailable helper entries are locale inputs
introduced on merged main, not Rule D refusals. Rule D refuses **zero entries
and zero of the 1,017 registrations**. This single workstation run is not a Linux
workflow benchmark; the binding step limit remains 180 seconds.

The requested supplied-spec proof is pinned to product source and baseline
43feaa4fe97018182a033c209f16a4a67cfa664a in an archived fixture, with current detector
code and installed dependencies. Its full render retains 1,017 registrations,
1,349 evaluations and five unavailable modules, in **76.331 seconds**. Its saved
spec replay is **6 FIXED, 0 stillFails, 0 UNPROVEN, exit 7, no ALSO PRESENT**.
Fixture-only input paths are
adapted for Seat 1's mutate.mjs. No production credential or fresh hosted spec
is used. The fixture has its own Git root at 43feaa4f so the no-current Git
fallback compares the intended trees, rather than an untracked nested directory.
After correcting that fixture setup, no-current and removed-function controls
each yield zero FIXED and six UNPROVEN; the shared missing-argument control yields
five FIXED and one stillFails. All four runs exit 7. The baseline has no ALSO
PRESENT; the shared-missing control correctly reports a standing defect.
The separately observed current-main replay has eight FIXED calls and
two evidence-drift findings for OpeningBalanceCard allocations[*].vehicleId.
That replay has ALSO PRESENT and is not substituted for the pinned proof.
The baseline and classifier are unchanged.

Main remains 09abccc14fb8243dcf7ce0c40d815260a616125c after a fresh fetch, and bare
`git merge origin/main` reports already up to date. Advisory Standards and Spec
reviews are not formal seats. Final-head certification remains unavailable;
this change does not waive Skill Evidence or authorize merge, deploy or launch.
