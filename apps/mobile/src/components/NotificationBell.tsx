import { nativeRoutes } from "@autoflow/shared";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { renderNotification } from "../../../../lib/notifications/render";
import { api, type MobileNotification } from "../convexApi";
import { relativeTimeLabel, useGenericError } from "../features/workspace/modules/moduleShared";
import { getNativeModule, nativeModulePath, type NativeModuleId } from "../features/workspace/nativeModules";
import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";
import { Icon } from "./Icon";

const PREVIEW_COUNT = 8;

/**
 * Web notification links are always `/{orgId}/{moduleSegment}` with an
 * optional `?highlightId=` query param (see convex/**\/*.ts's `notifyUser`
 * call sites). Mirrors that shape into a native module route so tapping a
 * notification lands on the same screen + row the web bell would.
 */
export function parseNotificationLink(
  link: string | undefined,
  orgId: string,
): { moduleId: NativeModuleId; highlightId?: string } | null {
  if (!link) return null;

  const prefix = `/${orgId}/`;
  if (!link.startsWith(prefix)) return null;

  const [segment, queryString] = link.slice(prefix.length).split("?");
  if (!getNativeModule(segment)) return null;

  const highlightPair = queryString?.split("&").find((pair) => pair.startsWith("highlightId="));
  const highlightId = highlightPair ? decodeURIComponent(highlightPair.slice("highlightId=".length)) : undefined;

  return { moduleId: segment as NativeModuleId, highlightId };
}

export function getBellPressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

export function getRowPressedStyle(pressed: boolean) {
  return pressed ? styles.rowPressed : null;
}

function renderedCopy(notification: MobileNotification, locale: "en" | "ar") {
  const rendered = renderNotification(
    locale,
    notification.type ?? "",
    notification.data as Record<string, string | number> | undefined,
  );
  return {
    title: notification.title || rendered.title || (locale === "ar" ? "إشعار" : "Notification"),
    message: notification.message || rendered.message,
  };
}

export function NotificationBell({ orgId }: Readonly<{ orgId: string }>) {
  const router = useRouter();
  const { locale, textDirection } = useLocale();
  const reportError = useGenericError();
  const [open, setOpen] = useState(false);
  const unreadCount = useQuery(api.notifications.unreadCount, { orgId });
  const notifications = useQuery(api.notifications.list, open ? { orgId } : "skip");
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const badgeCount = unreadCount ?? 0;
  const preview = (notifications ?? []).slice(0, PREVIEW_COUNT);

  const close = () => setOpen(false);

  const viewAll = () => {
    close();
    router.push({ pathname: nativeRoutes.orgFinance, params: { orgId, segment: "alerts" } });
  };

  async function handleMarkAllRead() {
    try {
      await markAllAsRead({ orgId });
    } catch (error) {
      reportError("Mobile notification bell mark all failed", error);
    }
  }

  async function handleRowPress(notification: MobileNotification) {
    if (!notification.isRead) {
      try {
        await markAsRead({ orgId, notificationId: notification._id });
      } catch (error) {
        reportError("Mobile notification bell mark read failed", error);
      }
    }

    const target = parseNotificationLink(notification.link, orgId);
    if (!target) return;

    close();
    router.push({
      pathname: nativeModulePath(target.moduleId),
      params: target.highlightId
        ? { orgId, moduleId: target.moduleId, highlightId: target.highlightId }
        : { orgId, moduleId: target.moduleId },
    });
  }

  return (
    <>
      <Pressable
        accessibilityLabel={locale === "ar" ? "الإشعارات" : "Notifications"}
        accessibilityRole="button"
        style={({ pressed }) => [styles.bellButton, getBellPressedStyle(pressed)]}
        onPress={() => setOpen(true)}
      >
        <Icon color="text" name="notifications" size={20} />
        {badgeCount > 0 ? (
          <View style={styles.badge}>
            <Text numberOfLines={1} style={styles.badgeText}>{badgeCount > 9 ? "9+" : badgeCount}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal animationType="fade" transparent visible={open} onRequestClose={close}>
        <Pressable
          accessibilityLabel={locale === "ar" ? "إغلاق" : "Close"}
          style={styles.backdrop}
          onPress={close}
        />
        <View style={[styles.panel, { direction: textDirection }]}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>{locale === "ar" ? "الإشعارات" : "Notifications"}</Text>
            {badgeCount > 0 ? (
              <Pressable accessibilityRole="button" onPress={handleMarkAllRead}>
                <Text style={styles.markAllText}>
                  {locale === "ar" ? "تحديد الكل كمقروء" : "Mark all read"}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {notifications === undefined ? (
            <View style={styles.stateRow}>
              <Text style={styles.stateText}>{locale === "ar" ? "جارٍ التحميل..." : "Loading..."}</Text>
            </View>
          ) : preview.length === 0 ? (
            <View style={styles.stateRow}>
              <Text style={styles.stateText}>
                {locale === "ar" ? "لا توجد إشعارات." : "No notifications yet."}
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
              {preview.map((notification, index) => {
                const { title, message } = renderedCopy(notification, locale);
                return (
                  <Pressable
                    key={notification._id}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.row,
                      !notification.isRead && styles.rowUnread,
                      index < preview.length - 1 && styles.rowSeparator,
                      getRowPressedStyle(pressed),
                    ]}
                    onPress={() => handleRowPress(notification)}
                  >
                    {!notification.isRead ? <View style={styles.unreadDot} /> : null}
                    <View style={styles.rowText}>
                      <View style={styles.rowTitleLine}>
                        <Text numberOfLines={1} style={styles.rowTitle}>{title}</Text>
                        <Text style={styles.rowTime}>
                          {relativeTimeLabel(notification._creationTime, locale)}
                        </Text>
                      </View>
                      {message ? (
                        <Text numberOfLines={2} style={styles.rowMessage}>{message}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.viewAllButton, getRowPressedStyle(pressed)]}
            onPress={viewAll}
          >
            <Text style={styles.viewAllText}>{locale === "ar" ? "عرض الكل" : "View all"}</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
  pressed: {
    opacity: 0.82,
  },
  badge: {
    position: "absolute",
    top: -2,
    end: -2,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: 2,
    borderColor: theme.colors.surfaceAlt,
    backgroundColor: theme.colors.danger,
    paddingHorizontal: 3,
  },
  badgeText: {
    color: theme.colors.onPrimary,
    fontSize: 9,
    fontWeight: "700",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    bottom: 0,
    start: 0,
    end: 0,
    backgroundColor: "rgba(15, 23, 42, 0.35)",
  },
  panel: {
    position: "absolute",
    top: 64,
    start: theme.spacing.lg,
    end: theme.spacing.lg,
    maxHeight: 440,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
    ...theme.shadows.lg,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  panelTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  markAllText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "600",
  },
  stateRow: {
    padding: theme.spacing.xl,
    alignItems: "center",
  },
  stateText: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  list: {
    maxHeight: 340,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  rowUnread: {
    backgroundColor: theme.colors.infoSoft,
  },
  rowSeparator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  rowPressed: {
    opacity: 0.7,
  },
  unreadDot: {
    marginTop: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.info,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  rowTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  rowTime: {
    color: theme.colors.subtleText,
    fontSize: 11,
  },
  rowMessage: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  viewAllButton: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.surfaceMuted,
  },
  viewAllText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
});
