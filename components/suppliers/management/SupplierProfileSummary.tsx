"use client";

import type { FullSupplier } from "./SupplierDetailScreen";
import { useTranslate } from "./shared";

export function SupplierSummary({ supplier }: Readonly<{ supplier: FullSupplier }>) {
  const translate = useTranslate();
  const rows: Array<[string, string | undefined]> = [
    ["SuppliersFieldLegalName", supplier.legalName],
    ["SuppliersFieldAddress", supplier.contact?.address],
    ["SuppliersFieldTaxId", supplier.taxId],
    ["SuppliersFieldTaxJurisdiction", supplier.taxJurisdiction],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{translate(label)}</dt>
          <dd className="text-sm">
            <bdi>{value || "—"}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}
