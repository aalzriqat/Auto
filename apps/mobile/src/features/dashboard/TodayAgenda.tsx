import { nativeRoutes } from "@autoflow/shared";
import { useQuery, usePaginatedQuery } from "convex/react";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { api, type MobileMyMembership } from "../../convexApi";
import { Card } from "../../components/Card";
import { Icon, type SemanticIconName } from "../../components/Icon";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";

const AGENDA_TASK_PAGE_SIZE = 25;

type AgendaTone = "warning" | "indigo" | "info";

const rowToneSoft: Record<AgendaTone, string> = {
  warning: theme.colors.warningSoft,
  indigo: theme.colors.indigoSoft,
  info: theme.colors.infoSoft,
};

function getTodayBounds(): { todayStart: number; todayEnd: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { todayStart: start.getTime(), todayEnd: end.getTime() };
}

type AgendaRow = Readonly<{
  key: string;
  icon: SemanticIconName;
  tone: AgendaTone;
  text: string;
  onPress: () => void;
}>;

export function TodayAgenda({
  orgId,
  myMembership,
}: Readonly<{ orgId: string; myMembership: MobileMyMembership }>) {
  const router = useRouter();
  const { locale, t, textDirection } = useLocale();
  const canApprove = myMembership.permissions.includes("approve:requests");

  const { results: myTasks } = usePaginatedQuery(
    api.tasks.list,
    { orgId, assignedTo: myMembership.userId, status: "PENDING" },
    { initialNumItems: AGENDA_TASK_PAGE_SIZE },
  );
  const unreadCount = useQuery(api.notifications.unreadCount, { orgId });
  const pendingApprovals = useQuery(
    api.approvals.listPendingApprovals,
    canApprove ? { orgId } : "skip",
  );

  const { todayStart, todayEnd } = getTodayBounds();
  const tasks = myTasks ?? [];
  const overdueCount = tasks.filter((task) => task.dueDate < todayStart).length;
  const dueTodayCount = tasks.filter(
    (task) => task.dueDate >= todayStart && task.dueDate <= todayEnd,
  ).length;
  const approvalsCount = pendingApprovals?.length ?? 0;

  const rows: AgendaRow[] = [];
  if (overdueCount > 0) {
    rows.push({
      key: "tasks-overdue",
      icon: "tasksFilled",
      tone: "warning",
      text: `${overdueCount} ${t("todayAgendaOverdueTasks")}`,
      onPress: () =>
        router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId: "tasks" } }),
    });
  } else if (dueTodayCount > 0) {
    rows.push({
      key: "tasks-due-today",
      icon: "tasksFilled",
      tone: "warning",
      text: `${dueTodayCount} ${t("todayAgendaDueTodayTasks")}`,
      onPress: () =>
        router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId: "tasks" } }),
    });
  }
  if (approvalsCount > 0) {
    rows.push({
      key: "approvals",
      icon: "approvalsFilled",
      tone: "indigo",
      text: `${approvalsCount} ${t("todayAgendaApprovalsWaiting")}`,
      onPress: () =>
        router.push({ pathname: nativeRoutes.orgModule, params: { orgId, moduleId: "approvals" } }),
    });
  }
  if ((unreadCount ?? 0) > 0) {
    rows.push({
      key: "notifications",
      icon: "notificationsFilled",
      tone: "info",
      text: `${unreadCount} ${t("todayAgendaUnreadNotifications")}`,
      onPress: () =>
        router.push({ pathname: nativeRoutes.orgFinance, params: { orgId, segment: "alerts" } }),
    });
  }

  const stillLoading =
    myTasks === undefined || unreadCount === undefined || (canApprove && pendingApprovals === undefined);

  if (stillLoading) {
    return null;
  }

  return (
    <Card style={styles.card}>
      {rows.length > 0 ? (
        <View style={[styles.rows, { direction: textDirection }]}>
          {rows.map((row, index) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.row,
                index < rows.length - 1 && styles.rowSeparator,
                pressed && styles.rowPressed,
              ]}
              onPress={row.onPress}
            >
              <View style={[styles.rowIconShell, { backgroundColor: rowToneSoft[row.tone] }]}>
                <Icon color={row.tone} name={row.icon} size={17} />
              </View>
              <Text numberOfLines={1} style={styles.rowText}>
                {row.text}
              </Text>
              <Icon color="subtleText" name={textDirection === "rtl" ? "back" : "chevronForward"} size={16} />
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={[styles.caughtUp, { direction: textDirection }]}>
          <View style={styles.caughtUpIconShell}>
            <Icon color="onPrimary" name="check" size={18} />
          </View>
          <View style={styles.caughtUpText}>
            <Text style={styles.caughtUpTitle}>{t("todayAgendaAllCaughtUpTitle")}</Text>
            <Text style={styles.caughtUpBody}>{t("todayAgendaAllCaughtUpBody")}</Text>
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 0,
    overflow: "hidden",
  },
  rows: {
    width: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  rowSeparator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  rowIconShell: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  rowText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  caughtUp: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.successSoft,
  },
  caughtUpIconShell: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.success,
  },
  caughtUpText: {
    flex: 1,
    minWidth: 0,
  },
  caughtUpTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  caughtUpBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
});
