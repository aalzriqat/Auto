import { readEconomicCommandSourceLines } from "../scripts/financeDealCostCommandSources";
import { argIsOptional } from "../test-utils/idempotencyArgOptionality";
import { describe, expect, test } from "vitest";

/**
 * ─── The classification ratchet ─────────────────────────────────────────────
 *
 * Every command classified ECONOMIC must expose a REQUIRED identity at the
 * trust boundary. This is the guard that catches the next one: adding a new
 * financial mutation with `v.optional(v.string())`, or quietly relaxing an
 * existing one, fails here rather than in production.
 *
 * The manifest is written out by hand deliberately. A test that discovered the
 * list by scanning for `runWithIdempotency` would pass vacuously the day
 * somebody writes an economic mutation that never calls it.
 *
 * ─── THE DENOMINATOR, stated explicitly (SCRUM-313 RC integration) ──────────
 *
 * The combined RC has THIRTY-TWO `runWithIdempotency` call sites, and they split:
 *
 *   31  economic: true   — every one listed below, identity + fingerprint
 *                          REQUIRED at the trust boundary
 *    1  economic: false  — `sales.createDraft`, and only that one
 *   ──
 *   32  total classified call sites
 *
 * (It was 30 = 29 + 1 until an owner finding showed `collections.createReceivable`
 * and `collections.createInstallmentPlan` emit real accounting events through
 * `hookReceivableCreated`. Both are now identity-guarded and listed below.)
 *
 * So "30 sites" and "29 protected" describe the same tree with no gap between
 * them. `sales.createDraft` is not an unprotected economic command; it is a
 * classified NON-economic one. Verified on this topology rather than inherited
 * from the artifact's judgement: it reaches `createDraftSale`, which calls
 * `prepareSaleCompletion(ctx, args, "DRAFT")` — a helper that performs NO
 * database writes at all — and then `insertSaleRecord(..., "PENDING")`, whose
 * only write is `ctx.db.insert("sales")`. It never calls
 * `applySaleCompletionSideEffects`, which is where the receivable, the vehicle
 * status change and the queued accounting event live. A draft commits nothing,
 * reserves nothing and posts nothing; `sales.completeDraft` is the economic
 * event and IS classified economic below.
 *
 * The set equality is asserted both ways by the ratchet, so this comment cannot
 * drift from the source: nothing may be economic in the code and absent here,
 * and nothing may be listed here without being economic in the code.
 */
