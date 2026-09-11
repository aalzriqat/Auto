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
  const { locale, textDirection } = useLocale();
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
        <View
          style={[notice.banner, { direction: textDirection }]}
          testID="cash-movements-notice"
        >
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
// list must not mistake the standing caveat for one more cash movement.
//
// The rule is a LOGICAL edge, and the banner carries its own `direction` taken
// from the app locale. Both halves are load-bearing, and each closes two of the
// four locale/native-layout combinations:
//
//   * a logical edge alone resolves against the NATIVE layout direction. This
//     app calls `allowRTL(true)` and never `forceRTL`, so an Arabic UI on an
//     English-locale device has `textDirection: "rtl"` while `I18nManager.isRTL`
//     is false — see `homeModel.ts`, which compensates for the same divergence.
//     `DEFAULT_LOCALE` is "ar", so that is the first-run case.
//   * a physical edge alone does NOT stay physical. Under native RTL, React
//     Native rewrites authored left/right into logical start/end before Yoga
//     runs — `YogaLayoutableShadowNode::swapLeftAndRightInYogaStyleProps` moves
//     `border(Edge::Left)` to `Edge::Start`, and `swapLeftAndRightInViewProps`
//     does the same for `borderColors.left`. It is on by default and this app
//     never calls `swapLeftAndRightInRTL(false)`.
//
// Declaring the direction on this node makes its own start edge resolve against
// the app locale in all four combinations, and leaves no authored left/right for
// the native swap to rewrite. Jest runs no Yoga, so the tests assert those two
// properties rather than the rendered edge; the rendered edge still wants a
// device check on an Arabic-locale phone.
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
