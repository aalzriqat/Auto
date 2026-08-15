"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { ImportWizard, ImportFieldConfig, ImportRow, normalizeKey } from "@/components/import/ImportWizard";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { assertDirectVehicleCreateStatus } from "@/convex/utils/vehicleStatusGuards";
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

// Mirror of the backend guard (convex/vehicles.ts): a run of x's/dashes/zeros,
// "N/A", or blank is a filler VIN, not a real one. Blanking it here keeps the
// preview honest and lets the backend assign each row a unique placeholder
// instead of skipping stock rows that share the same filler string.
function isPlaceholderVin(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return lower === "n/a" || lower === "na" || lower === "tbd" || lower === "none" || lower === "-";
}

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
 * Smart model/make splitting + year extraction, applied after the dealer's
 * column mapping. "TYPE/Name" often contains the full vehicle name (e.g.
 * "BYD Dolphin 2024"); when there's no explicit model column, we split on
 * the first space (make / model) and pull a 19xx/20xx year out of the model.
 */
function deriveVehicleRow(mapped: Record<string, any>): Record<string, any> {
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
  const sellingPrice = parseFloat(String(mapped.sellingPrice ?? "0").replace(/,/g, ""));
  const purchasePrice = mapped.purchasePrice != null
    ? parseFloat(String(mapped.purchasePrice).replace(/,/g, ""))
    : undefined;

  const sourceType = normalizeImportSourceType(mapped.sourceType);
  const sourcedFrom = String(mapped.sourcedFrom ?? "").trim();

  const valuations: Array<{ companyId?: string; companyName?: string; valuationAmount: number }> = [];
  Object.entries(mapped).forEach(([key, value]) => {
    if (!key.startsWith(NEW_COMPANY_PREFIX) && !key.startsWith(EXISTING_COMPANY_PREFIX)) return;
    const amount = parseFloat(String(value ?? "").replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) return;
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
    sellingPrice: isNaN(sellingPrice) ? 0 : sellingPrice,
    purchasePrice: purchasePrice && !isNaN(purchasePrice) ? purchasePrice : undefined,
    // Only fields declared in the importBulk validator may be returned here —
    // the whole derived row (minus _errors) is sent as the mutation payload, and
    // Convex rejects any undeclared field. sourcedFromName holds the supplier.
    sourceType,
    // For a sourced vehicle the supplier cost is the same "Cost" column that
    // owned stock uses for purchase price; importBulk mirrors it into sourceCost.
    sourceCost: sourceType === "SOURCED" && purchasePrice && !isNaN(purchasePrice) ? purchasePrice : undefined,
    sourcedFromName: sourceType === "SOURCED" ? (sourcedFrom || undefined) : undefined,
    status: mapped.status ? String(mapped.status).toUpperCase() : undefined,
    notes: mapped.notes ? String(mapped.notes).trim() : undefined,
    valuations,
  };
}

function validateVehicleRow(row: Record<string, any>): string[] {
  const errors: string[] = [];
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
 * The four settled methods only — deliberately NOT importBulk's fifth,
 * ON_ACCOUNT. The single-vehicle create form (VehicleDialog) offers exactly
 * these, and making the CSV importer the one place in the product where a
 * dealer can buy on account would be a strange asymmetry to introduce here.
 * The backend accepts and guards ON_ACCOUNT because postVehicleAcquisitionIfOwned
 * does; exposing it is a product decision for the vehicle-acquisition surface as
 * a whole, not something to slip in through an import dialog.
 */
const IMPORT_PAYMENT_METHODS: readonly PaymentMethod[] = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"];

/** Rows that will actually reach Vehicle Inventory: owned, with a cost. */
function capitalizingRows(rows: Record<string, any>[]) {
  return rows.filter((r) => r.sourceType !== "SOURCED" && Number(r.purchasePrice) > 0);
}

/**
 * The server's PURCHASE rules, re-checked here across the WHOLE file.
 *
 * Not a duplicate of the server control — the server still refuses, per call.
 * This exists because a file larger than a chunk arrives as several separate
 * transactions: without a whole-file check, a bad row in the last chunk is only
 * discovered after the earlier chunks have already posted real journal entries,
 * leaving the operator with a half-capitalized import and a generic error.
 */
function purchaseBlockers(rows: Record<string, any>[]): { missingVin: number } {
  // Every row, not just the ones that post today — see the server's own
  // `missingVin` check for why a sourced or cost-less row is not harmless.
  return {
    missingVin: rows.filter((r) => !String(r.vin ?? "").trim()).length,
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
  posting,
  setPosting,
  paymentMethod,
  setPaymentMethod,
}: {
  validRows: Record<string, any>[];
  posting: AcquisitionPosting | null;
  setPosting: (p: AcquisitionPosting) => void;
  paymentMethod: PaymentMethod | null;
  setPaymentMethod: (m: PaymentMethod) => void;
}) {
  const { t } = useLanguage();
  const currency = useCurrency();

  const capitalizing = capitalizingRows(validRows);
  const totalCost = capitalizing.reduce((sum, r) => sum + Number(r.purchasePrice ?? 0), 0);
  const blockers = purchaseBlockers(validRows);

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
      <p className="text-sm font-semibold">{t("ImportAccountingHeading" as any)}</p>

      <div className="grid gap-2 sm:grid-cols-2">
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
 * Must not exceed importBulk's IMPORT_BULK_MAX_POSTING_ROWS. A PURCHASE row
 * writes a journal entry and its lines on top of the vehicle insert, so the
 * transaction it shares fills up an order of magnitude faster.
 */
const IMPORT_POSTING_CHUNK_SIZE = 25;

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
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);

  const isBlocked = ({ validRows }: { validRows: Record<string, any>[] }) => {
    if (posting === null) return true;
    if (posting !== "PURCHASE") return false;
    return paymentMethod === null || purchaseBlockers(validRows).missingVin > 0;
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
      renderPreflight={({ validRows }) => (
        <ImportAccountingChoice
          validRows={validRows}
          posting={posting}
          setPosting={setPosting}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
        />
      )}
      onImport={(vehicles) => {
        if (!activeOrgId) return Promise.resolve({ inserted: 0, skipped: 0 });
        // The wizard's Import button is disabled until this is answered; the
        // guard is here as well because a disabled button is a hint, not a
        // control, and importBulk itself refuses an unstated method.
        if (posting === null || isBlocked({ validRows: vehicles })) {
          return Promise.resolve({ inserted: 0, skipped: 0 });
        }
        // Send only the fields importBulk's validator declares — Convex rejects
        // any undeclared field, so we pick explicitly rather than spreading the
        // whole derived row (which also carries preview-only helper values).
        const payload = vehicles.map((v) => ({
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
        // Chunked to match importBulk's server-side row cap: one transaction
        // per chunk, so a large spreadsheet cannot exceed Convex's
        // per-transaction write budget now that each row also maintains the
        // vehicle aggregate — and a much smaller chunk when each row also posts
        // a journal entry, which costs an order of magnitude more per row.
        const chunkSize = posting === "PURCHASE" ? IMPORT_POSTING_CHUNK_SIZE : IMPORT_CHUNK_SIZE;
        return (async () => {
          const totals = { inserted: 0, skipped: 0 };
          for (let i = 0; i < payload.length; i += chunkSize) {
            const chunk = payload.slice(i, i + chunkSize);
            try {
              const result = await importBulk({
                orgId: activeOrgId,
                acquisitionPosting: posting,
                purchasePaymentMethod: posting === "PURCHASE" ? paymentMethod! : undefined,
                vehicles: chunk as any,
              });
              totals.inserted += result.inserted;
              totals.skipped += result.skipped;
            } catch (err) {
              // Each chunk is its own transaction, so a failure here leaves the
              // earlier ones committed — vehicles AND, in PURCHASE mode, their
              // journal entries. Saying so is the difference between an
              // operator who knows to fix the bad row and re-import, and one
              // who has no idea anything landed.
              //
              // Re-importing the same file afterwards is safe: a PURCHASE row
              // must carry a real VIN, so the already-imported cars are skipped
              // as duplicates rather than capitalized a second time (covered by
              // "re-importing the same VIN does not capitalize it twice").
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
              throw new Error(
                totals.inserted > 0 ? `${stopped} ${detail} ${retryAdvice}` : detail
              );
            }
          }
          return totals;
        })();
      }}
    />
  );
}
