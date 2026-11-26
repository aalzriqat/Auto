# AutoFlow

**A multi-tenant operating system for car dealerships.**

AutoFlow is an end-to-end platform that runs the daily operations of an automotive dealership — inventory, sales, financing, accounting, staff, and a cross-dealer marketplace — behind a single bilingual (English / Arabic) interface. It is built as a strictly multi-tenant SaaS: every record is scoped to an organization, and access is governed by fine-grained, per-org role-based permissions.

The platform ships as a web application, a companion mobile app, and an edge worker, sharing one strongly-typed backend.

---

## Highlights

- **True multi-tenancy** — every entity is org-scoped end to end, with an onboarding flow for users without an organization.
- **Fine-grained RBAC** — permissions are `action:resource` strings composed into customizable per-org roles (`OWNER`, `MANAGER`, `SALES`, `RECEPTION`, `ACCOUNTANT`, …). All authorization is enforced server-side.
- **Double-entry accounting** — a general-ledger subledger with journals, COGS/commission recognition, prepaid amortization, and reconciliation reporting.
- **Approval workflows** — vehicle creates/edits, status changes, and below-minimum-profit sales route through a pending → approved/rejected flow with a full audit trail.
- **Dealer marketplace** — a reverse marketplace that matches buyer requests to inventory across dealers, with push notifications and messaging.
- **Bilingual, RTL-aware UI** — first-class English and Arabic support, with dynamic font swapping and full right-to-left layout.
- **Super-admin control plane** — a cross-tenant operations console, isolated from per-org RBAC, for platform administration and system health.

## Feature surface

Inventory & sourcing · Customers & leads · Sales & commissions · Financing applications · Deposits & payments · Expenses & payroll · Accounting & reports · Tasks · Team & permissions · Notifications · Internal messaging · Social inbox · Cross-dealer marketplace.

---

## Architecture

AutoFlow is a **pnpm monorepo** built around a single Convex backend that every client consumes through generated, type-safe APIs.

```
apps/mobile        React Native (Expo) companion app, OTA-updatable
convex/            Backend: queries, mutations, schema, cron jobs, HTTP endpoints
app/               Next.js App Router — dashboard, auth, marketing pages
components/         UI (shadcn/ui + Tailwind), providers, domain components
lib/               Shared client logic (financing math, i18n, utilities)
dealer-worker/     Cloudflare Worker for edge-side dealer integrations
packages/          Shared cross-app code
```

**Stack**

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React, TypeScript |
| Backend | Convex (reactive database + server functions) |
| Auth | Clerk (web + native), synced to Convex via Svix webhooks |
| Styling | Tailwind CSS, shadcn/ui, `sonner` toasts |
| Forms | react-hook-form + zod |
| Mobile | React Native / Expo with OTA updates |
| Edge | Cloudflare Workers |
| Observability | Sentry |

**Design principles**

- **Backend owns the truth.** All validation and business logic live in Convex functions; the frontend is never trusted to enforce a rule. Auth is centralized in `convex/utils/tenancy.ts` (`requireAuth`, `requireTenantAuth`, `requireOwner`, `requireSuperAdmin`).
- **Soft deletes everywhere.** Entities carry `isDeleted` / `deletedAt` / `deletedBy` and are filtered out of reads.
- **Defensive frontend.** Optional chaining and fallbacks on all async/nested data, with explicit loading and empty states.
- **Zero-`any` TypeScript.** Types are explicit and generated types are treated as source of truth.

---

## Getting started

**Prerequisites:** Node 22+, pnpm, and Convex / Clerk accounts.

```bash
pnpm install
pnpm dev          # runs the Convex dev server and Next.js together
```

Configure the required environment variables (Clerk keys, Convex deployment, webhook secrets) before first run. The mobile app and dealer worker are managed through the workspace scripts below.

### Common scripts

```bash
pnpm dev              # Convex + Next.js, watched
pnpm build            # production web build
pnpm lint             # ESLint
pnpm test             # unit + Convex function tests (vitest)
pnpm typecheck        # tsc --noEmit
pnpm preflight        # the mechanical pre-push checks in one run (see below)
pnpm mobile:start     # start the Expo mobile app
pnpm mobile:android   # run the mobile app on Android
```

### Before you push: `pnpm preflight`

Runs, cheapest first and without stopping at the first failure: the `convex/_generated/api.d.ts` order and completeness check (an offline emulation of the Convex generator), the quality guardrails, the contract-skew baseline evidence check, eslint on the changed files, and all three typechecks (`typecheck:convex`, `typecheck` and `typecheck:contract-skew`), which always run, as in CI (about 2-3 minutes cold; only a docs-only diff skips them). It prints one PASS / FAIL / NOT APPLICABLE line per check, the total time, and the command or edit that fixes each FAIL; it exits non-zero if any check fails, and a check that cannot run counts as a FAIL. `pnpm preflight --tests` also runs vitest (`--maxWorkers=1`) on the changed `*.test.ts` files. It compares against `origin/main` as last fetched, so `git fetch origin` first; `--base <ref>` compares against another ref. It is advisory and CI remains the gate: the full lint, the whole test suite and the real Convex codegen still run there. It reads the working tree while CI reads the pushed commit (and the baseline check reads HEAD), so commit first, then run it; it warns when the tree has uncommitted changes. Details: `scripts/preflight/preflight.mjs`.