const ECONOMIC_COMMANDS: Record<string, string[]> = {
  "./applications": [
    "cancelApplication",
    "finalizeDeal",
    "confirmDisbursement",
    "returnFinanceDisbursementCheque",
    "confirmSupplierDisbursement",
    "amendSupplierDisbursementAdvice",
  ],
  "./collections": [
    "recordPayment",
    // The invoice commands already required identity. Their same-line calls
    // were invisible to the old multiline source scan.
    "activateSaleInvoiceReceipt",
    "reserveSaleInvoiceReceipt",
    // ADDED during RC integration (SCRUM-313). SCRUM-218-C created this command
    // AFTER SCRUM-57's artifact was authored, so the artifact's manifest could
    // not have listed it. It relieves a receivable against a retained receipt
    // and posts to the GL — an at-most-once effect on money — so it is
    // classified ECONOMIC like every other command here. Without this entry the
    // ratchet would have passed while the one genuinely new money command in
    // the combined RC kept an optional identity.
    "applyRetainedCredit",
    // ADDED during RC integration (SCRUM-313) after an owner finding. These two
    // were first disclosed as "write only a receivable row, no GL" — WRONG, and
    // the error was reading `ctx.db.insert` calls instead of reading the helper.
    // Both call `hookReceivableCreated`, which emits a real RECEIVABLE_CREATED
    // event whose accounting key is `receivable_created_${receivableId}`. The id
    // is minted per call, so a retry mints a new id, a new key and a SECOND
    // journal that the downstream dedupe is structurally blind to.
    //
    // For the plan, the identity represents the WHOLE PLAN intent: a per-row
    // identity would let a retry mint installments 13..24 under the first plan's
    // name — a second plan wearing the first one's identity.
    "createReceivable",
    "createInstallmentPlan",
    "clearCheque",
    "returnClearedCheque",
    "respondToApproval",
    "submitCashierReconciliation",
  ],
  "./deposits": ["create", "release"],
  // SCRUM-444: `request` writes no money but carries an identity and a canonical
  // fingerprint like every deposit door; `confirm` is the money-moving one.
  "./depositRequests": ["request", "confirm"],
  // SCRUM-724: standalone refund of customer credit left by a cheque that cleared
  // after its sale was cancelled. Both doors carry a fingerprinted identity.
  "./retainedCreditRefunds": ["respondToRetainedCreditRefund", "executeRetainedCreditRefund"],
  // ADDED by the SCRUM-313 CENSUS (owner ruling: scope A, mechanism C). These six
  // were outside the SCRUM-57 manifest because that manifest reasoned about
  // `runWithIdempotency` callers, which was only ever a SUBSET of the commands
  // that can move money. The census derives the population from the call graph
  // in both directions instead; see scripts/economicCommandCensus.test.ts, which
  // is now the release instrument and treats THIS manifest as a subset.
  "./fixedAssets": ["capitalize"],
  "./partnerEquity": ["add", "recordEquityMovement"],
  "./vehicles": ["create", "createReservation"],
  "./workOrders": ["create"],
  "./expenses": ["create"],
  "./financeCompanyForward": ["recordFinanceCompanyForward", "reverseFinanceCompanyForward", "reportFinanceCompanyForwardReturned"],
  "./customerFinanceCompanyPayments": ["confirmPayment"],
  "./firstPaymentEvidenceCorrections": [
    "requestFirstPaymentEvidenceCorrection",
    "approveFirstPaymentEvidenceCorrection",
  ],
  "./deliveredLenderCorrections": ["request", "approve"],
  "./dealUnwind": ["startDealUnwind", "recordDealUnwindForwardReturn", "finishDealUnwind", "abandonDealUnwind"],
  "./financeDealCosts": [
    "recordDealFee",
    "recordTemplateFeeActual",
    "openDealCustody",
    "recordCustodyMovement",
    "migrateLegacyCustodyToLedger",
    "reconcileDealCustody",
    "recordDirectFeePayment",
    "recordExecutionFeeActual",
  ],
  "./paymentIntents": ["create", "markSettled"],
  "./payroll": ["recordAdvance", "recoverAdvance"],
  "./prepaidExpenses": ["correctSchedule"],
  "./sales": ["create", "completeFromQuote", "completeDraft", "markCommissionPaid"],
  "./sourcingPayables": ["markPaid", "recordPartialPayment", "setDisputed"],
  "./supplierCostRecoveries": ["recordReceipt", "reverseReceipt"],
  "./supplierReceivables": ["recordReceipt", "setDisputed"],
  // ⚠️ `./transactions: ["add"]` was REMOVED during RC integration (SCRUM-313),
  // and the removal is NOT a relaxation — it is a retirement, guarded below.
  //
  // SCRUM-53 retired `transactions.add` / `update` / `remove` to unconditional
  // refusals. They take no economic arguments at all any more, so "does this
  // command expose a required identity" has no subject: there is no command
  // left to identify. Leaving the entry in place would have failed this ratchet
  // forever on a mutation that can no longer move money.
  //
  // Deleting a manifest line is exactly the silent shrink this ratchet exists
  // to prevent, so the obligation is not dropped — it is TRANSFERRED to
  // "the retired legacy ledger writers stay retired" below. If anyone ever
  // un-retires one of them, that test fails and the classification requirement
  // is re-armed, rather than the command quietly re-entering the codebase with
  // no identity and nothing watching.
};

