import * as Updates from "expo-updates";

/**
 * Checks the OTA server for a newer JS bundle and, if one is available,
 * downloads it — but does NOT reload. The app keeps running the current bundle
 * so the user is never interrupted mid-task; the fetched update is then applied
 * either when the user taps "Update now" (see {@link reloadIntoOtaUpdate}) or
 * automatically on the next cold start (expo-updates activates an already
 * fetched update on launch).
 *
 * Returns `true` when a new bundle was downloaded and is ready to activate.
 * No-ops (returns `false`) in development and whenever expo-updates is disabled
 * (no configured update URL — see app.config.ts). Never throws: a failed or
 * offline check must never block the app from starting.
 *
 * NOTE: OTA ships JS/assets only; native changes still require a fresh APK
 * (that's the APK-fallback path).
 */
export async function fetchOtaUpdateIfAvailable(): Promise<boolean> {
  if (__DEV__ || !Updates.isEnabled) return false;

  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    return true;
  } catch (error) {
    console.error("OTA update check failed", error);
    return false;
  }
}

/**
 * Activates a previously fetched update by reloading the JS bundle in place.
 * The OS process is never killed, so from the user's side there's no "close and
 * reopen the app" — the screen just refreshes into the new version. Never
 * throws: a failed reload must not crash the app.
 */
export async function reloadIntoOtaUpdate(): Promise<void> {
  try {
    await Updates.reloadAsync();
  } catch (error) {
    console.error("OTA reload failed", error);
  }
}
