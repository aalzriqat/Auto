"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { renderNotification } from "@/lib/notifications/render";
import { CATEGORY_ICONS } from "@/lib/notifications/icons";

export function NotificationsBell() {
  const { t, locale } = useLanguage();
  const { activeOrgId } = useOrg();
  const notifications = useQuery(
    api.notifications.list,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownRef]);

  const unreadCount = notifications?.filter(n => !n.isRead).length || 0;
  const prevUnreadCountRef = useRef(unreadCount);

  useEffect(() => {
    if (unreadCount > prevUnreadCountRef.current) {
      // Play an awesome notification chime
      try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioContext();

        const playTone = (freq: number, startTime: number, duration: number) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startTime);

          gain.gain.setValueAtTime(0, startTime);
          gain.gain.linearRampToValueAtTime(0.4, startTime + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + duration);
        };

        // Play a rising two-tone chime (A5 then C#6)
        playTone(880.00, ctx.currentTime, 0.5); // A5
        playTone(1108.73, ctx.currentTime + 0.12, 0.8); // C#6
      } catch (e) {
        console.error("Audio playback failed", e);
      }
    }
    prevUnreadCountRef.current = unreadCount;
  }, [unreadCount]);

  const handleMarkAsRead = async (id: Id<"notifications">) => {
    if (!activeOrgId) return;
    try {
      await markAsRead({ orgId: activeOrgId, notificationId: id });
    } catch (e) {
      console.error(e);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (!activeOrgId) return;
    try {
      await markAllAsRead({ orgId: activeOrgId });
      toast.success(t("SaveChanges" as any) || "All notifications marked as read");
    } catch (e) {
      console.error(e);
    }
  };

  const handleNotificationClick = async (notif: any) => {
    if (!notif.isRead) {
      await handleMarkAsRead(notif._id);
    }
    setOpen(false);
  };

  const formatTime = (ts: number) => {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const diff = (ts - Date.now()) / 1000;

    if (Math.abs(diff) < 60) return t("JustNow" as any);
    if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return new Date(ts).toLocaleDateString();
  };

  // Typed notifications render bilingually via the shared registry; legacy
  // rows (pre-dating the type/category/data fields) fall back to their
  // stored plain-text title/message.
  const renderNotif = (notif: { type?: string; data?: any; title?: string; message?: string }) => {
    if (notif.type) {
      return renderNotification(locale, notif.type, notif.data);
    }
    return { title: notif.title ?? "", message: notif.message ?? "" };
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(!open)}>
        <Bell className="h-5 w-5 text-muted-foreground" />
        {unreadCount > 0 && (
          <Badge
            variant="destructive"
            className="absolute -top-1 -end-1 h-5 w-5 flex items-center justify-center p-0 text-[10px]"
          >
            {unreadCount}
          </Badge>
        )}
      </Button>

      {open && (
        <div className="absolute end-0 top-12 mt-2 w-80 bg-background border rounded-md shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-card">
            <h4 className="font-semibold text-sm">{t("Notifications")}</h4>
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={handleMarkAllAsRead}>
                {t("MarkAllRead")}
              </Button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications === undefined ? (
              <div className="p-4 text-center text-sm text-muted-foreground">{t("Loading")}</div>
            ) : notifications.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">{t("NoNotifications")}</div>
            ) : (
              <div className="flex flex-col">
                {notifications.map((notif) => {
                  const { title, message } = renderNotif(notif);
                  const CategoryIcon = notif.category ? CATEGORY_ICONS[notif.category as keyof typeof CATEGORY_ICONS] : undefined;
                  return (
                    <div
                      key={notif._id}
                      className={`flex items-start gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors ${!notif.isRead ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}`}
                    >
                      {CategoryIcon && (
                        <CategoryIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-sm font-medium leading-none ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {notif.link ? (
                              <Link href={notif.link} onClick={() => handleNotificationClick(notif)} className="hover:underline">
                                {title}
                              </Link>
                            ) : (
                              title
                            )}
                          </p>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {formatTime(notif._creationTime)}
                          </span>
                        </div>
                        {message && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {message}
                          </p>
                        )}
                      </div>
                      {!notif.isRead && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-full shrink-0"
                          onClick={(e) => { e.stopPropagation(); handleMarkAsRead(notif._id); }}
                        >
                          <Check className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {activeOrgId && (
            <Link
              href={`/${activeOrgId}/notifications`}
              onClick={() => setOpen(false)}
              className="block text-center text-xs font-medium text-primary py-2.5 border-t bg-card hover:bg-muted/50 transition-colors"
            >
              {t("NotificationsInbox" as any)}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
