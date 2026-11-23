import type { Id } from "../_generated/dataModel";
import { simplePayloadHash } from "../accounting/postingRules";
import { PURCHASE_IMPORT_MAX_ROWS } from "./importLimits";
import { fromMinorUnits } from "./money";
import type { AcquisitionPaymentMethod } from "./paymentMethods";
import type { ProvenAcquisitionEvidence } from "./vehicleAcquisition";
import { storedVehicleSourceType } from "./vehicleSourceShape";

/**
 * Ceiling on rows per `importBulk` call.
 *
 * Each vehicle insert now also walks and patches the aggregate B-tree, so a row
 * costs several index reads and node writes on top of its own document write.
 * An uncapped array put the whole spreadsheet in one transaction, which puts a
 * large import within reach of Convex's per-transaction limits — and a
 * transaction that trips them rolls the entire import back with an opaque
 * error. The client chunks to this size; the cap is enforced here because the
 * client is never the control.
 */
export const IMPORT_BULK_MAX_ROWS = 200;

/**
 * A much lower ceiling once the batch also POSTS.
 *
 * 200 was sized for a transaction whose per-row cost was an insert plus the
 * aggregate B-tree walk. A PURCHASE row additionally writes an
 * `accountingEvents` row, a `journalEntries` row and its lines, an
 * `incrementAccountSnapshot` read+patch per line, an audit entry, and either a
 * legacy `transactions` row or a `vehicleSupplierPayables` row — roughly an
 * order of magnitude more documents touched, all inside the one transaction.
 *
 * This number is deliberately conservative rather than measured: `convex-test`
 * does not enforce Convex's real per-transaction limits, so a green suite is no
 * evidence at all here (the same trap that let a backfill clear 2,115 tests and
 * fail on its first production call). The cost of being too low is more chunks;
 * the cost of being too high is an opaque rollback of a dealer's whole import.
 * Measuring the real ceiling against a live deployment is follow-up work.
 */
export const IMPORT_BULK_MAX_POSTING_ROWS = PURCHASE_IMPORT_MAX_ROWS;

/**
 * FOR A PURCHASE IMPORT, WHOLE-FILE MUST EQUAL WHOLE-TRANSACTION.
 *
 * This cap is therefore the limit on the FILE, not the size of a chunk. A
 * PURCHASE import is never split: it is one mutation, and a mutation is atomic,
 * so it either records every car and every journal entry or records nothing.
 *
 * That is an architectural rule, not a conservative number. Chunking a
 * money-posting import puts whole-FILE invariants inside per-CHUNK
 * transactions, and two entire classes of defect follow from the mismatch —
 * both measured on this branch before the rule was adopted:
 *
 *  - a duplicate spread ACROSS chunks escapes a per-chunk duplicate check
 *    entirely; the second chunk reads the first chunk's committed VIN as a
 *    legitimate retry and silently skips a car that was genuinely bought;
 *  - a bound evaluated per chunk can be crossed MID-FILE, so an import commits
 *    part of itself into a state where its own retry is refused.
 *
 * Neither is fixable by adding another guard around the protocol, because the
 * guard would still be reasoning about one chunk. Making the file the
 * transaction removes the category. A read-limit failure likewise becomes a
 * clean pre-write refusal instead of "chunk 1 posted money and chunk 2 failed".
 *
 * OPENING_STOCK is unaffected and still chunks at IMPORT_BULK_MAX_ROWS: it
 * posts nothing, so it has no money-shaped invariant to preserve across a
 * boundary.
 *
 * The recovery story is correspondingly simpler and is what the operator is
 * told: if a PURCHASE import fails, nothing was written — fix the rows and
 * import again. To retry a successful purchase, reuse the original import ID
 * and row IDs with matching row data. A matching VIN alone cannot prove that
 * the purchase was already recorded.
 */

