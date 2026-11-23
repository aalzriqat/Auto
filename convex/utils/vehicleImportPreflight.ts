import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { simplePayloadHash } from "../accounting/postingRules";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { findCommandUnit } from "./idempotency";
import { assertFiniteNumber, assertMajorAmountRepresentable, toMinorUnits } from "./money";
import { loadOpeningSourceIdentity } from "./openingSourceIdentity";
import { OPENING_STOCK_IMPORT_OPERATION, listOpeningStockEvidence } from "./openingVehicleBasis";
import type { AcquisitionPaymentMethod } from "./paymentMethods";
import { assertVehicleCostPrecision } from "./supplierPaymentAmounts";
import { canReadVehicleCost } from "./vehicleCostVisibility";
import {
  IMPORT_BULK_MAX_POSTING_ROWS,
  IMPORT_BULK_MAX_ROWS,
  IMPORT_ROW_OPERATION,
  type ImportAcquisitionPosting,
  importRowFingerprint,
  isReplayProbeable,
} from "./vehicleImportEvidence";
import {
  assertVehicleIntakeSourceShape,
  parseVehicleSourceType,
  throwVehicleSourceShape,
} from "./vehicleSourceShape";
import { resolveImportSuppliers } from "./vehicleSupplierIdentity";
import { hasNonCanonicalVinCharacters, isPlaceholderVin } from "./vin";
import { ConvexError, type ObjectType, v } from "convex/values";

export const vehicleImportFields = {
  /**
   * Identifies the logical import. Required for PURCHASE. A nonblank ID
   * enables tracked OPENING_STOCK, which requires permission to read cost and
   * proof for each owned row. OPENING_STOCK without an ID keeps legacy behavior.
   *
   * Together with each row's `rowId` this is the ONLY thing that can prove a
   * re-sent row is a retry rather than a second car. Matching facts cannot:
   * two genuinely different vehicles are routinely identical in every recorded
   * field — same model, same price, same filler text in the VIN column — and
   * treating that as proof silently drops the second car and its acquisition.
   */
  importId: v.optional(v.string()),
  vehicles: v.array(v.object({
    /**
     * Original file row number. Required for PURCHASE and for each owned row
     * in a tracked OPENING_STOCK import. Keep it distinct and stable on retry.
     */
    rowId: v.optional(v.number()),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    vin: v.string(),
    color: v.string(),
    mileage: v.optional(v.number()),
    fuelType: v.string(),
    transmission: v.string(),
    sellingPrice: v.number(),
    purchasePrice: v.optional(v.number()),
    status: v.optional(v.string()),
    notes: v.optional(v.string()),
    // Owned stock vs sourced (drop-ship from another dealer). SOURCED rows
    // carry the supplier name + cost and land as SOURCING status. SCRUM-717:
    // the type is an EXPLICIT choice — a blank or unrecognised value is
    // refused for the file, never defaulted to owned STOCK — and an owned row
    // carries no `sourcedFromName`/`sourceCost`.
    sourceType: v.optional(v.string()),
    sourcedFromName: v.optional(v.string()),
    sourceCost: v.optional(v.number()),
    /** SCRUM-717: the creditor of an OWNED row bought ON_ACCOUNT (never `sourcedFromName`). */
    purchaseSupplierName: v.optional(v.string()),
    /**
     * SCRUM-868 P2: the supplier master ids. A SOURCED row that names a supplier carries
     * `sourcedSupplierId`; an owned row bought ON_ACCOUNT carries `purchaseSupplierId`. A name without
     * its id refuses the whole file; the stored name is always the master's.
     */
    sourcedSupplierId: v.optional(v.id("suppliers")),
    purchaseSupplierId: v.optional(v.id("suppliers")),
    // Per-company financing valuations carried over from the spreadsheet's
    // valuation columns. `companyId` targets an existing finance company;
    // `companyName` (no companyId) means the column's header didn't match
    // any existing company and a placeholder one should be auto-created.
    valuations: v.optional(v.array(v.object({
      companyId: v.optional(v.id("financeCompanies")),
      companyName: v.optional(v.string()),
      valuationAmount: v.number(),
    }))),
  })),
};

