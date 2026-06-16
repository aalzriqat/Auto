"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Download } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLanguage } from "@/components/providers/LanguageProvider";

// ---------------------------------------------------------------------------
// Column name mapping — handles Arabic + English header variations
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

  // Finance-company valuations (imported but not pushed to vehicles table)
  الكوتر: "valuationCoater",
  بندار: "valuationBandar",
  تمكين: "valuationTamkeen",
  السماحة: "valuationSamaha",

  // Misc
  status: "status", الحالة: "status",
  notes: "notes", comments: "notes", remarks: "notes", ملاحظات: "notes",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ParsedVehicle {
  make: string;
  model: string;
  year: number;
  vin: string;
  color: string;
  mileage?: number;
  fuelType: string;
  transmission: string;
  sellingPrice: number;
  purchasePrice?: number;
  status?: string;
  notes?: string;
  _errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Parses a raw row object (keyed by whatever header strings the file used)
 * into a typed ParsedVehicle, using COL_MAP for normalisation.
 */
function parseRows(rows: Record<string, any>[]): ParsedVehicle[] {
  return rows.map((row) => {
    const mapped: Record<string, any> = {};
    for (const [rawKey, val] of Object.entries(row)) {
      const normalized = normalizeKey(rawKey);
      const field = COL_MAP[normalized];
      if (field) mapped[field] = val;
    }

    // Extract year from model string if no explicit year column
    const rawModel = String(mapped.model ?? "").trim();
    const yearFromModel = rawModel.match(/\b(19|20)\d{2}\b/)?.[0];
    let model = yearFromModel ? rawModel.replace(yearFromModel, "").trim() : rawModel;
    const year = parseInt(mapped.year) || (yearFromModel ? parseInt(yearFromModel) : NaN);

    const errors: string[] = [];
    let make = String(mapped.make ?? "").trim();

    // "TYPE/Name" often contains the full vehicle name (e.g. "BYD Dolphyn").
    // When the model column is empty, split on the first space: first token → make, rest → model.
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

    if (!make) errors.push("Missing Make");
    if (!model) errors.push("Missing Model");
    if (!year || isNaN(year) || year < 1900 || year > new Date().getFullYear() + 2) errors.push("Invalid Year");
    if (mileage !== undefined && (isNaN(mileage) || mileage < 0)) errors.push("Invalid Mileage");

    return {
      make, model, year: isNaN(year) ? 0 : year,
      vin, color: color || "Unknown",
      mileage: mileage !== undefined && !isNaN(mileage) ? mileage : undefined,
      fuelType, transmission,
      sellingPrice: isNaN(sellingPrice) ? 0 : sellingPrice,
      purchasePrice: purchasePrice && !isNaN(purchasePrice) ? purchasePrice : undefined,
      status: mapped.status ? String(mapped.status).toUpperCase() : undefined,
      notes: mapped.notes ? String(mapped.notes).trim() : undefined,
      _errors: errors,
    };
  }).filter(v => v.make || v.model || v.vin);
}

/**
 * Reads a worksheet that may have a single OR double header row.
 * The image template uses 2 rows:
 *   Row 1: TYPE/Name | VIN | Color | KM | Cost | Model | المتخصصة | الكوتر | [التخمين merged]
 *   Row 2:                                                                   | بندار | تمكين | السماحة
 * When row 2 contains Arabic valuation sub-headers, we merge both rows into
 * a single header and start data from row 3.
 */
function parseWorksheet(ws: XLSX.WorkSheet): Record<string, any>[] {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (rawRows.length === 0) return [];

  const VALUATION_SUB_HEADERS = new Set(["بندار", "تمكين", "السماحة"]);

  const primaryHeaders: string[] = (rawRows[0] ?? []).map((c: any) => String(c ?? "").trim());
  const secondRow: string[] = (rawRows[1] ?? []).map((c: any) => String(c ?? "").trim());

  const isDoubleHeader = secondRow.some(cell => VALUATION_SUB_HEADERS.has(cell));

  let finalHeaders: string[];
  let dataStartRow: number;

  if (isDoubleHeader) {
    // For each column: prefer the sub-header value if it's non-empty, else use the primary
    finalHeaders = primaryHeaders.map((h, i) => secondRow[i] || h);
    dataStartRow = 2;
  } else {
    finalHeaders = primaryHeaders;
    dataStartRow = 1;
  }

  return rawRows
    .slice(dataStartRow)
    .filter(row => row.some((cell: any) => cell !== ""))
    .map(row => {
      const obj: Record<string, any> = {};
      finalHeaders.forEach((h, i) => {
        if (h) obj[h] = row[i] ?? "";
      });
      return obj;
    });
}

// ---------------------------------------------------------------------------
// Template download — matches the image layout exactly
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
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const importBulk = useMutation(api.vehicles.importBulk);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ParsedVehicle[]>([]);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState("");

  const validRows = rows.filter(r => r._errors.length === 0);
  const invalidRows = rows.filter(r => r._errors.length > 0);

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = e.target?.result;
      const wb = XLSX.read(data, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      setRows(parseRows(parseWorksheet(ws)));
    };
    reader.readAsBinaryString(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  async function handleImport() {
    if (!activeOrgId || validRows.length === 0) return;
    setImporting(true);
    try {
      const result = await importBulk({
        orgId: activeOrgId,
        vehicles: validRows.map(({ _errors, ...v }) => v),
      });
      toast.success(`Imported ${result.inserted} vehicles${result.skipped > 0 ? `, skipped ${result.skipped} duplicates` : ""}.`);
      onOpenChange(false);
      setRows([]);
      setFileName("");
    } catch (err: any) {
      toast.error(err.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  }

  function handleClose() {
    if (!importing) {
      onOpenChange(false);
      setRows([]);
      setFileName("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t("ImportVehiclesTitle" as any)}
          </DialogTitle>
          <DialogDescription>
            {t("ImportVehiclesDesc" as any)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Drop zone */}
          <div
            className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm font-medium">{fileName || t("DropFileHere" as any)}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("FileTypesAccepted" as any)}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <Download className="h-4 w-4 me-2" />
              {t("DownloadTemplate" as any)}
            </Button>
            {rows.length > 0 && (
              <div className="flex gap-2 text-sm">
                <Badge variant="default" className="bg-green-600">
                  <CheckCircle2 className="h-3 w-3 me-1" />
                  {validRows.length} {t("ReadyToImport" as any)}
                </Badge>
                {invalidRows.length > 0 && (
                  <Badge variant="destructive">
                    <AlertCircle className="h-3 w-3 me-1" />
                    {invalidRows.length} {t("ImportErrors" as any)}
                  </Badge>
                )}
              </div>
            )}
          </div>

          {invalidRows.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {invalidRows.length} {t("RowsHaveErrors" as any)}
              </AlertDescription>
            </Alert>
          )}

          {/* Preview table */}
          {rows.length > 0 && (
            <div className="rounded-md border overflow-auto max-h-64">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>{t("TypeName" as any)}</TableHead>
                    <TableHead>{t("Model" as any)}</TableHead>
                    <TableHead>{t("Year" as any)}</TableHead>
                    <TableHead>{t("VIN" as any)}</TableHead>
                    <TableHead>{t("Color" as any)}</TableHead>
                    <TableHead>KM</TableHead>
                    <TableHead className={`text-${isRtl ? "left" : "right"}`}>{t("Cost" as any)}</TableHead>
                    <TableHead className={`text-${isRtl ? "left" : "right"}`}>{t("AlMutakhasisa" as any)}</TableHead>
                    <TableHead>{t("Status" as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={i} className={row._errors.length > 0 ? "bg-destructive/5" : ""}>
                      <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                      <TableCell>{row.make || <span className="text-destructive">—</span>}</TableCell>
                      <TableCell>{row.model || <span className="text-destructive">—</span>}</TableCell>
                      <TableCell>{row.year || <span className="text-destructive">—</span>}</TableCell>
                      <TableCell className="font-mono text-xs">{row.vin || "—"}</TableCell>
                      <TableCell>{row.color}</TableCell>
                      <TableCell>{row.mileage !== undefined ? row.mileage.toLocaleString() : <span className="text-muted-foreground text-xs">TBD</span>}</TableCell>
                      <TableCell className={`text-${isRtl ? "left" : "right"}`}>{row.purchasePrice ? row.purchasePrice.toLocaleString() : "—"}</TableCell>
                      <TableCell className={`text-${isRtl ? "left" : "right"}`}>{row.sellingPrice > 0 ? row.sellingPrice.toLocaleString() : "—"}</TableCell>
                      <TableCell>
                        {row._errors.length > 0 ? (
                          <Badge variant="destructive" className="text-xs">{row._errors[0]}</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-green-600 border-green-600">OK</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter className="pt-2 border-t">
          <Button variant="outline" onClick={handleClose} disabled={importing}>{t("Cancel" as any)}</Button>
          <Button onClick={handleImport} disabled={validRows.length === 0 || importing}>
            {importing ? t("ImportingEllipsis" as any) : `${t("ImportVehiclesAction" as any)} (${validRows.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