/**
 * What an import means in accounting terms — the operator states it, the server
 * never guesses.
 *
 * A CSV of owned stock is two completely different economic facts wearing the
 * same shape, and only the person importing knows which one it is:
 *
 * - OPENING_STOCK — cars the dealership already owns, being carried over from a
 *   spreadsheet at cutover. No cash moves today, and the GL entry for them is
 *   the opening balance: either the org's opening-balance journal (which carries
 *   its own Vehicle Inventory line) or the per-vehicle
 *   `accountingMigration.backfillVehicleInventoryOpeningBalances`. So this posts
 *   nothing — byte-identical to what importBulk did before this argument
 *   existed. Posting here as well would double-capitalize every migrated car.
 *
 * - PURCHASE — cars the dealership just bought. These are ordinary acquisitions
 *   and go through the same `postVehicleAcquisitionIfOwned` the single-vehicle
 *   create path uses, so a car bought in a batch is capitalized exactly like a
 *   car added one at a time.
 *
 * There is deliberately no default. Guessing OPENING_STOCK silently recreates
 * SCRUM-59 — imported stock with a purchasePrice but no Dr Vehicle Inventory,
 * which `ruleSaleCompleted` then credits at sale time, driving the asset
 * negative and leaving the balance sheet wrong while the P&L still looks right.
 * Guessing PURCHASE would double-count every cutover migration against the
 * opening balance and invent cash payments that never happened. Both silent
 * choices corrupt the books, so the caller must say which one it is.
 */
export const IMPORT_ACQUISITION_POSTING = ["OPENING_STOCK", "PURCHASE"] as const;
export type ImportAcquisitionPosting = (typeof IMPORT_ACQUISITION_POSTING)[number];

/**
 * The unit of idempotency for a bulk purchase import: ONE SPREADSHEET ROW.
 *
 * Keyed `<importId>:<rowId>` under this operation name, where `importId`
 * identifies the logical import (stable across every call it takes) and `rowId`
 * identifies the row within the operator's original file (stable across
 * retries, and NOT the position within the valid subset — otherwise correcting
 * an earlier row would renumber every row after it and void their evidence).
 */
export const IMPORT_ROW_OPERATION = "vehicles.importBulk.row";

/**
 * What must be identical for a re-sent row to be the SAME requested operation.
 *
 * EVERY input that changes what is written, posted, or created — not a summary,
 * and not only the financial fields. A re-sent row whose selling price, status,
 * mileage or valuations differ is a different request wearing a used identifier,
 * and because a proven retry does no work at all, accepting it would discard
 * the operator's change in silence: no write, no error, and a response
 * indistinguishable from an ordinary no-op retry.
 *
 * ⚠️ An earlier revision covered only the money fields, and its own comment
 * claimed it covered everything. `color`, `mileage`, `fuelType`, `transmission`,
 * `sellingPrice`, `status`, `notes` and `valuations` were all persisted and all
 * omitted. If a field is added to the row validator, it belongs here too.
 *
 * ⚠️ THE EXCLUSIONS BELOW ARE PAIRED WITH THE WRITER, NOT SUFFICIENT ALONE.
 * This function drops entries the writer would not store — non-positive
 * amounts, and entries with no usable company. That only holds because the
 * writer drops the same shapes: if either side stops, the hash starts
 * describing something other than what was written, which is how every defect
 * on this function got in. Change one, change both.
 *
 * ⚠️ ONE KNOWN RESIDUAL, AND THIS FUNCTION DOES NOT CLAIM OTHERWISE — SCRUM-173.
 * Valuations are keyed by the value the row SUBMITS, so an entry naming a
 * company by `companyId` and another naming the SAME company by name are one
 * record to storage but two keys here. Reversing that pair changes which amount
 * storage keeps while leaving this hash unchanged. Not producible by the import
 * dialog, which never emits both forms for one company, and `vehicleValuations`
 * reaches no journal — but it is real through a direct call, and it is a known
 * gap rather than a covered case. Closing it needs an identity resolution that
 * survives the company being CREATED by the very call being fingerprinted, and
 * that is a decision of its own.
 */
