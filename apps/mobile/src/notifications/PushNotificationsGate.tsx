import { useAuth } from "@clerk/expo";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, type ReactNode } from "react";

import { api } from "../convexApi";
import { parseNotificationLink } from "./pushLink";
import { registerForPushNotificationsAsync } from "./pushSetup";

/**
 * Registers this device for push once the user is signed in (so the token can
 * be attributed to their account), and routes a tapped notification to its
 * in-app link. Renders its children untouched — it's a side-effect gate, not a
 * visual one. All failures are swallowed: push is a nice-to-have and must never
 * block the app from rendering.
 */
export function PushNotificationsGate({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const registerToken = useMutation(api.mobilePushTokens.register);
  const hasRegistered = useRef(false);

  useEffect(() => {
    if (!isSignedIn || hasRegistered.current) return;
    hasRegistered.current = true;

    void registerForPushNotificationsAsync()
      .then((registration) => {
        if (!registration) return;
        return registerToken({ token: registration.token, platform: registration.platform });
      })
      .catch((error: unknown) => {
        console.error("Push registration failed", error);
      });
  }, [isSignedIn, registerToken]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const link = parseNotificationLink(response.notification.request.content.data);
      if (link) {
        // expo-router's typed routes can't know these runtime paths; the link
        // is validated to be a same-app absolute path in parseNotificationLink.
        router.push(link as never);
      }
    });
    return () => subscription.remove();
  }, [router]);

  return <>{children}</>;
}
