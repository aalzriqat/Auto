"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useMutation, useQuery } from "convex/react";
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
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Download, ArrowRight, ArrowLeft } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/components/providers/LanguageProvider";

export interface ImportFieldConfig {
  key: string;
  label: string;
  required?: boolean;
}

export interface ImportPreviewColumn {
  key: string;
  label: string;
  align?: "start" | "end";
}

export interface ImportRow {
  _errors: string[];
  [key: string]: any;
}

interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "vehicle" | "customer";
  title: string;
  description: string;
  fields: ImportFieldConfig[];
  autoGuess: Record<string, string>;
  parseWorksheet?: (ws: XLSX.WorkSheet) => { headers: string[]; rows: any[][] };
  deriveRow?: (mapped: Record<string, any>) => Record<string, any>;
  validateRow: (mapped: Record<string, any>) => string[];
  previewColumns: ImportPreviewColumn[];
  renderPreviewCell: (row: ImportRow, columnKey: string) => React.ReactNode;
  templateBuilder: () => void;
  onImport: (validRows: Record<string, any>[]) => Promise<{ inserted: number; skipped: number }>;
}

const IGNORE = "__IGNORE__";

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ");
}

function defaultParseWorksheet(ws: XLSX.WorkSheet): { headers: string[]; rows: any[][] } {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (rawRows.length === 0) return { headers: [], rows: [] };
  const headers = (rawRows[0] ?? []).map((c: any) => String(c ?? "").trim());
  const rows = rawRows.slice(1).filter((row) => row.some((cell: any) => cell !== ""));
  return { headers, rows };
}

