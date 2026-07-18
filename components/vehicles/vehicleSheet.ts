"use client";

import { downloadXlsxTemplate, type SpreadsheetCell } from "@/lib/spreadsheet";

// ---------------------------------------------------------------------------
// Single source of truth for the dealership's vehicle spreadsheet layout.
// The blank-template download, the "Export all vehicles" button, and the import
// parser (VehicleImportDialog) all key off the header text defined here, so an
// exported file re-imports with zero manual column remapping — including into a
// brand-new dealer account that has none of these finance companies yet.
// ---------------------------------------------------------------------------

/**
 * Default finance-company valuation columns that ship with the blank template.
 * They double as the importer's double-header trigger (parseVehicleWorksheet in
 * VehicleImportDialog keys on these three names to decide a sheet uses the
 * two-row valuation header), so every exported file always includes them — that
 * is what guarantees the valuation block is detected on re-import even when the
 * target account has no finance companies configured.
 */
export const DEFAULT_VALUATION_HEADERS = ["بندار", "تمكين", "السماحة"];

/**
 * Canonical non-valuation columns, in template order. The header text is what
 * the importer's COL_MAP auto-maps back to each vehicle field, so template
 * download, export, and import stay in lockstep through this one list.
 */
const CORE_HEADERS = [
  "TYPE/Name", // make
  "VIN",
  "Color",
  "KM", // mileage
  "Cost", // purchasePrice (== sourceCost for sourced vehicles)
  "Model", // model, with the year embedded (e.g. "Camry 2022")
  "المتخصصة", // sellingPrice (retail)
  "الكوتر", // unused passthrough column — kept for template fidelity
  "Source Type", // STOCK / SOURCED
  "Sourced From", // supplier dealer name (sourced vehicles only)
];

const VALUATION_GROUP_HEADER = "التخمين";
const SELLING_PRICE_HEADER = "المتخصصة";

export interface VehicleSheetRow {
  make: string;
  vin: string;
  color: string;
  mileage?: number | null;
  /** purchasePrice for stock, sourceCost for sourced — the template's "Cost" column. */
  cost?: number | null;
  model: string;
  year?: number | null;
  sellingPrice: number;
  sourceType: "STOCK" | "SOURCED";
  sourcedFrom?: string | null;
  /** company name -> valuation amount */
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

function buildHeaderRows(companyNames: string[]): { row1: SpreadsheetCell[]; row2: SpreadsheetCell[] } {
  const row1: SpreadsheetCell[] = [...CORE_HEADERS, VALUATION_GROUP_HEADER];
  const row2: SpreadsheetCell[] = CORE_HEADERS.map(() => "");
  companyNames.forEach((name, i) => {
    // The first valuation column sits under the group header already pushed
    // above; the rest extend the merged group header across their columns.
    if (i > 0) row1.push("");
    row2.push(name);
  });
  return { row1, row2 };
}

function buildDataRow(row: VehicleSheetRow, companyNames: string[]): SpreadsheetCell[] {
  const byCompany = row.valuationsByCompany ?? {};
  return [
    row.make ?? "",
    row.vin ?? "",
    row.color ?? "",
    numberOrBlank(row.mileage),
    numberOrBlank(row.cost),
    composeModelCell(row.model, row.year),
    numberOrBlank(row.sellingPrice),
    "", // الكوتر (unused)
    row.sourceType,
    row.sourcedFrom ?? "",
    ...companyNames.map((name) => numberOrBlank(byCompany[name])),
  ];
}

function rightAlignedValuationCells(companyCount: number): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  const sellingPriceCol = CORE_HEADERS.indexOf(SELLING_PRICE_HEADER) + 1; // 1-based
  cells.push({ row: 1, col: sellingPriceCol });
  const firstValuationCol = CORE_HEADERS.length + 1;
  for (let c = firstValuationCol; c < firstValuationCol + companyCount; c += 1) {
    cells.push({ row: 1, col: c });
    cells.push({ row: 2, col: c });
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
  /** [headerRow1, headerRow2, ...dataRows] in canonical column order. */
  rows: SpreadsheetCell[][];
  /** Finance-company valuation columns actually written (defaults + org companies). */
  companyNames: string[];
  merges: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
  rightAlignedCells: Array<{ row: number; col: number }>;
}

/**
 * Pure builder for the vehicle spreadsheet cell matrix — separated from the
 * download side effect so it can be unit-tested (and reused). Always prepends
 * the default valuation headers so the importer's double-header detection fires.
 */
export function buildVehicleSheetMatrix(
  companyNamesInput: string[],
  rows: VehicleSheetRow[]
): VehicleSheetMatrix {
  const companyNames = dedupeNames([...DEFAULT_VALUATION_HEADERS, ...companyNamesInput]);
  const { row1, row2 } = buildHeaderRows(companyNames);
  const dataRows = rows.map((row) => buildDataRow(row, companyNames));

  const firstValuationCol = CORE_HEADERS.length + 1;
  const merges =
    companyNames.length > 1
      ? [
          {
            startRow: 1,
            startCol: firstValuationCol,
            endRow: 1,
            endCol: firstValuationCol + companyNames.length - 1,
          },
        ]
      : [];

  return {
    rows: [row1, row2, ...dataRows],
    companyNames,
    merges,
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
 * Source Type / Sourced From distinction, is filled in.
 */
export async function downloadVehicleTemplate(): Promise<void> {
  const stockExample: VehicleSheetRow = {
    make: "Toyota",
    vin: "JTDKARFU7G3529873",
    color: "White",
    mileage: 45000, // known mileage; leave KM empty for a used car to fill in later
    cost: 14000,
    model: "Camry",
    year: 2022,
    sellingPrice: 18000,
    sourceType: "STOCK",
    valuationsByCompany: { "بندار": 19000, "تمكين": 18500, "السماحة": 17000 },
  };
  const sourcedExample: VehicleSheetRow = {
    make: "BYD",
    vin: "LJ136HBDA4P123456",
    color: "Black",
    mileage: null,
    cost: 22000, // for a sourced car, Cost is the supplier cost
    model: "Dolphin",
    year: 2024,
    sellingPrice: 26000,
    sourceType: "SOURCED",
    sourcedFrom: "Gulf Motors",
    valuationsByCompany: { "بندار": 27000, "تمكين": 26500, "السماحة": 25500 },
  };

  await downloadVehicleSheet({
    fileName: "vehicle_import_template.xlsx",
    companyNames: [],
    rows: [stockExample, sourcedExample],
  });
}
