import * as Updates from "expo-updates";

/**
 * Checks the OTA server for a newer JS bundle and, if one is available,
 * downloads it and reloads into it. This is what removes the "reinstall / can't
 * connect on every push" pain for JavaScript changes — the app self-updates on
 * launch with no Metro and no APK.
 *
 * No-ops in development and whenever expo-updates is disabled (no configured
 * update URL — see app.config.ts). Never throws: a failed or offline update
 * check must never block the app from starting. NOTE: OTA ships JS/assets only;
 * native changes still require a fresh APK (that's the APK-fallback path).
 */
export async function checkForOtaUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return;

  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return;
    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
  } catch (error) {
    console.error("OTA update check failed", error);
  }
}
