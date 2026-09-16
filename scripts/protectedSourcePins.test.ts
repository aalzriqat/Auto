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
       */
      file: "convex/applications.ts",
      // Renewed for the owner-requested quote→application lineage fix: the
      // application now freezes the quote's denomination, selling target,
      // customer first payment and explicitly included dealer-borne fees.
      // Exact-SHA review is required again before merge.
      bytes: 224756,
      sha256: "4ad3183398261ed6a3a839efb2c6caf26361b2fef32b0397cb2d16380762fc7c",
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
      bytes: 9216,
      sha256: "1eb4f689e0082d3b4fbe591cc0a3bf62924734eedf3679c7d011981565aa7ab4",
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
