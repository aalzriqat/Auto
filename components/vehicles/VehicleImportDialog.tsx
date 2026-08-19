"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useCurrency } from "@/hooks/useCurrency";
import {
  ImportWizard,
  ImportFieldConfig,
  ImportRow,
  normalizeKey,
  type ImportPreflightInfo,
} from "@/components/import/ImportWizard";
import {
  PaymentMethodSelect,
  type AcquisitionPaymentMethod,
} from "@/components/payments/PaymentMethodSelect";
import { PURCHASE_IMPORT_MAX_ROWS } from "@/convex/utils/importLimits";
import { assertDirectVehicleCreateStatus } from "@/convex/utils/vehicleStatusGuards";
import { hasNonCanonicalVinCharacters, isPlaceholderVin } from "@/convex/utils/vin";
import { cn } from "@/lib/utils";
import { SpreadsheetRows } from "@/lib/spreadsheet";
import { downloadVehicleTemplate } from "@/components/vehicles/vehicleSheet";

const NEW_COMPANY_PREFIX = "valuation:new:";
const EXISTING_COMPANY_PREFIX = "valuation:id:";

// ---------------------------------------------------------------------------
// Column name auto-guess — handles Arabic + English header variations.
// This is only a starting point; the dealer can remap any column themselves,
// and their choice is remembered per-organization for next time.
// ---------------------------------------------------------------------------
const COL_MAP: Record<string, string> = {
  // Make / brand
  "type/name": "make", typename: "make", type: "make", name: "make",
  make: "make", brand: "make", manufacturer: "make",
  الشركة: "make", الصانع: "make", الماركة: "make", الاسم: "make", النوع: "make",

  // Model (may embed year, e.g. "Camry 2022")
  model: "model", النموذج: "model", الموديل: "model",

  // Year (standalone column)
  year: "year", سنة: "year", "سنة الصنع": "year",

  // VIN / chassis
  vin: "vin", chassis: "vin", "chassis number": "vin", "رقم الشاصي": "vin", الشاصي: "vin",

  // Color
  color: "color", colour: "color", اللون: "color",

  // Mileage
  mileage: "mileage", km: "mileage", "ك.م": "mileage",
  kilometers: "mileage", odometer: "mileage",
  المسافة: "mileage", الكيلومترات: "mileage",

  // Fuel type
  "fuel type": "fuelType", fuel: "fuelType",
  "نوع الوقود": "fuelType", الوقود: "fuelType",

  // Transmission
  transmission: "transmission", gearbox: "transmission",
  "ناقل الحركة": "transmission", ناقلالحركة: "transmission",

  // Selling price — المتخصصة is the primary retail price in the dealership's template
  "selling price": "sellingPrice", price: "sellingPrice", "sale price": "sellingPrice",
  "سعر البيع": "sellingPrice", السعر: "sellingPrice",
  المتخصصة: "sellingPrice",

  // Purchase / cost price
  "purchase price": "purchasePrice", cost: "purchasePrice", "buy price": "purchasePrice",
  "سعر الشراء": "purchasePrice", التكلفة: "purchasePrice",

  // Owned stock vs sourced (drop-ship). Note bare "type" is already mapped to
  // make above, so the source-type column must be a distinct header.
  "source type": "sourceType", sourcetype: "sourceType", "نوع المصدر": "sourceType",
  "نوع الملكية": "sourceType", "الملكية": "sourceType",

  // Supplier the sourced vehicle came from
  "sourced from": "sourcedFrom", sourcedfrom: "sourcedFrom", supplier: "sourcedFrom",
  "المورد": "sourcedFrom", "اسم المورد": "sourcedFrom", "مصدر السيارة": "sourcedFrom",

  // Misc
  status: "status", الحالة: "status",
  notes: "notes", comments: "notes", remarks: "notes", ملاحظات: "notes",

  // Finance-company valuation columns (بندار / تمكين / السماحة / ...) are not
  // listed here — they're injected dynamically per-file by resolveDynamicFields
  // below, since the set of companies/columns varies per sheet and per org.
};

const VEHICLE_FIELDS: ImportFieldConfig[] = [
  { key: "make", label: "Make / Brand", required: true },
  { key: "model", label: "Model", required: true },
  { key: "year", label: "Year" },
  { key: "vin", label: "VIN / Chassis Number" },
  { key: "color", label: "Color" },
  { key: "mileage", label: "Mileage / KM" },
  { key: "fuelType", label: "Fuel Type" },
  { key: "transmission", label: "Transmission" },
  { key: "sellingPrice", label: "Selling Price", required: true },
  { key: "purchasePrice", label: "Purchase Price / Cost" },
  { key: "sourceType", label: "Source Type (Stock / Sourced)" },
  { key: "sourcedFrom", label: "Sourced From (supplier)" },
  { key: "status", label: "Status" },
  { key: "notes", label: "Notes" },
];