describe("SCRUM-57 — classification ratchet", () => {
  test("every classified economic command requires a command identity", async () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const [modulePath, exportNames] of Object.entries(ECONOMIC_COMMANDS)) {
      const mod = (await import(modulePath)) as Record<string, unknown>;
      for (const exportName of exportNames) {
        // Throws if it cannot be established — never silently skipped.
        if (argIsOptional(mod, exportName)) {
          offenders.push(`${modulePath}#${exportName}`);
        }
        checked += 1;
      }
    }

    expect(offenders).toEqual([]);
    // The enumeration itself is asserted, so a manifest that silently shrank
    // (or a loop that stopped early) fails instead of passing on zero work.
    expect(checked).toBe(
      Object.values(ECONOMIC_COMMANDS).reduce((n, list) => n + list.length, 0)
    );
    // SCRUM-426 guardrail 4: the manifest size is not pinned. The source-to-manifest set
    // equality in the next test is the independent check; this only proves the loop ran.
    expect(checked).toBeGreaterThan(0);
  }, 15_000);

  test("no command appears twice in the flattened manifest", () => {
    // A duplicated entry would be walked twice and still pass every set check above.
    const keys = Object.entries(ECONOMIC_COMMANDS).flatMap(([modulePath, names]) =>
      names.map((name) => `${modulePath}#${name}`)
    );
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(duplicates).toEqual([]);
  });
  /**
   * The OTHER direction, and the one that makes the denominator above a fact
   * rather than a claim in a comment.
   *
   * The test above walks manifest → source: every listed command must require
   * an identity. That cannot detect the failure the owner asked about during
   * RC integration (SCRUM-313) — a command marked `economic: true` in the code
   * that nobody added to the manifest. It would simply never be looked at, and
   * the ratchet would stay green while an economic command went unprotected.
   *
   * So this walks source → manifest and asserts the two sets are EQUAL. It also
   * pins the non-economic side by name: a command may be `economic: false` only
   * if it is `sales.createDraft`, `suppliers.create` or
   * `supplierDueAlerts.processOrgSupplierDueAlerts` (each with its recorded
   * reason where the set is asserted below). Flipping any economic command to `false` to
   * silence the ratchet fails here instead of passing quietly.
   */
  test("the manifest is exactly the set of economic commands in the source, both directions", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ts = await import("typescript");
    const { directImportedHandlers } = await import("../scripts/convexDelegatedHandlers");
    const root = join(process.cwd(), "convex");

    const economicInSource = new Set<string>();
    const nonEconomicInSource = new Set<string>();
    for (const file of readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const path = join(root, file);
      const source = readFileSync(path, "utf8");
      const moduleName = file.replace(/\.ts$/, "");
      const lines = file === "financeDealCosts.ts" ? readEconomicCommandSourceLines(path) : source.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trim() !== "return await runWithIdempotency(" && !/runWithIdempotency\($/.test(line.trim())) return;
        let exportName: string | null = null;
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/^export const (\w+)\s*=/);
          if (m) { exportName = m[1]; break; }
        }
        let economic: string | null = null;
        for (let j = i; j < Math.min(i + 16, lines.length); j++) {
          const m = lines[j].match(/economic:\s*(true|false)/);
          if (m) { economic = m[1]; break; }
        }
        // "cannot tell" is never the permissive branch on a money path.
        expect(exportName, `could not resolve the export for a runWithIdempotency call in ${file}:${i + 1}`).not.toBeNull();
        expect(economic, `${file}#${exportName} does not declare \`economic\``).not.toBeNull();
        const key = moduleName + "." + exportName;
        (economic === "true" ? economicInSource : nonEconomicInSource).add(key);
      });

      for (const [name, handler] of directImportedHandlers(path, source)) {
        const key = moduleName + "." + name;
        const visit = (node: import("typescript").Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runWithIdempotency") {
            const options = node.arguments[1];
            const flag = options && ts.isObjectLiteralExpression(options)
              ? options.properties.find((property): property is import("typescript").PropertyAssignment =>
                  ts.isPropertyAssignment(property) && property.name.getText() === "economic")?.initializer
              : undefined;
            expect([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword], key + " must declare economic").toContain(flag?.kind);
            (flag?.kind === ts.SyntaxKind.TrueKeyword ? economicInSource : nonEconomicInSource).add(key);
          }
          ts.forEachChild(node, visit);
        };
        visit(handler);
      }
    }

    const manifestKeys = new Set(
      Object.entries(ECONOMIC_COMMANDS).flatMap(([mod, names]) =>
        names.map((n) => `${mod.replace("./", "")}.${n}`)
      )
    );

    const missingFromManifest = [...economicInSource].filter((k) => !manifestKeys.has(k)).sort();
    const missingFromSource = [...manifestKeys].filter((k) => !economicInSource.has(k)).sort();

    expect(missingFromManifest, "economic in the source but UNPROTECTED by the manifest").toEqual([]);
    expect(missingFromSource, "listed in the manifest but not economic in the source").toEqual([]);

    // SCRUM-426 guardrail 4: no count. The economic set is diffed against the manifest in both
    // directions above, so a count would only repeat it and need a hand bump per command.
    // Non-vacuity: an empty scan must not pass as an empty manifest.
    expect(economicInSource.size).toBeGreaterThan(0);
    // The non-economic side is pinned by name. `sales.createDraft` is the original entry.
    //
    // `suppliers.create` (SCRUM-868 S1, supplier master) is the second, classified on the code
    // rather than inherited: it inserts one `suppliers` row, one audit log row and bumps the
    // `supplierRegistryState` version, and nothing else. It posts no accounting event, creates
    // no receivable or payable, moves no vehicle status and reserves nothing. The master holds
    // identity only: `scripts/supplierMasterGuards.test.ts` pins the exact field list of all
    // three tables and fails if any field name looks like money (I12), so this classification
    // cannot lapse silently if someone adds a money field. It still takes a REQUIRED
    // `idempotencyKey` (a retry returns the first supplier), but a double submit would create a
    // duplicate master row, which the candidate check already refuses, not a double posting.
    // Any later supplier command that touches money must be economic: true and listed above.
    //
    // `supplierDueAlerts.processOrgSupplierDueAlerts` (SCRUM-869 S8, supplier due-date alerts) is
    // the third, classified on the code: an internal per-organisation worker that inserts in-app
    // `notifications` rows (plus the idempotency record) and nothing else. It posts no accounting
    // event, creates or changes no payable, receivable or recovery, and moves no money; it only
    // reads the obligation rows. Its idempotency key is `kind:obligationId:step:occurrence`, so a
    // retry or a catch-up run cannot send the same alert twice. A duplicate would be a repeated
    // notification, not a double posting, so it is economic: false like `suppliers.create`.
    expect([...nonEconomicInSource].sort()).toEqual([
      "sales.createDraft",
      "supplierDueAlerts.processOrgSupplierDueAlerts",
      "suppliers.create",
    ]);
  });

  /**
   * The other half of removing `./transactions` from the manifest above.
   *
   * A deleted manifest line and a genuinely retired command look identical from
   * inside this file. This test is what tells them apart: it holds only while
   * the legacy ledger writers actually refuse. Restore any one of them to a
   * working writer and this fails — which is the signal to put it back into
   * ECONOMIC_COMMANDS with a required identity, not to delete this test.
   */
  test("the retired legacy ledger writers stay retired, so their classification cannot lapse silently", async () => {
    const mod = (await import("./transactions")) as Record<string, unknown>;

    for (const name of ["add", "update", "remove"] as const) {
      const fn = mod[name] as { exportArgs?: () => string } | undefined;
      expect(fn, `transactions.${name} must still exist to be provably retired`).toBeDefined();
    }

    // Not "it throws somewhere" — the refusal must be the WHOLE handler, which
    // is what makes the command unable to move money regardless of arguments.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "convex/transactions.ts"), "utf8");
    for (const name of ["add", "update", "remove"] as const) {
      expect(source).toContain(`refuseLegacyLedgerWrite("transactions.${name}")`);
    }
  });
});
