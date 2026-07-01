"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { ImportWizard, ImportFieldConfig, ImportRow } from "@/components/import/ImportWizard";
import { downloadXlsxTemplate } from "@/lib/spreadsheet";

// Column name auto-guess — only a starting point; the dealer can remap any
// column themselves, and their choice is remembered per-organization.
const COL_MAP: Record<string, string> = {
  "first name": "firstName", firstname: "firstName", "الاسم الأول": "firstName", "الاسم": "firstName",
  "last name": "lastName", lastname: "lastName", surname: "lastName", "اسم العائلة": "lastName", "الكنية": "lastName",
  phone: "phone", mobile: "phone", "phone number": "phone", "هاتف": "phone", "رقم الهاتف": "phone",
  whatsapp: "whatsapp", "واتساب": "whatsapp",
  email: "email", "البريد الإلكتروني": "email", "الإيميل": "email",
  "national id": "nationalId", "id number": "nationalId", "national id number": "nationalId", "رقم الهوية": "nationalId", الهوية: "nationalId",
  address: "address", "العنوان": "address",
};

const CUSTOMER_FIELDS: ImportFieldConfig[] = [
  { key: "firstName", label: "First Name", required: true },
  { key: "lastName", label: "Last Name", required: true },
  { key: "phone", label: "Phone" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "Email" },
  { key: "nationalId", label: "National ID" },
  { key: "address", label: "Address" },
];

const PREVIEW_COLUMNS = [
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "nationalId", label: "National ID" },
];

function deriveCustomerRow(mapped: Record<string, any>): Record<string, any> {
  return {
    firstName: String(mapped.firstName ?? "").trim(),
    lastName: String(mapped.lastName ?? "").trim(),
    phone: mapped.phone ? String(mapped.phone).trim() : undefined,
    whatsapp: mapped.whatsapp ? String(mapped.whatsapp).trim() : undefined,
    email: mapped.email ? String(mapped.email).toLowerCase().trim() : undefined,
    nationalId: mapped.nationalId ? String(mapped.nationalId).trim() : undefined,
    address: mapped.address ? String(mapped.address).trim() : undefined,
  };
}

function validateCustomerRow(row: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!row.firstName) errors.push("Missing First Name");
  if (!row.lastName) errors.push("Missing Last Name");
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push("Invalid Email");
  return errors;
}

function renderCustomerPreviewCell(row: ImportRow, key: string) {
  switch (key) {
    case "firstName": return row.firstName || <span className="text-destructive">—</span>;
    case "lastName": return row.lastName || <span className="text-destructive">—</span>;
    case "phone": return row.phone || "—";
    case "email": return row.email || "—";
    case "nationalId": return row.nationalId || "—";
    default: return null;
  }
}

const TEMPLATE_HEADERS = ["First Name", "Last Name", "Phone", "WhatsApp", "Email", "National ID", "Address"];
const TEMPLATE_EXAMPLE = ["Ahmed", "Al-Hassan", "0791234567", "0791234567", "ahmed@email.com", "123456789", "Amman, Jordan"];

async function downloadTemplate() {
  await downloadXlsxTemplate({
    fileName: "customer_import_template.xlsx",
    sheetName: "Customers",
    rows: [TEMPLATE_HEADERS, TEMPLATE_EXAMPLE],
    columnWidth: 20,
  });
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerImportDialog({ open, onOpenChange }: Props) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const importBulk = useMutation(api.customers.importBulk);

  return (
    <ImportWizard
      open={open}
      onOpenChange={onOpenChange}
      entityType="customer"
      title={t("ImportCustomersTitle" as any)}
      description={t("ImportCustomersDesc" as any)}
      fields={CUSTOMER_FIELDS}
      autoGuess={COL_MAP}
      deriveRow={deriveCustomerRow}
      validateRow={validateCustomerRow}
      previewColumns={PREVIEW_COLUMNS}
      renderPreviewCell={renderCustomerPreviewCell}
      templateBuilder={downloadTemplate}
      onImport={(customers) => {
        if (!activeOrgId) return Promise.resolve({ inserted: 0, skipped: 0 });
        return importBulk({ orgId: activeOrgId, customers: customers as any });
      }}
    />
  );
}
