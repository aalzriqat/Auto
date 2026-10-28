# Baseline call identities (SCRUM-866 part B)

Run from the repository root after installing dependencies:

```sh
node scripts/contractSkew/checkBaselineIdentity.mjs
node scripts/contractSkew/relocateBaseline.mjs --base <reviewed-base-sha>
node scripts/contractSkew/relocateBaseline.mjs --base <reviewed-base-sha> --write
```

Both commands accept `--baseline <file>`. The helper requires a revision where
the reviewed expressions still occupy their recorded coordinates. Use the PR
base SHA for a new line shift. An already-stranded baseline may need an older
revision; selecting a revision does not renew its review.

The helper defaults to a dry run. Inspect the proposals before using `--write`.
It changes `callSiteId` for a unique candidate in the same surface and file,
and requires the complete containing call expression to match the old expression
byte for byte. Whitespace and argument changes inside that expression require
human review. Invalid UTF-8 is refused rather than normalized. Multiple findings
on one call can move together; different old calls cannot claim one destination.
Candidates already named by another baseline call are refused. Other review
fields are preserved. JSON formatting is normalized when a write occurs.
Writes are staged in a sibling temporary file and then renamed over the baseline;
this avoids truncating the original while preparing its replacement.

Exit 0 means the scoped operation completed without stranded/refused entries;
10 means identity drift or human review is needed; 3 means evidence was
unavailable. A missing base/source or unreadable baseline cannot pass. With
`--write`, safe entries may move even when other entries require human review;
the command still exits 10. The production monitor does not invoke this helper.

## Signal and limits

The check uses `CLIENT_SURFACES`, `listSurfaceFiles`, `createClientProgram` and
`extractClientCalls`, shared with the production monitor. It scans baseline-bearing
files with each surface's actual tsconfig and resolves their imports. It checks
membership of `(surface, file, callSiteId, functionId)`. Deleted files, unresolved
calls and calls proven skipped cannot satisfy that membership. It does not use a
backend spec, a deployment, credentials, or a second regex-based call extractor.

`contractPath` and finding `kind` require comparison with the backend validator;
payload extraction alone cannot determine them. The check therefore does not
certify those fields, fingerprints, causes, multiplicity, expiry, duplicate
findings, new debt or contract compatibility. A same-function call that changes
arguments without moving can still satisfy the four-field check. Identical call
text also does not prove that surrounding bindings, imports or backend semantics
are unchanged; reviewed rationale remains a human/independent-review obligation.
File moves and request-map sites whose positions do not identify the containing
call's callee or first argument need manual review, including memoized maps.

The `Tests` workflow runs the new Node tests and check in its existing
`type-check` job after dependency installation. On `pull_request`, its existing
checkout tests GitHub's candidate merge ref, so it also sees integration with the
base branch. No production secret is used. This change does not edit branch
protection, `.github/release-waivers.json`, or the baseline JSON. It does not claim
that a new standalone check is required by branch protection.

## Empty baseline

