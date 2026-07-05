"use client";

import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { parseSpreadsheetFile, type SpreadsheetRows } from "@/lib/spreadsheet";
import type { Translate } from "./types";

type ColumnRole = "date" | "description" | "amount" | "ignore";

type BankStatementUploadDialogProps = {
  t: Translate;
  currencyScaleFactor: number;
  onImport: (rows: { statementDate: number; description: string; amountMinor: number }[]) => Promise<void>;
  importing: boolean;
};

function cellToString(cell: SpreadsheetRows[number][number]): string {
  if (cell === null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell);
}

function parseCellDate(cell: SpreadsheetRows[number][number]): number | null {
  if (cell instanceof Date) return cell.getTime();
  const parsed = new Date(cellToString(cell));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function parseCellAmount(cell: SpreadsheetRows[number][number]): number | null {
  if (typeof cell === "number") return cell;
  const cleaned = cellToString(cell).replace(/[,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

export function BankStatementUploadDialog({
  t,
  currencyScaleFactor,
  onImport,
  importing,
}: Readonly<BankStatementUploadDialogProps>) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SpreadsheetRows>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [dateCol, setDateCol] = useState<string>("0");
  const [descriptionCol, setDescriptionCol] = useState<string>("1");
  const [amountCol, setAmountCol] = useState<string>("2");

  async function handleFile(file: File) {
    try {
      const parsed = await parseSpreadsheetFile(file);
      setRows(parsed);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("StatementParseFail" as any));
    }
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columnCount = rows[0]?.length ?? 0;

  async function handleImport() {
    const dateIdx = Number(dateCol);
    const descIdx = Number(descriptionCol);
    const amountIdx = Number(amountCol);

    const parsedRows: { statementDate: number; description: string; amountMinor: number }[] = [];
    for (const row of dataRows) {
      const statementDate = parseCellDate(row[dateIdx]);
      const amount = parseCellAmount(row[amountIdx]);
      if (statementDate === null || amount === null) continue;
      parsedRows.push({
        statementDate,
        description: cellToString(row[descIdx]),
        amountMinor: Math.round(amount * currencyScaleFactor),
      });
    }
    if (parsedRows.length === 0) {
      toast.error(t("StatementNoValidRows" as any));
      return;
    }
    await onImport(parsedRows);
    setOpen(false);
    setRows([]);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="h-4 w-4" />
        {t("UploadStatement" as any)}
      </Button>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("UploadStatement" as any)}</DialogTitle>
          <DialogDescription>{t("UploadStatementDesc" as any)}</DialogDescription>
        </DialogHeader>

        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="text-sm"
        />

        {rows.length > 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>{t("DateColumn" as any)}</Label>
                <Select value={dateCol} onValueChange={setDateCol}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>{t("Column" as any)} {i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("DescriptionColumn" as any)}</Label>
                <Select value={descriptionCol} onValueChange={setDescriptionCol}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>{t("Column" as any)} {i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("AmountColumn" as any)}</Label>
                <Select value={amountCol} onValueChange={setAmountCol}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>{t("Column" as any)} {i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              {t("FirstRowIsHeader" as any)}
            </label>

            <div className="rounded-md border border-slate-200 overflow-x-auto max-h-64">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("DateColumn" as any)}</TableHead>
                    <TableHead>{t("DescriptionColumn" as any)}</TableHead>
                    <TableHead className="text-right">{t("AmountColumn" as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dataRows.slice(0, 8).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{cellToString(row[Number(dateCol)])}</TableCell>
                      <TableCell>{cellToString(row[Number(descriptionCol)])}</TableCell>
                      <TableCell className="text-right">{cellToString(row[Number(amountCol)])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-slate-500">{t("StatementRowCount" as any).replace("{count}", String(dataRows.length))}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel" as any)}
          </Button>
          <Button onClick={handleImport} disabled={rows.length === 0 || importing}>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("Import" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
