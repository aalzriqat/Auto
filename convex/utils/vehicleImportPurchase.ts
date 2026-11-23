import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { requireActiveBankInCurrency } from "./bankAccountGuards";
import { findCommandUnit } from "./idempotency";
import { toMinorUnits } from "./money";
import { provenAcquisitionEvidence } from "./vehicleAcquisition";
import {
  IMPORT_ROW_OPERATION,
  acquisitionFingerprintMismatch,
  importRowFingerprint,
  ownershipTermsMismatch,
  sameText,
  vehicleFactsMismatch,
} from "./vehicleImportEvidence";
import { prepareVehicleImport } from "./vehicleImportPreflight";
import { parseVehicleSourceType } from "./vehicleSourceShape";
import { hasNonCanonicalVinCharacters, isPlaceholderVin } from "./vin";
import { ConvexError } from "convex/values";

export async function checkPurchaseVehicleImport(
  ctx: MutationCtx,
  batch: Awaited<ReturnType<typeof prepareVehicleImport>>,
) {
  const { args, postsAcquisitions, importId, resolvedImport, mayReadCost } = batch;

  /**
   * Row ids for which DURABLE EVIDENCE says this exact import operation
   * already ran, and the row's facts are unchanged since it did.
   *
   * PURCHASE only. Keyed by `rowId`, not by VIN — the whole point of the
   * redesign is that a VIN, and indeed every other recorded fact, cannot
   * distinguish "this operation ran before" from "a second identical car was
   * bought". Only the (importId, rowId) evidence can.
   */
  const provenRetries = new Set<number>();

  // The same rules vehicles.create enforces for a single acquisition, applied
  // to this batch up front (like the numeric validation above) so a request
  // that can't be posted correctly is rejected before any of it is written
  // rather than half-importing and half-posting.
  //
  // "This batch", not "the whole file": a file larger than the cap arrives as
  // several calls, and each one is its own transaction. The client re-checks
  // these same rules across every row before sending the first chunk, so a
  // bad row late in a large file stops the import instead of being discovered
  // after earlier chunks have already posted.
  if (postsAcquisitions) {
    // A purchase price with no declared payment method would post as CASH —
    // normalizePaymentMethod's default — even when the dealer paid by bank
    // transfer, cheque or card.
    if (!args.purchasePaymentMethod) {
      throw new ConvexError("Payment method is required when importing purchased vehicles.");
    }

    // ── The import must be able to identify ITSELF, and each row within it.
    //
    // Without this the mutation has no way to tell a re-sent file from a
    // second purchase of identical cars, and the only alternative — comparing
    // recorded facts — provably cannot: two different vehicles are routinely
    // identical in every field a spreadsheet carries. Rather than guess, a
    // purchase import states which operation it is.
    if (!importId) {
      throw new ConvexError(
        "This purchase import did not identify itself, so it cannot be safely retried. Nothing was imported. Reload the page and import the file again."
      );
    }
    const missingRowIds = args.vehicles.filter(
      (row) => row.rowId === undefined || !Number.isInteger(row.rowId)
    );
    if (missingRowIds.length > 0) {
      throw new ConvexError(
        `${missingRowIds.length} row(s) in this purchase import carry no row number, so they cannot be safely retried. Nothing was imported. Reload the page and import the file again.`
      );
    }
    // Two rows claiming the same identity would share one evidence record, so
    // the second would read as a retry of the first — the same silent loss,
    // arriving through the key instead of through the VIN.
    const rowIdsSeen = new Set<number>();
    const repeatedRowIds = args.vehicles.filter((row) => {
      if (rowIdsSeen.has(row.rowId!)) return true;
      rowIdsSeen.add(row.rowId!);
      return false;
    });
    if (repeatedRowIds.length > 0) {
      throw new ConvexError(
        `${repeatedRowIds.length} row(s) repeat a row number within this import. Nothing was imported. Reload the page and import the file again.`
      );
    }
    // ── A PURCHASE ACQUISITION MUST CARRY DURABLE PHYSICAL-VEHICLE IDENTITY.
    //
    // TWO DIFFERENT IDENTITIES ARE IN PLAY HERE, and conflating them is what
    // this guard now exists to prevent:
    //
    //   (importId, rowId)  — COMMAND identity. Proves that this exact row of
    //                        this exact import already executed. It owns
    //                        replay safety completely, and needs no VIN.
    //   a real VIN         — VEHICLE identity. The only thing that can
    //                        correlate one physical car ACROSS independent
    //                        acquisition commands.
    //
    // ⚠️ An earlier revision justified this guard by saying "a purchase
    // import's retry safety IS the VIN dedup". That reason is DEAD: row
    // evidence owns same-import retry safety now. The guard survives on a
    // different and stronger invariant.
    //
    // A blank or filler VIN is replaced by generateImportVinPlaceholder(),
    // which is unique to the INSERTION. So the same physical car uploaded
    // tomorrow under a new importId has nothing to correlate against — and
    // that second import is legitimately a different command, so row evidence
    // cannot and should not stop it. The result would be:
    //
    //     first import   → vehicle A + acquisition A
    //     second import  → vehicle B + acquisition B, same physical car
    //
    // one car, capitalized twice, silently. That is precisely the class
    // SCRUM-59 exists to fail closed on.
    //
    // Identity is NOT inferred from make, model, year or price. Those are
    // contradiction and fingerprint evidence; they are not durable identity,
    // and two genuinely different cars agree on all of them routinely.
    //
    // This also keeps bulk import from becoming a WEAKER accounting entry
    // point than the single-vehicle path: `vehicles.create` already refuses a
    // non-sourced vehicle with no VIN, and arriving by CSV should not lower
    // the bar. Applied to EVERY row, not only the ones that post today —
    // a SOURCED or cost-less row converted to owned stock with a price later
    // posts its own VEHICLE_ACQUIRED, and by then the identity is long gone.
    //
    // ⚠️ WHAT THIS DOES NOT DO, STATED PLAINLY.
    //
    // `isPlaceholderVin` is a DENYLIST — blanks, single-character runs, and a
    // handful of named tokens. It cannot establish that a string IS a durable
    // identifier, only that it is one of the fillers we have seen. `TEMP123`,
    // `PENDING` and `NOVIN1` are alphanumeric, pass every check here, and are
    // recorded as durable VINs. The failure this guard exists to prevent is
    // therefore still reachable through an unrecognised temporary label.
    //
    // Closing that needs a POSITIVE identifier contract — a validated VIN or
    // chassis format, or an explicit alternative durable identity for stock
    // that genuinely has neither. That is a design with its own migration and
    // its own product decisions, it is deliberately NOT invented here, and it
    // is tracked separately. The denylist narrows the opening; it does not
    // close it, and no comment here should imply otherwise.
    const missingVin = args.vehicles.filter((row) => isPlaceholderVin(row.vin));
    if (missingVin.length > 0) {
      throw new ConvexError(
        // The alternative is deliberately qualified rather than offered as an
        // equal option: OPENING_STOCK posts nothing, so an operator who takes
        // it for a car they genuinely just bought silently loses the
        // acquisition entry — the very thing SCRUM-59 exists to stop.
        `A VIN is required for every vehicle in a purchase import — ${missingVin.length} row(s) have none. Add the VINs. Import them as stock you already own only if you did not just buy them, because that records no purchase.`
      );
    }

    // ...and it must be plain letters and numbers, so that the durable
    // identity above is a CANONICAL match and not merely an exact one — the
    // same car written with and without punctuation must not read as two
    // vehicles. See hasNonCanonicalVinCharacters for why the remaining
    // equivalence problem belongs to SCRUM-94 rather than to a
    // canonicalization applied only here.
    const malformedVin = args.vehicles.filter((row) => hasNonCanonicalVinCharacters(row.vin));
    if (malformedVin.length > 0) {
      throw new ConvexError(
        `A VIN can only contain letters and numbers — ${malformedVin.length} row(s) have dashes, spaces or punctuation. Remove them. Import these as stock you already own only if you did not just buy them, because that records no purchase.`
      );
    }
    // ── SCRUM-59: what a PURCHASE import refuses, before a single row is
    // written. Each of these is decidable from the file plus an EXACT VIN
    // lookup — the identity rule every writer already uses.
    //
    // ⚠️ Deciding whether a historically stored, differently-WRITTEN VIN is the
    // same physical car is NOT attempted here and must not be added. Three
    // attempts each introduced a new identity defect; SCRUM-94 owns that
    // problem in full, including the residual that an existing punctuated or
    // otherwise differently-encoded VIN will not be matched by this import.
    // That residual is knowingly accepted, not overlooked.

    // Only rows that would actually reach Vehicle Inventory carry the basis
    // ambiguity below. A SOURCED row and a cost-less row post nothing, so an
    // existing VIN there is an ordinary duplicate and is skipped as it always
    // was. Refusing those would break the retry contract, because a retried
    // file legitimately re-presents rows that never posted.
    const wouldCapitalize = (row: { sourceType?: string; purchasePrice?: number }) =>
      parseVehicleSourceType(row.sourceType) !== "SOURCED" && (row.purchasePrice ?? 0) > 0;

    // (1) TWO ROWS IN THIS FILE THAT ARE THE SAME CAR. The per-row dedup below
    // reads this mutation's own writes, so the second row silently resolves to
    // the vehicle the first row just inserted and is counted as "skipped" —
    // two purchased cars become one vehicle and ONE acquisition, understating
    // inventory.
    //
    // Reachable with ordinary filler, not just identical VINs: `UNK` and
    // `UNKNOWN` are alphanumeric and are not in `isPlaceholderVin`'s list, so
    // they pass every other guard.
    //
    // Identity here is the EXACT rule every writer already uses —
    // `trim().toUpperCase()` — and deliberately nothing wider. The guards above
    // have already refused any VIN that is not plain `[A-Z0-9]`, so among
    // accepted rows this IS the rule the `by_org_vin` dedup applies. Deciding
    // that two differently-WRITTEN VINs are one car is a different problem and
    // belongs to SCRUM-94; see the note in convex/utils/vin.ts for the three
    // attempts that proved it cannot be done correctly here.
    const firstSeenAt = new Map<string, number>();
    const batchDuplicates: string[] = [];
    args.vehicles.forEach((row, index) => {
      const identity = row.vin.trim().toUpperCase();
      if (!identity) return;
      if (!firstSeenAt.has(identity)) {
        firstSeenAt.set(identity, index);
        return;
      }
      batchDuplicates.push(identity);
    });
    if (batchDuplicates.length > 0) {
      throw new ConvexError(
        `${batchDuplicates.length} row(s) repeat a VIN already used earlier in this file (${batchDuplicates.slice(0, 3).join(", ")}). Each vehicle needs its own VIN — otherwise only the first is recorded and the rest are bought without ever being added. Give every row its real VIN and import again.`
      );
    }

    // (2) THE EXISTING VEHICLE'S BASIS CANNOT BE PROVEN. An exact VIN match is
    // skipped by the loop below, and that is right for a genuine retry: the car
    // is already capitalized and must not post twice.
    //
    // It is NOT right when the existing row arrived as OPENING_STOCK. That row
    // carries no acquisition event, so a later PURCHASE of the same VIN would
    // silently do nothing, and a subsequent sale would credit Vehicle Inventory
    // with no matching debit.
    //
    // The inverse is equally wrong: absence of an event does NOT mean "needs
    // posting". Legitimate opening stock is represented by the org's
    // opening-balance position, and posting here would capitalize it a second
    // time. The two cases are indistinguishable from the row alone, so this
    // FAILS CLOSED and asks a human instead of guessing in either direction.
    if (args.purchasePaymentMethod === "ON_ACCOUNT") {
      // `purchaseSupplierName` is the "who is this owed to" field here exactly
      // as it is on vehicles.create — the AP-Suppliers credit and the
      // vehicleSupplierPayables row both need a name.
      const missingSupplier = args.vehicles.filter(
        (row) =>
          parseVehicleSourceType(row.sourceType) !== "SOURCED" &&
          (row.purchasePrice ?? 0) > 0 &&
          !row.purchaseSupplierName?.trim()
      );
      if (missingSupplier.length > 0) {
        throw new ConvexError(
          `A supplier name is required for every vehicle purchased on account — ${missingSupplier.length} row(s) are missing one.`
        );
      }
    }

    // ── (3) EVERY ROW IS CLASSIFIED BEFORE ANYTHING IS WRITTEN.
    //
    // A PURCHASE import ends in one of two outcomes per row: the car is
    // recorded, or it was ALREADY recorded by a provably identical purchase.
    // Everything this pass cannot place in one of those two throws here,
    // before the first write, and the whole file rolls back.
    //
    // ⚠️ ONE PRE-EXISTING EXCEPTION, stated rather than glossed: an owned
    // STOCK row with no purchase price is still INSERTED and posts nothing,
    // because `postVehicleAcquisitionIfOwned` no-ops without a cost. That is
    // `vehicles.create`'s long-standing behaviour and is not introduced here
    // — `vehicleHasCostBasis` (utils/vehicleCost.ts) stops it corrupting
    // commission and profit downstream. It is a third outcome all the same,
    // and this comment previously claimed there were only ever two. SCRUM-168.
    //
    // ⚠️ The row loop must NOT re-derive this. Every VIN proven here is added
    // to `provenRetries`, and the loop counts `alreadyRecorded` only for a
    // member of that set — an existing VIN that is somehow not in it is an
    // internal error, not a duplicate. An earlier revision asserted that
    // invariant in a comment instead of enforcing it, and the gap was real:
    // a row that took an early `continue` here was still certified below.
    //
    // Why a proof at all, rather than "the VIN matches, so skip it": this mode
    // posts money. `skipped` used to mean both "already bought this car,
    // nothing to do" and "could not record your car", and those are opposite
    // economic outcomes. The second loses a physical vehicle's acquisition
    // entirely and reports it to the operator as a duplicate.
    const orgCurrency = await getOrgCurrency(ctx, args.orgId);
    const unprovenBasis: string[] = [];
    const contradictions: string[] = [];
    const uncreatable: string[] = [];
    const collisions: string[] = [];

    for (const row of args.vehicles) {
      const normalized = row.vin.trim().toUpperCase();

      // ── (a) HAS THIS EXACT ROW OF THIS EXACT IMPORT ALREADY RUN?
      //
      // This is the only question whose answer is proof. It is asked FIRST,
      // and nothing about the database's contents is consulted to answer it.
      // A conflicting fingerprint throws from inside findCommandUnit: the same
      // key with different details is a new request wearing a used identifier,
      // and resolving that in either direction loses something.
      const evidence = await findCommandUnit(ctx, {
        orgId: args.orgId,
        operation: IMPORT_ROW_OPERATION,
        idempotencyKey: `${importId}:${row.rowId}`,
        fingerprint: await importRowFingerprint(row, args.purchasePaymentMethod, args.bankAccountId),
        label: `Row ${row.rowId} (${normalized})`,
      });
      if (evidence) {
        provenRetries.add(row.rowId!);
        continue;
      }

      // ── (b) NO EVIDENCE, so this is a NEW requested operation.
      //
      // From here an existing VIN is a COLLISION, never a retry. It may well
      // be the same physical car — but "may well be" is what this redesign
      // exists to stop being treated as proof on a path that posts money.
      const existing = await ctx.db
        .query("vehicles")
        .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalized))
        .unique();

      // ── A row with no existing vehicle will be INSERTED. If it cannot be,
      // the FILE is refused rather than the row dropped. The row loop below
      // skips a SOURCED row with no supplier or no cost — correct when an
      // import posts nothing, and a silent loss of a purchased car when it
      // does, reported to the operator as a "duplicate".
      if (!existing) {
        const isSourcedRow = parseVehicleSourceType(row.sourceType) === "SOURCED";
        const rowCost = row.sourceCost ?? row.purchasePrice;
        if (isSourcedRow && (!row.sourcedFromName?.trim() || rowCost === undefined || rowCost <= 0)) {
          uncreatable.push(normalized);
        }
        continue;
      }

      // ── An exact VIN already here, on an operation that has never run.
      //
      // Whatever this is, it is NOT a proven retry, so it is refused. The
      // checks below only decide HOW TO SAY SO: naming the field that
      // disagrees is far more useful than "this VIN exists", and where
      // everything agrees the message has to be honest that agreement is
      // exactly what cannot settle the question.
      const factsMismatch = vehicleFactsMismatch(existing, row) ?? ownershipTermsMismatch(existing, row, mayReadCost);
      if (factsMismatch) {
        contradictions.push(`${normalized}: ${factsMismatch}`);
        continue;
      }

      if (wouldCapitalize(row)) {
        // Proven POSTED evidence only — a REVERSED or dead-lettered FAILED
        // record does not prove this car is capitalized today.
        const acquisition = await provenAcquisitionEvidence(ctx, args.orgId, existing._id);
        if (!acquisition) {
          unprovenBasis.push(normalized);
          continue;
        }
        const moneyMismatch = acquisitionFingerprintMismatch(
          acquisition,
          toMinorUnits(row.purchasePrice!, orgCurrency),
          orgCurrency,
          args.purchasePaymentMethod,
          args.bankAccountId
        );
        if (moneyMismatch) {
          // SCRUM-886: see `mayReadCost` above.
          if (mayReadCost) contradictions.push(`${normalized}: ${moneyMismatch}`);
          else collisions.push(normalized);
          continue;
        }
        if (args.purchasePaymentMethod === "ON_ACCOUNT") {
          const payables = await ctx.db
            .query("vehicleSupplierPayables")
            .withIndex("by_vehicle", (q) => q.eq("vehicleId", existing._id))
            .collect();
          const supplier = row.purchaseSupplierName ?? "";
          const sameCreditor = (payable: { sourcedFromName: string; supplierId?: string }) =>
            payable.supplierId && row.purchaseSupplierId
              ? payable.supplierId === row.purchaseSupplierId
              : sameText(payable.sourcedFromName, supplier);
          if (!payables.some(sameCreditor)) {
            // SCRUM-886: the creditor is COST tier (purchaseSupplierName); see `mayReadCost` above.
            if (!mayReadCost) {
              collisions.push(normalized);
              continue;
            }
            contradictions.push(
              payables.length === 0
                ? `${normalized}: recorded on account, but no supplier payable exists to compare against`
                : `${normalized}: owed to ${payables[0].sourcedFromName}, this file says ${supplier.trim()}`
            );
            continue;
          }
        }
      }

      // Everything recorded agrees — and that is precisely why this cannot be
      // waved through. A second identical car produces the same agreement, so
      // accepting it would silently drop a vehicle that was genuinely bought.
      collisions.push(normalized);
    }

    if (uncreatable.length > 0) {
      throw new ConvexError(
        `${uncreatable.length} sourced row(s) cannot be recorded because they are missing a supplier or a cost (${uncreatable.slice(0, 3).join(", ")}). Nothing was imported. Complete those rows and import again — a purchase import records every row or none of them, so they are never quietly left out.`
      );
    }
    if (contradictions.length > 0) {
      throw new ConvexError(
        `${contradictions.length} row(s) use a VIN that is already here but do not match what was recorded (${contradictions.slice(0, 3).join("; ")}). Nothing was imported. If these are different cars, give them their real VINs. If you are changing what was already recorded, use the vehicle's own edit and correction workflow — an import cannot rewrite a purchase that has already posted.`
      );
    }
    if (collisions.length > 0) {
      throw new ConvexError(
        `${collisions.length} vehicle(s) in this file are already recorded under the same VIN (${collisions.slice(0, 3).join(", ")}), and this import has not been sent before. Nothing was imported. If these are cars you already added, remove those rows. If they are different cars that happen to share a VIN in the sheet, give each its own real VIN — matching details cannot tell the two apart, and guessing would drop a car you actually bought.`
      );
    }
    if (unprovenBasis.length > 0) {
      throw new ConvexError(
        `${unprovenBasis.length} vehicle(s) already exist here with no recorded purchase (${unprovenBasis.slice(0, 3).join(", ")}). They may already be covered by this dealership's opening balance, so importing them as a purchase could count them twice — and skipping them could leave them with no cost at all. Reconcile those vehicles' basis first, then import the rest.`
      );
    }
  }

  // Validate before the first write, but after durable row evidence was read.
  // A lost-response retry of a purchase remains a no-op even if its original
  // bank was later deactivated. Any genuinely new row must still name a live bank.
  if (postsAcquisitions && args.vehicles.some((row) => !provenRetries.has(row.rowId!))) {
    const bankMethod = args.purchasePaymentMethod === "BANK_TRANSFER" ||
      args.purchasePaymentMethod === "CARD" || args.purchasePaymentMethod === "CHEQUE";
    if (bankMethod) {
      await requireActiveBankInCurrency(ctx, {
        orgId: args.orgId,
        bankAccountId: args.bankAccountId,
        currency: await getOrgCurrency(ctx, args.orgId),
        missingMessage: "Choose the bank account used for this vehicle purchase import.",
        currencySubject: "vehicle purchase import",
      });
    } else if (args.bankAccountId) {
      throw new ConvexError("A bank account is only valid for a bank-funded vehicle purchase import.");
    }
  }
  return provenRetries;
}
