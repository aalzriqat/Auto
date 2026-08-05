import { useMutation, useQuery } from "convex/react";
import { Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSale } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { money, dateLabel, idempotencyKey, useGenericError, PrimaryButton, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

/**
 * An undecided commission is not a zero one. `money(undefined)` renders "0.00",
 * which would read as "this sale earns nothing" — the opposite of the truth.
 */
function amountLabel(sale: MobileSale, locale: "en" | "ar"): string {
  if (sale.commissionAmount == null) return locale === "ar" ? "غير محددة" : "Not set";
  return money(sale.commissionAmount, locale);
}

function statusLabel(sale: MobileSale, locale: "en" | "ar"): string {
  if (sale.commissionPaidAt) return dateLabel(sale.commissionPaidAt, locale);
  if (sale.commissionAmount == null) return locale === "ar" ? "بانتظار المراجعة" : "Awaiting review";
  if (sale.commissionAmount <= 0) return locale === "ar" ? "لا توجد عمولة" : "No commission";
  return locale === "ar" ? "غير مدفوعة" : "Unpaid";
}

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
    <ModuleList
      data={commissions}
      emptyLabel={locale === "ar" ? "لا توجد عمولات." : "No commissions found."}
      keyExtractor={(sale) => sale._id}
      renderItem={(sale) => (
        <RecordCard>
          <Text style={styles.recordTitle}>{sale.salespersonName}</Text>
          <Text style={styles.recordMeta}>{sale.vehicleSummary} · {sale.customerName}</Text>
          <Text style={styles.recordMeta}>{amountLabel(sale, locale)} · {statusLabel(sale, locale)}</Text>
          {/* Only a positive, unpaid commission can actually be paid — the
              server rejects the rest, so the button is not offered for them.
              Setting a first amount is a desktop action for now. */}
          {!sale.commissionPaidAt && (sale.commissionAmount ?? 0) > 0 ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل كمدفوعة" : "Mark paid"} tone="muted" onPress={() => pay(sale)} />
          ) : null}
        </RecordCard>
      )}
    />
  );
}

