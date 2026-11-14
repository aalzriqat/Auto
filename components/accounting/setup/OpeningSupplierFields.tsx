"use client";

import { SupplierSelect } from "@/components/suppliers/SupplierSelect";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Id } from "@/convex/_generated/dataModel";
import type { OpeningAllocationDraft } from "./openingAllocationForm";

export function OpeningSupplierFields({ orgId, row, onChange }: Readonly<{
  orgId: Id<"organizations">;
  row: OpeningAllocationDraft;
  onChange: (patch: Partial<OpeningAllocationDraft>) => void;
}>) {
  const { t } = useLanguage();
  if (row.kind !== "SUPPLIER_RECOVERABLE" && row.kind !== "SUPPLIER_PAYABLE" && row.kind !== "OTHER_PAYABLE") return null;
  return <div className="min-w-0 space-y-1">
    <Label htmlFor={`${row.rowKey}-supplier`}>{t("OpeningAllocationSupplier")}</Label>
    <SupplierSelect id={`${row.rowKey}-supplier`} orgId={orgId} value={row.supplierId}
      valueLabel={row.counterpartyName} ariaLabel={t("OpeningAllocationSupplier")}
      onChange={(supplier) => onChange({ supplierId: supplier.id, counterpartyName: supplier.displayName })} />
    {row.kind === "OTHER_PAYABLE" && <>
      <p className="text-xs text-muted-foreground">{t("OpeningAllocationSupplierOptional")}</p>
      <Label htmlFor={`${row.rowKey}-counterparty`}>{t("OpeningAllocationCounterpartySnapshot")}</Label>
      <Input id={`${row.rowKey}-counterparty`} value={row.counterpartyName ?? ""} readOnly={!!row.supplierId}
        onChange={(event) => onChange({ counterpartyName: event.target.value })} />
      {row.supplierId && <Button type="button" variant="ghost" size="sm"
        onClick={() => onChange({ supplierId: undefined, counterpartyName: "" })}>{t("OpeningAllocationOrdinaryCreditor")}</Button>}
    </>}
  </div>;
}