// Shared dialog for bulk-importing an entity from Excel/CSV. Detects the
// file's column headers and lets the dealer map each one to a target field
// (pre-filled from their org's last-confirmed mapping, falling back to a
// best-guess), instead of requiring a fixed set of column names.
export function ImportWizard(props: ImportWizardProps) {
  const {
    open, onOpenChange, entityType, title, description, fields, autoGuess,
    parseWorksheet = defaultParseWorksheet, deriveRow, validateRow,
    previewColumns, renderPreviewCell, templateBuilder, onImport,
  } = props;

  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"upload" | "preview">("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sampleValues, setSampleValues] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);

  const savedMapping = useQuery(
    api.importMappings.get,
    activeOrgId ? { orgId: activeOrgId, entityType } : "skip"
  );
  const saveMapping = useMutation(api.importMappings.save);

  function resetAll() {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setSampleValues([]);
    setRawRows([]);
    setMapping({});
    setRows([]);
  }

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = e.target?.result;
      const wb = XLSX.read(data, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const { headers: detectedHeaders, rows: detectedRows } = parseWorksheet(ws);

      const savedDict: Record<string, string> = {};
      (savedMapping ?? []).forEach((m: any) => {
        savedDict[m.sourceHeader] = m.targetField;
      });

      const initialMapping: Record<string, string> = {};
      detectedHeaders.forEach((h) => {
        const norm = normalizeKey(h);
        initialMapping[norm] = savedDict[norm] ?? autoGuess[norm] ?? IGNORE;
      });

      setHeaders(detectedHeaders);
      setSampleValues(detectedHeaders.map((_, i) => String(detectedRows[0]?.[i] ?? "")));
      setRawRows(detectedRows);
      setMapping(initialMapping);
    };
    reader.readAsBinaryString(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function confirmMapping() {
    const mappedRows: ImportRow[] = rawRows.map((rawRow) => {
      const mapped: Record<string, any> = {};
      headers.forEach((h, i) => {
        const field = mapping[normalizeKey(h)];
        if (field && field !== IGNORE) mapped[field] = rawRow[i];
      });
      const derived = deriveRow ? deriveRow(mapped) : mapped;
      return { ...derived, _errors: validateRow(derived) };
    });

    setRows(mappedRows);
    setStep("preview");

    if (activeOrgId) {
      const mappingArray = Object.entries(mapping)
        .filter(([, field]) => field !== IGNORE)
        .map(([sourceHeader, targetField]) => ({ sourceHeader, targetField }));
      saveMapping({ orgId: activeOrgId, entityType, mapping: mappingArray }).catch(() => {});
    }
  }

  const validRows = rows.filter((r) => r._errors.length === 0);
  const invalidRows = rows.filter((r) => r._errors.length > 0);

  async function handleImport() {
    if (!activeOrgId || validRows.length === 0) return;
    setImporting(true);
    try {
      const result = await onImport(validRows.map(({ _errors, ...r }) => r));
      toast.success(`Imported ${result.inserted}${result.skipped > 0 ? `, skipped ${result.skipped} duplicates` : ""}.`);
      onOpenChange(false);
      resetAll();
    } catch (err: any) {
      toast.error(err.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  }

  function handleClose() {
    if (!importing) {
      onOpenChange(false);
      resetAll();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          {headers.length === 0 && (
            <>
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
              <Button variant="outline" size="sm" onClick={templateBuilder}>
                <Download className="h-4 w-4 me-2" />
                {t("DownloadTemplate" as any)}
              </Button>
            </>
          )}

          {headers.length > 0 && step === "upload" && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("MapColumnsDesc" as any) ?? "Tell us what each column in your file means — we've pre-filled our best guess."}
              </p>
              <div className="rounded-md border overflow-auto max-h-96">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("ColumnInYourFile" as any) ?? "Column in your file"}</TableHead>
                      <TableHead>{t("SampleValue" as any) ?? "Sample value"}</TableHead>
                      <TableHead>{t("MapsTo" as any) ?? "Maps to"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {headers.map((h, i) => {
                      const norm = normalizeKey(h);
                      return (
                        <TableRow key={i}>
                          <TableCell className="font-medium">
                            {h || <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs truncate max-w-[160px]">
                            {sampleValues[i]}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={mapping[norm] ?? IGNORE}
                              onValueChange={(val) => setMapping((m) => ({ ...m, [norm]: val }))}
                            >
                              <SelectTrigger className="w-[220px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={IGNORE}>
                                  {t("IgnoreColumn" as any) ?? "Ignore this column"}
                                </SelectItem>
                                {fields.map((f) => (
                                  <SelectItem key={f.key} value={f.key}>
                                    {f.label}{f.required ? " *" : ""}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {step === "preview" && (
            <>
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep("upload")}>
                  <ArrowLeft className="h-4 w-4 me-2" />
                  {t("BackToMapping" as any) ?? "Back to column mapping"}
                </Button>
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
              </div>

              {invalidRows.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {invalidRows.length} {t("RowsHaveErrors" as any)}
                  </AlertDescription>
                </Alert>
              )}

              <div className="rounded-md border overflow-auto max-h-64">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      {previewColumns.map((c) => (
                        <TableHead key={c.key} className={c.align === "end" ? "text-end" : undefined}>
                          {c.label}
                        </TableHead>
                      ))}
                      <TableHead>{t("Status" as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className={row._errors.length > 0 ? "bg-destructive/5" : ""}>
                        <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                        {previewColumns.map((c) => (
                          <TableCell key={c.key} className={c.align === "end" ? "text-end" : undefined}>
                            {renderPreviewCell(row, c.key)}
                          </TableCell>
                        ))}
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
            </>
          )}
        </div>

        <DialogFooter className="pt-2 border-t">
          <Button variant="outline" onClick={handleClose} disabled={importing}>{t("Cancel" as any)}</Button>
          {headers.length > 0 && step === "upload" && (
            <Button onClick={confirmMapping}>
              {t("ContinueToPreview" as any) ?? "Continue"}
              <ArrowRight className="h-4 w-4 ms-2" />
            </Button>
          )}
          {step === "preview" && (
            <Button onClick={handleImport} disabled={validRows.length === 0 || importing}>
              {importing ? t("ImportingEllipsis" as any) : `${t("Import" as any) ?? "Import"} (${validRows.length})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
