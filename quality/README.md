# AutoFlow quality guardrails

These checks make new maintainability debt, dependency regressions, and a small
set of AutoFlow-specific safety violations merge-blocking. Existing debt is
recorded as exact budgets or exact cyclic edges; directories and files are not
blanket-allowlisted.

Run the same commands as CI from the repository root:

```sh
pnpm quality:guardrails:test
pnpm quality:guardrails
```

The aggregate command runs the three repository scans concurrently and prints
each scan's duration. Individual commands are available as
`quality:maintainability`, `quality:architecture`, and `quality:autoflow`.

## Maintainability ratchet

Production TypeScript and JavaScript under `app`, `components`, `hooks`, `lib`,
`convex`, the mobile app, the shared package, and the dealer worker are checked,
along with the quality tooling itself, executable TypeScript/JavaScript anywhere
under `public`, and exact framework runtime names. The latter cover the installed
Next.js root/`src` instrumentation, client instrumentation, proxy, and deprecated
middleware variants, plus the supported root Sentry config variants. A static
resolver reads the checkout's own `next.config` without executing it, so a
reviewed `pageExtensions` change updates both working-tree and historical
inventories; dynamic composition, mutation, or an unsupported extension fails
closed. A bare side-effect import widens the inventory to every supported
JavaScript/TypeScript runtime extension, and an exact root/`src` runtime
candidate with any other extension fails rather than being silently skipped.
Non-code public assets remain outside the source inventory. Tests,
generated Convex bindings, and ten exact one-shot migration/seed files are
excluded.
Declarative schema, localization, generated mobile API, and style-catalog files
have narrow metric-specific exemptions; they are not excluded from every
metric. The exact manifest lives beside the scanner so additions are visible in
review.

The global budgets are:

| Metric                | Budget |
| --------------------- | -----: |
| File code lines       |    600 |
| Function code lines   |    120 |
| Cyclomatic complexity |     15 |
| Control-flow nesting  |      4 |
| Parameters            |      5 |

The committed baseline stores only budgets already exceeded at its source
commit. Checks compare the working tree against both that historical inventory
and the current `origin/main` analysis. A current value at or below both legacy
ceilings passes; an improvement already merged to main immediately becomes the
tighter ceiling, so old headroom cannot be reintroduced. A previously compliant
entity that crosses a global budget fails as new debt.

The initial inventory contains 748 production files: 57 exceed the file budget,
231 functions exceed the function budget, 283 functions exceed the complexity
budget, 5 functions exceed the nesting budget, and 8 functions exceed the
parameter budget. One function can contribute to more than one count.

Function identity uses lexical ownership and a semantic hash rather than line
numbers. Paths are normalized and case-fold collisions fail. Matching is
one-to-one: a pure rename or move can inherit one legacy budget, while a copy
cannot make that budget multiply. Same-anchor edits need structural similarity,
so deleting and recreating unrelated code under an old name is treated as new.
Baseline records are canonical, duplicate-free, and verified against their
source commit. The source must be in complete `origin/main` history and ancestral
to the checked-out commit. The latest mainline tree is pinned before analysis;
when it is newer than the baseline source it supplies an additional, tighter
ratchet. CI never writes a baseline or accepts branch-created debt through
baseline generation.

Baseline changes require a dedicated review. The JSON is an exact, recomputed
inventory of its source commit, so hand-editing, lowering, or raising individual
budgets fails validation. To refresh the inventory after improvements are on
`origin/main`, run
`node quality/maintainability.mjs --write-baseline <full-origin-main-commit>`
and review the stdout diff before replacing the file. The command cannot use a
branch-only commit and has no in-place output option. If a legitimate move plus
edit cannot be matched safely, improve the matcher with regression coverage or
bring the entity under budget; do not hand-add an exception.

## Architecture ratchet

Dependency Cruiser 17.4.3 resolves TypeScript aliases, workspace imports,
re-exports, CommonJS imports, and literal dynamic imports. Nonliteral runtime
`import()` calls and indirect CommonJS loaders fail closed because their targets
cannot be audited. A direct literal `require()` remains allowed and participates
in the dependency graph. Repository-local worker `importScripts()` calls fail
closed because Dependency Cruiser cannot trace that edge; direct literal
external URLs remain allowed. Access to `node:module` through namespaces,
dynamic or CommonJS loading, re-exports, or `createRequire` also fails closed;
ordinary static named imports from that built-in remain allowed. Loader-capable
`node:process` and `node:vm` access, plus `eval`/`Function` code generation, is
rejected when it could hide a repository dependency. Proven Function
constructors, immutable reflection aliases, and statically bound constructor
keys are covered. Arbitrary runtime-computed property indirection and prototype
descriptor extraction remain outside the static proof; introducing either is a
review-significant escape pattern rather than an accepted exception.

Tests remain in the graph as targets, so production cannot hide a dependency
behind a test suffix; test-origin edges are excluded from production boundaries
and cycle debt. Type-only dependencies count for layer rules, but a type-only
return edge cannot create a runtime cycle. Runtime modules under `quality` are
also scanned so the guardrail system cannot depend on application code or add a
cycle of its own. The graph begins at every audited production root plus all
installed-framework runtime filename variants and the full `public` tree, then
follows repository source dependencies so a bridge through an otherwise
unscoped helper cannot hide a cycle or boundary violation.

