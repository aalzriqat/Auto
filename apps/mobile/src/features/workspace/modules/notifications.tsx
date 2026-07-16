import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Text, View } from "react-native";
import { renderNotification } from "../../../../../../lib/notifications/render";
import { api, type MobileNotification } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { DetailPill, PAGE_SIZE, compactNumber, useGenericError, PrimaryButton, RecordCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

function priorityLabel(priority: string | undefined, locale: "en" | "ar"): string {
  if (priority === "urgent") return locale === "ar" ? "عاجل" : "Urgent";
  if (priority === "low") return locale === "ar" ? "منخفض" : "Low";
  return locale === "ar" ? "عادي" : "Normal";
}

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
      renderItem={(notification: MobileNotification) => {
        const rendered = renderNotification(
          locale,
          notification.type ?? "",
          notification.data as Record<string, string | number> | undefined,
        );
        const title = notification.title || rendered.title || (locale === "ar" ? "إشعار" : "Notification");
        const message = notification.message || rendered.message;

        return (
        <RecordCard>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle}>{title}</Text>
            <Text style={styles.statusPill}>{notification.isRead ? (locale === "ar" ? "مقروء" : "Read") : (locale === "ar" ? "جديد" : "New")}</Text>
          </View>
          {message ? <Text style={styles.recordMeta}>{message}</Text> : null}
          <DetailPill label={priorityLabel(notification.priority, locale)} tone={notification.priority === "urgent" ? "warning" : "neutral"} />
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
        );
      }}
    />
  );
}
