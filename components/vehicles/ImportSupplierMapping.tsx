"use client";

/**
 * SCRUM-868 P2: maps each supplier name in an import file to a supplier in the master.
 * The dealer picks every one; nothing is matched by name. The import stays blocked until each
 * name has a supplier (see `unmappedImportSuppliers`), and the rows then send ids only.
 */
import type { Id } from "@/convex/_generated/dataModel";
import { SupplierSelect, type PickedSupplier } from "@/components/suppliers/SupplierSelect";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { interpolate } from "@/lib/i18n/interpolate";
import {
  unmappedImportSuppliers,
  type ImportSupplierNeed,
} from "@/lib/vehicles/importSupplierMapping";

export type ImportSupplierMap = Record<string, PickedSupplier | undefined>;

interface Props {
  orgId: Id<"organizations"> | null | undefined;
  needs: ReadonlyArray<ImportSupplierNeed>;
  mapped: ImportSupplierMap;
  onMap: (key: string, supplier: PickedSupplier) => void;
}

export function ImportSupplierMapping({ orgId, needs, mapped, onMap }: Readonly<Props>) {
  const { t } = useLanguage();
  const translate = t as (key: string) => string;
  if (needs.length === 0) return null;
  const remaining = unmappedImportSuppliers(needs, mapped).length;

  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby="import-supplier-mapping-heading">
      <div className="space-y-1">
        <p className="text-sm font-semibold" id="import-supplier-mapping-heading">
          {translate("ImportSupplierMappingHeading")}
        </p>
        <p className="text-xs leading-snug text-muted-foreground">{translate("ImportSupplierMappingHint")}</p>
      </div>
      {remaining > 0 && (
        <p role="status" className="text-xs font-medium leading-snug text-destructive">
          {interpolate(translate("ImportSupplierMappingRequired"), { count: remaining })}
        </p>
      )}
      <ul className="space-y-2">
        {needs.map((need) => (
          <li key={need.key} className="grid gap-1 sm:grid-cols-2 sm:items-center sm:gap-3">
            <div className="text-start text-sm">
              <bdi className="font-medium">{need.name}</bdi>
              <span className="block text-xs text-muted-foreground">
                {translate(need.role === "SOURCED" ? "ImportSupplierRoleSourced" : "ImportSupplierRoleCreditor")}
                {" · "}
                {interpolate(translate("ImportSupplierRowCount"), { count: need.rowCount })}
              </span>
            </div>
            <SupplierSelect
              orgId={orgId}
              value={mapped[need.key]?.id}
              valueLabel={mapped[need.key]?.displayName}
              ariaLabel={need.name}
              invalid={!mapped[need.key]}
              dataTestId={`import-supplier-${need.key}`}
              onChange={(supplier) => onMap(need.key, supplier)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
