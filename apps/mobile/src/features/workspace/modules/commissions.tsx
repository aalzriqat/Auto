import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { Text } from "react-native";
import { RouteLoadingState } from "../../../components/RouteState";
import { api, type MobileSale } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, commissionAmountLabel, commissionStatusLabel, idempotencyKey, useGenericError, PrimaryButton, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

/** Ceiling on pages this screen will fetch by itself. See the effect below. */
const MAX_AUTO_PAGES = 20;

export function CommissionsModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const reportError = useGenericError();
  // Paginated: the server reads a fixed number of sale documents per page, so
  // rendering the first response as the complete list would hide every older
  // commission with no way to reach it.
  const { loadMore, results, status } = usePaginatedQuery(
    api.sales.listCommissionsPaginated,
    { orgId },
    { initialNumItems: PAGE_SIZE }
  );
  const markPaid = useMutation(api.sales.markCommissionPaid);

  // ModuleList advances pages from FlatList's onEndReached, which never fires
  // when there is nothing to scroll. A page reads a fixed number of sale
  // documents and may match none of them, so without this the list would settle
  // on "No commissions found." over rows it simply had not reached yet.
  //
  // Bounded, for the same reason the web table's walk is: an organization whose
  // sales produce no commission rows at all would otherwise issue one request
  // per page of its entire history every time somebody opens this screen. Once
  // the budget is spent the manual load-more control takes over.
  const autoPages = useRef(0);
  const autoLoadCapped = results.length === 0 && autoPages.current >= MAX_AUTO_PAGES;
  useEffect(() => {
    if (results.length === 0 && status === "CanLoadMore" && autoPages.current < MAX_AUTO_PAGES) {
      autoPages.current += 1;
      loadMore(PAGE_SIZE);
    }
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
      emptyLabel={
        autoLoadCapped
          ? locale === "ar"
            ? "لم يتم العثور على عمولات ضمن ما تم تحميله. حمّل المزيد للمتابعة."
            : "No commissions in the sales loaded so far. Load more to keep looking."
          : locale === "ar"
            ? "لا توجد عمولات."
            : "No commissions found."
      }
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
