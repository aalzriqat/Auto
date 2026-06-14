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

// Flexible column name mapping — handles common Excel column header variations
const COL_MAP: Record<string, string> = {
  make: "make", brand: "make", manufacturer: "make", الشركة: "make", الصانع: "make", الماركة: "make",
  model: "model", النموذج: "model", الموديل: "model",
  year: "year", سنة: "year", سنةالصنع: "year", "سنة الصنع": "year",
  vin: "vin", chassis: "vin", "chassis number": "vin", "رقم الشاصي": "vin", الشاصي: "vin",
  color: "color", colour: "color", اللون: "color",
  mileage: "mileage", km: "mileage", kilometers: "mileage", odometer: "mileage", المسافة: "mileage", "الكيلومترات": "mileage",
  "fuel type": "fuelType", fuel: "fuelType", "نوع الوقود": "fuelType", الوقود: "fuelType",
  transmission: "transmission", gearbox: "transmission", ناقلالحركة: "transmission", "ناقل الحركة": "transmission",
  "selling price": "sellingPrice", price: "sellingPrice", "sale price": "sellingPrice", "سعر البيع": "sellingPrice", السعر: "sellingPrice",
  "purchase price": "purchasePrice", cost: "purchasePrice", "buy price": "purchasePrice", "سعر الشراء": "purchasePrice", التكلفة: "purchasePrice",
  status: "status", الحالة: "status",
  notes: "notes", comments: "notes", remarks: "notes", ملاحظات: "notes",
};

interface ParsedVehicle {
  make: string;
  model: string;
  year: number;
  vin: string;
  color: string;
  mileage: number;
  fuelType: string;
  transmission: string;
  sellingPrice: number;
  purchasePrice?: number;
  status?: string;
  notes?: string;
  _errors: string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ");
}

function parseRows(rows: Record<string, any>[]): ParsedVehicle[] {
  return rows.map((row) => {
    const mapped: Record<string, any> = {};
    for (const [rawKey, val] of Object.entries(row)) {
      const normalized = normalizeKey(rawKey);
      const field = COL_MAP[normalized];
      if (field) mapped[field] = val;
    }

    const errors: string[] = [];
    const make = String(mapped.make ?? "").trim();
    const model = String(mapped.model ?? "").trim();
    const year = parseInt(mapped.year);
    const vin = String(mapped.vin ?? "").trim();
    const color = String(mapped.color ?? "").trim();
    const mileage = parseFloat(String(mapped.mileage ?? "0").replace(/,/g, ""));
    const fuelType = String(mapped.fuelType ?? "Petrol").trim() || "Petrol";
    const transmission = String(mapped.transmission ?? "Automatic").trim() || "Automatic";
    const sellingPrice = parseFloat(String(mapped.sellingPrice ?? "0").replace(/,/g, ""));
    const purchasePrice = mapped.purchasePrice != null
      ? parseFloat(String(mapped.purchasePrice).replace(/,/g, ""))
      : undefined;

    if (!make) errors.push("Missing Make");
    if (!model) errors.push("Missing Model");
    if (!year || isNaN(year) || year < 1900 || year > new Date().getFullYear() + 2) errors.push("Invalid Year");
    if (!sellingPrice || isNaN(sellingPrice) || sellingPrice <= 0) errors.push("Invalid Selling Price");
    if (isNaN(mileage) || mileage < 0) errors.push("Invalid Mileage");

    return {
      make, model, year, vin, color: color || "Unknown",
      mileage: isNaN(mileage) ? 0 : mileage,
      fuelType, transmission, sellingPrice: isNaN(sellingPrice) ? 0 : sellingPrice,
      purchasePrice: purchasePrice && !isNaN(purchasePrice) ? purchasePrice : undefined,
      status: mapped.status ? String(mapped.status).toUpperCase() : undefined,
      notes: mapped.notes ? String(mapped.notes).trim() : undefined,
      _errors: errors,
    };
  }).filter(v => v.make || v.model || v.sellingPrice); // Drop completely empty rows
}

const TEMPLATE_HEADERS = ["Make", "Model", "Year", "VIN", "Color", "Mileage", "Fuel Type", "Transmission", "Selling Price", "Purchase Price", "Status", "Notes"];
const TEMPLATE_EXAMPLE = ["Toyota", "Camry", "2022", "1HGCM82633A123456", "White", "45000", "Petrol", "Automatic", "18000", "14000", "AVAILABLE", ""];

function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
  ws["!cols"] = TEMPLATE_HEADERS.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, "Vehicles");
  XLSX.writeFile(wb, "vehicle_import_template.xlsx");
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VehicleImportDialog({ open, onOpenChange }: Props) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
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
      const json: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
      setRows(parseRows(json));
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
                    <TableHead>Make</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead>VIN</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead className="text-right">Selling Price</TableHead>
                    <TableHead>Status</TableHead>
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
                      <TableCell className="text-right">{row.sellingPrice > 0 ? row.sellingPrice.toLocaleString() : <span className="text-destructive">—</span>}</TableCell>
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
          <Button
            onClick={handleImport}
            disabled={validRows.length === 0 || importing}
          >
            {importing ? t("ImportingEllipsis" as any) : `Import ${validRows.length} Vehicle${validRows.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
