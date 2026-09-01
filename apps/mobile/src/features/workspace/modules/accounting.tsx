import { usePaginatedQuery } from "convex/react";
import { StyleSheet, Text, View } from "react-native";

import { api, type MobileLedgerTransaction } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { useThemedStyles } from "../../../providers/ThemeProvider";
import { type AppTheme } from "../../../theme";
import { PAGE_SIZE, money, dateLabel, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

// These rows are the operational cash-movement projection. `journalEntries` +
// `journalLines` are the authoritative books, and nothing reachable from this
// screen posts or reverses them — so the screen must not offer a write it
// cannot honour, and must not call itself a ledger. Adding, editing or deleting
// a row here moved this list and left the General Ledger, trial balance and
// financial statements on a different number. SCRUM-53.
export function AccountingModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const notice = useThemedStyles(makeNoticeStyles);
  const { locale } = useLocale();
  const isArabic = locale === "ar";
  const { loadMore, results, status } = usePaginatedQuery(
    api.transactions.list,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );

  return (
    <ModuleList
      data={results}
      emptyLabel={isArabic ? "لا توجد حركات نقدية." : "No cash movements found."}
      keyExtractor={(transaction) => transaction._id}
      loadMore={loadMore}
      status={status}
      header={
        <View style={notice.banner} testID="cash-movements-notice">
          <Text style={notice.title}>
            {isArabic
              ? "حركات نقدية — للعرض فقط، وليست دفتر الأستاذ العام"
              : "Cash movements — view only, not the General Ledger"}
          </Text>
          <Text style={notice.body}>
            {isArabic
              ? "تُسجَّل القيود المحاسبية من العملية التي تخصها أو من قيد يدوي معتمد."
              : "Accounting entries are posted by the operation that owns them, or by an approved manual journal."}
          </Text>
        </View>
      }
      renderItem={(transaction: MobileLedgerTransaction) => (
        <RecordCard>
          <View style={styles.recordHeader} testID={`cash-movement-${transaction._id}`}>
            <Text style={styles.recordTitle}>{transaction.description}</Text>
            <Text style={styles.statusPill}>{transaction.type}</Text>
          </View>
          <Text style={styles.recordMeta}>{transaction.category} · {dateLabel(transaction.date, locale)}</Text>
          <Text style={styles.recordMeta}>{money(transaction.amount, locale)} · {transaction.vehicleLabel || transaction.customerName || "-"}</Text>
        </RecordCard>
      )}
    />
  );
}

// A caution surface, deliberately unlike `recordCard`: a reader scanning the
// list must not mistake the standing caveat for one more cash movement. The
// rule sits on the inline start edge so it stays leading in Arabic RTL.
const makeNoticeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    banner: {
      gap: theme.spacing.xs,
      borderRadius: theme.radius.md,
      borderStartWidth: 3,
      borderStartColor: theme.colors.warning,
      backgroundColor: theme.colors.warningSoft,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    title: {
      color: theme.colors.text,
      fontSize: 14,
      fontWeight: "700",
    },
    body: {
      color: theme.colors.mutedText,
      fontSize: 13,
      lineHeight: 19,
    },
  });
