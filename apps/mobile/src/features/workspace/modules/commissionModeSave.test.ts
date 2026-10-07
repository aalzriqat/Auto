import { saveSettingsThenCommissionMode } from "./commissionModeSave";

describe("SCRUM-778: saving settings and the commission mode together", () => {
  test("refused settings leave the commission mode untouched", async () => {
    const setCommissionMode = jest.fn(async () => "id");
    const saveSettings = jest.fn(async () => {
      throw new Error("Reservation hold days must be at least 1");
    });

    await expect(
      saveSettingsThenCommissionMode({
        saveSettings,
        setCommissionMode,
        currentMode: undefined,
        selectedMode: "AUTO_MEMBER",
      })
    ).rejects.toThrow("Reservation hold days");
    expect(setCommissionMode).not.toHaveBeenCalled();
  });

  test("a deliberate mode change is saved after the settings", async () => {
    const calls: string[] = [];
    const result = await saveSettingsThenCommissionMode({
      saveSettings: async () => calls.push("settings"),
      setCommissionMode: async (mode) => calls.push(`mode:${mode}`),
      currentMode: "MANUAL",
      selectedMode: "AUTO_TIERS",
    });

    expect(result).toBe("saved");
    expect(calls).toEqual(["settings", "mode:AUTO_TIERS"]);
  });

  test("an unchanged mode is not resent", async () => {
    const setCommissionMode = jest.fn(async () => "id");
    const result = await saveSettingsThenCommissionMode({
      saveSettings: async () => undefined,
      setCommissionMode,
      currentMode: undefined,
      selectedMode: "MANUAL",
    });

    expect(result).toBe("saved");
    expect(setCommissionMode).not.toHaveBeenCalled();
  });

  test("a refused mode change after saved settings is reported, not hidden", async () => {
    const result = await saveSettingsThenCommissionMode({
      saveSettings: async () => undefined,
      setCommissionMode: async () => {
        throw new Error("Only the owner can change the commission mode");
      },
      currentMode: "MANUAL",
      selectedMode: "AUTO_MEMBER",
    });

    expect(result).toBe("settingsSavedModeFailed");
  });
});