`checkBaselineIdentity.mjs` refuses a baseline with no entries (exit 3, "has no
baseline entries"). "0 entries matched" is vacuously true and is also what a
truncated or mispointed file looks like. Retiring all reviewed debt is a reviewed
decision, stated on the command line with `--allow-empty`; the flag never excuses a
non-empty baseline that has drifted (exit 10 still applies).

## Renewal closure and what it cannot see (SCRUM-866)

`renewBaselineReviewed.mjs` renews an entry mechanically only when every file in
its closure is the same git blob at the reviewed revision and HEAD. The closure of
the client file and of the backend module (`importClosure.mjs`) contains:

- files reached by an import edge, resolved with the surface's real tsconfig;
- backend modules reached by a Convex function reference: `api.<module>.<fn>` and
  `internal.<module>.<fn>` at any depth (`ctx.runQuery`, `runMutation`, `runAction`,
  the scheduler and crons all take one) and `makeFunctionReference("mod:fn")`, also
  through a namespace import of `convex/server`. The module is exactly every segment
  but the last (`convex/messages/access.ts` is `api.messages.access.<fn>`:
  `convex/_generated/ai/guidelines.md`, "Function references", and
  [Query names](https://docs.convex.dev/functions/query-functions)). A shorter prefix
  that happens to exist (`convex/messages.ts`) is a different module, and `index` is
  not special: `api.idx.index.fn` is `convex/idx/index.ts`, `api.idx.fn` names no
  module. A reference whose exact module does not exist is unresolved and refuses.
  Which import is the generated api or `convex/server` is decided by the module
  TypeScript resolves the specifier to (`./_generated/api.js` and path aliases
  included), with the specifier text only as a fallback;
- the tsconfig of each program and its relative `extends` chain, that directory's
  `package.json`, and the shared inputs `package.json`, `pnpm-lock.yaml` and
  `convex/schema.ts` (clients reach the schema only through the excluded
  `_generated/dataModel`). An input that is source is traversed like any member, so
  what `convex/schema.ts` imports (validators, enums) is in every closure too.

Not traced, and each REFUSES mechanical renewal (reported as unresolved, never
skipped): `api`/`internal` used other than as a static chain (bare, destructured,
`api[key]`, a chain that stops at a module or names no function); a default import,
namespace import, `import x = require()` or dynamic `import()`/`require()` of the
generated api; any re-export that hands `api`, `internal`, `makeFunctionReference`
or `anyApi` on (`export { internal } from "./_generated/api"`, `export *`,
`export { api }`), which also refuses every file that imports the re-exporting file;
`anyApi`; `makeFunctionReference` with a non-literal name or used without a call; a
`convex/server` namespace used any way but `ns.makeFunctionReference("mod:fn")`; a
dynamic load of `convex/server`; and any computed load in any closure file, whatever it
targets: `import()`, `require()` or `import x = require()` whose specifier is not a plain
string literal after wrappers are skipped (`"a" + "b"`, a template with a substitution,
an identifier, no argument); every use of `require` other than a call (allowlist: only a
called `require.resolve(...)` and `typeof require` are inert, so `const r = require`,
`require.call/apply/bind`, `require["call"]` and `require.context` refuse); every
property access named `require` and every element access with a plain string key
`"require"`, whatever the receiver and in any position (called, extracted, passed,
or used via `.call`, `.apply` or `.bind`); and every non-literal element key on
`module`, `require` or `globalThis`; and any reference to a free identifier
`module`, `global`, `globalThis` or `Reflect`, except the exact CommonJS export
access `module.exports` and the shipped Web Crypto access `globalThis.crypto`.
This catches destructuring, `Reflect.get`, constructor
loads and simple aliases without a new rule for each loader syntax. A locally
bound identifier does not trigger the latter rule. Receivers and keys are unwrapped first.
String, numeric, bigint, regexp and no-substitution template literals are literal
keys. The rule deliberately refuses an unrelated object's `.require` too.
Direct literal `require("...")` calls remain traced. Called `require.resolve(...)`
and `typeof require` remain accepted. Node documents
[`module.require`](https://nodejs.org/api/modules.html#modulerequireid) as a loader;
checking the member access itself also catches indirect invocation and extraction.
Parentheses, `as`, `satisfies`, `<T>x`, `x!` and `f<T>` are looked through before every
decision, so a wrapped load or reference is judged like the plain one (the public
TypeScript predicates are used; `ts.skipOuterExpressions` is not in `typescript.d.ts`).
At this revision the real-tree baseline dry run refuses 1012 entries and reports 0
unresolved closures. This measures the baseline closures, not every repo file.

Still outside the closure and not detected: ambient declarations (`declare global`, a
`.d.ts` nobody imports); `eval`; `new Function`; `createRequire` under another
name such as `const load = createRequire(url); load(x)`; and type-only `import("x")`
types. The scan does not track arbitrary loader aliases originating without those
free identifiers. Other limits are what a
dependency's code does inside `node_modules` (the lockfile and package.json pin the
version, nothing reviews its behaviour);
handler-only behaviour that no edge reaches (a trigger, an HTTP route, a cron table, a
scheduled job, a function named through a string built at run time); `components.*`
references; and a local variable that shadows `api` or `internal`, which is treated as
the generated object (it only over-includes). A reference graph this wide reaches most
of the backend, so a change to a widely referenced module refuses almost every entry:
mechanical renewal refuses those entries. Human evidence now uses the narrower
round 9 policy below.

## Evidence, 2026-10-28

Base: `2e7ea58cdbfe746a0169494570443316846026e6`. Live GitHub main was read
through the GitHub connector at implementation start and matched this SHA.
Local shell fetch/network access was denied; no successful fetch is claimed.

Recurring incidents supplied in the task and corroborated by SCRUM-866 and
PR #700: #678 stranded 13 mobile entries (repaired in #680); #690 moved
`sourcingPayables:markPaid` from `150:13` to `156:13`, stranding three entries.
This prevention belongs in CI because documentation cannot prevent a coordinate
shift. Changing the baseline's identity architecture is outside this part's
scope; the monitor remains authoritative for backend finding identity.

Failing-first command, before either CLI existed:

```text
node --test --test-concurrency=1 scripts/contractSkew/baselineIdentity.test.mjs
tests 6
pass 1
fail 5
#690 line shift ... AssertionError: 1 !== 10
Cannot find module '.../checkBaselineIdentity.mjs'
dry-run proposes ... AssertionError: 1 !== 0
Cannot find module '.../relocateBaseline.mjs'
```

This initial red run proves the missing feature, not a pre-existing checker
returning a wrong verdict. The initial unavailable-input control was too broad
and passed on the missing CLIs; it now requires the deliberate exit code 3.
The green regression executes real CLIs, compiler extraction, temporary Git
base revisions and filesystem writes. The unchanged fixture reproduces exactly
`150:13 -> 156:13`; a changed `taxAmount` argument is refused.

The implemented checker also ran against the untouched baseline at the assigned
base and reported three `STRANDED` entries (`bankAccountId`, `taxAmount`,
`idempotencyKey`) at `150:13`, each naming candidate `156:13`. This is an expected
red result requiring the separate baseline lane. #690 changed the actual
`taxAmount` producer too, so that real call must not be automatically relocated.

An advisory review found a separate wrapper-call edge: a memoized request-map
entry selected the enclosing `useMemo(...)` expression. A failing-first test
reported 8 passed / 1 failed, with that wrapper text where `null` was required.
The locator now refuses that site. Scoped advisory rechecks reported the finding
fixed; these are not independent review-seat certifications.

Final local validation (Node v26.4.0; CI uses Node 22.21.1):

```text
node --test --test-concurrency=1 scripts/contractSkew/baselineIdentity.test.mjs
9 passed, 0 failed
pnpm exec vitest run scripts/contractSkew/baseline.test.ts scripts/contractSkew/acceptance.test.ts --maxWorkers=1
2 files passed; 80 tests passed
pnpm typecheck:contract-skew
tsc -p scripts/contractSkew/tsconfig.json --noEmit
```

The dedicated detector project checks `.mjs` with `checkJs`; the root typecheck
was not run because this part changes no `.ts` files. The first typecheck found
new JSDoc/catch-narrowing errors; a later test addition needed Git availability
narrowing. Those were corrected before the final run. No wide suites, browser
hunters, CI runs, interruption fault injection, deployment or production
verification are claimed for this tooling-only change.

Git staging was attempted with the five explicit code/workflow paths. It failed
creating `E:/Auto/Auto/.git/worktrees/auto-866c/index.lock` with permission denied.
No commit SHA was produced, and nothing was pushed or opened as a PR. The report
is the sixth changed file. The coordinator must commit these files with the
requested `Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>` trailer, integrate
the separate baseline repair/review lane, and run the normal PR/review gates.

## Design sources

- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API):
  reuse compiler programs and AST nodes for source locations and expression text.
- [Git show](https://git-scm.com/docs/git-show): read the base revision's blob,
  without a checkout or mutation of the working tree.
- [GitHub pull request events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request):
  retain the existing candidate-merge checkout and credential-free PR execution.
- [Node parseArgs](https://nodejs.org/api/util.html#utilparseargsconfig)
  and [Node test runner](https://nodejs.org/api/test.html): use
  supported native CLI parsing and named, single-worker process-level tests.
- [Node filesystem rename](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsrenamesyncoldpath-newpath):
  stage replacement content before renaming, rather than truncating the baseline.

Documentation supports these design choices; the executable regression and
detector typecheck provide implementation evidence. CI, independent review and
production verification are separate evidence surfaces.


## Round 6 loader refusal evidence, 2026-10-28

Local implementation boundary: `claude/scrum866-baseline-renewal`, HEAD
`7cadeb9af647edefae1539c9e2c9a17633bd9d72`, with the round 6 edits uncommitted.
Finding accepted; conservative refusal adopted. No baseline file was edited.

Before the implementation change, the new temporary Git fixture committed each
loader and `{ run: 1 }`, then committed only the worker changing to `{ run: 2 }`.
Node executed the `.call` fixture and returned `{ run: 2 }`. Each renewal test
failed with `AssertionError: expected 1 to be +0`:

| Loader form | Before fix | After fix |
| --- | --- | --- |
| `module.require.call(module, "./worker.js")` | renewed 1 | renewed 0, refused 1 |
| `module.require.apply(module, ["./worker.js"])` | renewed 1 | renewed 0, refused 1 |
| `module.require.bind(module)("./worker.js")` | renewed 1 | renewed 0, refused 1 |
| `module["require"]["call"](module, "./worker.js")` | renewed 1 | renewed 0, refused 1 |
| `const load = module.require; load("./worker.js")` | renewed 1 | renewed 0, refused 1 |
| `module[k]("./worker.js")`, with `k = "require"` | renewed 1 | renewed 0, refused 1 |

The failing-first command was:

```sh
pnpm vitest run scripts/contractSkew/renewBaselineReviewed.test.ts --maxWorkers=1 -t 'member loader renewal'
# 6 failed, 1 passed, 74 filtered out
```

Final commands and observed outputs:

```sh
pnpm typecheck:contract-skew
# tsc -p scripts/contractSkew/tsconfig.json --noEmit; exit 0
node scripts/contractSkew/checkBaselineIdentity.mjs
# Call identity check: 1012 baseline entries matched (surface, file, callSiteId, functionId).
# Backend finding identity was not checked.
node --test --test-concurrency=1 scripts/contractSkew/baselineIdentity.test.mjs
# tests 14; pass 14; fail 0; skipped 0
pnpm vitest run scripts/contractSkew/renewBaselineReviewed.test.ts scripts/contractSkew/baseline.test.ts scripts/contractSkew/acceptance.test.ts --maxWorkers=1
# Test Files 3 passed (3); Tests 169 passed (169)
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --expires 2027-01-01 --renewal 'SCRUM-866 round 6 dry run; do not write baseline'
# reviewed c82890bd726a067774766d6723467a8b8fbc21c1
# head     7cadeb9af647edefae1539c9e2c9a17633bd9d72
# renewed 0, already current 0, refused 1012
# dry run; pass --write to apply
# exit 0; unresolved refusal lines 0
```

The January date exercises refusal because the current baseline already expires
on December 1. No `--write` was used. Separately, every one of the 228 distinct
client/backend roots for the 1012 entries was traversed with `createImportClosure`,
the surface tsconfigs, and the same implicit inputs as the renewal CLI. That
measurement reported 0 unresolved roots, including roots whose renewal refuses
before it reads their closure. Direct closure checks of
`scripts/contractSkew/convexInventory.mjs` and `scripts/pilotRoleAuditEvidence.mjs`
also reported 0 unresolved each. This confirms their called `require.resolve`
forms remain accepted. Existing inert controls passed alongside new controls for
direct literal `require` and unrelated computed keys.

The dedicated detector typecheck includes `.mjs` with `checkJs` and detector
TypeScript tests; it is not the root application or Convex backend typecheck.
These are local tooling results, not CI, release, production, or review-seat
certification. Fetch and shell GitHub access were denied. The coordinator owns
commits and the subsequent independent reviews.

## Round 7 renewal evidence after #697

Historical policy, superseded for `--check-evidence` by round 9 below.

The `--check-evidence` mode of `renewBaselineReviewed.mjs` is read-only. For each
entry with a `renewal` string, it derives the current client and backend closures,
compares each member's Git blob to the reviewed revision, and requires the
renewal text to name every changed or missing member by its complete repository
path. It also reads the latest `SCRUM-866 round N review against origin/main <sha>`
marker in each renewal and refuses when any closure member changed again after
that SHA, including a member already named in the prose. A missing marker, a
non-ancestor review SHA or an unresolved closure fails. The existing Tests workflow runs:

```sh
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence
```

This catches new closure files and edits to already named files after a merge to
main without changing an expiry or a contract field. The check cannot judge whether the prose's description of a
diff is true, whether the original UNKNOWN finding has become proven, or whether
an untraced runtime dependency changed. The reviewed revision is fixed in the CI
invocation to the original `c82890bd` evidence base; passing a later revision by
hand would ask a different, weaker question.

At round 7, #697 (`549267ae`) added supplier-concession handling, sale-row
projection and schema fields. The renewal text of each entry was extended with
the #697 files in its current closure and a short description of each diff.
The three `vehicles:update` entries for `sourceType`, `sourcedFromName` and
`sourceCost` explicitly state that the backend now refuses a real supplier-term
change while an open deal holds a concession. The earlier schema description is
scoped to `ffe284917`; #697 extended existing tables after that revision.
The three sourcing `markPaid` entries also now name the full
`app/(dashboard)/[orgId]/sourcing/client.tsx` path. Their prior short-path
mention was readable to a person but insufficient for an exact-path check.

The loader scan refuses free `module`, `global`, `globalThis` and `Reflect`
identifier references at the source AST level. It allows only `module.exports`
for CommonJS exports and `globalThis.crypto` for shipped Web Crypto usage; direct
literal `require`, called `require.resolve` and `typeof require` retain their
existing treatment. Node documents `module.exports` and `module.require` in its
[CommonJS module API](https://nodejs.org/api/modules.html); TypeScript documents
the CommonJS export syntax in its [module handbook](https://www.typescriptlang.org/docs/handbook/2/modules.html).
Locally declared names are checked in their enclosing lexical scopes.

## Round 9 narrow evidence policy, 2026-10-28

Owner decision: first prove that an argument-validator change in a shared file
reaches the mechanical comparator. Then limit human renewal evidence to each
entry's own client file and the file declaring its registered backend function.
Mechanical renewal keeps its full import closure and every loader refusal.
`--check-evidence` no longer constructs or scans an import closure.

### Shared-validator prerequisite

`sharedValidator.test.ts` copies two fixtures into a disposable local directory.
`function.mjs` imports its argument validators from `args.mjs`. Separate Node
processes load the registered function before and after changing only
`v.optional(v.string())` to `v.string()` in the shared file. The function file
stays byte-identical. Both argument contracts come from `update.exportArgs()`.
Only the function-spec metadata envelope is assembled by the test.

The installed Convex 1.42.1 source establishes the serialization boundary:

- `node_modules/convex/src/server/impl/registration_impl.ts:172`: `exportArgs`
  calls `asObjectValidator(functionDefinition.args)` and serializes `args.json`
  at line 181. `mutationGeneric` attaches that exporter at line 261.
- `node_modules/convex/src/cli/lib/functionSpec.ts:19`: the actual CLI reads
  `_system/cli/modules:apiSpec`; line 32 wraps the result as `{ url, functions }`.
  This test uses the registered exporter locally. It does not claim to execute
  the platform's system query or a deployment.

The old spec accepts an omitted `label`. The new spec rejects it, and the same
call classifies as revision skew against the compatible old spec. A second call
with a string `label` fits both. The test also passes both rendered specs as
files to the real `cli.mjs`: old exits 0, new exits 7, with exactly one break at
`label` and two resolved calls. Nothing is fetched or deployed.

Mutation control, run before step 2: temporarily filtering `label` findings out
of the production comparison produced this red output. The comparator was then
restored byte-for-byte.

```text
pnpm vitest run scripts/contractSkew/sharedValidator.test.ts --maxWorkers=1
Test Files 1 failed (1); Tests 1 failed (1)
AssertionError: expected [] to deeply equal [ ObjectContaining{...} ]
Expected path: label; siteId: app/page.tsx:1:1
# restored comparator
Test Files 1 passed (1); Tests 1 passed (1)
```

This checks the premise using the same exported validator representation that
feeds function-spec. It is not a proof of every validator or payload shape.
[Convex's validation documentation](https://docs.convex.dev/functions/validation)
defines optional/required fields and object argument validation. The separate
CLI checks establish that file diffs are not needed to detect this change.

### Fooling and over-refusal analysis

The following limits were identified before the evidence implementation changed.
`backendDefinition.mjs` reuses `createClientProgram` and TypeScript's symbol APIs
with the backend tsconfig. It follows named re-exports and local/imported aliases
of registered functions, including direct namespace members. This follows the
[TypeScript Compiler API guidance](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
and the installed `typescript.d.ts` declarations for `getExportsOfModule`,
`getSymbolAtLocation`, and `getImmediateAliasedSymbol`.

| Case | Treatment and remaining limit |
| --- | --- |
| Backend function re-exported from another file | Resolve named re-exports, including chains, to the variable declaration containing registration. Require that defining file. Re-export wiring itself is outside the two-file evidence set; redirecting an export to another unchanged definition can evade freshness. The mechanical spec comparison and review remain necessary. |
| Registered function defined in a helper module | Resolve imported/local aliases and direct namespace members to the helper's registration declaration. A registration call through a custom factory belongs to the call's file. The factory body and imported handler implementation remain outside this check. |
| Client call through a wrapper hook in another file | Require the baseline entry's own client file, wherever extraction located it. Other wrappers, hooks and argument producers are outside this evidence check. UNKNOWN payloads remain unproven; this policy does not turn them into compatible calls. |
| Renamed or moved function file | Resolve the exact current `module:function` path, including nested modules. A missing old module/export refuses. An updated identity must carry evidence; a new path absent at the original base can pass only when named and unchanged since a recorded ancestor where it exists. No rename guessing. |
| Several functions in one client file | Resolve and check each entry separately. A changed backend for one function does not stale siblings on another backend. A change anywhere in the shared client file still stales every entry using that file, including unrelated edits. |
| Missing client file | Compare it explicitly, independent of compiler extraction. If missing at HEAD or the evidence revision, it stays stale even when named in prose. A newly added path missing only from the original base requires its full path in the text. |
| Missing backend module, export or import | Refuse unresolved attribution, never fall back to a shorter module prefix or a passing empty file set. |
| Unsupported definitions | Refuse cycles, declaration-only targets, syntax errors, computed forwarded values, direct default export assignments, targets outside the repository or in node_modules, and star exports along the resolved alias path. Valid star/default/computed forms can therefore over-refuse and need supported source form or a separately reviewed resolver extension. Module roots retain the `.ts` convention; other root extensions refuse. |
| Shared validators and other imported code | Outside renewal evidence. The permanent gate proves an optional-to-required shared validator change reaches comparison through `exportArgs()`. Arbitrary payloads, return contracts, business logic, dynamic loaders, ambient declarations and handler-only changes are not proved by that gate. |
| Config, dependencies and resolution changes | Outside the evidence file set. They can redirect attribution or alter runtime behavior without changing required blobs. Required tracked files with uncommitted changes refuse; this is not a clean-worktree or dependency-integrity gate. |
| Misleading prose or baseline edits | The check proves full-path coverage and Git freshness, not that a review happened or its explanation is true. Identity checking, baseline evaluation and independent review have separate jobs. A forged valid ancestor marker can satisfy this mechanical check. |
| Broad or malformed evidence | Retain the full original-baseline identity/expiry comparison: changed expiry or a new/relocated identity requires renewal text even if `renewal` was removed. Malformed or whitespace text refuses even when expiry did not change. Latest recorded SHA must resolve and be an ancestor of HEAD. Every changed required path must be named exactly, and every required path must be unchanged since that SHA. Truncated, malformed, non-array and empty evidence inputs refuse. |

The header of `renewBaselineReviewed.mjs` records these same scope limits.
The check remains read-only and refuses `--write`, `--expires`, and `--renewal`.
The existing workflow command and its original review base remain unchanged:

```sh
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence
```

Failing-first scope tests reported 4 failed and 2 passed: imported helpers and
wrapper changes over-refused; defining-file attribution and per-function scope
were not observed. An additional intermediate-star-export control failed with
`expected [] to deeply equal [cannot resolve backend definition ...]` before the
alias-path refusal was added. Current controls cover both refusals and supported
named/imported/namespace forwarding.

### Integration with #694

Local HEAD is the supplied committed merge
`bb0a537eec5357a83517401fd14ce6783708fdcd`, containing main
`fa4bdab24` and the round 8 work. Fetch was attempted but denied write access to
`FETCH_HEAD`; no fresh remote-state claim is made.

All 1012 entries resolve to 228 distinct required files. Enumerating all 14 files
in `git diff fa4bdab2^ fa4bdab2` and intersecting them with that set gives zero
matches. The narrowed check reports zero stale entries before any baseline
write. Therefore no renewal text needs restating after #694, and round 9 leaves
the baseline JSON byte-identical. The December 1 expiry is unchanged.

Real-tree dry run, with a later date to exercise refusal rather than skip:

```text
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --expires 2027-01-01 --renewal 'SCRUM-866 round 9 dry run; do not write baseline'
reviewed c82890bd726a067774766d6723467a8b8fbc21c1
head     bb0a537eec5357a83517401fd14ce6783708fdcd
renewed 0, already current 0, refused 1012
exit 0; unresolved refusal lines 0
```

A refusal before closure traversal does not prove its imports resolve. The
separate closure-root enumeration below measures every distinct baseline
client/backend root with the same surface configs and implicit inputs as the
mechanical renewal command. It is the evidence for unresolved-closure counts.

Final round 9 local checks:

```text
pnpm typecheck:contract-skew
  tsc -p scripts/contractSkew/tsconfig.json --noEmit; exit 0
node --test --test-concurrency=1 scripts/contractSkew/baselineIdentity.test.mjs
  tests 14; pass 14; fail 0; skipped 0
pnpm vitest run scripts/contractSkew/renewBaselineReviewed.test.ts scripts/contractSkew/baseline.test.ts scripts/contractSkew/acceptance.test.ts scripts/contractSkew/sharedValidator.test.ts --maxWorkers=1
  Test Files 4 passed (4); Tests 287 passed (287)
pnpm exec eslint scripts/contractSkew/renewBaselineReviewed.mjs scripts/contractSkew/backendDefinition.mjs scripts/contractSkew/renewBaselineReviewed.test.ts scripts/contractSkew/sharedValidator.test.ts scripts/contractSkew/__fixtures__/sharedValidator/args.mjs scripts/contractSkew/__fixtures__/sharedValidator/function.mjs
  exit 0; 0 errors
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence
  renewal evidence: 1012 renewed entries checked, 0 unrenewed, 0 stale, 0 malformed, 0 missing
  exit 0
node scripts/contractSkew/checkBaselineIdentity.mjs
  Call identity check: 1012 baseline entries matched (surface, file, callSiteId, functionId).
  Backend finding identity was not checked.
all distinct baseline client/backend import-closure roots, same configs and implicit inputs
  roots 228; unresolved 0
```

The detector typecheck covers its `.mjs` and TypeScript project, not the root
application or Convex backend typecheck; input fixtures are excluded. Initial
local typecheck errors in the new resolver and the lint error for a variable
named `module` were fixed before the final green runs. Existing Git ignore-file
permission/CRLF warnings appeared during tests; the final commands above exited
0. No CI, bug-hunter run, independent review-seat certification, deployment or
production verification is claimed. The coordinator owns committing/pushing and
subsequent review. Round 9 did not edit `.gitignore`, `.ignore`, importClosure,
the workflow, or baseline JSON; the two ignore files were already dirty on entry.
