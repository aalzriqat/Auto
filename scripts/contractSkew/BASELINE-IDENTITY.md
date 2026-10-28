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
`require.call/apply/bind`, `require["call"]` and `require.context` refuse); and any call
whose callee is a member named `require` whatever the receiver (`module.require(x)`,
`(globalThis as any).require(x)`).
Parentheses, `as`, `satisfies`, `<T>x`, `x!` and `f<T>` are looked through before every
decision, so a wrapped load or reference is judged like the plain one (the public
TypeScript predicates are used; `ts.skipOuterExpressions` is not in `typescript.d.ts`).
At this revision no shipped (non-test) file does any of these: the real-tree dry run
refuses 1012 and none for an unresolved reference.

Still outside the closure and not detected: ambient declarations (`declare global`, a
`.d.ts` nobody imports); code that loads by other means (`eval`, `new Function`, a
loader obtained under another name such as `const load = createRequire(url)`, type-only
`import("x")` types); what a
dependency's code does inside `node_modules` (the
lockfile and package.json pin the version, nothing reviews its behaviour);
handler-only behaviour that no edge reaches (a trigger, an HTTP route, a cron table, a
scheduled job, a function named through a string built at run time); `components.*`
references; and a local variable that shadows `api` or `internal`, which is treated as
the generated object (it only over-includes). A reference graph this wide reaches most
of the backend, so a change to a widely referenced module refuses almost every entry:
each renewal text then names the changed files it was read against.

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
