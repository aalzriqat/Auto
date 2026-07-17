import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

// Foreground presentation: show the banner + list entry and play a sound, but
// don't touch the app badge (we don't maintain an unread badge count on the
// icon yet). Set at module load so it's in place before any notification lands.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushRegistration = { token: string; platform: "IOS" | "ANDROID" };

function resolveProjectId(): string | undefined {
  // eas init writes extra.eas.projectId; the EXPO_PUBLIC_EAS_PROJECT_ID env var
  // is the manual fallback wired in app.config.ts.
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

/**
 * Requests the OS notification permission and, if granted, returns this
 * device's Expo push token. Returns null (never throws) whenever push can't be
 * set up — a simulator, a denied permission, or a missing EAS project id — so
 * the caller can treat "no token" uniformly. Android also needs a notification
 * channel before anything can be shown.
 */
export async function registerForPushNotificationsAsync(): Promise<PushRegistration | null> {
  if (!Device.isDevice) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    granted = (await Notifications.requestPermissionsAsync()).granted;
  }
  if (!granted) return null;

  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn("Skipping Expo push token: no EAS projectId (run `eas init` or set EXPO_PUBLIC_EAS_PROJECT_ID).");
    return null;
  }

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: data, platform: Platform.OS === "ios" ? "IOS" : "ANDROID" };
  } catch (error) {
    console.error("Failed to fetch Expo push token", error);
    return null;
  }
}