Two more checks (SCRUM-1011) catch what failed our required SonarCloud gate and the registration inventories before CI does:

- **`sonar-lint`** runs ESLint with `eslint.preflight.config.mjs` on the changed files: the main config plus 13 hand-picked `eslint-plugin-sonarjs` rules that mirror SonarCloud rules which have failed us (table with S-numbers: `scripts/preflight/sonarRules.mjs`). Only findings on lines the change added or modified count, as in Sonar's new-code gate (a legacy finding on an untouched line of a touched file is ignored). Findings in Sonar's bug and vulnerability classes (S2871 alphabetical `sort()`, S3403 dissimilar-type `===`, S4036 PATH-resolved child process, S5852 catastrophic regex) are errors and FAIL the check, with the rule id, `file:line` and the S-number in the fix line. Code-smell classes (S3776 complexity over 15, S3358 nested ternary, S4624 nested template literal, S6759, S1481, S1854, S4043, S6594, S8786) are printed as warnings and counted but never fail. Typed rules run on TypeScript through the TypeScript project service and on plain `.mjs`/`.js` through `tsconfig.preflight.json`. `pnpm lint` and `eslint.config.mjs` are unchanged. A rule that cannot load, or a file that cannot be parsed, is a FAIL, never a skip.
- **`picomatch-backport`** runs `scripts/security/verifyPicomatchBackport.mjs`, the check CI's required `dependency-audit` job runs after install, when `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vendor/picomatch/` or `dealer-worker/package-lock.json` changed (about 2 s). A lockfile that installs cleanly can still fail it, for example when a second snapshot of a picomatch consumer appears.
- **`inventories`** runs the registration-inventory tests CI runs as unit tests (`scripts/tenantWriteGuard*.test.ts`, `scripts/regression/pilotDoorInventory.test.ts`, `scripts/economicCommandCensus*.test.ts`, `--maxWorkers=1`) when `convex/` or one of those tests changed; otherwise NOT APPLICABLE. About 1 minute.

**ESLint is not Sonar.** A clean `sonar-lint` does not prove the Sonar gate will pass; treat the local pass as "the known failure classes are absent", not as the gate. What it does and does not see:

- Replayed on PR #898 (head `eeddc280b`), it caught 15 of the 20 SonarCloud findings. The five it cannot see are S6557, S7750, S7781 and S7786 (newer Sonar rules that are not in `eslint-plugin-sonarjs` 4.2.1 at all) and S8705 (a taint-analysis rule with no local equivalent).
- It does not measure test coverage or code duplication, which SonarCloud's gate also checks.
- It does not lint `apps/**` or `packages/**`, although SonarCloud scans them: `eslint.config.mjs` ignores both (they carry their own toolchains) and `tsconfig.preflight.json` excludes them.
- It ignores `eslint-disable` comments (`--no-inline-config`), because SonarCloud does not honour them either; only findings from the 13 `sonarjs` rules count, so other ESLint messages never change its result.
- It reads `git diff -U0` against the merge-base with git's quoting, path-prefix, external-diff, textconv and inter-hunk-context settings pinned (and `GIT_DIFF_OPTS` / `GIT_EXTERNAL_DIFF` removed from the environment), and parses it by the diff format. The guarantee is narrow: if the parser meets anything it does not fully understand for a file (a context line, a hunk whose length does not match its header, a combined-diff header, a repeated header block), that file gets no entry and every line of it is judged. Source lines that look like diff headers therefore cannot narrow the judged lines of any file.
- `inventories` runs only when a file under `convex/` or one of `scripts/tenantWriteGuard*.test.ts`, `scripts/economicCommandCensus*.test.ts` or `scripts/regression/pilotDoorInventory.test.ts` changed. A registration inventory fed by any other file is not re-checked locally.

The plugin is pinned exactly, so lockfile regeneration cannot drift onto a release younger than the pnpm `minimumReleaseAge` gate; run `pnpm install --frozen-lockfile --ignore-scripts` with pnpm 11.13.0, as CI does, to check a lockfile change before pushing.

Measured added time on this machine (cold, Windows): `sonar-lint` about 7 s for changed `.mjs` files only, about 13 s for one `convex/` file, about 17 s for `lib/` TypeScript, and about 25 s for a mixed 5-file change (the project-service start-up dominates); `inventories` about 56 s when it applies.

---

## Testing

Quality is enforced at multiple levels:

- **Unit & backend tests** — `vitest` with `convex-test` exercises Convex functions in isolation, plus library-level tests for pure logic (financing math, date handling, i18n).
- **End-to-end** — **Playwright** covers the critical flows (sign-in, dashboard, inventory, customers, leads, expenses, an end-to-end cash sale, marketplace listings, and language switching) against a real production build.
- **Load testing** — `k6` smoke and 1,000-user scenarios under `load-tests/`.
- **Coverage** — tracked in CI with per-module thresholds on the accounting core.

```bash
pnpm test                 # unit + backend
pnpm e2e:playwright       # Playwright E2E
pnpm test:coverage        # coverage report
```

---

## Deployment

The web app deploys to Vercel; the Convex backend deploys via the Convex CLI; the mobile app ships production builds and over-the-air updates through Expo/EAS; and the dealer worker deploys to Cloudflare. CI runs linting, type-checking, tests, and the E2E suites on every change.

---

## License

Proprietary. All rights reserved.