const PREVIEW_COLUMNS = [
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "year", label: "Year" },
  { key: "vin", label: "VIN" },
  { key: "color", label: "Color" },
  { key: "mileage", label: "KM" },
  { key: "sourceType", label: "Type" },
  { key: "purchasePrice", label: "Cost", align: "end" as const },
  { key: "sellingPrice", label: "Selling Price", align: "end" as const },
  { key: "valuations", label: "Financing Company Valuations" },
];

function normalizeImportSourceType(raw: unknown): "STOCK" | "SOURCED" {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "STOCK";
  if (value === "SOURCED" || value.includes("SOURCE") || value.includes("مصدر") || value.includes("خارج")) {
    return "SOURCED";
  }
  return "STOCK";
}

/**
 * Reads a worksheet that may have a single OR double header row.
 * The dealership's template uses 2 rows:
 *   Row 1: TYPE/Name | VIN | Color | KM | Cost | Model | المتخصصة | الكوتر | [التخمين merged]
 *   Row 2:                                                                   | بندار | تمكين | السماحة
 * When row 2 contains Arabic valuation sub-headers, we merge both rows into
 * a single header and start data from row 3.
 */
function parseVehicleWorksheet(rawRows: SpreadsheetRows): { headers: string[]; rows: any[][]; valuationHeaders: string[] } {
  if (rawRows.length === 0) return { headers: [], rows: [], valuationHeaders: [] };

  // Only these three trigger double-header detection (matches the dealership's
  // known template), but once triggered, EVERY non-empty row-2 cell becomes a
  // valuation column — so a dealer typing a 4th financing company name in row 2 just works.
  const VALUATION_SUB_HEADERS = new Set(["بندار", "تمكين", "السماحة"]);
  const primaryHeaders: string[] = (rawRows[0] ?? []).map((c: any) => String(c ?? "").trim());
  const secondRow: string[] = (rawRows[1] ?? []).map((c: any) => String(c ?? "").trim());
  const isDoubleHeader = secondRow.some((cell) => VALUATION_SUB_HEADERS.has(cell));

  let finalHeaders: string[];
  let dataStartRow: number;
  let valuationHeaders: string[] = [];
  if (isDoubleHeader) {
    finalHeaders = primaryHeaders.map((h, i) => secondRow[i] || h);
    valuationHeaders = finalHeaders.filter((_, i) => secondRow[i] !== "");
    dataStartRow = 2;
  } else {
    // Single-header sheet (the dealership's current template): the valuation
    // columns sit inline on row 1 with descriptive Arabic names (one per finance
    // program), not on a second row. Any non-empty header that COL_MAP doesn't
    // recognize as a core vehicle field is therefore a finance-company valuation
    // column — resolveDynamicFields turns each into a mappable target, and the
    // dealer can still switch any of them to "Ignore" in the wizard.
    finalHeaders = primaryHeaders;
    dataStartRow = 1;
    valuationHeaders = finalHeaders.filter(
      (h) => h.trim() !== "" && !(normalizeKey(h) in COL_MAP)
    );
  }

  const dataRows = rawRows.slice(dataStartRow).filter((row) => row.some((cell: any) => cell !== ""));
  return { headers: finalHeaders, rows: dataRows, valuationHeaders };
}

/**
/**
 * A money cell either reads EXACTLY, or it is an error the operator has to see.
 *
 * `parseFloat` is a PREFIX parser, and on a money column that is a silent
 * corruption rather than a failure. Measured on the cells dealers actually
 * produce:
 *
 *   "1O000"      (capital O for zero) -> 1          — posts one dinar
 *   "10000abc"                        -> 10000      — reads as if clean
 *   "JOD 10,000" (currency in-cell)   -> NaN -> undefined, i.e. "no cost", so
 *                                        the car imports UNCAPITALIZED and the
 *                                        import reports success
 *
 * Each of those reaches accounting meaning something different from the
 * spreadsheet cell, and none of them tells anyone. The grammar below is
 * deliberately narrow — optional sign, digits, optional 3-digit thousands
 * groups, optional decimal — and anything outside it is an error rather than a
 * repair. Currency text is NOT stripped and separators are NOT guessed: a cell
 * this function cannot read is a cell a human has to look at.
 *
 * `\d` here is ASCII-only (no `u` flag), so Arabic-Indic digits do not match and
 * are refused rather than silently mapped. That is the fail-closed direction and
 * it needs no digit table.
 *
 * Space-grouped values ("10 000") are deliberately NOT accepted: a space is
 * equally likely to be a typo splitting two numbers, and guessing which is the
 * silent repair this function exists to stop. An explicit "+" IS accepted — it
 * is unambiguous, and refusing it was an oversight rather than a decision.
 */
const MONEY_CELL = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

type MoneyCell = { ok: true; value: number | undefined } | { ok: false };

/** Blank is `undefined` (absent, which is legitimate); unreadable is `ok: false`. */
export function parseMoneyCell(raw: unknown): MoneyCell {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  // A spreadsheet parser can hand back a real number; trust it only if finite.
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false };
  }
  const text = String(raw).trim();
  if (text === "") return { ok: true, value: undefined };
  if (!MONEY_CELL.test(text)) return { ok: false };
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

