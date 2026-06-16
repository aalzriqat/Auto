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

const COL_MAP: Record<string, string> = {
  "first name": "firstName", firstname: "firstName", "الاسم الأول": "firstName", "الاسم": "firstName",
  "last name": "lastName", lastname: "lastName", surname: "lastName", "اسم العائلة": "lastName", "الكنية": "lastName",
  phone: "phone", mobile: "phone", "phone number": "phone", "هاتف": "phone", "رقم الهاتف": "phone",
  whatsapp: "whatsapp", "واتساب": "whatsapp",
  email: "email", "البريد الإلكتروني": "email", "الإيميل": "email",
  "national id": "nationalId", "id number": "nationalId", "national id number": "nationalId", "رقم الهوية": "nationalId", الهوية: "nationalId",
  address: "address", "العنوان": "address",
};

interface ParsedCustomer {
  firstName: string;
  lastName: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  nationalId?: string;
  address?: string;
  _errors: string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ");
}

function parseRows(rows: Record<string, any>[]): ParsedCustomer[] {
  return rows.map((row) => {
    const mapped: Record<string, any> = {};
    for (const [rawKey, val] of Object.entries(row)) {
      const normalized = normalizeKey(rawKey);
      const field = COL_MAP[normalized];
      if (field) mapped[field] = val;
    }

    const errors: string[] = [];
    const firstName = String(mapped.firstName ?? "").trim();
    const lastName = String(mapped.lastName ?? "").trim();
    const phone = mapped.phone ? String(mapped.phone).trim() : undefined;
    const whatsapp = mapped.whatsapp ? String(mapped.whatsapp).trim() : undefined;
    const email = mapped.email ? String(mapped.email).toLowerCase().trim() : undefined;
    const nationalId = mapped.nationalId ? String(mapped.nationalId).trim() : undefined;
    const address = mapped.address ? String(mapped.address).trim() : undefined;

    if (!firstName) errors.push("Missing First Name");
    if (!lastName) errors.push("Missing Last Name");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Invalid Email");

    return { firstName, lastName, phone, whatsapp, email, nationalId, address, _errors: errors };
  }).filter(c => c.firstName || c.lastName);
}

const TEMPLATE_HEADERS = ["First Name", "Last Name", "Phone", "WhatsApp", "Email", "National ID", "Address"];
const TEMPLATE_EXAMPLE = ["Ahmed", "Al-Hassan", "0791234567", "0791234567", "ahmed@email.com", "123456789", "Amman, Jordan"];

function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
  ws["!cols"] = TEMPLATE_HEADERS.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, "Customers");
  XLSX.writeFile(wb, "customer_import_template.xlsx");
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerImportDialog({ open, onOpenChange }: Props) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const importBulk = useMutation(api.customers.importBulk);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ParsedCustomer[]>([]);
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
        customers: validRows.map(({ _errors, ...c }) => c),
      });
      toast.success(`Imported ${result.inserted} customers${result.skipped > 0 ? `, skipped ${result.skipped} duplicates` : ""}.`);
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
            {t("ImportCustomersTitle" as any)}
          </DialogTitle>
          <DialogDescription>
            {t("ImportCustomersDesc" as any)}
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
                    <TableHead>{t("FirstName" as any)}</TableHead>
                    <TableHead>{t("LastName" as any)}</TableHead>
                    <TableHead>{t("Phone" as any)}</TableHead>
                    <TableHead>{t("Email" as any)}</TableHead>
                    <TableHead>{t("NationalID" as any)}</TableHead>
                    <TableHead>{t("Status" as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={i} className={row._errors.length > 0 ? "bg-destructive/5" : ""}>
                      <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                      <TableCell>{row.firstName || <span className="text-destructive">—</span>}</TableCell>
                      <TableCell>{row.lastName || <span className="text-destructive">—</span>}</TableCell>
                      <TableCell>{row.phone || "—"}</TableCell>
                      <TableCell>{row.email || "—"}</TableCell>
                      <TableCell>{row.nationalId || "—"}</TableCell>
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
            {importing ? t("ImportingEllipsis" as any) : `${t("ImportCustomersAction" as any)} (${validRows.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
