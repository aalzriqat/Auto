"use client";

import { useState } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { Archive, Check, Bell } from "lucide-react";
import Link from "next/link";
import { renderNotification } from "@/lib/notifications/render";
import { CATEGORY_ICONS } from "@/lib/notifications/icons";
import { NOTIFICATION_CATEGORIES, NotificationCategory } from "@/lib/notifications/types";

const CATEGORY_LABEL_KEYS: Record<NotificationCategory, string> = {
  sales: "NotificationsCategorySales",
  inventory: "NotificationsCategoryInventory",
  finance: "NotificationsCategoryFinance",
  operations: "NotificationsCategoryOperations",
  team: "NotificationsCategoryTeam",
  social: "NotificationsCategorySocial",
  system: "NotificationsCategorySystem",
};

export default function NotificationsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  if (!activeOrgId) return null;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Bell className="h-5 w-5" />
        <h1 className="text-xl font-semibold">{t("Notifications")}</h1>
      </div>

      <Tabs defaultValue="inbox">
        <TabsList>
          <TabsTrigger value="inbox">{t("NotificationsInbox" as any)}</TabsTrigger>
          <TabsTrigger value="archive">{t("NotificationsArchive" as any)}</TabsTrigger>
          <TabsTrigger value="preferences">{t("NotificationsPreferences" as any)}</TabsTrigger>
        </TabsList>

        <TabsContent value="inbox">
          <NotificationsFeed orgId={activeOrgId} showArchived={false} />
        </TabsContent>
        <TabsContent value="archive">
          <NotificationsFeed orgId={activeOrgId} showArchived={true} />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesPanel orgId={activeOrgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NotificationsFeed({ orgId, showArchived }: { orgId: Id<"organizations">; showArchived: boolean }) {
  const { t, locale } = useLanguage();
  const [category, setCategory] = useState<NotificationCategory | undefined>(undefined);

  const { results, status, loadMore } = usePaginatedQuery(
    api.notifications.listPage,
    { orgId, category, showArchived },
    { initialNumItems: 20 }
  );

  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const archive = useMutation(api.notifications.archive);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            variant={category === undefined ? "default" : "outline"}
            onClick={() => setCategory(undefined)}
          >
            {t("NotificationsCategoryAll" as any)}
          </Button>
          {NOTIFICATION_CATEGORIES.map((cat) => (
            <Button
              key={cat}
              size="sm"
              variant={category === cat ? "default" : "outline"}
              onClick={() => setCategory(cat)}
            >
              {t(CATEGORY_LABEL_KEYS[cat] as any)}
            </Button>
          ))}
        </div>
        {!showArchived && (
          <Button size="sm" variant="ghost" onClick={() => markAllAsRead({ orgId })}>
            {t("NotificationsMarkAllRead" as any)}
          </Button>
        )}
      </div>

      <div className="border rounded-md divide-y">
        {results.length === 0 && status !== "LoadingFirstPage" && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("NotificationsEmptyState" as any)}
          </div>
        )}
        {results.map((notif) => {
          const rendered = notif.type ? renderNotification(locale, notif.type, notif.data) : { title: notif.title ?? "", message: notif.message ?? "" };
          const CategoryIcon = notif.category ? CATEGORY_ICONS[notif.category as NotificationCategory] : undefined;
          return (
            <div key={notif._id} className={`flex items-start gap-3 p-4 ${!notif.isRead ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}>
              {CategoryIcon && <CategoryIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {notif.link ? (
                    <Link href={notif.link} className="hover:underline" onClick={() => !notif.isRead && markAsRead({ orgId, notificationId: notif._id })}>
                      {rendered.title}
                    </Link>
                  ) : (
                    rendered.title
                  )}
                </p>
                {rendered.message && <p className="text-xs text-muted-foreground mt-1">{rendered.message}</p>}
                <p className="text-[10px] text-muted-foreground mt-1">{new Date(notif._creationTime).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!notif.isRead && (
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => markAsRead({ orgId, notificationId: notif._id })}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                )}
                {!showArchived && (
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => archive({ orgId, notificationId: notif._id })}>
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {status === "CanLoadMore" && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(20)}>
            {t("LoadMore" as any)}
          </Button>
        </div>
      )}
    </div>
  );
}

function PreferencesPanel({ orgId }: { orgId: Id<"organizations"> }) {
  const { t } = useLanguage();
  const preferences = useQuery(api.notificationPreferences.getMyPreferences, { orgId });
  const setPreference = useMutation(api.notificationPreferences.setPreference);
  const me = useQuery(api.users.getMe, {});
  const updateProfile = useMutation(api.users.updateMyNotificationProfile);

  const [whatsappPhone, setWhatsappPhone] = useState<string | undefined>(undefined);
  const phoneValue = whatsappPhone !== undefined ? whatsappPhone : (me?.whatsappPhone ?? "");

  const saveWhatsappPhone = async () => {
    await updateProfile({ whatsappPhone: phoneValue });
    toast.success(t("NotificationsPreferencesSaved" as any));
  };

  return (
    <div className="mt-4 space-y-6">
      <div className="space-y-1">
        <Label htmlFor="whatsapp-phone">{t("NotificationsWhatsappPhoneLabel" as any)}</Label>
        <div className="flex gap-2 max-w-sm">
          <Input
            id="whatsapp-phone"
            value={phoneValue}
            onChange={(e) => setWhatsappPhone(e.target.value)}
            placeholder="+971501234567"
          />
          <Button size="sm" onClick={saveWhatsappPhone}>{t("Save")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("NotificationsWhatsappPhoneHelp" as any)}</p>
      </div>

      <div className="border rounded-md divide-y">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 items-center px-4 py-2 text-xs font-medium text-muted-foreground">
          <span />
          <span>{t("NotificationsChannelEmail" as any)}</span>
          <span>{t("NotificationsChannelWhatsapp" as any)}</span>
        </div>
        {preferences === undefined
          ? null
          : preferences.map((pref) => {
              const CategoryIcon = CATEGORY_ICONS[pref.category as NotificationCategory];
              return (
                <div key={pref.category} className="grid grid-cols-[1fr_auto_auto] gap-4 items-center px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                    {t(CATEGORY_LABEL_KEYS[pref.category as NotificationCategory] as any)}
                  </div>
                  <Switch
                    checked={pref.emailEnabled}
                    onCheckedChange={(checked) =>
                      setPreference({ orgId, category: pref.category, emailEnabled: checked, whatsappEnabled: pref.whatsappEnabled })
                    }
                  />
                  <Switch
                    checked={pref.whatsappEnabled}
                    onCheckedChange={(checked) =>
                      setPreference({ orgId, category: pref.category, emailEnabled: pref.emailEnabled, whatsappEnabled: checked })
                    }
                  />
                </div>
              );
            })}
      </div>
    </div>
  );
}
