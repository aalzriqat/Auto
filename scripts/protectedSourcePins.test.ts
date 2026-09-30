import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Exact content pins for the sources SCRUM-215 P3 was reviewed against.
 *
 * ## What this asserts — the whole claim, stated narrowly
 *
 *   The protected source files are byte-for-byte the owner-reviewed
 *   postimages, modulo CRLF→LF checkout normalization.
 *
 * That is all. It is a CHANGE-CONTROL ratchet, not a security boundary and not
 * a safety proof.
 *
 * ## What this deliberately does NOT claim
 *
 * It does not prove that all database access is recognized, that all predicate
 * spellings are recognized, that raw reads are structurally impossible, or that
 * the wrapper is semantically safe under any refactor. It cannot: it never
 * looks at the code's meaning at all. A file that matches its pin has not
 * changed; nothing more follows from a match.
 *
 * ## Why it is a hash and not an analyzer
 *
 * Five successive generations of a semantic recognizer were built for this
 * lane, reviewed, and defeated — each by a construct its author had not
 * enumerated: an unrunnable `git diff` baseline, occurrence counting beaten by a
 * net-zero swap, regexes beaten by three raw-read spellings and by a decoy
 * string literal, an AST walker beaten by `ctx[k]`, and finally a version that
 * refused computed access wholesale, beaten by `Reflect.get(ctx, "db")` plus a
 * predicate reassembled from `"REJ" + "ECTED"`. The lesson recorded in the Jira
 * history and in git is that "recognize every unsafe spelling" is not a
 * property a single-file, type-checker-less analyzer can hold. Pinning content
 * abandons recognition rather than extending it, so there is no sixth spelling
 * to find.
 *
 * The cost is intentional friction: any legitimate change to a pinned file
 * requires explicit owner authorization, renewal of the constants below, and a
 * fresh exact-SHA certification. A silently updated pin is the same as no
 * ratchet at all.
 */
