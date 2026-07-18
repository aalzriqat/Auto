import { useMutation, useQuery } from "convex/react";
import { Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSale } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { money, dateLabel, idempotencyKey, useGenericError, PrimaryButton, RecordCard, EmptyList, ModuleScroll } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function CommissionsModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  const commissions = useQuery(api.sales.listCommissions, { orgId });
  const markPaid = useMutation(api.sales.markCommissionPaid);

  async function pay(sale: MobileSale) {
    try {
      await markPaid({ orgId, saleId: sale._id, paymentMethod: "CASH", idempotencyKey: idempotencyKey("sales.markCommissionPaid") });
    } catch (error) {
      reportError("Mobile commission pay failed", error);
    }
  }

  if (commissions === undefined) {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleScroll>
      {commissions.length ? commissions.map((sale) => (
        <RecordCard key={sale._id}>
          <Text style={styles.recordTitle}>{sale.salespersonName}</Text>
          <Text style={styles.recordMeta}>{sale.vehicleSummary} · {sale.customerName}</Text>
          <Text style={styles.recordMeta}>{money(sale.commissionAmount, locale)} · {sale.commissionPaidAt ? dateLabel(sale.commissionPaidAt, locale) : (locale === "ar" ? "غير مدفوعة" : "Unpaid")}</Text>
          {!sale.commissionPaidAt ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل كمدفوعة" : "Mark paid"} tone="muted" onPress={() => pay(sale)} />
          ) : null}
        </RecordCard>
      )) : <EmptyList label={locale === "ar" ? "لا توجد عمولات." : "No commissions found."} />}
    </ModuleScroll>
  );
}

