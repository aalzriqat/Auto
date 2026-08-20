"use client";

import { useRef, useState } from "react";

/** Opaque, unique per uploaded file. Never derived from the file's contents. */
function newImportId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older/insecure contexts: still unique enough for one operator's session,
  // and the server treats the value as opaque.
  return `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

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
import { parseSpreadsheetFile, SpreadsheetRows } from "@/lib/spreadsheet";

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
  /**
   * This row's position in the uploaded file, 1-based, assigned before any
   * filtering. A consumer whose retry safety depends on row identity must use
   * this and not an index into the valid subset: correcting one bad row would
   * renumber every row after it, and evidence keyed on those numbers would stop
   * matching the rows it was written for.
   */
  _sourceRow: number;
  [key: string]: any;
}

/**
 * What the preflight and the block-check are given.
 *
 * `validRows` is the rows that will actually be sent. `totalCount` and
 * `invalidCount` describe the file they came from, so a consumer whose invariant
 * is about the whole file can refuse rather than silently import a subset.
 */
/**
 * What an import actually did, told apart rather than summed.
 *
 * `alreadyRecorded` and `skipped` are NOT the same outcome and must never share
 * a counter. `alreadyRecorded` means the row was proven to be a repeat of work
 * already done — nothing needed doing. `skipped` is the older, looser
 * "an existing record matched" used by imports that post nothing.
 *
 * The reason this distinction exists at all: a single `skipped` counter was
 * rendered to the operator as "skipped N duplicates" no matter WHY the row was
 * not written. A vehicle that could not be recorded — and whose purchase
 * therefore never reached the ledger — was announced as a duplicate, which is
 * the one message guaranteed to stop anyone looking into it.
 */
/**
 * Identifies the import operation itself, so a consumer can prove a re-sent row
 * is a RETRY rather than a second, genuinely new record.
 *
 * This matters wherever an import has effects that must not happen twice. Two
 * different real-world things are routinely identical in every field a
 * spreadsheet carries, so comparing the contents of a re-sent row against what
 * is already stored cannot answer the question — it can only guess, and on a
 * money path guessing wrong destroys a record silently.
 */
export interface ImportSubmission {
  /** Stable for this uploaded file across every call and retry it produces. */
  importId: string;
  /**
   * Original file row number for each submitted row, index-aligned with them.
   *
   * Carried BESIDE the rows rather than inside them, because a consumer is free
   * to forward a row straight to its backend — `CustomerImportDialog` does
   * exactly that — and a stray bookkeeping field would be rejected as an
   * undeclared argument. Anything the wizard adds for its own use is stripped
   * before a row leaves it.
   */
  sourceRows: number[];
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  /** Rows proven to repeat work already recorded. Never a row that was dropped. */
  alreadyRecorded?: number;
  companiesCreated?: number;
}

/**
 * The sentence an operator reads after an import, built from the result alone.
 *
 * Pure and exported so the copy is testable against the real dictionaries
 * without a render harness — the wording is the whole point of this function,
 * and "skipped N duplicates" being wrong for a row that was never recorded is
 * precisely the kind of defect a render test would not have been written to
 * catch.
 */
export function describeImportResult(
  result: ImportResult,
  translate: (key: string) => string
): string {
  const line = (key: string, count: number) => translate(key).replace("{count}", String(count));
  // Each outcome gets its own sentence. Concatenating them into one
  // "imported N, skipped M duplicates" is how two different things — work
  // already done, and work that did not happen — became indistinguishable.
  const parts = [line("ImportResultImported", result.inserted)];
  if (result.alreadyRecorded) parts.push(line("ImportResultAlreadyRecorded", result.alreadyRecorded));
  if (result.skipped > 0) parts.push(line("ImportResultSkippedDuplicates", result.skipped));
  if (result.companiesCreated) parts.push(line("ImportResultCompaniesCreated", result.companiesCreated));
  return parts.join(" ");
}

/**
 * A row as a CONSUMER sees it: every field the wizard added for its own
 * bookkeeping removed, so the row can be forwarded to a backend unchanged.
 *
 * This is not tidiness. `CustomerImportDialog` passes its rows straight into a
 * Convex mutation, and Convex REJECTS an undeclared argument — so any field the
 * wizard leaves on a row breaks a consumer that never asked for it. The `_`
 * prefix is the convention; this function is what makes it load-bearing.
 */
export function stripInternalFields(row: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  Object.entries(row).forEach(([key, value]) => {
    if (!key.startsWith("_")) clean[key] = value;
  });
  return clean;
}

export interface ImportPreflightInfo {
  validRows: Record<string, any>[];
  invalidCount: number;
  totalCount: number;
}

interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "vehicle" | "customer";
  title: string;
  description: string;
  fields: ImportFieldConfig[];
  autoGuess: Record<string, string>;
  parseWorksheet?: (rows: SpreadsheetRows) => { headers: string[]; rows: any[][]; valuationHeaders?: string[] };
  deriveRow?: (mapped: Record<string, any>) => Record<string, any>;
  validateRow: (mapped: Record<string, any>) => string[];
  previewColumns: ImportPreviewColumn[];
  renderPreviewCell: (row: ImportRow, columnKey: string) => React.ReactNode;
  templateBuilder: () => void | Promise<void>;
  /**
   * Lets the entity-specific dialog inject extra mapping targets discovered
   * only after parsing this file (e.g. one "Valuation: <company>" option per
   * finance-company-valuation column detected in the sheet). Called synchronously right
   * after parsing so the returned autoGuess entries can seed initialMapping.
   */
  resolveDynamicFields?: (info: { headers: string[]; valuationHeaders: string[] }) => {
    extraFields: ImportFieldConfig[];
    extraAutoGuess: Record<string, string>;
  };
  /**
   * Optional block rendered on the preview step, directly above the Import
   * button — for a decision the operator can only make once they can see the
   * rows they are about to commit (vehicles use it to declare what the file
   * means in accounting terms; see SCRUM-59).
   *
   * `isBlocked` is what actually stops the import. It is a separate callback
   * rather than something inferred from the returned node because the wizard
   * must not have to understand the entity-specific rule to enforce it — and
   * because a required decision that only *looks* required is not a control.
   *
   * It receives every valid row in the file, not just the current chunk, so a
   * rule that must hold across the whole import can be checked before the first
   * chunk is sent rather than discovered after earlier chunks have committed.
   */
  renderPreflight?: (info: ImportPreflightInfo) => React.ReactNode;
  isBlocked?: (info: ImportPreflightInfo) => boolean;
  onImport: (validRows: Record<string, any>[], meta: ImportSubmission) => Promise<ImportResult>;
}

const IGNORE = "__IGNORE__";

export function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ");
}

function defaultParseWorksheet(rawRows: SpreadsheetRows): { headers: string[]; rows: any[][]; valuationHeaders: string[] } {
  if (rawRows.length === 0) return { headers: [], rows: [], valuationHeaders: [] };
  const headers = (rawRows[0] ?? []).map((c: any) => String(c ?? "").trim());
  const rows = rawRows.slice(1).filter((row) => row.some((cell: any) => cell !== ""));
  return { headers, rows, valuationHeaders: [] };
}

// Shared dialog for bulk-importing an entity from Excel/CSV. Detects the
// file's column headers and lets the dealer map each one to a target field
// (pre-filled from their org's last-confirmed mapping, falling back to a
// best-guess), instead of requiring a fixed set of column names.
export function ImportWizard(props: ImportWizardProps) {
  const {
    open, onOpenChange, entityType, title, description, fields, autoGuess,
    parseWorksheet = defaultParseWorksheet, deriveRow, validateRow,
    previewColumns, renderPreviewCell, templateBuilder, resolveDynamicFields,
    renderPreflight, isBlocked, onImport,
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
  const [importId, setImportId] = useState<string>("");
  const [dynamicFields, setDynamicFields] = useState<ImportFieldConfig[]>([]);

  const allFields = [...fields, ...dynamicFields];

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
    setImportId("");
    setDynamicFields([]);
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    try {
      const spreadsheetRows = await parseSpreadsheetFile(file);
      const { headers: detectedHeaders, rows: detectedRows, valuationHeaders } = parseWorksheet(spreadsheetRows);

      const dynamic = resolveDynamicFields?.({
        headers: detectedHeaders,
        valuationHeaders: valuationHeaders ?? [],
      }) ?? { extraFields: [], extraAutoGuess: {} };
      setDynamicFields(dynamic.extraFields);
      const effectiveAutoGuess = { ...autoGuess, ...dynamic.extraAutoGuess };

      const savedDict: Record<string, string> = {};
      (savedMapping ?? []).forEach((m: any) => {
        savedDict[m.sourceHeader] = m.targetField;
      });

      const initialMapping: Record<string, string> = {};
      detectedHeaders.forEach((h) => {
        const norm = normalizeKey(h);
        initialMapping[norm] = savedDict[norm] ?? effectiveAutoGuess[norm] ?? IGNORE;
      });

      setHeaders(detectedHeaders);
      setSampleValues(detectedHeaders.map((_, i) => String(detectedRows[0]?.[i] ?? "")));
      setRawRows(detectedRows);
      setMapping(initialMapping);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read this spreadsheet.");
      resetAll();
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function confirmMapping() {
    const mappedRows: ImportRow[] = rawRows.map((rawRow, index) => {
      const mapped: Record<string, any> = {};
      headers.forEach((h, i) => {
        const field = mapping[normalizeKey(h)];
        if (field && field !== IGNORE) mapped[field] = rawRow[i];
      });
      const derived = deriveRow ? deriveRow(mapped) : mapped;
      return { ...derived, _errors: validateRow(derived), _sourceRow: index + 1 };
    });

    setRows(mappedRows);
    // One identity per uploaded file, stable for every call this import makes.
    // Regenerated here rather than per send, so the chunk loop and any retry
    // within this upload all present the same operation.
    setImportId(newImportId());
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

  // `validRows` alone is NOT enough to decide whether an import may proceed.
  // A consumer whose rule is about the WHOLE FILE — a purchase import, which
  // is one atomic transaction — must be able to see that rows were dropped,
  // or it silently imports a subset and calls it the file.
  const preflightInfo = {
    validRows: validRows.map(stripInternalFields),
    invalidCount: invalidRows.length,
    totalCount: rows.length,
  };

  async function handleImport() {
    if (!activeOrgId || validRows.length === 0) return;
    // The wizard enforces the control it documents, rather than relying on the
    // Button being disabled. A disabled button is a hint; any consumer that
    // supplies `isBlocked` and calls handleImport from another path — a form
    // submit, an Enter key, a future shortcut — would otherwise get a silent
    // bypass. VehicleImportDialog re-checks inside its own onImport too, so
    // there is no live bypass today; this makes the abstraction authoritative
    // so the next consumer does not have to know to duplicate it.
    if (isBlocked?.(preflightInfo)) return;
    setImporting(true);
    try {
      const result = await onImport(validRows.map(stripInternalFields), {
        importId,
        sourceRows: validRows.map((r) => r._sourceRow),
      });
      toast.success(describeImportResult(result, (key) => t(key as any)));
      onOpenChange(false);
      resetAll();
    } catch (err: any) {
      // Render the message, not the object — an Error passed straight to the
      // toast stringifies to nothing an operator can act on, which hid the
      // "how far did it get" detail the vehicle importer now reports.
      toast.error(err instanceof Error ? err.message : String(err));
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
              <button
                type="button"
                className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm font-medium">{fileName || t("DropFileHere" as any)}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("FileTypesAccepted" as any)}</p>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <Button variant="outline" size="sm" onClick={() => { void templateBuilder(); }}>
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
                                {allFields.map((f) => (
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

              {renderPreflight?.(preflightInfo)}
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
            <Button
              onClick={handleImport}
              disabled={validRows.length === 0 || importing || (isBlocked?.(preflightInfo) ?? false)}
            >
              {importing ? t("ImportingEllipsis" as any) : `${t("Import" as any) ?? "Import"} (${validRows.length})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