Ten zero-debt boundaries are enforced:

1. Convex backend modules cannot depend on web presentation or mobile code.
2. `packages/shared/src` cannot depend on application layers.
3. Lower layers cannot import Next.js `app` route entrypoints.
4. Mobile code cannot import the web app, web components/hooks, or Convex
   implementation modules.
5. Web app, component, and hook modules cannot import mobile application code.
6. `lib` and the dealer worker cannot import web or mobile presentation code.
7. Quality tooling cannot import application runtime modules.
8. Production modules cannot import `.test`/`.spec` or `__tests__` modules;
   tests may still import production modules.
9. Ordinary production modules cannot import the exact migration/seed files
   excluded from maintainability metrics. Migrations may still import audited
   runtime modules or other migrations, and tests may exercise them.
10. Audited production modules cannot import repository source outside the
    maintainability scope; production helpers must live under an audited root.

The baseline records the one existing runtime accounting strongly connected
component as seven exact modules and thirteen exact internal edges. Every
current cyclic edge must be present in the baseline and every baseline edge
must still be cyclic. Consequently, a new edge or module fails, while an
improvement must remove its now-stale baseline entry in the same PR. Aliases,
barrels, and dynamic imports do not evade this comparison. Paths are canonical,
case-insensitive identities; unresolved repository-looking imports fail closed.

The guard reconstructs the declared source commit in an isolated temporary
worktree and recomputes its cycle snapshot. A submitted baseline may only be a
subset of both that proven snapshot and the baseline already on `origin/main`.
During initial bootstrap, before `origin/main` has an architecture baseline, the
source commit must equal the exact resolved current `origin/main` commit. This
permits same-PR pruning after an improvement but rejects source rollback,
branch-created cycles, and reintroduction of previously pruned debt.
Architecture baseline updates are manual and reviewable. Do not allowlist a
cyclic module or directory, and do not retain stale edges: either choice would
permit later regrowth.

## AutoFlow-specific safety rules

These are zero-debt AST rules. Each has passing and failing executable fixtures
under `quality/tests`.

1. **Admin authentication first.** Every public builder in `convex/admin*.ts`
   must await super-admin authentication before database, network, or other
   executable work. The established delegated authentication used by the admin
   user action is supported. Builder aliases and exported registrations are
   traced; missing, late, unawaited, swallowed, conditional, shadowed,
   reassigned, or dead-closure checks fail.
2. **Financing economics revision coupling.** A patch or replacement that
   writes a protected financing economics field must co-write
   a statically proven `economicsRevision` increment in the same resolved
   payload. Payload variables, computed keys, helpers, object spreads, database
   aliases, object-held databases, local persistence helpers, bound/call/apply
   write methods, `Reflect.get`/`Reflect.apply`, standard Function-prototype
   invocation wrappers, and statically resolvable tuple spreads are inspected.
   `Object.assign`, `defineProperty`/`defineProperties`, and `fromEntries`
   payload construction are covered. The revision must come from the same
   database row; conditional mutation, deletion, or merely copying the old
   revision is not a bump. Relative imported payload factories are followed
   through immutable named, namespace, default, and re-export bindings; their
   returned payload and call-site arguments are analyzed, while an opaque
   payload fails closed when the target is proven to be a finance application.
   Imported row helpers fail closed except for the exact structurally verified,
   read-only
   `convex/utils/vehicleOwnership.ts#consignedSettlementRoute` projection; any
   re-export, signature/body change, reassignment, or known prototype mutation
   invalidates that proof.
3. **Aggregate-aware mutation builders.** Production Convex modules must import
   `mutation` and `internalMutation` from `convex/functions.ts`, never from
   `_generated/server`. Aliases, namespaces, re-exports, `.js` specifiers, and
   dynamic imports are covered. A generated-server namespace may not escape
   through an object/array container, helper call, callback, proxy, or
   unverified reflection alias; pass an explicitly safe query/action member
   instead. Queries, actions, internal actions, and type-only imports remain
   allowed because the aggregate wrapper does not replace them. Only the five
   generated Convex binding outputs are skipped; other JavaScript/TypeScript
   under `_generated` remains subject to the rule.
4. **Exact aggregate trigger wiring.** Every `TableAggregate` variable needs
   its own `idempotentTrigger()` registration, and both database writer trigger
   sets must call the shared registrar. Matching uses aggregate variable
   identity rather than table name, so two aggregates over the same table
   cannot mask one missing registration. Mutable, conditional, subclassed, or
   reassigned constructor/registrar provenance fails closed. Immutable object
   aliases plus named, namespace, and default local re-exports are resolved;
   the two required writer arguments must retain the canonical writer
   identities rather than merely reuse their names.

The repository's existing tenant-write guard remains part of the normal unit
test suite. It is not duplicated or weakened here.

## Diagnostics and CI

Failures identify the rule, normalized file, source line where available, the
observed value or dependency edge, and the allowed legacy/global budget. Fix the
code when practical. Legitimate exclusions require a narrow manifest change,
an explanation, and regression coverage. Do not add broad globs, inline disable
comments, or branch debt to either baseline.

Actions runs the regression fixtures and repository scans in the existing
required `lint` job. That keeps the guardrails merge-blocking without changing
live branch-protection settings, while the job itself continues to run in
parallel with tests, type checks, builds, security scans, and dependency audit.
