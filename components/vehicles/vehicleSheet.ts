"use client";

import { downloadXlsxTemplate, type SpreadsheetCell } from "@/lib/spreadsheet";

// ---------------------------------------------------------------------------
// Single source of truth for the dealership's vehicle spreadsheet layout.
// The blank-template download, the "Export all vehicles" button, and the import
// parser (VehicleImportDialog) all key off the header text defined here, so an
// exported file re-imports with zero manual column remapping — including into a
// brand-new dealer account that has none of these finance companies yet.
//
// Layout is a SINGLE header row (matching the dealer's working sheet):
//   TYPE/Name | VIN | Color | KM | Cost | Selling Price | Model | Source Type |
//   Sourced From | <finance-program valuation columns…>
// Every column after "Sourced From" is a finance-company/program valuation —
// the importer treats any header it doesn't recognize as a core field as one.
// ---------------------------------------------------------------------------

/**
 * Default finance-program valuation columns that ship with the blank template —
 * the dealer's real programs. Every column after the core columns is imported as
 * a valuation, so these round-trip on re-import even into an account that has no
 * finance companies configured yet (they're auto-created inactive on import).
 */
export const DEFAULT_VALUATION_HEADERS = [
  "المتخصصة / 80% زيرو بدون كفيل",
  "الكوثر 90% اثاث",
  "زيرو بندار زيرو 90%",
  "المتخصصه 90%",
  "دار التمويل",
  "الكوثر 85%",
  "الكوثر 6.5%",
  "بندار مستعمل 8.5%",
  "المتخصصة مستعمل / سماحه تطبيقات",
];

/**
 * Canonical non-valuation columns, in template order. The header text is what
 * the importer's COL_MAP auto-maps back to each vehicle field, so template
 * download, export, and import stay in lockstep through this one list.
 */
const CORE_HEADERS = [
  "TYPE/Name", // make (may embed the model too, e.g. "BYD Dolphin")
  "VIN",
  "Color",
  "KM", // mileage
  "Cost", // purchasePrice (== sourceCost for sourced vehicles)
  "Selling Price", // the dealer's asking price (distinct from the finance valuations)
  "Model", // model, with the year embedded (e.g. "Camry 2022")
  "Source Type", // STOCK / SOURCED
  "Sourced From", // supplier dealer name (sourced vehicles only)
];

export interface VehicleSheetRow {
  make: string;
  vin: string;
  color: string;
  mileage?: number | null;
  /** purchasePrice for stock, sourceCost for sourced — the template's "Cost" column. */
  cost?: number | null;
  model: string;
  year?: number | null;
  /** The dealer's asking price — written to the "Selling Price" column. */
  sellingPrice?: number | null;
  sourceType: "STOCK" | "SOURCED";
  sourcedFrom?: string | null;
  /** company/program name -> valuation amount */
  valuationsByCompany?: Record<string, number>;
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Embeds the model year the way the template encodes it — inside the Model text. */
function composeModelCell(model: string, year?: number | null): SpreadsheetCell {
  const trimmed = (model ?? "").trim();
  if (!year || Number.isNaN(year)) return trimmed;
  if (new RegExp(`\\b${year}\\b`).test(trimmed)) return trimmed;
  return trimmed ? `${trimmed} ${year}` : String(year);
}

function numberOrBlank(value?: number | null): SpreadsheetCell {
  return value === undefined || value === null || Number.isNaN(value) ? "" : value;
}

function buildDataRow(row: VehicleSheetRow, companyNames: string[]): SpreadsheetCell[] {
  const byCompany = row.valuationsByCompany ?? {};
  return [
    row.make ?? "",
    row.vin ?? "",
    row.color ?? "",
    numberOrBlank(row.mileage),
    numberOrBlank(row.cost),
    numberOrBlank(row.sellingPrice),
    composeModelCell(row.model, row.year),
    row.sourceType,
    row.sourcedFrom ?? "",
    ...companyNames.map((name) => numberOrBlank(byCompany[name])),
  ];
}

/** RTL-align the Arabic valuation header cells (row 1) so they read correctly. */
function rightAlignedValuationCells(companyCount: number): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  const firstValuationCol = CORE_HEADERS.length + 1; // 1-based
  for (let c = firstValuationCol; c < firstValuationCol + companyCount; c += 1) {
    cells.push({ row: 1, col: c });
  }
  return cells;
}

