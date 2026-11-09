# SCRUM-850 round 4 implementation evidence

Worktree `E:/tmp/auto-850`, branch `claude/scrum850-opening-correction`.
Starting head `9b2003b2ac294fe66d1d5a878406de21efb27c25`; supplied base and
freshly fetched origin/main `95ffa13e91e9c619336ac9d4274c560d3b132121`, zero behind
at the start. The coordinator owns Jira, GitHub and independent review seats.
No external posts, push, deployment, production reads or backend-connected
browser tests were performed. Seat 1 LOW findings are unchanged.

## Invariant and independent reproduction

A cutover attestation stores exact reviewed monetary gross totals per currency,
or refuses before writing either its sign-off row or its financial audit copy.
The reviewed production code includes POSTED and REVERSED journals. Thus the
gross history includes the original opening, its linked reversal and replacement.
The safe per-opening BigInt cap and safe account snapshot shards do not cap this
history. No journal is dropped or netted to make the attestation fit.

The new suite uses registered public commands through convex-test for both
reviewed approval and owner direct posting. It posts `9007199254740991` to
CASH_ON_HAND/RETAINED_EARNINGS, requests and independently approves governed void,
then posts `1` to VAT_RECEIVABLE/SALES_TAX_PAYABLE. A signer distinct from the
replacement approver calls sign-off. The tests independently sum retained lines
with BigInt and assert literal exact debit and credit `18014398509481983`.
Every stored account snapshot operand is safe. At the red commit sign-off
instead resolves with both gross totals `18014398509481984`, `isBalanced: true`.

Failing-first commit `a1918002ef42fe9fd8ad0fdf5518fbb1a7468765` contains all
12 literal test names, before any production fix. Full-file run there:

```text
pnpm exec vitest run --maxWorkers=1 convex/accountingCutoverExactness.scrum850.test.ts
Test Files 1 failed (1)
Tests 6 failed | 6 passed (12)
VITEST_EXIT=1
```

Output: `%TEMP%/s850-r4-red-a1918002e.log`. The six failures are both public
unsafe lifecycle cases, isolated unsafe debit/credit history, and both legacy
comparison gross sides. Both ordinary, both below-limit and both currency
controls pass. The first authoring run had nine tests; its four intended failures
are not substituted for the committed twelve-test run.

## Design, review differences and impact

Reuse `addBalanceMinor` and translate only `isUnsafeBalanceError` to
`CUTOVER_UNSAFE_TOTAL`. Unexpected errors escape unchanged. This distinct code
truthfully names journal-based cutover totals; snapshot-specific wording would
misidentify the failed computation. The EN/AR message applies to the sign-off and
the comparison query. The error is thrown during read-only aggregation, before
the sign-off insert and `auditLog`, and remains uncaught by the mutation.

I agree with the reviewer's minimal checked-addition fix. Differences in proof:
I require refusal rather than accepting either success or refusal, and compare
all existing audit rows before/after rather than expecting an empty audit table.
Opening/void legitimately leave earlier audits. I add explicit one-sided corrupt
historical-data fixtures because a balanced overflow is caught by either side
and cannot independently kill removal of the other check. Those controls assert
the arithmetic code, so ordinary unbalanced refusal is insufficient. Currency
fixtures represent retained pre-currency-change history by editing test data;
they do not claim that today's locked currency setting can be changed publicly.
The legacy fixture similarly represents retained migrated history, not an enabled
`transactions` source writer. No existing assertion was changed or weakened.

One read-only advisory design attack found these proof details and verified the
opening/void BigInt path. It is not an independent seat or certification.
`correct` guidance was applied to the repeated gross-aggregation mistake class:
round 3 snapshot accumulators and round 4 journal attestation accumulator are
distinct consumers. Reusing the shared arithmetic and permanent public tests
is the scoped prevention; a new exact storage model is outside this repair.

| Impact area | Disposition |
| --- | --- |
| Writers | One sign-off writer, its returned response and audit copy; aggregation refuses before writes. |
| Readers | `listSignOffs` returns persisted snapshots; no recomputation or historical rewrite. |
| Historical data | Unsafe journal operands/totals refuse; already-rounded attestations are not repaired. |
| State transitions | Both posting routes, governed void and re-entry retain state/version checks. |
| Reversal | Original and reversal remain in gross history. No new spend or reversal door. |
| Idempotency | No new command identity; existing retry and void controls rerun. |
| Authorization | Finance permission and distinct signer unchanged; no flags enabled. |
| Tenant isolation | Organization-indexed reads retained; tenant write guard is required. |
| Ledger | Arithmetic-only reader change, no journal/snapshot writer change or added I/O. |
| Audit | Ordinary snapshot copy equals persisted readback; refusal preserves full prior audit rows. |
| UI | New bilingual error entry only; no tracked sign-off UI caller found in the census below. |
| E2E | Public-function serial harness only. Browser/backend tests prohibited in this lane. |
| Runtime/release | No deploy, real OCC, cloud limits, production prevalence or pilot certification claimed. |

