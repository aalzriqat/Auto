export type MobileCommissionModeValue = "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL";

export type SettingsWithModeSaveResult = "saved" | "settingsSavedModeFailed";

/**
 * SCRUM-778: a mobile form that saves settings and the commission mode with
 * one button. The mode has its own door (`setCommissionMode`), so the two are
 * separate mutations. The other settings save first: if they are refused, the
 * error propagates and the mode is never touched, so a failed save cannot
 * switch an org onto automatic commissions. If the settings save and the mode
 * change is then refused, the caller is told exactly that.
 */
export async function saveSettingsThenCommissionMode({
  saveSettings,
  setCommissionMode,
  currentMode,
  selectedMode,
}: {
  saveSettings: () => Promise<unknown>;
  setCommissionMode: (mode: MobileCommissionModeValue) => Promise<unknown>;
  currentMode: MobileCommissionModeValue | undefined;
  selectedMode: MobileCommissionModeValue;
}): Promise<SettingsWithModeSaveResult> {
  await saveSettings();
  if (selectedMode === (currentMode ?? "MANUAL")) return "saved";
  try {
    await setCommissionMode(selectedMode);
  } catch (error) {
    console.error("Commission mode change failed after settings saved", error);
    return "settingsSavedModeFailed";
  }
  return "saved";
}

export function saveResultMessage(result: SettingsWithModeSaveResult, locale: string): string {
  if (result === "settingsSavedModeFailed") {
    return locale === "ar"
      ? "تم حفظ الإعدادات، لكن لم يتغير نظام العمولة."
      : "Settings saved, but the commission mode was not changed.";
  }
  return locale === "ar" ? "تم الحفظ" : "Saved";
}