export type VehicleImportInput = ObjectType<typeof vehicleImportFields> & {
  orgId: Id<"organizations">;
  bankAccountId?: Id<"bankAccounts">;
  acquisitionPosting: ImportAcquisitionPosting;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
};

export function readVehicleImportRequest(submitted: VehicleImportInput) {
  const postsAcquisitions = submitted.acquisitionPosting === "PURCHASE";
  const importId = submitted.importId?.trim();
  const tracksOpeningStock = submitted.acquisitionPosting === "OPENING_STOCK" && !!importId;
  const maxRows = postsAcquisitions ? IMPORT_BULK_MAX_POSTING_ROWS : IMPORT_BULK_MAX_ROWS;
  if (submitted.vehicles.length > maxRows) {
    throw new ConvexError(
      `Import too large: ${submitted.vehicles.length} rows in one request (max ${maxRows}). Split the file and import again.`
    );
  }
  return { postsAcquisitions, importId, tracksOpeningStock };
}

export async function prepareVehicleImport(
  ctx: MutationCtx,
  submitted: VehicleImportInput,
  request: ReturnType<typeof readVehicleImportRequest>,
  authority: { user: Doc<"users">; role: Doc<"roles"> },
) {
  const { postsAcquisitions, importId, tracksOpeningStock } = request;
  const { user, role } = authority;
  let args = submitted;

  // SCRUM-886 (OWASP API3:2023): creating vehicles does not imply reading their cost. A stored cost is
  // COST tier, so a caller who may not read it gets the same generic "already recorded under this VIN"
  // refusal whether the file's figure matches or differs: no stored amount and no equality signal.
  // Callers who may read cost keep the detailed reasons. Every refusal below that compares a row with
  // an existing vehicle's cost, currency, payment route or creditor follows this rule. Since the
  // round-8 gate right below, only a PURCHASE import reaches those refusals and a caller without
  // cost access never gets that far, so the `!mayReadCost` branches are defence in depth.
  const mayReadCost = canReadVehicleCost(role);
  // SCRUM-886 (OWASP API3:2023; Convex: authorize inside the function from `ctx.auth`, never from a
  // client argument). INVARIANT: a caller who cannot read vehicle cost never submits a cost-bearing
  // value into a path that compares it with a stored value or a stored fingerprint of it.
  // Two import modes run exactly such a path, and both are decided here, by the caller's role and the
  // request's mode alone, before any evidence lookup, fingerprint, supplier read or comparison:
  //  - PURCHASE hashes every row with `importRowFingerprint` (purchasePrice, sourceCost, supplier,
  //    the file's payment method and bank) and looks the (import, row) evidence up with it, twice
  //    (the proven-replay probe below and the evidence loop). A match is `alreadyRecorded`, a
  //    mismatch is IDEMPOTENCY_CONFLICT, so a replayed key plus guessed figures confirms the stored
  //    ones. The mode always carries cost: a payment method is required, and a priceless row still
  //    hashes `purchasePrice: null` against a stored price, so no row shape is exempt.
  //  - OPENING_STOCK with an import id runs a retry proof that compares the price and the cost in
  //    minor units by design. The import and row ids are OPEN fields on the vehicle.
  // The import key is a client-supplied idempotency token, not a credential: "no reader exposes it"
  // is no defence. Neutralising the comparison would weaken the proof readers rely on, so the call
  // is refused instead. What stays open to a caller without cost access is the legacy opening-stock
  // call with no import id: it posts nothing, keeps no proof and reads no stored cost (an existing
  // VIN is counted as skipped, a VIN is an open field). `vehicles.update` and
  // `vehicleEdits.requestUpdate` follow the same rule through `editPayloadCarriesCost`.
  if ((postsAcquisitions || tracksOpeningStock) && !mayReadCost) {
    throwVehicleSourceShape("VEHICLE_COST_EDIT_NEEDS_COST_ACCESS");
  }
  // SCRUM-868 P2: a row whose (import, row) evidence already exists and whose fingerprint matches is a
  // PROVEN REPLAY. It writes nothing now, so it must not be refused because its supplier was
  // deactivated after the original run. Only the inactive refusal is relaxed for these rows (below);
  // tenant, missing-id and foreign-id checks still apply, and a row that is not a proven replay is a
  // NEW use and still needs an active supplier. A conflicting fingerprint throws from findCommandUnit
  // exactly as it does in the evidence loop further down.
  const provenReplayRowIds = new Set<number>();
  if (postsAcquisitions && importId && args.purchasePaymentMethod !== undefined) {
    for (const row of args.vehicles) {
      if (!isReplayProbeable(row)) continue;
      const evidence = await findCommandUnit(ctx, {
        orgId: args.orgId,
        operation: IMPORT_ROW_OPERATION,
        idempotencyKey: `${importId}:${row.rowId}`,
        fingerprint: await importRowFingerprint(row, args.purchasePaymentMethod, args.bankAccountId),
        label: `Row ${row.rowId} (${row.vin.trim().toUpperCase()})`,
      });
      if (evidence) provenReplayRowIds.add(row.rowId!);
    }
  }
  // SCRUM-868 P2 resolve-then-normalise: every supplier id of the file is resolved in the caller's org
  // before anything else; the rows' name fields become the master's names. A wrong row refuses the file.
  const resolvedImport = await resolveImportSuppliers(ctx, args.orgId, args.vehicles, {
    onAccountPurchase: postsAcquisitions && args.purchasePaymentMethod === "ON_ACCOUNT",
    provenReplayRowIds,
  });
  args = { ...args, vehicles: resolvedImport.rows };
  const openingCurrency = tracksOpeningStock ? await getOrgCurrency(ctx, args.orgId) : undefined;

  // Bulk import runs no Zod schema, and its two range filters (`sourceCost <= 0`
  // at the SOURCED check, `valuationAmount <= 0` on valuations) are both false
  // for NaN — so NaN passed straight into vehicles and vehicleValuations. Every
  // numeric field is validated up front, before any row is written, so a bad
  // cell fails the whole import rather than half-applying it.
  const costCurrency = await getOrgCurrency(ctx, args.orgId);
  for (const row of args.vehicles) {
    assertFiniteNumber(row.year, "year");
    assertFiniteNumber(row.sellingPrice, "selling price");
    if (row.mileage !== undefined) assertFiniteNumber(row.mileage, "mileage");
    if (row.purchasePrice !== undefined) assertFiniteNumber(row.purchasePrice, "purchase price");
    if (row.sourceCost !== undefined) assertFiniteNumber(row.sourceCost, "supplier cost");
    for (const val of row.valuations ?? []) {
      assertFiniteNumber(val.valuationAmount, "valuation amount");
    }
    // SCRUM-717 (D-45): the RAW row's ownership decision, before anything is
    // normalised. A blank or unknown type is refused (not defaulted to STOCK),
    // and an owned row may not carry consignment fields. An incomplete SOURCED
    // row keeps its mode-specific handling below (OPENING_STOCK skips it,
    // PURCHASE refuses the file), so this only adds what was silently guessed.
    if (parseVehicleSourceType(row.sourceType) === "SOURCED") continue;
    assertVehicleIntakeSourceShape(row);
  }

  // Preserve the purchase-cost refusal before checking currency precision.
  // Both validations run for the whole batch before any writes.
  if (postsAcquisitions) {
    const negativeCost = args.vehicles.filter(
      (row) => (row.purchasePrice ?? 0) < 0 || (row.sourceCost ?? 0) < 0
    );
    if (negativeCost.length > 0) {
      throw new ConvexError(
        `${negativeCost.length} row(s) have a negative cost. A purchase cannot cost less than nothing — correct the amounts and import again.`
      );
    }
  }
  for (const row of args.vehicles) {
    assertVehicleCostPrecision(row, costCurrency);
  }
  return { args, postsAcquisitions, importId, tracksOpeningStock, openingCurrency, resolvedImport, user, mayReadCost };
}

