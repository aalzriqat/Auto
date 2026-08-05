import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect } from "react";
import { Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSale } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, commissionAmountLabel, commissionStatusLabel, idempotencyKey, useGenericError, PrimaryButton, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

export function CommissionsModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  // Paginated: the server reads a fixed number of sale documents per page, so
  // rendering the first response as the complete list would hide every older
  // commission with no way to reach it.
  const { loadMore, results, status } = usePaginatedQuery(
    api.sales.listCommissions,
    { orgId },
    { initialNumItems: PAGE_SIZE }
  );
  const markPaid = useMutation(api.sales.markCommissionPaid);

  // ModuleList advances pages from FlatList's onEndReached, which never fires
  // when there is nothing to scroll. A page reads a fixed number of sale
  // documents and may match none of them, so without this the list would settle
  // on "No commissions found." over rows it simply had not reached yet.
  useEffect(() => {
    if (results.length === 0 && status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [results.length, status, loadMore]);

  async function pay(sale: MobileSale) {
    try {
      await markPaid({ orgId, saleId: sale._id, paymentMethod: "CASH", idempotencyKey: idempotencyKey("sales.markCommissionPaid") });
    } catch (error) {
      reportError("Mobile commission pay failed", error);
    }
  }

  if (status === "LoadingFirstPage") {
    return <RouteLoadingState label={locale === "ar" ? "جاري التحميل" : "Loading"} />;
  }

  return (
    <ModuleList
      data={results}
      emptyLabel={locale === "ar" ? "لا توجد عمولات." : "No commissions found."}
      keyExtractor={(sale) => sale._id}
      loadMore={loadMore}
      status={status}
      renderItem={(sale) => (
        <RecordCard>
          <Text style={styles.recordTitle}>{sale.salespersonName}</Text>
          <Text style={styles.recordMeta}>{sale.vehicleSummary} · {sale.customerName}</Text>
          <Text style={styles.recordMeta}>{commissionAmountLabel(sale, locale)} · {commissionStatusLabel(sale, locale)}</Text>
          {/* Only a commission the server will actually accept payment for. A
              cancelled sale keeps its amount as history (commissionStatus
              VOID) and a decided-but-zero one owes nothing, so neither gets a
              button that could only fail. Setting a first amount is a desktop
              action for now. */}
          {sale.commissionStatus === "UNPAID" ? (
            <PrimaryButton label={locale === "ar" ? "تسجيل كمدفوعة" : "Mark paid"} tone="muted" onPress={() => pay(sale)} />
          ) : null}
        </RecordCard>
      )}
    />
  );
}
