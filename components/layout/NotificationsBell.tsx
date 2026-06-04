"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useUser } from "@clerk/nextjs";
import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Id } from "@/convex/_generated/dataModel";

export function NotificationsBell() {
  const { activeOrgId } = useOrg();
  const { user } = useUser();

  const memberships = useQuery(api.memberships.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const membership = memberships?.find(m => m.userEmail === user?.primaryEmailAddress?.emailAddress);
  const localUserId = membership?.userId;

  const notifications = useQuery(
    api.notifications.list,
    activeOrgId && localUserId ? { orgId: activeOrgId, userId: localUserId } : "skip"
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

  const handleMarkAsRead = async (id: Id<"notifications">) => {
    try {
      await markAsRead({ notificationId: id });
    } catch (e) {
      console.error(e);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (!activeOrgId || !localUserId) return;
    try {
      await markAllAsRead({ orgId: activeOrgId, userId: localUserId });
      toast.success("All notifications marked as read");
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(!open)}>
        <Bell className="h-5 w-5 text-muted-foreground" />
        {unreadCount > 0 && (
          <Badge 
            variant="destructive" 
            className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-[10px]"
          >
            {unreadCount}
          </Badge>
        )}
      </Button>
      
      {open && (
        <div className="absolute right-0 bottom-12 mb-2 w-80 bg-background border rounded-md shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-card">
            <h4 className="font-semibold text-sm">Notifications</h4>
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={handleMarkAllAsRead}>
                Mark all as read
              </Button>
            )}
          </div>
          
          <div className="max-h-80 overflow-y-auto">
            {notifications === undefined ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">No notifications.</div>
            ) : (
              <div className="flex flex-col">
                {notifications.map((notif) => (
                  <div 
                    key={notif._id} 
                    className={`flex items-start gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors ${!notif.isRead ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''}`}
                  >
                    <div className="flex-1 space-y-1">
                      <p className={`text-sm font-medium leading-none ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {notif.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {notif.message}
                      </p>
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
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
