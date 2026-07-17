import { useQuery } from "convex/react";
import Constants from "expo-constants";
import { useEffect, useRef, type ReactNode } from "react";
import { Alert, Linking, Platform } from "react-native";

import { api } from "../convexApi";
import { useLocale } from "../providers/LocaleProvider";

function currentBuildNumber(): number {
  const extra = Constants.expoConfig?.extra as { buildNumber?: number } | undefined;
  return typeof extra?.buildNumber === "number" ? extra.buildNumber : 0;
}

/**
 * The APK-fallback half of the updater: when a NEW native build (not an OTA-able
 * JS change) is published, prompt the user to download it. Compares this app's
 * baked-in buildNumber against the newest published release for the platform;
 * downloading opens the signed APK URL in the browser, where the user taps to
 * install (a sideload-friendly flow that needs no install permission and works
 * on Play-less devices). A mandatory release offers only "Download".
 */
export function NativeUpdateGate({ children }: { children: ReactNode }) {
  const { t, locale } = useLocale();
  const platform = Platform.OS === "ios" ? "IOS" : "ANDROID";
  const release = useQuery(api.mobileReleases.getLatestRelease, {
    platform,
    currentBuildNumber: currentBuildNumber(),
  });
  const hasPrompted = useRef(false);

  useEffect(() => {
    if (!release?.updateAvailable || hasPrompted.current) return;
    hasPrompted.current = true;

    const notes = (locale === "ar" ? release.releaseNotesAr : release.releaseNotesEn) ?? "";
    const download = { text: t("nativeUpdateDownload"), onPress: () => void Linking.openURL(release.apkUrl) };
    const buttons = release.mandatory
      ? [download]
      : [{ text: t("nativeUpdateLater"), style: "cancel" as const }, download];

    Alert.alert(
      t("nativeUpdateTitle"),
      `${t("nativeUpdateBody")} (${release.versionName})${notes ? `\n\n${notes}` : ""}`,
      buttons,
      { cancelable: !release.mandatory },
    );
  }, [release, t, locale]);

  return <>{children}</>;
}
