"use client";

import * as XLSX from "xlsx";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { ImportWizard, ImportFieldConfig, ImportRow, normalizeKey } from "@/components/import/ImportWizard";

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
  { key: "purchasePrice", label: "Purchase Price" },
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
  { key: "purchasePrice", label: "Cost", align: "end" as const },
  { key: "sellingPrice", label: "Selling Price", align: "end" as const },
  { key: "valuations", label: "Bank Valuations" },
];

/**
 * Reads a worksheet that may have a single OR double header row.
 * The dealership's template uses 2 rows:
 *   Row 1: TYPE/Name | VIN | Color | KM | Cost | Model | المتخصصة | الكوتر | [التخمين merged]
 *   Row 2:                                                                   | بندار | تمكين | السماحة
 * When row 2 contains Arabic valuation sub-headers, we merge both rows into
 * a single header and start data from row 3.
 */
function parseVehicleWorksheet(ws: XLSX.WorkSheet): { headers: string[]; rows: any[][]; valuationHeaders: string[] } {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (rawRows.length === 0) return { headers: [], rows: [], valuationHeaders: [] };

  // Only these three trigger double-header detection (matches the dealership's
  // known template), but once triggered, EVERY non-empty row-2 cell becomes a
  // valuation column — so a dealer typing a 4th bank name in row 2 just works.
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
    finalHeaders = primaryHeaders;
    dataStartRow = 1;
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

  const vin = String(mapped.vin ?? "").trim();
  const color = String(mapped.color ?? "").trim();
  const rawMileage = mapped.mileage != null ? String(mapped.mileage).trim() : "";
  const mileage = rawMileage === "" ? undefined : parseFloat(rawMileage.replace(/,/g, ""));
  const fuelType = String(mapped.fuelType ?? "Petrol").trim() || "Petrol";
  const transmission = String(mapped.transmission ?? "Automatic").trim() || "Automatic";
  const sellingPrice = parseFloat(String(mapped.sellingPrice ?? "0").replace(/,/g, ""));
  const purchasePrice = mapped.purchasePrice != null
    ? parseFloat(String(mapped.purchasePrice).replace(/,/g, ""))
    : undefined;

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
    status: mapped.status ? String(mapped.status).toUpperCase() : undefined,
    notes: mapped.notes ? String(mapped.notes).trim() : undefined,
    valuations,
  };
}

function validateVehicleRow(row: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!row.make) errors.push("Missing Make");
  if (!row.model) errors.push("Missing Model");
  if (!row.year || isNaN(row.year) || row.year < 1900 || row.year > new Date().getFullYear() + 2) errors.push("Invalid Year");
  if (row.mileage !== undefined && (isNaN(row.mileage) || row.mileage < 0)) errors.push("Invalid Mileage");
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
// Template download — matches the dealership's existing spreadsheet layout
// ---------------------------------------------------------------------------
function downloadTemplate() {
  const wb = XLSX.utils.book_new();

  const row1 = ["TYPE/Name", "VIN", "Color", "KM", "Cost", "Model", "المتخصصة", "الكوتر", "التخمين", "", ""];
  const row2 = ["",           "",    "",      "",   "",     "",       "",          "",        "بندار",    "تمكين", "السماحة"];
  // KM=number → zero-km or known mileage; KM=empty → used car, mileage to be added later
  const example1 = ["Toyota", "JTDKARFU7G3529873", "White", "45000", "14000", "Camry 2022", "18000", "17500", "19000", "18500", "17000"];
  const example2 = ["BYD", "LJ136HBDA4P123456", "Black", "", "22000", "Dolphin 2024", "26000", "25000", "27000", "26500", "25500"];

  const ws = XLSX.utils.aoa_to_sheet([row1, row2, example1, example2]);

  // Merge التخمين across columns I–K (0-indexed: cols 8–10, row 0)
  ws["!merges"] = [{ s: { r: 0, c: 8 }, e: { r: 0, c: 10 } }];
  ws["!cols"] = Array(11).fill({ wch: 16 });

  // Right-align Arabic header cells
  const arabicCols = [6, 7, 8, 9, 10];
  arabicCols.forEach(c => {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = { alignment: { horizontal: "right", readingOrder: 2 } };
    const addr2 = XLSX.utils.encode_cell({ r: 1, c });
    if (ws[addr2]) ws[addr2].s = { alignment: { horizontal: "right", readingOrder: 2 } };
  });

  XLSX.utils.book_append_sheet(wb, ws, "Vehicles");
  XLSX.writeFile(wb, "vehicle_import_template.xlsx");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VehicleImportDialog({ open, onOpenChange }: Props) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const importBulk = useMutation(api.vehicles.importBulk);
  const financeCompanies = useQuery(
    api.finance.listCompanies,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  return (
    <ImportWizard
      open={open}
      onOpenChange={onOpenChange}
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
      templateBuilder={downloadTemplate}
      resolveDynamicFields={({ valuationHeaders }) => {
        const extraFields: ImportFieldConfig[] = [];
        const extraAutoGuess: Record<string, string> = {};
        const companies = financeCompanies ?? [];

        valuationHeaders.forEach((h) => {
          const name = h.trim();
          if (!name) return;
          const match = companies.find((c) => c.name.trim() === name);
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
      onImport={(vehicles) => {
        if (!activeOrgId) return Promise.resolve({ inserted: 0, skipped: 0 });
        return importBulk({ orgId: activeOrgId, vehicles: vehicles as any });
      }}
    />
  );
}