export async function checkOpeningVehicleImport(
  ctx: MutationCtx,
  batch: Awaited<ReturnType<typeof prepareVehicleImport>>,
) {
  const { args, importId, tracksOpeningStock, openingCurrency } = batch;

  // The import wizard supplies an import and source-row identity. For that
  // cutover path, each owned car needs durable proof before it can be matched
  // to a single opening journal. Legacy API imports without an importId keep
  // their historical non-posting behavior and cannot be allocated as proof.
  const provenOpeningRetries = new Set<number>();
  if (tracksOpeningStock) {
    const currency = openingCurrency!;
    const priorOpeningRows = await listOpeningStockEvidence(ctx, args.orgId);
    const priorKeys = new Set(priorOpeningRows.map((item) => item.command.idempotencyKey));
    const newOwnedRows = args.vehicles.filter((row) =>
      parseVehicleSourceType(row.sourceType) !== "SOURCED" && !priorKeys.has(`${importId}:${row.rowId}`));
    if (priorOpeningRows.length + newOwnedRows.length > 100) {
      throw new ConvexError("Opening stock exceeds the reviewed 100-vehicle allocation limit.");
    }
    const seenRows = new Set<number>();
    const seenVins = new Set<string>();
    const sourcedVins = new Set(args.vehicles
      .filter((row) => parseVehicleSourceType(row.sourceType) === "SOURCED" && !isPlaceholderVin(row.vin))
      .map((row) => row.vin.trim().toUpperCase()));
    const openingSource = await loadOpeningSourceIdentity(ctx, args.orgId);
    if (openingSource.status === "UNAVAILABLE") {
      throw new ConvexError("Opening stock has ambiguous opening balance proof.");
    }
    for (const row of args.vehicles) {
      if (parseVehicleSourceType(row.sourceType) === "SOURCED") continue;
      if (row.rowId === undefined || !Number.isSafeInteger(row.rowId) || row.rowId < 0 || seenRows.has(row.rowId)) {
        throw new ConvexError("Every opening stock row needs a distinct original file row number.");
      }
      seenRows.add(row.rowId);
      if (isPlaceholderVin(row.vin) || hasNonCanonicalVinCharacters(row.vin)) {
        throw new ConvexError("Opening inventory requires a real alphanumeric VIN for every owned car.");
      }
      const vin = row.vin.trim().toUpperCase();
      if (sourcedVins.has(vin)) {
        throw new ConvexError("Opening inventory cannot use the same VIN for owned and sourced rows.");
      }
      if (seenVins.has(vin)) throw new ConvexError("Opening inventory repeats a VIN in this batch.");
      seenVins.add(vin);
      if (row.purchasePrice === undefined || row.purchasePrice <= 0) {
        throw new ConvexError("Opening inventory requires each owned car's positive acquisition cost.");
      }
      assertMajorAmountRepresentable(row.purchasePrice, currency, "Opening stock cost");
      const key = `${importId}:${row.rowId}`;
      const fingerprint = await simplePayloadHash({ mode: "OPENING_STOCK", row });
      const evidence = await findCommandUnit(ctx, { orgId: args.orgId,
        operation: OPENING_STOCK_IMPORT_OPERATION, idempotencyKey: key, fingerprint, label: `Opening stock row ${row.rowId}` });
      if (evidence) {
        const prior = evidence.result as { vehicleId?: unknown; vin?: unknown;
          costMinor?: unknown; currency?: unknown; sourceType?: unknown } | null;
        const vehicleId = typeof prior?.vehicleId === "string"
          ? ctx.db.normalizeId("vehicles", prior.vehicleId) : null;
        const vehicle = vehicleId ? await ctx.db.get(vehicleId) : null;
        if (!vehicle || vehicle.orgId !== args.orgId || vehicle.openingStockImportId !== importId ||
            vehicle.openingStockRowId !== row.rowId || vehicle.vin !== vin ||
            vehicle.purchasePrice !== row.purchasePrice || vehicle.sourceType !== "STOCK" || vehicle.isDeleted ||
            prior?.vin !== vin || prior?.currency !== currency || prior?.sourceType !== "STOCK" ||
            prior?.costMinor !== toMinorUnits(row.purchasePrice, currency)) {
          throw new ConvexError("Opening stock retry proof conflicts with its vehicle.");
        }
        provenOpeningRetries.add(row.rowId);
        continue;
      }
      if (openingSource.status === "AVAILABLE") throw new ConvexError("New opening stock cannot be imported after the opening balance posted.");
      const existing = await ctx.db.query("vehicles")
        .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", vin)).unique();
      if (existing) throw new ConvexError("An opening stock VIN already exists without this import's proof.");
    }
  }
  return provenOpeningRetries;
}
