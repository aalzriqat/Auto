import { usePaginatedQuery } from "convex/react";
import { Text, View } from "react-native";
import { api, type MobileFinanceApplication } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, money, RecordCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function ApplicationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const { loadMore, results, status } = usePaginatedQuery(api.applications.list, { orgId }, { initialNumItems: PAGE_SIZE });
  return (
    <ModuleList
      data={results}
      emptyLabel={locale === "ar" ? "لا توجد طلبات تمويل." : "No finance applications found."}
      keyExtractor={(application) => application._id}
      loadMore={loadMore}
      status={status}
      renderItem={(application: MobileFinanceApplication) => (
        <RecordCard>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{application.customerName}</Text>
            <Text style={styles.statusPill}>{application.status}</Text>
          </View>
          <Text style={styles.recordMeta}>{application.vehicleDesc}</Text>
          <Text style={styles.recordMeta}>{application.companyName} · {money(application.financedAmount, locale)} · {money(application.monthlyInstallment, locale)}</Text>
        </RecordCard>
      )}
    />
  );
}