export async function importRowFingerprint(
  row: {
    vin: string; make: string; model: string; year: number;
    color: string; mileage?: number; fuelType: string; transmission: string;
    sellingPrice: number; status?: string; notes?: string;
    purchasePrice?: number; sourceType?: string; sourcedFromName?: string; sourceCost?: number;
    purchaseSupplierName?: string;
    sourcedSupplierId?: string; purchaseSupplierId?: string;
    valuations?: Array<{ companyId?: string; companyName?: string; valuationAmount: number }>;
  },
  paymentMethod: AcquisitionPaymentMethod,
  bankAccountId?: Id<"bankAccounts">
): Promise<string> {
  const text = (value: string | undefined) => (value ?? "").trim().toLowerCase();

  // ⚠️ CANONICALIZE THE WAY STORAGE RESOLVES — for the rules below. This is not
  // a claim of complete agreement with storage: see the alias residual in the
  // docstring (SCRUM-173). Three mismatches were reproduced against earlier
  // versions of this function, each of which let a materially different row
  // pass as a proven retry:
  //
  //   - a company is matched by its TRIMMED NAME WITH CASE PRESERVED
  //     (`companyIdByName`), so lowercasing here made "Orange Finance" and
  //     "orange finance" hash equal while creating two distinct companies;
  //   - two valuations naming the SAME company are applied in order and the
  //     last one wins, so an order-blind sort made a reversed pair hash equal
  //     while persisting a different final amount.
  //
  // Collapsing per company key, last-wins over the entries storage would
  // actually write, then sorting, reproduces all three: re-ordering DIFFERENT
  // companies stays a non-conflict, while changing the case, the surviving
  // amount, or a value storage would skip becomes one.
  const lastByCompany = new Map<string, number>();
  (row.valuations ?? [])
    // ⚠️ MIRROR THE SKIP, NOT JUST THE COLLAPSE. Storage drops a non-positive
    // valuation BEFORE reading or writing anything (`valuationAmount <= 0`
    // continue), so such an entry cannot overwrite what an earlier positive
    // entry for the same company already stored. Letting it win here does the
    // opposite: [100, 0] and [300, 0] both collapse to 0 and hash EQUAL, while
    // storage persists 100 and 300. The hash then agrees where the writes
    // differ — the exact failure this canonicalization exists to prevent, and
    // the third form of it found on this function.
    // Storage skips an entry when `!companyId || valuationAmount <= 0`, where
    // its `companyId` is POST-resolution. A non-blank name always resolves,
    // because the loop above creates one for it — so storage's `!companyId` is
    // exactly "no id and no non-blank name", which is what this expresses.
    .filter((v) => v.valuationAmount > 0 && (v.companyId || (v.companyName ?? "").trim()))
    .forEach((v) => {
      // ⚠️ IDS AND NAMES ARE DISJOINT KEY SPACES. Keying on the raw value put
      // them in one namespace, so a name that happened to equal another
      // company's id string collided with it: both entries collapsed to a
      // single key while storage wrote TWO valuations — company <id>, and a
      // company lazily created under that literal name. Changing the id-side
      // amount then left the hash untouched. Improbable through the importer,
      // which derives names from column headers, and trivial through a direct
      // call.
      lastByCompany.set(
        v.companyId ? `id:${v.companyId}` : `name:${(v.companyName ?? "").trim()}`,
        v.valuationAmount
      );
    });
  const valuations = Array.from(lastByCompany.entries())
    .map(([company, valuationAmount]) => ({ company, valuationAmount }))
    .sort((a, b) => a.company.localeCompare(b.company));
  return simplePayloadHash({
    vin: row.vin.trim().toUpperCase(),
    make: text(row.make),
    model: text(row.model),
    year: row.year,
    color: text(row.color),
    mileage: row.mileage ?? null,
    fuelType: text(row.fuelType),
    transmission: text(row.transmission),
    sellingPrice: row.sellingPrice,
    status: text(row.status),
    notes: text(row.notes),
    purchasePrice: row.purchasePrice ?? null,
    sourceType: ownershipOf(row),
    // SCRUM-868 N12: a supplier is keyed by its master id once the row carries one, never by the
    // name the server read from the master (which a rename would change under a retry). A row with
    // no supplier id hashes exactly as it did before.
    sourcedFromName: row.sourcedSupplierId ? "" : text(row.sourcedFromName),
    ...(row.sourcedSupplierId ? { sourcedSupplierId: row.sourcedSupplierId } : {}),
    sourceCost: row.sourceCost ?? null,
    purchaseSupplierName: row.purchaseSupplierId ? "" : text(row.purchaseSupplierName),
    ...(row.purchaseSupplierId ? { purchaseSupplierId: row.purchaseSupplierId } : {}),
    paymentMethod,
    bankAccountId: bankAccountId ?? null,
    valuations,
  });
}