/**
 * Smart model/make splitting + year extraction, applied after the dealer's
 * column mapping. "TYPE/Name" often contains the full vehicle name (e.g.
 * "BYD Dolphin 2024"); when there's no explicit model column, we split on
 * the first space (make / model) and pull a 19xx/20xx year out of the model.
 */
export function deriveVehicleRow(mapped: Record<string, any>): Record<string, any> {
  const rawModel = String(mapped.model ?? "").trim();
  const yearFromModel = rawModel.match(/\b(19|20)\d{2}\b/)?.[0];
  let model = yearFromModel ? rawModel.replace(yearFromModel, "").trim() : rawModel;
  const year = parseInt(mapped.year) || (yearFromModel ? parseInt(yearFromModel) : NaN);

  let make = String(mapped.make ?? "").trim();
  if (!model && make.includes(" ")) {
    const spaceIdx = make.indexOf(" ");
    model = make.slice(spaceIdx + 1).trim();
    make = make.slice(0, spaceIdx).trim();
  }

  const rawVin = String(mapped.vin ?? "").trim();
  const vin = isPlaceholderVin(rawVin) ? "" : rawVin;
  const color = String(mapped.color ?? "").trim();
  const rawMileage = mapped.mileage != null ? String(mapped.mileage).trim() : "";
  const mileage = rawMileage === "" ? undefined : parseFloat(rawMileage.replace(/,/g, ""));
  const fuelType = String(mapped.fuelType ?? "Petrol").trim() || "Petrol";
  const transmission = String(mapped.transmission ?? "Automatic").trim() || "Automatic";
  // Unreadable money is collected rather than coerced, and surfaced by
  // validateVehicleRow — which makes the row invalid, which (for a PURCHASE)
  // refuses the whole file before anything is sent. See parseMoneyCell.
  const numberErrors: string[] = [];
  const sellingCell = parseMoneyCell(mapped.sellingPrice);
  if (!sellingCell.ok) numberErrors.push(`Unreadable Selling Price: "${String(mapped.sellingPrice).trim()}"`);
  // Absent selling price has always meant 0 and still does; only a non-blank
  // cell that cannot be read is an error.
  const sellingPrice = sellingCell.ok ? (sellingCell.value ?? 0) : 0;

  const purchaseCell = parseMoneyCell(mapped.purchasePrice);
  if (!purchaseCell.ok) numberErrors.push(`Unreadable Cost: "${String(mapped.purchasePrice).trim()}"`);
  const purchasePrice = purchaseCell.ok ? purchaseCell.value : undefined;

  const sourceType = normalizeImportSourceType(mapped.sourceType);
  const sourcedFrom = String(mapped.sourcedFrom ?? "").trim();

  const valuations: Array<{ companyId?: string; companyName?: string; valuationAmount: number }> = [];
  Object.entries(mapped).forEach(([key, value]) => {
    if (!key.startsWith(NEW_COMPANY_PREFIX) && !key.startsWith(EXISTING_COMPANY_PREFIX)) return;
    // ⚠️ A valuation NEVER blocks the row, deliberately — and an earlier
    // revision of this made it do so, which was a real regression.
    //
    // A finance-company valuation posts nothing and is entirely optional, so a
    // cell that cannot be read means "this company gave no figure", exactly as
    // blank and zero already do. "N/A" in a valuation column is completely
    // ordinary in the spreadsheets dealers actually send. Treating it as a row
    // error excluded the whole VEHICLE from the import — a car dropped from a
    // cutover migration because of a column that carries no money at all.
    //
    // The strictness belongs on `purchasePrice` and `sellingPrice`, which is
    // where a misread cell changes what reaches the books.
    const cell = parseMoneyCell(value);
    const amount = cell.ok ? cell.value : undefined;
    if (amount === undefined || amount <= 0) return;
    if (key.startsWith(NEW_COMPANY_PREFIX)) {
      valuations.push({ companyName: key.slice(NEW_COMPANY_PREFIX.length), valuationAmount: amount });
    } else {
      // Encoded as "<companyId>:<headerText>" so the preview can still show a name.
      const rest = key.slice(EXISTING_COMPANY_PREFIX.length);
      const sepIdx = rest.indexOf(":");
      const companyId = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
      const companyName = sepIdx >= 0 ? rest.slice(sepIdx + 1) : undefined;
      valuations.push({ companyId, companyName, valuationAmount: amount });
    }
  });

  return {
    make, model, year, vin,
    color: color || "Unknown",
    mileage,
    fuelType, transmission,
    sellingPrice,
    // A cost of exactly 0 keeps its long-standing meaning of "no cost stated",
    // so nothing capitalizes off it. This was previously a `&&` truthiness test
    // that also swallowed NaN; NaN can no longer reach here, and the zero case
    // is now deliberate rather than incidental.
    purchasePrice: purchasePrice === 0 ? undefined : purchasePrice,
    // Only fields declared in the importBulk validator may be returned here —
    // the whole derived row (minus _errors) is sent as the mutation payload, and
    // Convex rejects any undeclared field. sourcedFromName holds the supplier.
    sourceType,
    // For a sourced vehicle the supplier cost is the same "Cost" column that
    // owned stock uses for purchase price; importBulk mirrors it into sourceCost.
    sourceCost: sourceType === "SOURCED" && purchasePrice ? purchasePrice : undefined,
    // Kept for STOCK rows too, not just SOURCED. importBulk writes
    // `sourcedFromName` onto the vehicle document ONLY for a SOURCED row, so this
    // does not pollute owned stock — but a PURCHASE on ON_ACCOUNT needs the
    // supplier name to credit AP-Suppliers and to create the payable, and every
    // capitalizing row is STOCK by definition. Discarding it here made the
    // supplier column unreachable, so selecting "On account" blocked the import
    // forever even from a spreadsheet that named the supplier in every row.
    sourcedFromName: sourcedFrom || undefined,
    status: mapped.status ? String(mapped.status).toUpperCase() : undefined,
    notes: mapped.notes ? String(mapped.notes).trim() : undefined,
    valuations,
    // Preview-only. Deliberately NOT in the payload picked for importBulk —
    // Convex rejects undeclared fields — and read by validateVehicleRow, which
    // is the only thing that turns it into a visible error.
    _numberErrors: numberErrors,
  };
}

