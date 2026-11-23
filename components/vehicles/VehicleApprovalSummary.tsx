import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import type { Doc } from "@/convex/_generated/dataModel";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";

type ApprovalSummaryRequest = Pick<Doc<"vehicleEdits">, "type" | "payload"> & {
  user: { name: string } | null;
};

export function VehicleApprovalSummary({
  request,
}: {
  request: ApprovalSummaryRequest;
}) {
  const { t, locale } = useLanguage();
  const { payload, type, user } = request;
  return (
    <>
      <div className="flex items-center gap-2">
        <Badge variant={type === "CREATE" ? "default" : "secondary"}>
          {t(type === "CREATE" ? "NewVehicleReq" : "EditDetailsReq")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {t("ByReq")} {user?.name}
        </span>
      </div>
      <p className="font-semibold text-sm mt-2">
        {payload?.year} {payload?.make} {payload?.model}
      </p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {t("VIN")}: <bdi dir="ltr">{payload?.vin || "—"}</bdi>
        </span>
        <span>•</span>
        <span>
          {t("Price")}:{" "}
          <bdi>
            {payload?.sellingPrice == null
              ? "—"
              : formatMoneyDisplay(payload.sellingPrice, "JOD", locale)}
          </bdi>
        </span>
      </div>
    </>
  );
}
