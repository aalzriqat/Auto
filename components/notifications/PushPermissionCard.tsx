"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BellRing } from "lucide-react";

/**
 * Lets the user opt this specific device into Web Push. Deliberately
 * separate from the per-category Push toggles below it: those control
 * *which* notifications get pushed once a device is enabled, this controls
 * whether the device receives push at all (the browser permission prompt +
 * subscription).
 */
export function PushPermissionCard({ orgId }: { orgId: Id<"organizations"> }) {
  const { t } = useLanguage();
  const { state, busy, enable, disable } = usePushNotifications(orgId);
  const devices = useQuery(api.pushSubscriptions.listMyDevices, { orgId });

  const isIos = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  const stateLabel =
    state === "granted"
      ? t("NotificationsPushStateGranted" as any)
      : state === "denied"
        ? t("NotificationsPushStateDenied" as any)
        : state === "unsupported"
          ? t("NotificationsPushStateUnsupported" as any)
          : state === "no-vapid-key"
            ? t("NotificationsPushStateNoVapidKey" as any)
            : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4" />
          {t("NotificationsPushTitle" as any)}
        </CardTitle>
        <CardDescription>{t("NotificationsPushDescription" as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === "granted" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={disable}>
            {t("NotificationsPushDisableButton" as any)}
          </Button>
        ) : state === "default" ? (
          <Button size="sm" disabled={busy} onClick={enable}>
            {t("NotificationsPushEnableButton" as any)}
          </Button>
        ) : null}

        {stateLabel && state !== "default" && (
          <p className="text-xs text-muted-foreground">{stateLabel}</p>
        )}

        {isIos && state !== "granted" && (
          <p className="text-xs text-muted-foreground">{t("NotificationsPushIosHint" as any)}</p>
        )}

        {devices && devices.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium mb-1.5">{t("NotificationsPushDevicesTitle" as any)}</p>
            <ul className="space-y-1">
              {devices.map((d) => (
                <li key={d._id} className="text-xs text-muted-foreground flex items-center justify-between gap-2">
                  <span className="truncate">{d.deviceName || d.userAgent || d._id}</span>
                  <span>{d.enabled ? "✓" : "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