## Gross accumulator and consumer census

Scope: tracked repository source, searched with graft plus `git grep` for
`accountingCutoverSignOffs`, `listSignOffs`, `trialBalanceByCurrency`, the three
cutover exports and every `+=`/`reduce` in `accountingCutover.ts`. Graft cannot
resolve registered-export caller edges, so literal source enumeration supplied
that part of the census. References below use fixed-code line numbers.

| File:line | What it sums or consumes | Verdict and change |
| --- | --- | --- |
| `convex/accountingCutover.ts:206-207` | Both gross journal sides by currency across POSTED/REVERSED history | Reproduced blocker; both use checked addition. |
| `convex/accountingCutover.ts:287-288,321` | Per-opening gross sides | BigInt plus safe-range admission; unchanged. |
| `convex/accountingCutover.ts:1694-1695` | Gross GL sides from posted events with `sourceType=transactions` | Pre-existing sibling excludes opening/void sources; both additions now checked. Ordinary Phase17 comparison retained. |
| `convex/accountingCutover.ts:1672-1673` | Legacy major-unit transactions converted to minor IN/OUT totals | Separate pre-existing legacy cashflow class, not journal debit/credit and not a sign-off snapshot source. Opening/void does not create these rows; unchanged, coordinator follow-up if desired. |
| `convex/financialAudit.ts:247-248` | Manual per-journal line admission | Reachable from opening but BigInt exact/safe-total preflight at cutover `:584-585` precedes it; void verifies/copies exact lines. No wrong stored result through this lifecycle; unchanged. Other manual admission is a separate pre-existing class. |
| `convex/accounting/postingRules.ts:3617-3618` | Event-rule per-journal admission | Opening/void insert direct journals and do not call it. No PR-lifecycle reachability; unchanged. |
| `convex/accountingCutover.ts:1759,1825-1851` | Build snapshot, insert sign-off, return snapshot, pass `after: snapshot` to auditLog | Shared checked sum precedes writes; no storage shape change. |
| `convex/financialAudit.ts:99-116` | `auditLog` inserts its supplied `after` into financialAuditLog | Copy only, no arithmetic; ordinary persisted copy and refusal preservation tested. |
| `convex/accountingCutover.ts:1855-1866` | `listSignOffs` reads stored snapshots | Unchanged, public persistence assertions. |
| `convex/openingBalanceMaintenance.ts:55` | Sign-off existence blocks void | Existence only, no totals consumed; unchanged. |
| `convex/schema.ts:5956-5981` | Snapshot Float64 schema and org index | Unchanged; schema is not an exact-integer proof. |
| `scripts/orgDeletionCoverage.test.ts:74` | Table name in deletion registry | No numeric consumer; unchanged. |
| Tracked app/components/apps/dealer-worker source | Snapshot/UI consumer census | No `listSignOffs`/`trialBalanceByCurrency` UI reference found in this scoped enumeration. No rendered UI claim. |

## Five predicted failures and tests

1. A catch might commit certification/audit writes. Refusal tests compare the
   empty sign-off table and unchanged full audit rows, after public lifecycle setup.
2. One side could remain unchecked. Isolated debit and credit histories assert
   the arithmetic code, and each check gets its own source mutant.
3. Netting or excluding originals could hide overflow. BigInt retained gross
   literals and exact ordinary persisted `600008` require the full history.
4. A global total could mix currencies. Each currency is safe while their mixed
   sum exceeds MAX_SAFE_INTEGER; sign-off still stores both buckets exactly.
5. Overbroad refusal could reject ordinary/near-limit sign-off or either posting
   route. Both routes persist `600008` and safe boundary `9007199254740990` exactly.

## Verification record

Initial fixed-code new suite: 12 passed. All measured commands name test files
and use `--maxWorkers=1`. Final check and mutation results will be appended after
the implementation commit, with restored-source verification. No unavailable
property is represented as passing.

## Official sources and limitations

Checked on 2026-11-09:

- [ECMAScript Number.isSafeInteger](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger): safe operands and accumulated Number results must stay within the exact integer range.
- [Convex types](https://docs.convex.dev/database/types): `v.number()` stores Float64; exact Int64 is a different API/schema contract.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): structured `ConvexError.data` carries the clean code/message.
- [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ): mutation transactions roll back on propagated failure. The serial convex-test observations do not prove cloud concurrency or platform limits.

No new module needs API registration. `convex/_generated/api.d.ts` was not
regenerated or staged. Protected initial local edits and unrelated untracked
files remain outside this lane's commits. Independent seats, all three bug
hunters, authenticated phone/desktop EN/AR rendering, live historical data and
exact-head CI remain with the coordinator; none is inferred from local checks.