export function validateVehicleRow(row: Record<string, any>): string[] {
  const errors: string[] = [];
  // A money cell that could not be read is a data-entry error in EITHER posting
  // mode. It blocks a purchase import outright (one transaction over the whole
  // file); in an opening-stock import it excludes the row from the valid set,
  // which is what the wizard already does with every other invalid row.
  errors.push(...((row._numberErrors as string[] | undefined) ?? []));
  if (!row.make) errors.push("Missing Make");
  if (!row.model) errors.push("Missing Model");
  // The server's own guard, called rather than restated — it throws both for an
  // unrecognized status and for the workflow-controlled ones (a car becomes
  // SOLD by completing a sale, RESERVED by taking a deposit). Catching it here
  // matters more since the import posts: without this the row sails through the
  // preview, and in a file bigger than one chunk it throws only after earlier
  // chunks have already committed vehicles AND their journal entries.
  try {
    assertDirectVehicleCreateStatus(row.status);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Invalid Status");
  }
  if (!row.year || isNaN(row.year) || row.year < 1900 || row.year > new Date().getFullYear() + 2) errors.push("Invalid Year");
  if (row.mileage !== undefined && (isNaN(row.mileage) || row.mileage < 0)) errors.push("Invalid Mileage");
  // A purchase cannot cost less than nothing. importBulk refuses this too and
  // is the control; catching it here names the row instead of failing the file
  // with a count after the operator has already pressed Import.
  if (row.purchasePrice !== undefined && row.purchasePrice < 0) errors.push("Negative Cost");
  if (row.sourceType === "SOURCED") {
    // Sourced vehicles must name their supplier and carry a supplier cost — the
    // same constraint the create-sourced flow enforces (backend re-checks too).
    if (!row.sourcedFromName) errors.push("Sourced vehicle needs a supplier (Sourced From)");
    if (!row.purchasePrice || isNaN(row.purchasePrice) || row.purchasePrice <= 0) {
      errors.push("Sourced vehicle needs a Cost");
    }
  }
  return errors;
}

