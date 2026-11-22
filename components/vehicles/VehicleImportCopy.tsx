import type { ImportRow } from "@/components/import/ImportWizard";
import { vehiclesEn } from "@/lib/i18n/domains/vehicles";
import { interpolate } from "@/lib/i18n/interpolate";

export type VehicleImportTranslate = (key: keyof typeof vehiclesEn) => string;
export const englishVehicleCopy: VehicleImportTranslate = (key) =>
  vehiclesEn[key];

export function describeUnreadableAmount(
  key: "VehicleImportUnreadablePrice" | "VehicleImportUnreadableCost",
  cell: unknown,
  t: VehicleImportTranslate,
  locale: "en" | "ar",
): string {
  const raw = String(cell).trim();
  const value = locale === "ar" ? `\u2068${raw}\u2069` : raw;
  return interpolate(t(key), { value });
}

export function renderVehiclePreviewCell(
  row: ImportRow,
  key: string,
  t: VehicleImportTranslate,
  locale: "en" | "ar",
) {
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";
  switch (key) {
    case "make":
      return row.make || <span className="text-destructive">—</span>;
    case "model":
      return row.model || <span className="text-destructive">—</span>;
    case "year":
      return row.year || <span className="text-destructive">—</span>;
    case "vin":
      return (
        <bdi dir="ltr" className="font-mono text-xs">
          {row.vin || "—"}
        </bdi>
      );
    case "color":
      return row.color;
    case "mileage":
      return row.mileage !== undefined && !isNaN(row.mileage) ? (
        row.mileage.toLocaleString(localeCode)
      ) : (
        <span className="text-muted-foreground text-xs">
          {t("VehicleImportPendingMileage")}
        </span>
      );
    case "sourceType":
      if (row.sourceType === "SOURCED")
        return (
          <span className="text-xs text-orange-600">
            {t("VehicleImportSourceSourced")}
          </span>
        );
      if (row.sourceType === "STOCK")
        return (
          <span className="text-xs text-muted-foreground">
            {t("VehicleImportSourceStock")}
          </span>
        );
      return <span className="text-destructive">—</span>;
    case "purchasePrice":
      return row.purchasePrice
        ? row.purchasePrice.toLocaleString(localeCode)
        : "—";
    case "sellingPrice":
      return row.sellingPrice > 0
        ? row.sellingPrice.toLocaleString(localeCode)
        : "—";
    case "valuations": {
      const valuations = (row.valuations ?? []) as Array<{
        companyName?: string;
        valuationAmount: number;
      }>;
      if (valuations.length === 0)
        return <span className="text-muted-foreground text-xs">—</span>;
      return (
        <span className="text-xs">
          {valuations
            .map(
              (v) =>
                `${v.companyName ?? "?"}: ${v.valuationAmount.toLocaleString(localeCode)}`,
            )
            .join(", ")}
        </span>
      );
    }
    default:
      return null;
  }
}