/**
 * A row can be looked up as a replay before the file's numeric validation runs only when its identity
 * and every number the fingerprint hashes are well-formed; anything else is left to the ordinary
 * validation and the evidence loop, which see it after normalisation.
 */
export function isReplayProbeable(row: {
  rowId?: number; year: number; sellingPrice: number; mileage?: number; purchasePrice?: number;
  sourceCost?: number; valuations?: Array<{ valuationAmount: number }>;
}): boolean {
  // The same test the PURCHASE validator applies to a row number. Evidence is keyed by whatever integer
  // the command accepted (including negative and beyond-safe ones), so a narrower test here would leave
  // already-recorded rows unrecognisable as replays once their supplier is deactivated.
  if (row.rowId === undefined || !Number.isInteger(row.rowId)) return false;
  const finite =(n: number | undefined) => n === undefined || Number.isFinite(n);
  return finite(row.year) && finite(row.sellingPrice) && finite(row.mileage) && finite(row.purchasePrice) &&
    finite(row.sourceCost) && (row.valuations ?? []).every((val) => Number.isFinite(val.valuationAmount));
}

export const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Does this row contradict the vehicle already stored under the same VIN?
 *
 * A CONTRADICTION GUARD, not proof of identity. Make, model and year are all
 * editable on an existing vehicle, so their agreement cannot establish that two
 * rows are the same car — but their DISAGREEMENT does establish that something
 * is wrong, and that is the half worth acting on. A Honda arriving under a VIN
 * stored against a Toyota is not a retry under any reading.
 *
 * Returns a human-readable reason, or null when nothing contradicts.
 */
export function vehicleFactsMismatch(
  existing: { make: string; model: string; year: number },
  row: { make: string; model: string; year: number }
): string | null {
  if (!sameText(existing.make, row.make) || !sameText(existing.model, row.model)) {
    return `recorded as ${existing.make} ${existing.model}, this file says ${row.make.trim()} ${row.model.trim()}`;
  }
  if (existing.year !== row.year) {
    return `recorded as a ${existing.year}, this file says ${row.year}`;
  }
  return null;
}

/** SOURCED (drop-ship, the supplier's car) or STOCK (owned). Never undefined. */
export const ownershipOf = (row: { sourceType?: string }) => storedVehicleSourceType(row.sourceType);

/**
 * Does this row contradict how the existing vehicle is OWNED, or on what terms?
 *
 * Separate from `vehicleFactsMismatch` because it is not about which car this
 * is — it is about whose car it is. STOCK and SOURCED are different ownership,
 * a different counterparty and a different sale-accounting basis downstream
 * (principal versus agent), so re-presenting one as the other is never a retry.
 *
 * This runs for rows that post NOTHING as well, which is the point. Such a row
 * changes no journal either way, so an earlier version skipped it — but it is
 * still reported to the operator as "already recorded with matching purchase
 * evidence", and that sentence must not be said about terms nobody compared.
 *
 * Returns a human-readable reason, or null when nothing contradicts.
 */
