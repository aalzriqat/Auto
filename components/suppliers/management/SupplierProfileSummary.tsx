"use client";

import type { Id } from "@/convex/_generated/dataModel";
import type { AliasRow } from "./SupplierAliasesSection";
import { useTranslate } from "./shared";

export interface FullSupplier {
  _id: Id<"suppliers">;
  displayName: string;
  legalName?: string;
  status: "ACTIVE" | "INACTIVE";
  contact?: { phone?: string; email?: string; address?: string };
  taxId?: string;
  taxJurisdiction?: string;
  sharedLegalIdentityOf?: Id<"suppliers">;
  version: number;
  /** The edit token: what `expectedVersion` must carry. Raised by every update. */
  revision: number;
  deactivatedReason?: string;
  aliases: AliasRow[];
}

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
