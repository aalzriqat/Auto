"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export type PushSupportState = "unsupported" | "no-vapid-key" | "default" | "granted" | "denied";

/** VAPID public keys are base64url; pushManager.subscribe() needs raw bytes. */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Manages this device's Web Push subscription for the active org. Registers
 * /sw.js on mount (cheap/idempotent — the browser no-ops a repeat call with
 * the same script URL) but never requests notification permission or
 * subscribes without an explicit user action, since browsers ignore/penalize
 * permission prompts that aren't tied to a user gesture.
 */
export function usePushNotifications(orgId: Id<"organizations"> | null) {
  const [state, setState] = useState<PushSupportState>("unsupported");
  const [busy, setBusy] = useState(false);

  const subscribeMutation = useMutation(api.pushSubscriptions.subscribe);
  const unsubscribeMutation = useMutation(api.pushSubscriptions.unsubscribe);

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // Deliberately deferred to an effect rather than computed during render:
  // browser/Notification support can't be evaluated during SSR, so the
  // "unsupported" default must render first and this syncs the real value in
  // after mount — computing it inline would produce a client/server mismatch.
  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;

    let next: PushSupportState;
    if (!supported) {
      next = "unsupported";
    } else if (!vapidPublicKey) {
      next = "no-vapid-key";
    } else {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
      next = Notification.permission === "granted" ? "granted" : Notification.permission === "denied" ? "denied" : "default";
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
  }, [vapidPublicKey]);

  const syncSubscription = useCallback(
    async (subscription: PushSubscription) => {
      if (!orgId) return;
      const json = subscription.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) return;
      await subscribeMutation({
        orgId,
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        userAgent: navigator.userAgent,
      });
    },
    [orgId, subscribeMutation]
  );

  // Keeps Convex in sync with whatever subscription the browser currently
  // considers current — covering both a fresh foreground load (row's
  // lastSeenAt/keys refreshed) and the aftermath of a `pushsubscriptionchange`
  // event, where the service worker already re-subscribed at the platform
  // level but had no way to persist the new endpoint itself (no Convex auth
  // context inside a service worker — see public/sw.js).
  useEffect(() => {
    if (state !== "granted" || !orgId) return;
    (async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await syncSubscription(subscription);
    })();
  }, [state, orgId, syncSubscription]);

  const enable = useCallback(async () => {
    if (!orgId || !vapidPublicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setState(permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default");
      if (permission !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }));

      await syncSubscription(subscription);
    } finally {
      setBusy(false);
    }
  }, [orgId, vapidPublicKey, syncSubscription]);

  const disable = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeMutation({ orgId, endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
    } finally {
      setBusy(false);
    }
  }, [orgId, unsubscribeMutation]);

  return { state, busy, enable, disable };
}
