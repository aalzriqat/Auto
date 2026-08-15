import { usePaginatedQuery } from "convex/react";
import { Text, View } from "react-native";
import { api, type MobileLedgerTransaction } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, money, dateLabel, RecordCard, ModuleList } from "./moduleShared";
import { useStyles } from "./moduleStyles";

/**
 * SCRUM-53 — read-only, and no longer calling itself the ledger.
 *
 * This screen used to offer Add / Edit / Delete over `api.transactions.*` and
 * label the rows "قيود" / "ledger entries". `convex/transactions.ts` is the
 * operational CASHBOOK, not the authoritative ledger: none of those mutations
 * posts an accounting event, checks the accounting period, writes
 * `financialAuditLog`, or reverses a GL posting. The official Trial Balance,
 * P&L and Balance Sheet are built from `journalEntries` + `journalLines`.
 *
 * So a finance user could "correct" cash, revenue, a partner draw or a claim
 * from their phone, watch it succeed, and the real books would keep the old
 * number with nothing on screen indicating which was right. That is a false
 * second set of books, produced by a supported action.
 *
 * The writes are gone rather than merely hidden — the mutations were reachable
 * from here and nowhere else in the product. New financial activity has to come
 * from the real domain workflow (a sale, an expense, a collection, a deposit),
 * each of which already inserts its own cashbook row, or from an explicit
 * manual journal. Editing a row the GL has already represented is refused by
 * the server as well (`assertNotRepresentedInGl`), so removing the buttons is
 * the second line of defence and not the only one.
 */
export function AccountingModule({ orgId }: { orgId: string }) {
  const styles = useStyles();
  const { locale } = useLocale();
  const { loadMore, results, status } = usePaginatedQuery(
    api.transactions.list,
    { orgId },
    { initialNumItems: PAGE_SIZE }
  );

  return (
    <ModuleList
      data={results}
      emptyLabel={locale === "ar" ? "لا توجد حركات نقدية." : "No cash movements found."}
      keyExtractor={(transaction) => transaction._id}
      loadMore={loadMore}
      status={status}
      header={
        <View style={styles.actionRow}>
          {/* Names the screen for what it is. "Ledger entries" invited the
              reader to believe these rows were the general ledger, which is
              the whole defect — the GL is journalEntries/journalLines. */}
          <Text style={styles.recordMeta}>
            {locale === "ar"
              ? "سجل الحركات النقدية (للعرض فقط) — ليس دفتر الأستاذ العام"
              : "Cash movements (view only) — not the general ledger"}
          </Text>
        </View>
      }
      renderItem={(transaction: MobileLedgerTransaction) => (
        <RecordCard>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{transaction.description}</Text>
            <Text style={styles.statusPill}>{transaction.type}</Text>
          </View>
          <Text style={styles.recordMeta}>
            {transaction.category} · {dateLabel(transaction.date, locale)}
          </Text>
          <Text style={styles.recordMeta}>
            {money(transaction.amount, locale)} ·{" "}
            {transaction.vehicleLabel || transaction.customerName || "-"}
          </Text>
        </RecordCard>
      )}
    />
  );
}