interface DownloadVehicleSheetOptions {
  fileName: string;
  /** Org finance-company names to add as valuation columns (merged with the defaults). */
  companyNames: string[];
  rows: VehicleSheetRow[];
}

export interface VehicleSheetMatrix {
  /** [headerRow, ...dataRows] in canonical column order. */
  rows: SpreadsheetCell[][];
  /** Finance-company valuation columns actually written (defaults + org companies). */
  companyNames: string[];
  merges: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
  rightAlignedCells: Array<{ row: number; col: number }>;
}

/**
 * Pure builder for the vehicle spreadsheet cell matrix — separated from the
 * download side effect so it can be unit-tested (and reused). Emits a single
 * header row followed by data rows; every finance-program valuation column lands
 * inline after the core columns.
 */
export function buildVehicleSheetMatrix(
  companyNamesInput: string[],
  rows: VehicleSheetRow[]
): VehicleSheetMatrix {
  const companyNames = dedupeNames([...DEFAULT_VALUATION_HEADERS, ...companyNamesInput]);
  const headerRow: SpreadsheetCell[] = [...CORE_HEADERS, ...companyNames];
  const dataRows = rows.map((row) => buildDataRow(row, companyNames));

  return {
    rows: [headerRow, ...dataRows],
    companyNames,
    merges: [],
    rightAlignedCells: rightAlignedValuationCells(companyNames.length),
  };
}

/**
 * Writes vehicles into the dealership's canonical import layout so the file can
 * be re-imported — into the same or a brand-new dealer account — with no manual
 * remapping. Shared by the export button and the blank-template download.
 */
export async function downloadVehicleSheet(options: DownloadVehicleSheetOptions): Promise<void> {
  const matrix = buildVehicleSheetMatrix(options.companyNames, options.rows);

  await downloadXlsxTemplate({
    fileName: options.fileName,
    sheetName: "Vehicles",
    rows: matrix.rows,
    columnWidth: 16,
    merges: matrix.merges,
    rightAlignedCells: matrix.rightAlignedCells,
  });
}

/**
 * Downloads the blank reference template with two worked examples — one owned
 * stock car and one sourced car — so dealers can see how every column, incl. the
 * Source Type / Sourced From distinction, is filled in. The stock example uses a
 * blank VIN (owned stock often has none yet) to show that leaving it empty is
 * fine — each such row still imports as its own vehicle.
 */
export async function downloadVehicleTemplate(): Promise<void> {
  const stockExample: VehicleSheetRow = {
    make: "Toyota Camry", // TYPE/Name may hold the full name; Model can just carry the year
    vin: "", // owned stock with no VIN yet — leave blank, it still imports
    color: "White",
    mileage: 45000,
    cost: 14000,
    sellingPrice: 18000,
    model: "",
    year: 2022,
    sourceType: "STOCK",
    valuationsByCompany: {
      "المتخصصة / 80% زيرو بدون كفيل": 19000,
      "الكوثر 90% اثاث": 18500,
      "دار التمويل": 17000,
    },
  };
  const sourcedExample: VehicleSheetRow = {
    make: "BYD Dolphin",
    vin: "LJ136HBDA4P123456",
    color: "Black",
    mileage: null,
    cost: 22000, // for a sourced car, Cost is the supplier cost
    sellingPrice: 26000,
    model: "",
    year: 2024,
    sourceType: "SOURCED",
    sourcedFrom: "العطيوي",
    valuationsByCompany: {
      "المتخصصة / 80% زيرو بدون كفيل": 27000,
      "المتخصصه 90%": 26500,
      "بندار مستعمل 8.5%": 25500,
    },
  };

  await downloadVehicleSheet({
    fileName: "vehicle_import_template.xlsx",
    companyNames: [],
    rows: [stockExample, sourcedExample],
  });
}