export function ownershipTermsMismatch(
  existing: { sourceType?: string; sourcedFromName?: string; sourcedSupplierId?: string; sourceCost?: number },
  row: { sourceType?: string; sourcedFromName?: string; sourcedSupplierId?: string; sourceCost?: number; purchasePrice?: number },
  mayReadCost: boolean
): string | null {
  const was = ownershipOf(existing);
  const now = ownershipOf(row);
  if (was !== now) {
    return was === "SOURCED"
      ? "recorded as sourced from a supplier, this file says owned stock"
      : "recorded as owned stock, this file says sourced from a supplier";
  }
  if (now === "STOCK") return null;

  // Both sourced: the supplier and the agreed cost ARE the terms. SCRUM-868: when both sides carry a
  // supplier master id the ids decide (a rename of the master is not a different supplier); otherwise
  // the snapshot names are compared as they always were.
  const sameSupplier = existing.sourcedSupplierId && row.sourcedSupplierId
    ? existing.sourcedSupplierId === row.sourcedSupplierId
    : sameText(existing.sourcedFromName, row.sourcedFromName);
  if (!sameSupplier) {
    return `recorded as sourced from ${existing.sourcedFromName ?? "no one"}, this file says ${row.sourcedFromName?.trim() || "no one"}`;
  }
  const incomingCost = row.sourceCost ?? row.purchasePrice;
  if (existing.sourceCost !== incomingCost) {
    // SCRUM-886: see `mayReadCost` in importBulk. Null falls through to the generic collision refusal.
    if (!mayReadCost) return null;
    return `recorded at a supplier cost of ${existing.sourceCost}, this file says ${incomingCost}`;
  }
  return null;
}

/**
 * Does the money in this row contradict the acquisition already posted?
 *
 * This is the part of "the same purchase" that a vehicle document cannot answer.
 * Two rows can agree on make, model and year and still be different economic
 * commands — a different price, a different currency, cash instead of supplier
 * credit. Re-presenting any of those under an existing VIN is a CHANGE to
 * recorded financial terms, and silently skipping it records the old terms
 * forever while the operator believes the new ones landed.
 *
 * FAILS CLOSED on missing evidence. A posted acquisition whose payload cannot
 * produce a cost, a currency or a payment method proves exposure but not
 * agreement, and "cannot tell" must never take the permissive branch here.
 *
 * Returns a human-readable reason, or null when everything agrees.
 */
export function acquisitionFingerprintMismatch(
  evidence: ProvenAcquisitionEvidence,
  incomingCostMinor: number,
  incomingCurrency: string,
  incomingPaymentMethod: AcquisitionPaymentMethod,
  incomingBankAccountId?: Id<"bankAccounts">
): string | null {
  if (evidence.currency === undefined) return "the recorded purchase does not state a currency";
  if (evidence.currency !== incomingCurrency) {
    return `recorded in ${evidence.currency}, this import is in ${incomingCurrency}`;
  }
  if (evidence.costMinor === undefined) return "the recorded purchase does not state a cost";
  if (evidence.costMinor !== incomingCostMinor) {
    return `recorded at ${fromMinorUnits(evidence.costMinor, evidence.currency)}, this file says ${fromMinorUnits(incomingCostMinor, incomingCurrency)}`;
  }
  if (evidence.paymentMethod === undefined) return "the recorded purchase does not state a payment method";
  if (evidence.paymentMethod !== incomingPaymentMethod) {
    return `recorded as paid by ${evidence.paymentMethod}, this import says ${incomingPaymentMethod}`;
  }
  const bankMethod = incomingPaymentMethod === "BANK_TRANSFER" || incomingPaymentMethod === "CARD" || incomingPaymentMethod === "CHEQUE";
  if (bankMethod && !evidence.bankAccountId) return "the recorded bank-funded purchase does not identify a physical bank";
  if (bankMethod && evidence.bankAccountId !== incomingBankAccountId) return "the recorded purchase used a different physical bank";
  if (!bankMethod && evidence.bankAccountId) return "the recorded purchase unexpectedly identifies a physical bank";
  return null;
}
