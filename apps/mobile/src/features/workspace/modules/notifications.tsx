import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Text, View } from "react-native";
import { api, type MobileNotification } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, compactNumber, useGenericError, PrimaryButton, RecordCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function NotificationsModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const unreadCount = useQuery(api.notifications.unreadCount, { orgId });
  const markRead = useMutation(api.notifications.markAsRead);
  const markAllRead = useMutation(api.notifications.markAllAsRead);
  const archive = useMutation(api.notifications.archive);
  const { loadMore, results, status } = usePaginatedQuery(
    api.notifications.listPage,
    { orgId },
    { initialNumItems: PAGE_SIZE },
  );

  async function act(context: string, action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      reportError(context, error);
    }
  }

  return (
    <ModuleList
      data={results}
      emptyLabel={locale === "ar" ? "لا توجد إشعارات." : "No notifications found."}
      keyExtractor={(notification) => notification._id}
      loadMore={loadMore}
      status={status}
      header={
        <View style={styles.actionRow}>
          <Text style={styles.sectionTitle}>
            {locale === "ar" ? "غير المقروء" : "Unread"}: {compactNumber(unreadCount ?? 0, locale)}
          </Text>
          <PrimaryButton
            label={locale === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}
            tone="muted"
            onPress={() => act("Mobile notifications mark all failed", () => markAllRead({ orgId }))}
          />
        </View>
      }
      renderItem={(notification: MobileNotification) => (
        <RecordCard>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>
              {notification.title || notification.type || (locale === "ar" ? "إشعار" : "Notification")}
            </Text>
            <Text style={styles.statusPill}>{notification.isRead ? (locale === "ar" ? "مقروء" : "Read") : (locale === "ar" ? "جديد" : "New")}</Text>
          </View>
          <Text style={styles.recordMeta}>{notification.message || notification.category || "-"}</Text>
          <Text style={styles.recordMeta}>{notification.priority || "normal"}</Text>
          <View style={styles.cardActions}>
            {!notification.isRead ? (
              <PrimaryButton
                label={locale === "ar" ? "مقروء" : "Mark read"}
                tone="muted"
                onPress={() => act("Mobile notification mark read failed", () => markRead({ orgId, notificationId: notification._id }))}
              />
            ) : null}
            <PrimaryButton
              label={locale === "ar" ? "أرشفة" : "Archive"}
              tone="danger"
              onPress={() => act("Mobile notification archive failed", () => archive({ orgId, notificationId: notification._id }))}
            />
          </View>
        </RecordCard>
      )}
    />
  );
}