function renderVehiclePreviewCell(row: ImportRow, key: string) {
  switch (key) {
    case "make": return row.make || <span className="text-destructive">—</span>;
    case "model": return row.model || <span className="text-destructive">—</span>;
    case "year": return row.year || <span className="text-destructive">—</span>;
    case "vin": return <span className="font-mono text-xs">{row.vin || "—"}</span>;
    case "color": return row.color;
    case "mileage":
      return row.mileage !== undefined && !isNaN(row.mileage)
        ? row.mileage.toLocaleString()
        : <span className="text-muted-foreground text-xs">TBD</span>;
    case "sourceType":
      return row.sourceType === "SOURCED"
        ? <span className="text-xs text-orange-600">Sourced</span>
        : <span className="text-xs text-muted-foreground">Stock</span>;
    case "purchasePrice": return row.purchasePrice ? row.purchasePrice.toLocaleString() : "—";
    case "sellingPrice": return row.sellingPrice > 0 ? row.sellingPrice.toLocaleString() : "—";
    case "valuations": {
      const valuations = (row.valuations ?? []) as Array<{ companyName?: string; valuationAmount: number }>;
      if (valuations.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
      return (
        <span className="text-xs">
          {valuations.map((v) => `${v.companyName ?? "?"}: ${v.valuationAmount.toLocaleString()}`).join(", ")}
        </span>
      );
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Accounting declaration (SCRUM-59)
// ---------------------------------------------------------------------------
type AcquisitionPosting = "OPENING_STOCK" | "PURCHASE";

/**
 * The four settled methods AND ON_ACCOUNT.
 *
 * An earlier revision offered only the four settled methods, reasoning that
 * exposing supplier credit here would be an asymmetry with the single-vehicle
 * form. That was the wrong trade once this dialog started POSTING. With
 * ON_ACCOUNT withheld, a dealer who bought on supplier credit had no truthful
 * selection: every remaining option credits cash, bank, cheque or card for money
 * that never moved, and writes no `vehicleSupplierPayables` row. An importer
 * that can only record a purchase by misstating how it was paid defeats the
 * point of SCRUM-59, which exists to stop the importer writing the wrong books.
 *
 * The server already implements, guards and tests this branch — it demands a
 * supplier name per capitalizing row and credits AP-Suppliers instead of cash.
 * Only this list withheld it. Owner decision, 2026-08-19, scoped to the bulk
 * importer and deliberately not to the single-vehicle form.
 */
const IMPORT_PAYMENT_METHODS: readonly AcquisitionPaymentMethod[] = [
  "CASH",
  "BANK_TRANSFER",
  "CHEQUE",
  "CARD",
  "ON_ACCOUNT",
];

/** Rows that will actually reach Vehicle Inventory: owned, with a cost. */
function capitalizingRows(rows: Record<string, any>[]) {
  return rows.filter((r) => r.sourceType !== "SOURCED" && Number(r.purchasePrice) > 0);
}

/**
 * The server's PURCHASE rules, re-checked here across the whole file.
 *
 * Not a duplicate of the server control — the server still refuses, and it is
 * authoritative. This exists so the operator learns BEFORE submitting, from a
 * message that names the rows, instead of from a generic server error after
 * staring at a preview.
 *
 * ⚠️ A PURCHASE import is ONE transaction and is never chunked, so there is no
 * "bad row in a later chunk" to discover late any more: the whole file either
 * commits or does not. An earlier version of this comment described that
 * chunk-boundary hazard; it no longer exists, and reasoning about one chunk is
 * precisely the mental model that produced this PR's defects.
 */
export function purchaseBlockers(
  rows: Record<string, any>[],
  paymentMethod: AcquisitionPaymentMethod | null,
  file: { invalidCount: number; totalCount: number } = { invalidCount: 0, totalCount: rows.length }
): {
  missingVin: number;
  malformedVin: number;
  missingSupplier: number;
  exceedsRowLimit: boolean;
  hasInvalidRows: boolean;
} {
  // Every row, not just the ones that post today — see the server's own
  // `missingVin` check for why a sourced or cost-less row is not harmless.
  //
  // BOTH VIN predicates call the SAME functions the server does rather than
  // restating them. A preflight that quietly disagrees with the guard it mirrors
  // is how a button ends up offering what the server refuses. `missingVin` used
  // to restate the rule as `!vin.trim()`, which agreed with the server only
  // because `deriveVehicleRow` happens to normalize placeholders to "" before
  // the preview sees them — an implicit dependency that would break silently.
  return {
    missingVin: rows.filter((r) => isPlaceholderVin(String(r.vin ?? ""))).length,
    malformedVin: rows.filter((r) => hasNonCanonicalVinCharacters(String(r.vin ?? ""))).length,
    // Mirrors the server's ON_ACCOUNT rule exactly: a capitalizing row bought on
    // supplier credit must name who the payable is owed to, because the
    // AP-Suppliers credit and the `vehicleSupplierPayables` row both need it.
    missingSupplier:
      paymentMethod === "ON_ACCOUNT"
        ? capitalizingRows(rows).filter((r) => !String(r.sourcedFromName ?? "").trim()).length
        : 0,
    // Counted over EVERY parsed row, not just the valid ones. A file of 26 rows
    // is a 26-row file whether or not one of them currently fails validation;
    // measuring the limit against the valid subset would let the same file
    // become importable simply because a row was broken.
    exceedsRowLimit: file.totalCount > IMPORT_PURCHASE_MAX_ROWS,
    // ⚠️ A PURCHASE import is one atomic transaction over the WHOLE file, so it
    // must not run on the valid subset while quietly dropping the rest. Two cars
    // sharing a filler VIN, where one row is momentarily invalid, would otherwise
    // import the first, and the corrected second would later be read as a retry
    // of it and skipped — one car bought, no acquisition, nothing said. The whole
    // action waits until every row is valid.
    hasInvalidRows: file.invalidCount > 0,
  };
}

/**
 * The last thing between a spreadsheet and the ledger.
 *
 * Deliberately not a card: it is the terms of the action about to be taken, so
 * it reads as part of the footer rather than as another object on the screen.
 * Two exclusive choices as real radios (keyboard + screen-reader correct), each
 * carrying the consequence in the dealer's own terms rather than an accounting
 * one — and, once "bought" is chosen, the exact figure that will land in
 * Vehicle Inventory. Seeing that number before committing is the whole point:
 * SCRUM-59 was possible precisely because the accounting effect of an import
 * was invisible.
 */
function ImportAccountingChoice({
  validRows,
  invalidCount,
  totalCount,
  posting,
  setPosting,
  paymentMethod,
  setPaymentMethod,
}: {
  validRows: Record<string, any>[];
  invalidCount: number;
  totalCount: number;
  posting: AcquisitionPosting | null;
  setPosting: (p: AcquisitionPosting) => void;
  paymentMethod: AcquisitionPaymentMethod | null;
  setPaymentMethod: (m: AcquisitionPaymentMethod) => void;
}) {
  const { t } = useLanguage();
  const currency = useCurrency();

  const capitalizing = capitalizingRows(validRows);
  const totalCost = capitalizing.reduce((sum, r) => sum + Number(r.purchasePrice ?? 0), 0);
  const blockers = purchaseBlockers(validRows, paymentMethod, { invalidCount, totalCount });

  const option = (value: AcquisitionPosting, label: string, hint: string) => {
    const selected = posting === value;
    return (
      <label
        key={value}
        className={cn(
          "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
          selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
        )}
      >
        <input
          type="radio"
          name="import-acquisition-posting"
          className="mt-1 accent-primary"
          checked={selected}
          onChange={() => setPosting(value)}
        />
        <span className="text-start">
          <span className="block text-sm font-medium leading-tight">{label}</span>
          <span className="mt-1 block text-xs leading-snug text-muted-foreground">{hint}</span>
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-sm font-semibold" id="import-accounting-heading">
        {t("ImportAccountingHeading" as any)}
      </p>

      {/* The two options are a native radio group, but the question itself was
          only a heading with no programmatic relationship to them — a screen
          reader announced "Stock I already own, 1 of 2" without ever saying what
          was being asked. This choice decides whether the import posts to the
          ledger, so the question carries the meaning. */}
      <div
        className="grid gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-labelledby="import-accounting-heading"
      >
        {option(
          "OPENING_STOCK",
          t("ImportAsOpeningStock" as any),
          t("ImportAsOpeningStockHint" as any)
        )}
        {option("PURCHASE", t("ImportAsPurchase" as any), t("ImportAsPurchaseHint" as any))}
      </div>

      {/* Directly under the choice that caused it, and above the payment row.
          The rendered pass at 390px found it below the fold when it sat at the
          bottom of this block: a disabled Import button whose reason the
          operator had to scroll to find is a dead end, not a control. */}
      {posting === "PURCHASE" && blockers.missingVin > 0 && (
        <p className="text-xs font-medium leading-snug text-destructive">
          {t("ImportVinRequiredForPurchase" as any).replace("{count}", String(blockers.missingVin))}
        </p>
      )}

      {posting === "PURCHASE" && blockers.malformedVin > 0 && (
        <p className="text-xs font-medium leading-snug text-destructive">
          {t("ImportVinCharactersForPurchase" as any).replace("{count}", String(blockers.malformedVin))}
        </p>
      )}

      {posting === "PURCHASE" && blockers.hasInvalidRows && (
        <p className="text-xs font-medium leading-snug text-destructive">
          {t("ImportPurchaseAllRowsMustBeValid" as any).replace(
            "{count}",
            String(invalidCount)
          )}
        </p>
      )}

      {posting === "PURCHASE" && blockers.exceedsRowLimit && (
        <p className="text-xs font-medium leading-snug text-destructive">
          {t("ImportPurchaseTooManyRows" as any)
            .replace("{count}", String(totalCount))
            .replace("{max}", String(IMPORT_PURCHASE_MAX_ROWS))}
        </p>
      )}

      {posting === "PURCHASE" && blockers.missingSupplier > 0 && (
        <p className="text-xs font-medium leading-snug text-destructive">
          {t("ImportSupplierRequiredOnAccount" as any).replace(
            "{count}",
            String(blockers.missingSupplier)
          )}
        </p>
      )}

      {posting === "PURCHASE" && (
        <div className="space-y-3 ps-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground" id="import-paid-from">
              {t("ImportPaidFrom" as any)}
            </span>
            <div className="w-56">
              <PaymentMethodSelect
                t={t as any}
                value={paymentMethod ?? undefined}
                onValueChange={setPaymentMethod}
                methods={IMPORT_PAYMENT_METHODS}
                ariaLabel={t("ImportPaidFrom" as any)}
                placeholder={t("ImportPaidFromPlaceholder" as any)}
              />
            </div>
          </div>

          {/* One method covers the whole file. Stated plainly here rather than
              inferred per row from a column the dealers spreadsheets do not
              have: guessing a payment method per row is exactly the silent
              invention this dialog exists to prevent. A mixed file is split,
              never guessed. */}
          <p className="text-xs leading-snug text-muted-foreground">
            {t("ImportPaidFromAppliesToAll" as any)}
          </p>

          {/* The ledger consequence, stated before it happens. The amount leads
              on narrow screens instead of being squeezed to the far edge of a
              row it shares with two lines of explanation — at 390px that put the
              figure half outside the dialog in both directions. */}
          <div className="flex flex-col gap-1 border-s-2 border-primary/40 ps-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <bdi className="text-base font-semibold tabular-nums sm:order-2">
              {currency.format(totalCost)}
            </bdi>
            <span className="text-xs leading-snug text-muted-foreground sm:order-1">
              {t("ImportWillCapitalize" as any)}
              <span className="mt-0.5 block">
                {t("ImportWillCapitalizeNote" as any).replace("{count}", String(capitalizing.length))}
              </span>
            </span>
          </div>
        </div>
      )}

      {posting === null && (
        <p className="text-xs text-muted-foreground">{t("ImportAccountingRequired" as any)}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Must not exceed importBulk's IMPORT_BULK_MAX_ROWS. */
const IMPORT_CHUNK_SIZE = 200;

/**
 * Re-exported from the shared module both sides consume, so the client and the
 * mutation cannot drift. See convex/utils/importLimits.ts for why this bounds
 * the FILE rather than a chunk.
 */
export const IMPORT_PURCHASE_MAX_ROWS = PURCHASE_IMPORT_MAX_ROWS;

export function VehicleImportDialog({ open, onOpenChange }: Props) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const importBulk = useMutation(api.vehicles.importBulk);
  const financeCompanies = useQuery(
    api.finance.listCompanies,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  // No initial value on purpose — see IMPORT_ACQUISITION_POSTING in
  // convex/vehicles.ts. Both possible defaults corrupt somebody's books.
  const [posting, setPosting] = useState<AcquisitionPosting | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<AcquisitionPaymentMethod | null>(null);

  const isBlocked = ({ validRows, invalidCount, totalCount }: ImportPreflightInfo) => {
    if (posting === null) return true;
    if (posting !== "PURCHASE") return false;
    if (paymentMethod === null) return true;
    const blockers = purchaseBlockers(validRows, paymentMethod, { invalidCount, totalCount });
    return (
      blockers.missingVin > 0 ||
      blockers.malformedVin > 0 ||
      blockers.missingSupplier > 0 ||
      blockers.exceedsRowLimit ||
      blockers.hasInvalidRows
    );
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setPosting(null);
      setPaymentMethod(null);
    }
    onOpenChange(next);
  };

  return (
    <ImportWizard
      open={open}
      onOpenChange={handleOpenChange}
      entityType="vehicle"
      title={t("ImportVehiclesTitle" as any)}
      description={t("ImportVehiclesDesc" as any)}
      fields={VEHICLE_FIELDS}
      autoGuess={COL_MAP}
      parseWorksheet={parseVehicleWorksheet}
      deriveRow={deriveVehicleRow}
      validateRow={validateVehicleRow}
      previewColumns={PREVIEW_COLUMNS}
      renderPreviewCell={renderVehiclePreviewCell}
      templateBuilder={downloadVehicleTemplate}
      resolveDynamicFields={({ valuationHeaders }) => {
        const extraFields: ImportFieldConfig[] = [];
        const extraAutoGuess: Record<string, string> = {};
        const companies = financeCompanies ?? [];

        valuationHeaders.forEach((h) => {
          const name = h.trim();
          if (!name) return;
          const match = companies.find((c: Doc<"financeCompanies">) => c.name.trim() === name);
          const key = match
            ? `${EXISTING_COMPANY_PREFIX}${match._id}:${name}`
            : `${NEW_COMPANY_PREFIX}${name}`;
          const label = match
            ? `${t("Valuations" as any)}: ${match.name}`
            : `${t("Valuations" as any)}: ${name} (${t("NewFinanceCompanyTag" as any)})`;
          extraFields.push({ key, label });
          extraAutoGuess[normalizeKey(h)] = key;
        });

        return { extraFields, extraAutoGuess };
      }}
      isBlocked={isBlocked}
      renderPreflight={({ validRows, invalidCount, totalCount }) => (
        <ImportAccountingChoice
          validRows={validRows}
          invalidCount={invalidCount}
          totalCount={totalCount}
          posting={posting}
          setPosting={setPosting}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
        />
      )}
      onImport={(vehicles, { importId, sourceRows }) => {
        if (!activeOrgId) return Promise.resolve({ inserted: 0, skipped: 0, alreadyRecorded: 0 });
        // The wizard's Import button is disabled until this is answered; the
        // guard is here as well because a disabled button is a hint, not a
        // control, and importBulk itself refuses an unstated method.
        // Same whole-file view the button and the wizard use. `vehicles` is the
        // valid subset, so the counts have to come with it — re-checking against
        // `vehicles.length` alone would silently re-admit the subset import this
        // guard exists to refuse.
        if (
          posting === null ||
          isBlocked({ validRows: vehicles, invalidCount: 0, totalCount: vehicles.length })
        ) {
          return Promise.resolve({ inserted: 0, skipped: 0, alreadyRecorded: 0 });
        }
        // A purchase import refuses without this, and would do so only after the
        // operator pressed Import. Saying it here keeps the failure legible.
        if (posting === "PURCHASE" && !importId) {
          return Promise.reject(
            new Error(t("ImportCouldNotIdentifyItself" as any))
          );
        }
        // Send only the fields importBulk's validator declares — Convex rejects
        // any undeclared field, so we pick explicitly rather than spreading the
        // whole derived row (which also carries preview-only helper values).
        const payload = vehicles.map((v, i) => ({
          // The row's position in the operator's ORIGINAL file, index-aligned
          // with `vehicles`. This is what makes a re-sent row provably the same
          // row, so it must survive correcting an earlier row — which an index
          // into the valid subset would not.
          rowId: sourceRows[i],
          make: v.make,
          model: v.model,
          year: v.year,
          vin: v.vin,
          color: v.color,
          mileage: v.mileage,
          fuelType: v.fuelType,
          transmission: v.transmission,
          sellingPrice: v.sellingPrice,
          purchasePrice: v.purchasePrice,
          sourceType: v.sourceType,
          sourcedFromName: v.sourcedFromName,
          sourceCost: v.sourceCost,
          status: v.status,
          notes: v.notes,
          valuations: v.valuations,
        }));
        // OPENING_STOCK is chunked so a large spreadsheet cannot exceed Convex's
        // per-transaction write budget now that each row also maintains the
        // vehicle aggregate. It posts nothing, so nothing of accounting
        // significance straddles a chunk boundary.
        //
        // PURCHASE is NEVER chunked. Whole-file must equal whole-transaction on
        // the path that posts money — see IMPORT_PURCHASE_MAX_ROWS. The file is
        // refused above this point if it is too large, so the single slice below
        // is the entire file, and its atomicity is what makes "if it failed,
        // nothing was written" true rather than aspirational.
        const chunkSize =
          posting === "PURCHASE" ? IMPORT_PURCHASE_MAX_ROWS : IMPORT_CHUNK_SIZE;
        return (async () => {
          const totals = { inserted: 0, skipped: 0, alreadyRecorded: 0 };
          for (let i = 0; i < payload.length; i += chunkSize) {
            const chunk = payload.slice(i, i + chunkSize);
            try {
              const result = await importBulk({
                orgId: activeOrgId,
                acquisitionPosting: posting,
                purchasePaymentMethod: posting === "PURCHASE" ? paymentMethod! : undefined,
                // Same identity for every chunk and every retry of this upload.
                // A purchase import refuses outright without it.
                importId,
                vehicles: chunk as any,
              });
              totals.inserted += result.inserted;
              totals.skipped += result.skipped;
              totals.alreadyRecorded += result.alreadyRecorded;
            } catch (err) {
              // Each chunk is its own transaction, so a failure here leaves the
              // earlier ones committed — vehicles AND, in PURCHASE mode, their
              // journal entries. Saying so is the difference between an
              // operator who knows to fix the bad row and re-import, and one
              // who has no idea anything landed.
              //
              // Re-importing the same file afterwards skips the cars already
              // added, PROVIDED their VIN strings survive the edit unchanged — a
              // PURCHASE row must carry a plain-alphanumeric VIN, so dedup is a
              // canonical match among them (covered by "re-importing the same
              // VIN does not capitalize it twice"). A spreadsheet re-saved
              // through Excel can still alter a cell, which is why the message
              // says "as long as their VINs are unchanged" rather than
              // promising outright.
              const detail = err instanceof Error ? err.message : String(err);
              // What a re-import actually does depends on the mode. A PURCHASE
              // file has a real VIN on every row, so every car already added is
              // skipped as a duplicate. An OPENING_STOCK file may contain
              // VIN-less rows, which get a fresh placeholder each time and would
              // be added again — promising blanket retry safety there would be
              // false.
              const retryAdvice = t(
                (posting === "PURCHASE"
                  ? "ImportRetryAdvicePurchase"
                  : "ImportRetryAdviceOpeningStock") as any
              );
              const stopped = t("ImportStoppedAfter" as any).replace(
                "{count}",
                String(totals.inserted)
              );
              // PURCHASE is one atomic call, so `totals.inserted` is ALWAYS 0 here
              // and the "imported N, then stopped" framing never applies — gating
              // the guidance on it made the guidance unreachable. For PURCHASE the
              // advice is always true and always relevant, so it is always shown.
              // OPENING_STOCK keeps the partial-progress form, which is accurate
              // for it because it still chunks.
              throw new Error(
                posting === "PURCHASE"
                  ? `${detail} ${retryAdvice}`
                  : totals.inserted > 0
                    ? `${stopped} ${detail} ${retryAdvice}`
                    : detail
              );
            }
          }
          return totals;
        })();
      }}
    />
  );
}
