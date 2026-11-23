import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { simplePayloadHash } from "../accounting/postingRules";
import { recordCommandUnit } from "./idempotency";
import { toMinorUnits } from "./money";
import { OPENING_STOCK_IMPORT_OPERATION } from "./openingVehicleBasis";
import { requireOwnedRow } from "./tenancy";
import { postOwnedVehicleAcquisition } from "./vehicleAcquisition";
import { IMPORT_ROW_OPERATION, importRowFingerprint } from "./vehicleImportEvidence";
import { prepareVehicleImport } from "./vehicleImportPreflight";
import { parseVehicleSourceType } from "./vehicleSourceShape";
import {
  type VehicleLifecycleStatus,
  assertDirectVehicleCreateStatus,
  normalizeVehicleStatus,
} from "./vehicleStatusGuards";
import { isPlaceholderVin } from "./vin";
import { ConvexError } from "convex/values";

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateImportVinPlaceholder(): string {
  return `IMPORT-${Date.now()}-${randomHex(3)}`;
}

export async function importVehicleRows(
  ctx: MutationCtx,
  batch: Awaited<ReturnType<typeof prepareVehicleImport>>,
  provenOpeningRetries: ReadonlySet<number>,
  provenRetries: ReadonlySet<number>,
) {
  const { args, postsAcquisitions, importId, tracksOpeningStock, openingCurrency, resolvedImport, user } = batch;
  const isOpeningReplay = (row: (typeof args.vehicles)[number]) =>
    tracksOpeningStock && parseVehicleSourceType(row.sourceType) !== "SOURCED" &&
    row.rowId !== undefined && provenOpeningRetries.has(row.rowId);
  const isPurchaseReplay = (row: (typeof args.vehicles)[number]) =>
    postsAcquisitions && row.rowId !== undefined && provenRetries.has(row.rowId);

  const checkedCompanies = new Set<Id<"financeCompanies">>();
  for (const row of args.vehicles) {
    if (isOpeningReplay(row) || isPurchaseReplay(row)) continue;
    for (const { companyId, valuationAmount } of row.valuations ?? []) {
      if (!companyId || valuationAmount <= 0 || checkedCompanies.has(companyId)) continue;
      await requireOwnedRow(ctx, args.orgId, "financeCompanies", companyId, "Finance company not found in this organization.");
      checkedCompanies.add(companyId);
    }
  }

  // Resolve (and lazily create) finance companies referenced by name only.
  // Created inert (isActive: false, zero rates) — an Owner must configure
  // and activate them from Settings → Finance before they affect quotes.
  const existingCompanies = await ctx.db
    .query("financeCompanies")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .collect();
  const companyIdByName = new Map<string, Id<"financeCompanies">>();
  existingCompanies.forEach((c) => companyIdByName.set(c.name.trim(), c._id));

  let companiesCreated = 0;
  for (const row of args.vehicles) {
    if (isOpeningReplay(row)) {
      continue;
    }
    // ⚠️ A PROVEN RETRY CREATES NOTHING — INCLUDING COMPANIES.
    //
    // This loop runs before the row loop, so it used to reach proven-retry
    // rows too. Harmless while the company still exists under the name the
    // spreadsheet used; NOT harmless after somebody renames it in Settings,
    // because the lookup then misses and the retry recreates an inert
    // duplicate under the old name — while reporting `alreadyRecorded`, i.e.
    // while claiming it did nothing at all. Reproduced:
    //
    //   again={alreadyRecorded:1, companiesCreated:1}
    //   companies = "Orange Finance PLC" | "Orange Finance"
    //
    // A no-op that creates a row is not a no-op. The original call already
    // created whatever its valuations named, in the same transaction as the
    // evidence that makes this a retry at all.
    if (isPurchaseReplay(row)) continue;
    for (const val of row.valuations ?? []) {
      // ⚠️ PURCHASE ONLY: a valuation the writer will never store must not
      // create a company either.
      //
      // The writer skips a non-positive valuation (`valuationAmount <= 0`),
      // and so does the retry fingerprint — but this loop had no amount check
      // at all, so a named zero-valued entry still created an inert company.
      // That put a real side effect outside everything the fingerprint
      // describes: `{A, 0}`, `{B, 0}` and no valuation at all are one command
      // to the proof and three different outcomes in the database, so a
      // re-sent row naming a different company was accepted as a proven retry
      // and its company silently never created.
      //
      // Scoped to PURCHASE deliberately. Only that mode has an idempotency
      // proof to disagree with; OPENING_STOCK creates companies from
      // zero-valued columns exactly as it always has, and a cutover migration
      // must not change shape because of a rule written for a different mode.
      if (postsAcquisitions && val.valuationAmount <= 0) continue;
      if (val.companyId || !val.companyName) continue;
      const name = val.companyName.trim();
      if (!name || companyIdByName.has(name)) continue;
      const newId = await ctx.db.insert("financeCompanies", {
        orgId: args.orgId,
        name,
        profitRate: 0,
        maxTermMonths: 84,
        gracePeriodMonths: 0,
        isActive: false,
      });
      companyIdByName.set(name, newId);
      companiesCreated++;
    }
  }

  let inserted = 0;
  // ⚠️ `skipped` is OPENING_STOCK's counter and means "an exact VIN was already
  // here". In PURCHASE mode it stays 0 for the whole run: a proven retry is
  // counted as `alreadyRecorded`, and every other reason a row might not be
  // written has already thrown above. One counter carrying both meanings is
  // what let a lost car be announced as a duplicate.
  let skipped = 0;
  let alreadyRecorded = 0;

  for (const row of args.vehicles) {
    if (isOpeningReplay(row)) {
      skipped++;
      continue;
    }
    // ── A PROVEN RETRY IS FINISHED. Nothing below runs for it.
    //
    // ⚠️ This MUST come before the VIN lookup, and an earlier revision had it
    // nested inside that lookup instead — which meant a proven row whose
    // vehicle had since been renamed was not recognised at all. Reproduced:
    // import a car, correct its VIN through the ordinary edit screen, then let
    // the original call retry. The lookup for the OLD vin found nothing, so
    // the row fell through and inserted a SECOND vehicle, posted a SECOND
    // acquisition, and wrote a SECOND evidence row under the same key — double
    // inventory and cash, plus an evidence table that then throws on every
    // `.unique()` read of that key.
    //
    // Proof of execution is a property of the ROW, not of anything currently
    // in the database. Consulting it through a database lookup made it
    // conditional on state the proof was supposed to make irrelevant.
    if (isPurchaseReplay(row)) {
      alreadyRecorded++;
      continue;
    }

    // Placeholder VINs (xxxxx, N/A, blank, ...) are treated as "no VIN": they
    // must NOT dedupe against each other, or all-but-one stock row is skipped.
    const normalizedVin = isPlaceholderVin(row.vin) ? "" : row.vin.trim().toUpperCase();
    const isSourced = parseVehicleSourceType(row.sourceType) === "SOURCED";

    // OPENING_STOCK only: an existing VIN is skipped, and that vehicle's
    // valuations are still refreshed from this import. PURCHASE cannot reach
    // this — a proven retry already left the loop, and any other existing VIN
    // was refused during classification.
    let vehicleId: Id<"vehicles"> | null = null;
    if (normalizedVin) {
      const existing = await ctx.db
        .query("vehicles")
        .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalizedVin))
        .unique();
      if (existing) {
        // PURCHASE never reaches here: a proven retry left the loop at the
        // top, and every other existing-VIN row was refused before any write.
        // This is OPENING_STOCK's long-standing duplicate handling.
        if (postsAcquisitions) {
          throw new ConvexError(
            `Internal check failed: row ${row.rowId} (${normalizedVin}) reached the writer without proof. Nothing was imported.`
          );
        }
          if (tracksOpeningStock && !isSourced) {
            throw new ConvexError("An opening stock VIN already exists without this import's proof.");
          }
        skipped++;
        vehicleId = existing._id;
      }
    }

    if (!vehicleId) {
      // A sourced row without its supplier name + cost can't be created (the
      // same constraint createSourced enforces). For OPENING_STOCK it is
      // skipped rather than thrown — one bad row must not roll back the whole
      // batch's inserts, and nothing of accounting significance is lost.
      //
      // PURCHASE never reaches here: the classification pass refuses the whole
      // file for exactly this row shape, because dropping it means a car that
      // was genuinely bought is never recorded, its acquisition never posts,
      // and the operator is told it was a "duplicate". The assertion is not
      // defensive decoration — it states the invariant that makes the
      // `alreadyRecorded` accounting above sound.
      const sourceCost = row.sourceCost ?? row.purchasePrice;
      if (isSourced && (!row.sourcedFromName?.trim() || sourceCost === undefined || sourceCost <= 0)) {
        if (postsAcquisitions) {
          throw new ConvexError(
            `Internal check failed: a purchase import reached row ${row.vin} without a supplier or cost. Nothing was imported.`
          );
        }
        skipped++;
        continue;
      }

      // Sourced vehicles begin life as SOURCING; owned stock as AVAILABLE.
      const status = normalizeVehicleStatus(row.status) ?? (isSourced ? "SOURCING" : "AVAILABLE");
      assertDirectVehicleCreateStatus(status);

      const insertedVin = normalizedVin || generateImportVinPlaceholder();
      vehicleId = await ctx.db.insert("vehicles", {
        orgId: args.orgId,
        ...(tracksOpeningStock && !isSourced ? { openingStockImportId: importId, openingStockRowId: row.rowId } : {}),
        vin: insertedVin,
        make: row.make.trim(),
        model: row.model.trim(),
        year: row.year,
        mileage: row.mileage ?? 0,
        color: row.color.trim(),
        fuelType: row.fuelType,
        transmission: row.transmission,
        sellingPrice: row.sellingPrice,
        // For a sourced vehicle purchasePrice mirrors the supplier cost, matching createSourced.
        purchasePrice: isSourced ? sourceCost : row.purchasePrice,
        ...(isSourced
          ? {
              sourceType: "SOURCED" as const,
              sourcedFromName: row.sourcedFromName!.trim(),
              sourcedSupplierId: row.sourcedSupplierId,
              sourceCost,
            }
          : { sourceType: "STOCK" as const }),
        status: status as VehicleLifecycleStatus,
        notes: row.notes,
        addedBy: user._id,
        updatedBy: user._id,
        updatedAt: Date.now(),
      });
      inserted++;

      if (tracksOpeningStock && !isSourced) {
        await recordCommandUnit(ctx, {
          orgId: args.orgId, operation: OPENING_STOCK_IMPORT_OPERATION,
          idempotencyKey: `${importId}:${row.rowId}`,
          fingerprint: await simplePayloadHash({ mode: "OPENING_STOCK", row }),
          result: { vehicleId, vin: insertedVin, costMinor: toMinorUnits(row.purchasePrice!, openingCurrency!),
            currency: openingCurrency, sourceType: "STOCK" }, actorId: user._id,
        });
      }

      // Only newly inserted rows post. A duplicate-VIN row resolved to an
      // existing vehicle above must not re-post an acquisition for stock that
      // was already capitalized (postVehicleAcquisitionIfOwned's underlying
      // event is idempotent per vehicle, but re-running it would also insert a
      // second legacy VEHICLE_PURCHASE cash transaction, which is not).
      if (postsAcquisitions) {
        await postOwnedVehicleAcquisition(ctx, {
          orgId: args.orgId,
          vehicleId,
          isSourced,
          purchasePrice: isSourced ? sourceCost : row.purchasePrice,
          purchasePaymentMethod: args.purchasePaymentMethod,
          bankAccountId: args.bankAccountId,
          creditor: row.purchaseSupplierId ? resolvedImport.snapshots.get(row.purchaseSupplierId) : undefined,
          vehicleLabel: `${row.year} ${row.make.trim()} ${row.model.trim()}`,
          vin: insertedVin,
          actorId: user._id,
        });

        // ⚠️ THE SAME TRANSACTION AS THE WORK IT ATTESTS TO — deliberately,
        // and this ordering is the whole safety argument.
        //
        // A Convex mutation is atomic: if the acquisition above throws, or any
        // later row throws, this insert rolls back with it and the retry
        // correctly sees no evidence. Writing it from a separate mutation, an
        // action or the scheduler would invert the defect this fixes —
        // evidence surviving a posting that failed, so every retry is refused
        // as "already recorded" and the money never reaches the ledger.
        await recordCommandUnit(ctx, {
          orgId: args.orgId,
          operation: IMPORT_ROW_OPERATION,
          idempotencyKey: `${importId}:${row.rowId}`,
          fingerprint: await importRowFingerprint(row, args.purchasePaymentMethod!, args.bankAccountId),
          result: { vehicleId },
          actorId: user._id,
        });
      }
    }

    for (const val of row.valuations ?? []) {
      // Surveyed with the rest of the lenient-skip class and deliberately left
      // alone. This is a sub-record, not a whole row: dropping it loses a
      // finance company's valuation, never a vehicle and never an acquisition,
      // so no money goes unrecorded either way. A blank or zero valuation
      // column is also completely ordinary — most companies have no figure for
      // most cars — so refusing on it would reject nearly every real
      // spreadsheet. An UNREADABLE valuation cell is a different matter and is
      // caught client-side by parseMoneyCell, which marks the row invalid.
      // ⚠️ PURCHASE ONLY: a name-only entry whose name is blank resolves to
      // NOTHING, and must not resolve to something by accident.
      //
      // `finance.createCompany` accepts `name: v.string()` and stores it
      // untrimmed, so a company literally named "   " can exist. It is then
      // indexed under the EMPTY key, and `companyIdByName.get("")` finds it —
      // so a valuation naming no company at all silently attached itself to
      // that one. The retry fingerprint excludes such an entry (it has no
      // usable company), which made this a write the proof does not describe:
      // a re-sent row changing it hashed identically and the change was
      // discarded.
      //
      // Scoped to PURCHASE, and deliberately narrow: only the AMBIGUOUS
      // name-only lookup is removed. An explicit `companyId` still resolves,
      // so a malformed company that already exists stays fully referenceable
      // — this closes a lookup, it does not orphan data. OPENING_STOCK has no
      // idempotency proof to disagree with and keeps its behaviour.
      //
      // The underlying model problem — that whitespace-only company names can
      // be created at all — is NOT fixed here. SCRUM-175.
      if (postsAcquisitions && !val.companyId && !(val.companyName ?? "").trim()) continue;
      const companyId = val.companyId ?? (val.companyName ? companyIdByName.get(val.companyName.trim()) : undefined);
      if (!companyId || val.valuationAmount <= 0) continue;

      const existingValuation = await ctx.db
        .query("vehicleValuations")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId!))
        .filter((q) => q.eq(q.field("companyId"), companyId))
        .first();

      if (existingValuation) {
        await ctx.db.patch(existingValuation._id, { valuationAmount: val.valuationAmount });
      } else {
        await ctx.db.insert("vehicleValuations", {
          orgId: args.orgId,
          vehicleId: vehicleId!,
          companyId,
          valuationAmount: val.valuationAmount,
        });
      }
    }
  }

  return { inserted, skipped, alreadyRecorded, companiesCreated };
}