describe("protected source content pins", () => {
  const repoRoot = path.resolve(__dirname, "..");

  /**
   * Complete file contents, with CRLF→LF applied and nothing else.
   *
   * Normalization is load-bearing rather than cosmetic: this repository has no
   * `.gitattributes` and `core.autocrlf=true`, so an identical commit is larger
   * on a Windows worktree than on a Linux runner. A raw byte hash would pass on
   * one and fail on the other. A bare `\r` is rejected rather than normalized —
   * it is not a checkout artifact, so silently folding it would let a real
   * content change hide inside the normalization step.
   */
  const normalized = (relativePath: string): string => {
    const raw = readFileSync(path.join(repoRoot, relativePath), "utf8");
    const text = raw.replace(/\r\n/g, "\n");
    expect(
      text.includes("\r"),
      `${relativePath} contains a bare CR, which checkout normalization does not explain.`
    ).toBe(false);
    return text;
  };

  const sha256 = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

  const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

  /**
   * The reviewed postimages.
   *
   * ⚠️ These are computed from the approved files themselves. Do not copy them
   * from a report, a Jira comment or a chat message — a truncated or restated
   * digest pins nothing.
   */
  const PINS = [
    {
      /**
       * Immutable for a structural reason, not an architectural one: it carries
       * seven historical non-indexed query filters that predate the repository's
       * Convex lint rule, and that guard evaluates the whole projected file.
       *
       * ⚠️ WHAT THIS FILE'S DELTA ACTUALLY IS, relative to the branch this PR
       * merges into — stated because the shorter story is misleading.
       *
       * Against `origin/main` this file differs by **32 insertions and 4
       * deletions**, not by one token:
       *
       *   1. `pendingDepositResolution` is extracted into an exported function
       *      from logic previously inlined in `applications.list`, and `list`
       *      now calls it. Behaviour-preserving, covered by
       *      `applications.test.ts` and `dealWorkspace.test.ts`.
       *   2. `dealCockpit`'s payload gains two additive fields,
       *      `documentRulesApply` and `supplierDisbursementConfirmedAt`.
       *
       * The "one token" description is true only against `fa9d48d09` on the
       * parked `agent/scrum-215-unified-deal-p0-p3` branch — a lineage that is
       * NOT an ancestor of main and whose combined candidate failed review. That
       * framing understated the reviewable surface roughly thirtyfold and lent
       * an owner authorization, granted for one token, to content that
       * authorization never covered. Read the 32 lines; do not take this
       * comment's word for their pedigree.
       *
       * -- RENEWAL 2026-09-08 - SCRUM-57 ---------------------------------
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  214777
       *   sha256: 2ae2518ea68d67d320a19d76402f55683d8030e1e10284ef86af2c9ad560eab6
       *
       * Renewed because SCRUM-57 makes economic command identity mandatory, and
       * five mutations in this file are economic. The delta is five hunks of one
       * shape - `idempotencyKey: v.optional(v.string())` becomes `v.string()` and
       * `economic: true` is added to the `runWithIdempotency` args - for
       * `cancelApplication`, `finalizeDeal`, `confirmDisbursement`,
       * `confirmSupplierDisbursement` and `amendSupplierDisbursementAdvice`, plus
       * a `fingerprint` for `finalizeDeal`, which previously had none.
       *
       * No control flow, query, predicate or `ctx.db` access changed, so none of
       * the constructs this ratchet exists to catch are touched by the delta.
       * Read the five hunks; do not take this note's word for their scope.
       *
       * Renewed under explicit owner authorization for SCRUM-57's integration
       * repair, with the instruction that the pin must not be weakened, bypassed,
       * deleted, generalized or made vacuous to obtain a green check. It was not:
       * this is still an exact byte + sha256 pin on the same two files, the
       * negative control below is untouched, and normalization and the bare-CR
       * rejection are unchanged. Cross-lane notice to the owning ratchet lane was
       * posted BEFORE this change - Jira SCRUM-215 `c18246`.
       *
       * Both constants were recomputed FROM THE FILE, with this test's own
       * normalization, not copied from a report or a Jira comment.
       *
       * -- RENEWAL 2026-09-11 - SCRUM-241 (in the SCRUM-313 RC lane) --------
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  215115
       *   sha256: 65cfe8d241f2e745e5b8e93cd2493d499dd49fb822e091c9d90ef1c15bd5501f
       *
       * Renewed because SCRUM-241's canonical correction (owner-proxy c19230,
       * SCRUM-313 c19303) changes what `confirmDisbursement` settles and what
       * `finalizeDeal` accepts. Three hunks: a new `proveFinanceReceiptAuthority`
       * helper that loads the deal's finance-company receivable by
       * `by_org_source` and refuses on missing, foreign, non-OPEN, already
       * allocated or contradictory records BEFORE any write; `finalizeDeal`
       * refusing a pinned `economicsCurrency` that no longer equals the
       * organisation's currency; and `confirmDisbursement` settling the proved
       * figure in the receivable's own currency instead of the caller's amount
       * in the organisation's current currency, with the `min(outstanding,
       * caller)` allocation and the create-a-receivable-here fallback removed.
       * The new `ctx.db` access is one indexed `.unique()` read in the helper.
       * Read the three hunks; do not take this note's word for their scope.
       *
       * Renewed under the explicit owner-proxy authorization above, with the
       * same instruction: the pin is not weakened, bypassed, deleted,
       * generalized or made vacuous. Same exact byte + sha256 pin, same negative
       * control, same normalization and bare-CR rejection. Both constants were
       * recomputed FROM THE FILE with this test's own normalization.
       *
       * -- RENEWAL 2026-09-14 - SCRUM-116 (in the SCRUM-83/321 lane, PR #303) --
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  220303
       *   sha256: fc4a12211280087bd25a9b5a1305aabaa6976289bd5586f759697a9158e1e72c
       *
       * Renewed because an unsettled appraisal gap was enforced by the stage
       * rail alone: `registerVehicleHandover` and `finalizeDeal` never asked,
       * and handover seals the deal against `resolveAppraisalGap`. The delta is
       * exactly two hunks: one import name (`assertAppraisalGapSettledToAdvance`
       * from `./utils/financingEconomics`) and one call to it, with a three-line
       * comment, appended as the last check of `assertDealerEconomicsReady` —
       * the precondition BOTH mutations already run before their first write.
       * The refusal itself, its allowlist and its message live in the unpinned
       * utils module. No new control flow, query, predicate, permission check
       * or `ctx.db` access in this file. Read the two hunks; do not take this
       * note's word for their scope.
       *
       * Authorized by the implementing session's owner-side instruction of
       * 2026-09-14 ("add a minimal server-side refusal ... if the byte pin must
       * move, use the existing measured pin-renewal governance and disclose
       * it; do not weaken #305 boundaries"), disclosed on Jira SCRUM-117 /
       * SCRUM-83 and in #scrum-215 with the cross-lane notice to the ratchet
       * lane (AF-65). The pin is not weakened, bypassed, deleted, generalized
       * or made vacuous: same exact byte + sha256 pin, same negative control,
       * same normalization and bare-CR rejection. Both constants were
       * recomputed FROM THE FILE with this test's own normalization.
       * `convex/dealWorkspace.ts` is untouched.
       *
       * -- RENEWAL 2026-09-14 (2) - fee-template cap (SCRUM-83/321 lane, PR #303) --
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  220628
       *   sha256: dacdbfc9682687836350415a0fd4a4fa381c0900956c1c93576f96eab6b1103a
       *
       * Renewed because finance-company configuration needed a bounded policy
       * that reserves room below `MAX_LIVE_DEAL_FEE_LINES` for a deal's
       * additional costs, and `createFromQuote` could otherwise freeze a newly
       * noncompliant company policy onto an application. The delta is exactly
       * two hunks: one import (`assertFeeTemplatesWithinLimit` from
       * `./utils/dealCostLimits`) and one call to it on the snapshot just built,
       * with its comment, before the version-row read and before any write. The
       * limit, its message and its sibling checks on the company writers live
       * in the unpinned modules. No new control flow of its own,
       * no query, predicate, permission check or `ctx.db` access in this file.
       * Read the two hunks; do not take this note's word for their scope.
       *
       * Made under the same owner-side instruction as the entry above ("if
       * the byte pin must move, use the existing measured pin-renewal
       * governance and disclose it; do not weaken #305 boundaries"), in
       * response to the owner-proxy's preflight finding of 2026-09-14 that the
       * live-line cap made an oversized policy a dead end. This renewal is
       * part of the candidate evidence to disclose on Jira SCRUM-117 and in
       * #scrum-215 before merge. The pin is not
       * weakened, bypassed, deleted, generalized or made vacuous: same exact
       * byte + sha256 pin, same negative control, same normalization and
       * bare-CR rejection. Both constants were recomputed FROM THE FILE with
       * this test's own normalization. `convex/dealWorkspace.ts` is untouched.
       *
       * -- RENEWAL 2026-09-15 - supplier settlement on a DISPUTED claim (PR #310) --
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  221281
       *   sha256: 62928d43246a13a21bf5877451a7ac3c3c897b76b98610505091ecd1fa9a0f92
       *
       * Renewed because the deal cockpit had to say whether "Settle supplier"
       * may be recorded NOW from the same claim `recordReceipt` refuses on, so
       * a DISPUTED claim is withheld by the server's own verdict rather than
       * inferred by the client. The delta is exactly two hunks, 13 insertions
       * and 0 deletions (`ac9e7acc4` vs `35e99a2ed`): one import name
       * (`supplierReceiptActionability` from `./utils/financingEconomics`)
       * and one additive `supplierReceipt` field on `buildCockpitMoney`'s
       * payload, with its comment, computed by that helper from values the
       * function already held (`routeKnown`, `settlesDirect`, the supplier
       * claim's id and status, the supplier obligation). The decision itself
       * lives in the unpinned utils module. No new query, control flow,
       * predicate, permission check, export, workflow behavior or `ctx.db`
       * access in this file. Read the two hunks; do not take this note's
       * word for their scope.
       *
       * Made under the same owner-side instruction as the entries above ("if
       * the byte pin must move, use the existing measured pin-renewal
       * governance and disclose it; do not weaken #305 boundaries"), on the
       * reviewed change PR #310 carries; its unit-and-integration run passed
       * 5432 tests and failed only this pin. The pin is not weakened,
       * bypassed, deleted, generalized or made vacuous: same exact byte +
       * sha256 pin, same negative control, same normalization and bare-CR
       * rejection. Both constants were recomputed FROM THE FILE with this
       * test's own normalization. `convex/dealWorkspace.ts` is untouched.
       *
       * -- RENEWAL 2026-09-15 (2) - gap composition boundary (PR #314 R6) --
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  221884
       *   sha256: 6b1fe634ed1273704be0c6e050d3c7d47a6ccc8f228d826679c20497f9506c48
       *
       * Renewed because `buildCockpitMoney` composed the customer's gap
       * contribution inline — `(cash ?? 0) + (instalments ?? 0)` — so two
       * individually corrupt components (−100 + 200) cancelled into a safe
       * operand before any validation saw them (Codex gpt-5.6-sol HIGH on
       * PR #314 at `21bfcb812`). The delta is exactly three hunks, 11
       * insertions and 8 deletions: one import name
       * (`composeCustomerGapToDealer` from `./utils/financingEconomics`), one
       * local (`customerGapToDealer`) computed by that helper from the
       * application row the function already held, with the management
       * profit becoming `CorruptInput` when the composition is unreadable and
       * the existing `deriveManagementProfit` call otherwise, and that call's
       * `customerDirectToDealerMinor` reading the composed amount instead of
       * the inline sum. The validation itself lives in the unpinned utils
       * module. No new query, permission check, export, workflow behavior or
       * `ctx.db` access in this file. Read the three hunks; do not take this
       * note's word for their scope.
       *
       * Made under the same owner-side instruction as the entries above ("if
       * the byte pin must move, use the existing measured pin-renewal
       * governance and disclose it; do not weaken #305 boundaries"). The pin
       * is not weakened, bypassed, deleted, generalized or made vacuous: same
       * exact byte + sha256 pin, same negative control, same normalization
       * and bare-CR rejection. Both constants were recomputed FROM THE FILE
       * with this test's own normalization. `convex/dealWorkspace.ts` is
       * untouched.
       *
       * -- RENEWAL 2026-09-15 (3) - open custody blocks cancellation (AF-80) --
       *
       * Previous reviewed postimage, superseded by this entry:
       *
       *   bytes:  222110
       *   sha256: 2f0a3a2ae5e762105c305153719398a029a8b82cf5e14022ab4f52ff843d8251
       *
       * Renewed because employee cash custody now POSTS to the ledger
       * (DEAL_CUSTODY_CLEARING), and ACC-3 requires every un-happen path of
       * that spend to be handled or refused: `cancelApplication` refused
       * nothing about custody, so a cancelled deal could strand cash in an
       * employee's pocket on a record nothing offers actions on. The delta is
       * exactly three hunks, 22 insertions and 2 deletions: (1) two imports
       * (`loadCustodyRecords` from `./utils/settlementDeductions`, the
       * bounded custody loader every custody writer already uses, and
       * `financedSaleRecognitionDate` beside `resolveFinancedSalePlan`);
       * (2) one guard inside `cancelApplication`'s idempotent section, after
       * the already-CANCELLED early return and before the APPROVED permission
       * escalation, that loads the deal's custody records and throws while
       * any is OPEN — a CLOSED custody record is deliberately untouched, the
       * costs the employee really paid stay posted; (3) `finalizeDeal`'s
       * `completeSale` call dates the sale from
       * `financedSaleRecognitionDate(app, Date.now())` — the legal invoice's
       * date where one is recorded — instead of the bare wall clock, so the
       * period the sale's journal lands in is the one the invoice names
       * (owner-proxy finding on f1cca: `legalInvoiceDate` was documented to
       * decide the revenue period while the sale was dated at finalization).
       * No new query shape beyond the shared loader, no new export, no other
       * workflow behavior changed. Read the three hunks; do not take this
       * note's word for their scope.
       *
       * Same governance as the entries above: the pin is not weakened,
       * bypassed, deleted, generalized or made vacuous. Both constants were
       * recomputed FROM THE FILE with this test's own normalization.
       * `convex/dealWorkspace.ts` is untouched.
       *
       * -- RENEWAL 2026-09-25 - SCRUM-372 vehicle card (PR #338) ------------
       *
       * Previous reviewed postimage, superseded by this entry (single fee
       * authority renewal, S1-R3-H1..S1-R6-H1):
       *
       *   bytes:  236603
       *   sha256: d8082f5de2e49bd535ab41ca5894c48076fc20db40da474b2dd6b50eccd100a4
       *
       * Renewed because the deal cockpit's vehicle card needs the car's
       * identifying attributes. The delta is exactly two hunks, 4 insertions
       * and 0 deletions: (1) one import, `projectDealVehicleProfile` from
       * `./utils/dealVehicleProfile`; (2) in `dealCockpit`, one call to it
       * after the existing `Promise.all` on the vehicle row ALREADY loaded
       * there, and one additive payload field `profile` (with its comment)
       * inside the existing `vehicle` object. The helper lives in its own file:
       * it re-checks org and soft-delete and returns a six-field allowlist.
       * No new `ctx.db` access, query, index, predicate, mutation or control
       * flow in this file. Read the two hunks; do not take this note's word for
       * their scope.
       *
       * Renewed under the owner's standing autonomous authorization of
       * 2026-09-25; cross-lane notice posted BEFORE this change - Jira
       * SCRUM-215 `c20752`. Same governance as the entries above: the pin is
       * not weakened, bypassed, deleted, generalized or made vacuous. Both
       * constants were recomputed FROM THE FILE with this test's own
       * normalization.
       *
       * -- RENEWAL 2026-09-25 (2) - SCRUM-372 vehicle-card permission ------
       *
       * Previous reviewed postimage, superseded by this entry (the vehicle
       * card renewal just above):
       *
       *   bytes:  236882
       *   sha256: c46543e1803dff7d1e98bd4e377979c64eef8080e41f5f45d0fdc20bf955ef14
       *
       * Renewed because the card must follow VIEW_VEHICLES, not VIEW_SALES
       * (CodeRabbit on PR #338, accepted: a custom role can hold VIEW_SALES
       * without VIEW_VEHICLES). The delta is exactly one hunk in
       * `dealCockpit`, 3 insertions and 1 deletion: `canViewVehicles` is
       * derived from the `role` `requireTenantAuth` already returned, in the
       * neighbouring `canSeeMoney` idiom, and passed to
       * `projectDealVehicleProfile`, which returns null without it. It only
       * narrows what is returned. No new `ctx.db` access, query, index,
       * predicate, mutation or export. Cross-lane notice posted BEFORE this
       * change - Jira SCRUM-215 `c20763`. Same governance; both constants
       * recomputed FROM THE FILE with this test's own normalization.
       *
       * -- RENEWAL 2026-09-26 - SCRUM-37 tenant read boundary (PR #343) ------
       *
       * Previous reviewed postimage, superseded by this entry (the SCRUM-372
       * vehicle-card permission renewal just above):
       *
       *   bytes:  237014
       *   sha256: 9c353ded4a1154f7cd9095b2de2d984c86b681168161153f216ec0bbfadd2fbc
       *
       * Renewed because `getLog` read any organization's application status
       * history: membership of `args.orgId` proved nothing about
       * `args.applicationId`, so notes and actor names crossed tenants. The
       * delta is exactly two hunks, 23 insertions and 9 deletions: (1)
       * `getLog` proves the application with the existing `requireOwnedRow`
       * (already imported; missing and foreign refuse identically) and keeps
       * only log rows stamped with `args.orgId`; (2) `dealCockpit`'s
       * timeline, whose parent was already owned, keeps only rows stamped
       * with `args.orgId` before the actor lookup. No new import, export,
       * write, permission check or query shape: the same `by_application`
       * reads, narrowed in memory. Read the two hunks; do not take this
       * note's word for their scope.
       *
       * Made under the owner's standing full-authority directive of
       * 2026-09-26, with the cross-lane notice posted to the ratchet lane
       * BEFORE the change (Jira SCRUM-215 c20828, #scrum-215). Sol 6 and
       * Sonnet xhigh approved the code at `3d3443839`; Sol certified this
       * renewal against main `3866c8505` at `6af70d714`, and it was rebased
       * onto the SCRUM-372 renewals when #338 merged. The pin is not
       * weakened, bypassed, deleted, generalized or made vacuous: same exact
       * byte + sha256 pin, same negative control, same normalization and
       * bare-CR rejection. Both constants were recomputed FROM THE FILE with
       * this test's own normalization. `convex/dealWorkspace.ts` is untouched.
       *
       * A /simplify pass (owner rule 2026-09-27) then shortened only the two
       * hunks' comments (27 -> 23 insertions); every code line is unchanged.
       * Superseded pin for that step: 237857 / 7dfb02c2...0004674.
       *
       * -- RENEWAL 2026-09-27 - SCRUM-260 profit approval at the commit (PR #347)
       *
       * Previous reviewed postimage, superseded by this entry (the SCRUM-37
       * renewal just above):
       *
       *   bytes:  237565
       *   sha256: 0ed573139b3ba16ff5dee2d557ae3c6aab51b8ac385b102776545bfbd915b6d6
       *
       * Renewed because the minimum-profit approval moved from a quote-time
       * re-check in `finalizeDeal` to `completeSale`'s shared boundary
       * (utils/saleCompletion.ts), which proves it against the price the sale
       * persists for all four sale doors. The delta is exactly two hunks, 3
       * insertions and 14 deletions: (1) the now-unused import of
       * `assertProfitApproved` / `quoteModeRequiresMinimumProfit` is removed;
       * (2) the `finalizeDeal` block that re-checked `quote.desiredProfit` is
       * replaced by a three-line comment pointing at the shared boundary. No
       * new `ctx.db` access, query, index, mutation, import or export. Read
       * the two hunks; do not take this note's word for their scope.
       *
       * Made under the owner's standing full-authority directive of
       * 2026-09-26, with the cross-lane notice posted BEFORE the change (Jira
       * SCRUM-215 c20962). The SCRUM-260 code was certified by Sol 6 at
       * `4bcc1ea08` and rebased onto main `a1a0abd64` when #343 merged. Same
       * governance: not weakened, bypassed, deleted, generalized or made
       * vacuous. Both constants were recomputed FROM THE FILE with this
       * test's own normalization. `convex/dealWorkspace.ts` is untouched.
       *
       * -- RENEWAL 2026-09-27 (2) - SCRUM-373 D2 quote first-payment correction
       *
       * Previous reviewed postimage, superseded by this entry (the SCRUM-260
       * renewal just above):
       *
       *   bytes:  236998
       *   sha256: ec1c71d89d14d3ea9a545c1fe60ba76ecaa219504da113af3e975191f33132ed
       *
       * Renewed so the cockpit can say whether the approver may apply the
       * quote's first payment to a deal whose recorded split zeroed it. The
       * delta is three hunks, 36 insertions and 4 deletions: (1) imports of
       * `mayCorrectFirstPayment`, `quoteDownPaymentMinor` and
       * `firstPaymentCorrectionBlock` (and `mayEstablishAppliedLtv` dropped from
       * the projection import); (2) `dealCockpit` also destructures
       * `user` from its existing `requireTenantAuth` call, permissions
       * unchanged; (3) `dealCockpit` returns a money-gated
       * `firstPaymentCorrection` (null when `!canSeeMoney`), reading the quote
       * only once the cheaper conditions pass. No mutation, write, index or
       * permission change. Read the three hunks; do not take this note's word
       * for their scope.
       *
       * Amended once inside the same PR (CodeRabbit, #349): the cockpit's offer
       * read `mayEstablishAppliedLtv` while the action renders only for holders of
       * VIEW_FINANCE_APPLICATIONS, so the offer now reads `mayCorrectFirstPayment`,
       * the same permission list the mutation requires. Superseded pin for that
       * step: 238613 / 446e8979c307456bc4ae53dd26c50081c6654573a06a656c3aa8d74bd8782dca.
       *
       * Cross-lane notices posted BEFORE each change (Jira SCRUM-215 c20972, c20975),
       * under the owner's standing full-authority directive of 2026-09-26.
       * Same governance: not weakened, bypassed, deleted, generalized or made
       * vacuous. Both constants were recomputed FROM THE FILE with this test's
       * own normalization.
       *
       * -- RENEWAL 2026-09-27 (3) - SCRUM-404 record the calculated quotation at creation
       *
       * Previous reviewed postimage, superseded by this entry (the SCRUM-373 D2
       * renewal just above, as amended):
       *
       *   bytes:  238609
       *   sha256: fd9e75cde3446c86aea41878b9a3280d894ba39c431546bc1277f66477b1af8a
       *
       * Renewed so starting a finance application from a configured-company
       * quote can record the AutoFlow-calculated quotation the operator was
       * shown, in the same transaction. The delta, 87 insertions and 108
       * deletions: (1) imports — `mayRecordSubmittedQuotation` from the
       * projection, `applySubmittedQuotation` / `assertQuotationRecordAuthority`
       * from `./financingEconomics`, the two `./utils/creationEconomics`
       * resolvers (`resolveCreationRuleSnapshot`, `resolveCreationEconomicsInputs`);
       * the now-unused `buildRuleSnapshot` / `assertFeeTemplatesWithinLimit`
       * imports dropped; (2) `resolveExpectedExecutionFeesMinor` MOVED unchanged
       * to `convex/utils/creationEconomics.ts` (its one importer outside this
       * file, a test, now imports it from there); (3) `createFromQuote` takes an
       * optional `confirmedCalculatedQuotationMinor`, refused up front unless
       * the caller holds `create:finance_application` and would pass the
       * recorder's own authority check; (4) the rule snapshot and the
       * target / first payment / fees inputs now come from the shared
       * `resolveCreationRuleSnapshot` / `resolveCreationEconomicsInputs`, the
       * same helpers the new `previewCreationQuotation` query reads, so the
       * preview and the creation cannot compute different inputs, and
       * `repairQuoteEconomicsLineage` reads the same resolver (its NaN price
       * check now runs before the fee-authority check); (5) after
       * the application and its side effects are written, a confirmed figure is
       * recorded through `applySubmittedQuotation` (`recordedVia:
       * "DEAL_CREATION"`), whose refusal rolls the whole creation back. Without
       * the new argument the mutation behaves exactly as before. No index,
       * schema table or permission change. Read the hunks; do not take this
       * note's word for their scope.
       *
       * Same governance: not weakened, bypassed, deleted, generalized or made
       * vacuous. Both constants were recomputed FROM THE FILE with this test's
       * own normalization.
       *
       * -- RENEWAL 2026-09-28 - SCRUM-407 automatic closing readiness
       *
       * Previous reviewed postimage, superseded by this entry (the SCRUM-404
       * renewal just above):
       *
       *   bytes:  237715
       *   sha256: 530717160b2680b182a29f67a16d85853a4f9f16ec8e5a5f326fe16f2323ef5f
       *
       * Renewed for the owner's SCRUM-407 rulings: the manual closing
       * checklist is removed and accounting readiness becomes an automatic
       * check; finalizing a financed deal is for accountants only. The delta,
       * 98 insertions and 70 deletions: (1) `assertFinancedFinalizationEvidence`
       * — the `accountingClassification === "CLASSIFIED"` stamp gate and the
       * remittance-known check beside it — is DELETED; finalization now re-runs
       * the shared evaluator (`evaluateClosingReadiness`, inside
       * `resolveFinancedSalePlan`), which carries the remittance check itself
       * and adds the custody OPEN / closed-unbalanced checks for every route;
       * (2) `finalizeDeal` requires `confirm:finance_disbursement` instead of
       * `finalize:financed_deal`; (3) a new read-only query
       * `getClosingReadiness` (view:finance_applications + `requireOwnedRow`)
       * serves the same evaluator's verdict, with reasons and figures
       * withheld below owner / view:finance (the SCRUM-117 boundary sweep
       * covers it); (4) the import from `./utils/financedSaleRecognition`
       * widened to the evaluator and its types. No schema, index or other
       * mutation's permission changes. NOT yet reviewed by an independent
       * seat at the time of this renewal — the renewal records the author's
       * change, not a review verdict. Read the hunks; do not take this note's
       * word for their scope.
       *
       * Same governance: not weakened, bypassed, deleted, generalized or made
       * vacuous. Both constants were recomputed FROM THE FILE with this test's
       * own normalization.
       *
       * -- RENEWAL 2026-09-28 (2) - SCRUM-407 /simplify cleanup
       *
       * Previous postimage, superseded by this entry (the SCRUM-407 renewal
       * just above):
       *
       *   bytes:  238688
       *   sha256: 2f26139b5a495584db7597b6fdd0638a186649d78f47e105614d122208c8c8f6
       *
       * The delta, 56 insertions and 43 deletions: (1) a new private helper
       * `closingReadinessInputs` derives the settlement route and the currency
       * for BOTH `getClosingReadiness` and `finalizeDeal`, and now carries
       * `finalizeDeal`'s existing deal-currency vs org-currency refusal
       * (SCRUM-241), moved verbatim, so the query reports that deal as
       * UNAVAILABLE instead of READY while the door refuses it (P1.4 "one
       * evaluator"; failing-first test in sn31CurrencyMismatchRepro.test.ts);
       * (2) `getClosingReadiness` uses `mayReadFinanceEconomics` (the same
       * owner-or-view:finance rule it spelled out by hand), computes the
       * open/closed test once, and no longer returns the unused `figures`
       * block; (3) the import gains `mayReadFinanceEconomics`. The door's
       * permission, the order of its refusals and every refusal message are
       * unchanged. NOT yet reviewed by an independent seat at the time of
       * this renewal. Read the hunks; do not take this note's word for their
       * scope.
       *
       * -- RENEWAL 2026-09-28 (3) - SCRUM-407 review round 1 (doc comment only)
       *
       * Previous postimage, superseded by this entry (the /simplify renewal
       * just above; Sol 6 CERTIFIED the head carrying it, 13b5ee5b7):
       *
       *   bytes:  238873
       *   sha256: 4de5f5712a57aad5f095d98bd95428e6205f0a157a340d2b3a358dae5d82f9be
       *
       * The delta is the `getClosingReadiness` doc comment ONLY (Sonnet F2):
       * it no longer claims the screen and the server "cannot disagree"
       * without qualification — it scopes that to the closing-evidence checks
       * and names the finalize preconditions the query does not cover — and
       * it drops the reference to the `figures` block /simplify removed. No
       * code line changed. Read the hunk; do not take this note's word for it.
       *
       * Same governance: not weakened, bypassed, deleted, generalized or made
       * vacuous. Both constants were recomputed FROM THE FILE with this test's
       * own normalization.
       *
       * -- RENEWAL 2026-09-28 (4) - SCRUM-407 Sonar S3358 + CodeRabbit #352
       *
       * Previous postimage, superseded by this entry (renewal (3) just above;
       * Sol 6 CERTIFIED the head carrying it, d1610a4f0):
       *
       *   bytes:  239345
       *   sha256: 3a76a51eaea169d1cae957ac278f2fcba6e15c2aa60e46d38a2391ebeb52ca98
       *
       * The delta is confined to `getClosingReadiness`, a read-only query:
       * (1) Sonar S3358 — the nested ternary choosing a check's `reason` is
       * one ternary with the same three outcomes (null stays null; a finance
       * reader gets the reason; anyone else gets the withheld text);
       * (2) CodeRabbit #352 — a verdict that cannot be formed now returns
       * `unavailableReason`: the evaluator's own refusal for a finance
       * reader, the new `WITHHELD_UNAVAILABLE_READINESS_REASON` sentence for
       * anyone else. No mutation, door, permission, refusal or finalize
       * message changed. Read the hunks; do not take this note's word for
       * them. Same governance; both constants recomputed FROM THE FILE with
       * this test's own normalization.
       *
       * -- RENEWAL 2026-09-28 (5) - SCRUM-414 readiness reason codes
       *
       * Previous postimage, superseded by this entry (renewal (4) just above,
       * PR #352 head 615dc7995):
       *
       *   bytes:  239908
       *   sha256: c573d153b751c3b0e1860d0eebb2f294fc36aac0f91883cec4b51f2a530ad8b9
       *
       * The delta is confined to `getClosingReadiness` (read-only) and its
       * private input helper: (1) `closingReadinessInputs` now delegates to a
       * new private `closingReadinessInputsOrRefusal`, which returns the same
       * two refusals as coded reasons instead of throwing; the wrapper throws
       * the IDENTICAL English sentence, so `finalizeDeal`'s refusal text and
       * order are unchanged; (2) each check is served through
       * `closingReadinessCheckView`, adding `reasonCode` and (finance tier
       * only) `reasonParams`; below the finance tier the reason is the
       * per-check `WITHHELD_<KEY>` code with NO params and the existing plain
       * sentence (redaction test in financedConsignedSettlement.test.ts,
       * mutation-proven); (3) `unavailableReasonCode`/`unavailableReasonParams`
       * beside `unavailableReason`, withheld the same way; (4) type imports
       * from `../lib/closingReadinessReasonCodes`. No mutation, permission,
       * schema or index changed. NOT yet reviewed by an independent seat at
       * the time of this renewal. Read the hunks; do not take this note's
       * word for them. Same governance; both constants recomputed FROM THE
       * FILE with this test's own normalization.
       *
       * -- RENEWAL 2026-09-28 (6) - SCRUM-414 /simplify pass
       *
       * Previous postimage, superseded by this entry (renewal (5) just above,
       * branch head af22ec428):
       *
       *   bytes:  243398
       *   sha256: e1ce2d649656ca3cfe4e134acad649fef6a899bee387d4d976d706bde878c200
       *
       * The delta, 72 insertions and 91 deletions, is confined to
       * `getClosingReadiness` (read-only), its private input helper, and ONE
       * line of `finalizeDeal`: (1) the private `closingReadinessInputs`
       * wrapper is deleted; `finalizeDeal` calls
       * `closingReadinessInputsOrRefusal` and throws its refusal with
       * `closingRefusalError`, so the two input refusals (unsupported
       * denomination, currency drift) carry the same `{ message, code,
       * params? }` payload as the evaluator's refusals instead of a plain
       * string. The English `message` is the IDENTICAL sentence, thrown at
       * the same point in the same order; the door's permission and every
       * other refusal are unchanged (failing assertions updated in
       * sn31CurrencyMismatchRepro / scrum241FinanceReceiptAuthority to read
       * `data.message`); (2) the two redaction paths are one pure
       * `redactClosingReason` + one flattening `closingReasonView`; the wire
       * shape (`reason`/`reasonCode`/`reasonParams?`,
       * `unavailableReason`/`unavailableReasonCode`/`unavailableReasonParams?`)
       * is unchanged, the codes are now required in its type; (3) the
       * per-check `WITHHELD_READINESS_REASON` sentences and
       * `WITHHELD_UNAVAILABLE_READINESS_REASON` are deleted (the client
       * translates the WITHHELD_* code; the English left below the finance
       * tier is `WITHHELD_READINESS_REASON_FALLBACK`, which names nothing
       * about the deal), with the orphaned stacked JSDoc above them.
       * Redaction is unchanged in substance: below the finance tier no
       * params and no evaluator text are served (leak mutant re-run: letting
       * params through fails the redaction assertions in
       * financedConsignedSettlement.test.ts and sn31CurrencyMismatchRepro.test.ts;
       * file restored byte-identical). No mutation added, no permission,
       * schema or index changed. NOT yet reviewed by an independent seat at
       * the time of this renewal. Read the hunks; do not take this note's
       * word for them. Same governance; both constants recomputed FROM THE
       * FILE with this test's own normalization.
       *
       * -- RENEWAL 2026-09-28 (7) - SCRUM-414 round-1 review fixes (R1 / S414-RED-1)
       *
       * Previous postimage, superseded by this entry (renewal (6) just above,
       * branch head f3560fdff):
       *
       *   bytes:  241762
       *   sha256: 86230d7a5ccb5359c45faf3e88134a410bb95892b0f7238209e7880e060eb583
       *
       * The delta, 8 insertions and 19 deletions, applies the readiness
       * redaction to `finalizeDeal`'s refusals: (1) the private
       * `redactClosingReason` moves, unchanged in behaviour, to
       * `lib/closingReadinessReasonCodes.ts` so the query and the mutation
       * share ONE pure function (the now-unused `WITHHELD_READINESS_REASON_FALLBACK`
       * / `WithheldClosingReadinessReasonCode` imports go with it);
       * `getClosingReadiness` is otherwise untouched; (2) `finalizeDeal`
       * computes `mayReadMoney = mayReadFinanceEconomics(auth.role)` once,
       * after the unchanged `requireTenantAuth` and before
       * `runWithIdempotency`, and projects the input refusal through
       * `redactClosingReason(…, "WITHHELD_UNAVAILABLE")` before throwing
       * it — still uncaught, at the same point, before any write; (3) it
       * passes `mayReadMoney` to `resolveFinancedSalePlan`, which redacts the
       * evaluator's refusal to its check's WITHHELD code. Finance-tier
       * callers receive byte-identical code/params/English; refusal order and
       * verdicts are unchanged. No permission, schema, index, posting or
       * idempotency change (finalizeRefusalRedaction.test.ts, failing-first
       * and mutation-proven per throw site). NOT yet reviewed by an
       * independent seat at the time of this renewal. Read the hunks; do not
       * take this note's word for them. Same governance; both constants
       * recomputed FROM THE FILE with this test's own normalization.
       *
       * -- RENEWAL 2026-09-29 - SCRUM-443 handover costs paid (readiness carries line ids)
       *
       * Previous postimage, superseded by this entry (renewal (7) just above):
       *
       *   bytes:  241443
       *   sha256: a3c4ff8ede8b112e0fdbb9748eff8daabc32e6829e7cd5a901570ab80e39c2dc
       *
       * The delta, 4 insertions and 1 deletion, passes the new check's
       * `feeIds` through `getClosingReadiness`: the view type gains an optional
       * `feeIds?: string[]` and the mapper forwards it when the evaluator set
       * one (only `HANDOVER_COSTS_PAID` does). Ids only, never an amount or a
       * param. No permission, schema, index, posting or idempotency change;
       * `finalizeDeal` is untouched. NOT yet reviewed by an independent seat
       * at the time of this renewal. Read the hunks; do not take this note's
       * word for them. Same governance; both constants recomputed FROM THE
       * FILE with this test's own normalization.
       */
      file: "convex/applications.ts",
      // Renewed for single fee authority (S1-R3-H1..S1-R6-H1), then for the SCRUM-372 vehicle card and its permission (see RENEWALs 2026-09-25), then for the SCRUM-37 tenant read boundary (RENEWAL 2026-09-26), then for the SCRUM-260 commit-point profit approval and the SCRUM-373 D2 first-payment correction (RENEWALs 2026-09-27), then for SCRUM-404 creation-time quotation recording (RENEWAL 2026-09-27 (3)), then for SCRUM-407 automatic closing readiness (RENEWALs 2026-09-28, 2026-09-28 (2), (3) and (4)), then for SCRUM-414 readiness reason codes (RENEWALs 2026-09-28 (5), (6) and (7)).
      // SCRUM-444 RENEWAL 2026-09-29: three additive refusals (finalizeDeal, cancelApplication, updateStatus->REJECTED) via `assertNoPendingDepositRequest`; previous postimage bytes 241443, sha256 a3c4ff8ede8b112e0fdbb9748eff8daabc32e6829e7cd5a901570ab80e39c2dc. Recomputed from the file with this test's own normalization.
      // SCRUM-444 RENEWAL 2026-09-29 (2): fix round 2 — `createFromQuote` refuses to adopt a reservation that already holds a deposit (`assertReservationAdoptableWithoutDeposit`); previous postimage bytes 242587, sha256 9756ce0b6cc523161d92d9724e3e2a7e47d30b2ebd4ac28fd2c7206579a218bb. Recomputed from the file with this test's own normalization.
      // SCRUM-443 RENEWAL 2026-09-29 (handover costs paid, see the JSDoc entry above), re-applied on top of SCRUM-444 when merging origin/main 06d45b966: git auto-merged convex/applications.ts with no conflict; previous postimages 242976 / 19867f44… (main) and 241662 / d532f1c2… (SCRUM-443 branch). Recomputed from the merged file with this test's own normalization.
      // SCRUM-435 RENEWAL 2026-09-29: forward proof. `confirmDisbursement` refuses until the deposit and contribution the dealership owes the finance company are proven on the books (`deriveForwardState`); `cancelApplication` on a CLOSED v2 deal requires FINALIZE_FINANCED_DEAL and CONFIRM_FINANCE_DISBURSEMENT and the same proof; `dealCockpit` exposes the forward STATUS (no amounts) as `forward`; previous postimage bytes 243195, sha256 b42c6e1801d6af32ff2b66f67d46a71f30264f3b9fc7b19cbb17f36412e4e580. Recomputed from the file with this test's own normalization.
      // SCRUM-435 RENEWAL 2026-09-29 (2): returned-after-transfer dead end. `dealCockpit` passes one more fact to `deriveDealStages` (`forwardExceptionOpen: forwardProof.returnedExceptionOpen`, 1 insertion) so the transfer stage stays open while a returned payment is owed; previous postimage bytes 247994, sha256 9a69210109ef40519d99e4d92d8db3cf88f2c11e2d093db64b233a2f8f33ba5a. Recomputed from the file with this test's own normalization.
      // SCRUM-435 RENEWAL 2026-09-30 (CodeRabbit #376): `mayCancelFinalized` also requires CREATE_FINANCE_APPLICATION, which `cancelApplication` checks at entry (1 insertion, cockpit flag only; no mutation, posting or permission-check change); previous postimage bytes 248058, sha256 7cbb3cdb52357ce09b306eb57ab40eedf4bfc35bc158e908f67eb2c3a5b85103. Recomputed from the file with this test's own normalization.
      bytes: 248139,
      sha256: "2620f8cd1c9e68ae0d5abf01572162a5a7d13fc69eaab4eba1f0425bd9ff01c0",
    },
    {
      /**
       * -- RENEWAL 2026-09-13 (2) - SCRUM-117 F3 -------------------------
       *
       * Previous reviewed postimage, superseded by the entry above:
       *
       *   bytes:  219445
       *   sha256: 5e1e348c20067a98a01409f8cc91c67d89e7a3dcfbe515b675f9a20c9906886e
       *
       * The FIRST renewal below moved the boundary helper. This one repairs a
       * leak that renewal EXPOSED, and it is the only reason the file changed
       * again.
       *
       * The owner-proxy ruling of 2026-09-13 10:36 replaced SCRUM-117's single
       * VIEW_FINANCE wall with five workflow tiers. That split the approved
       * dealer purchase amount (an APPROVAL-workflow fact) from its
       * decomposition (accounting economics behind `view:finance`). But
       * `handoverEvidenceFor` gated the amount AND its two addends on ONE
       * derived boolean, `maySeeFigures` = "may this caller see the approved
       * amount?" - coherent while they shared a class, and once they did not,
       * that boolean published `financeCompanyFundedPortionMinor` and
       * `dealerContributionMinor` to every holder of
       * `approve:finance_application` or `confirm:finance_disbursement`.
       *
       * Caught by this lane's own retiered sentinel sweep, not by a reviewer:
       * four leak assertions across `applications.get` and
       * `applications.dealCockpit`. The ruling's evidence bar - a MANAGER
       * cannot obtain the composition - is unreachable without this change,
       * and the code is in this file only.
       *
       * THE DELTA, in full:
       *
       *   1. `const projected = projectFinanceApplication(app, role)` - the
       *      SAME call that was already in this function under the first
       *      renewal, hoisted into a local rather than newly introduced;
       *   2. `visibleAmount` reads `projected.approvedDealerPurchaseAmountMinor`
       *      instead of re-deriving it from that call inline;
       *   3. two returned fields read `projected.X ?? null` instead of
       *      `maySeeFigures ? app.X ?? null : null`.
       *
       * Net +3 functional lines, -5. No new query, control flow, permission
       * check, `ctx.db` access, export or workflow behavior: it REMOVES a
       * conditional and routes two fields through the canonical projected row,
       * which makes `financeApplicationProjection` the single authority instead
       * of one of two places that had to agree. Read the hunk; do not take this
       * note's word for its scope.
       *
       * Authorized explicitly and narrowly by the owner-proxy (#scrum-215,
       * 2026-09-13), in reply to a disclosure that named this exact hunk, both
       * recomputed constants and the residuals BEFORE any of it was frozen. The
       * pin was left RED in the interim rather than renewed on my own judgement,
       * and the extension granted covers this correction and nothing wider. The
       * same ruling confirms `financedSaleNetReceivableMinor` may remain visible
       * to `confirm:finance_disbursement` as the one narrow disbursement figure,
       * which widens nothing else.
       *
       * Both constants recomputed FROM THE FILE with this test's own
       * normalization, not copied from a report, a Jira comment or a chat
       * message. The pin is not weakened, bypassed, deleted, generalized or made
       * vacuous: same two files, same exact byte + sha256 pins, negative control
       * untouched, normalization and bare-CR rejection unchanged.
       * `convex/dealWorkspace.ts` remains untouched.
       */
      /**
       * -- RENEWAL 2026-09-13 - SCRUM-117 --------------------------------
       *
       * Previous reviewed postimage, superseded by the entry above:
       *
       *   bytes:  219221
       *   sha256: 8762cdd63a98cfff9a4558cd77615db95108ff073ea8509bd319c1cc49772dd8
       *
       * Renewed because the finance-application READ BOUNDARY moved out of
       * `convex/utils/tenancy.ts` and into an exhaustive allowlist,
       * `convex/utils/financeApplicationProjection.ts`. The leak SCRUM-117
       * closes is in this file's own doors — `applications.get` (VIEW_SALES)
       * and `applications.list` spread the row — so the boundary could not be
       * moved without changing what they return.
       *
       * The delta is FOUR lines: one import, and three call sites where
       * `redactSettlementEvidence(app, role)` becomes
       * `projectFinanceApplication(app, role)` (in `list`, in `get`, and in
       * `handoverEvidenceFor`). No control flow, query, predicate, permission
       * check, workflow or `ctx.db` access changed, so none of the constructs
       * this ratchet exists to catch is touched by the delta. Read the four
       * hunks; do not take this note's word for their scope.
       *
       * Renewed under explicit owner-proxy authorization, granted for exactly
       * that scope and no wider (#scrum-215, 2026-09-13, in reply to the
       * cross-lane notice posted BEFORE the change — the same order the
       * SCRUM-57 renewal followed). The instruction attached to it: rerun the
       * ratchet and the suites, freeze the successor SHA, then Sonnet MAX and
       * Codex high on that exact SHA before any merge decision.
       *
       * The pin was not weakened, bypassed, deleted, generalized or made
       * vacuous to obtain a green check: it is still an exact byte + sha256 pin
       * on the same two files, the negative control below is untouched, and
       * normalization and the bare-CR rejection are unchanged. Both constants
       * were recomputed FROM THE FILE with this test's own normalization, not
       * copied from a report, a Jira comment or a chat message.
       *
       * `convex/dealWorkspace.ts` is untouched by SCRUM-117 and keeps its
       * existing postimage.
       */
      /**
       * The P3 read-model wrapper. Pinned because it is the file that composes
       * the cash-custody flag and the appraisal provenance on top of an
       * authority it must not reinterpret.
       */
      file: "convex/dealWorkspace.ts",
      // SCRUM-444 RENEWAL 2026-09-29: the financed cockpit additionally returns `pendingDepositRequests` (read-only, tenant-scoped); previous postimage bytes 9216, sha256 1eb4f689e0082d3b4fbe591cc0a3bf62924734eedf3679c7d011981565aa7ab4. Recomputed from the file with this test's own normalization.
      bytes: 10142,
      sha256: "9b3110fb3e3d79b783c09acb18bd9c7b9fdc060edc0385b4561cc501324d4ce1",
    },
  ] as const;

  test.each(PINS)("$file is the reviewed postimage", ({ file, bytes, sha256: expected }) => {
    const text = normalized(file);
    // Length first: when a pin fails, "the file is 40 bytes longer" is a more
    // useful opening fact than two unequal digests.
    expect(byteLength(text)).toBe(bytes);
    expect(sha256(text)).toBe(expected);
  });

  /**
   * The one negative control kept.
   *
   * A pin nobody has watched fail is not a pin — this proves the assertion can
   * fail at all, which is the single thing a hash comparison can get wrong (a
   * digest computed over the wrong bytes, or compared against itself). It is
   * deliberately generic: an expanding taxonomy of semantic mutants is exactly
   * the load-bearing logic this ratchet replaced, and those five defeated
   * generations remain as review evidence in Jira and git history rather than
   * as code here.
   */
  test("a one-byte change to a pinned file changes its pin", () => {
    const text = normalized("convex/dealWorkspace.ts");
    const mutated = `${text} `;
    expect(byteLength(mutated)).not.toBe(byteLength(text));
    expect(sha256(mutated)).not.toBe(sha256(text));
  });
});
