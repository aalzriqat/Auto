/**
 * Haptic feedback, guarded.
 *
 * expo-haptics is a NATIVE module. An OTA update can deliver this JavaScript to
 * a binary that predates it, where both importing the module and calling into
 * it throw. Every call site here is decoration on top of an action that has
 * already happened, so the correct behaviour when the module is missing is to
 * do nothing at all — never to interrupt the action.
 *
 * Restraint is deliberate: haptics punctuate meaningful state changes
 * (a record saved, a deal reaching a terminal stage, a refresh completing).
 * Firing on every tap turns feedback into noise and drains the battery.
 */

type HapticsModule = {
  impactAsync: (style: string) => Promise<void>;
  notificationAsync: (type: string) => Promise<void>;
  ImpactFeedbackStyle: { Light: string; Medium: string; Heavy: string };
  NotificationFeedbackType: { Success: string; Warning: string; Error: string };
};

let cached: HapticsModule | null | undefined;

/** Resolves the native module once. `null` means "not in this binary". */
export function loadHaptics(): HapticsModule | null {
  if (cached !== undefined) {
    return cached;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-haptics") as HapticsModule;
  } catch (error) {
    console.error("expo-haptics is unavailable in this build", error);
    cached = null;
  }

  return cached;
}

/** Test seam: forget the resolved module. */
export function resetHapticsCache() {
  cached = undefined;
}

/**
 * Runs a haptic and absorbs every way it can fail: a native-module proxy whose
 * backing module is gone throws SYNCHRONOUSLY on access, and the call itself can
 * reject. Both end here, logged and no further — a haptic must never surface to
 * the user or block the action that triggered it.
 */
async function run(invoke: (haptics: HapticsModule) => Promise<void>) {
  const haptics = loadHaptics();
  if (!haptics) return;

  try {
    await invoke(haptics);
  } catch (error) {
    console.error("Haptic feedback failed", error);
  }
}

/** A confirmation landed — a record saved, an item added. */
export function hapticSuccess() {
  void run((haptics) => haptics.notificationAsync(haptics.NotificationFeedbackType.Success));
}

/** An action was refused — validation failed, a mutation was rejected. */
export function hapticWarning() {
  void run((haptics) => haptics.notificationAsync(haptics.NotificationFeedbackType.Warning));
}

/** A terminal, irreversible-feeling move — a deal won or lost, an archive. */
export function hapticImpact() {
  void run((haptics) => haptics.impactAsync(haptics.ImpactFeedbackStyle.Medium));
}

/** A pull-to-refresh reaching its trigger point. */
export function hapticSelection() {
  void run((haptics) => haptics.impactAsync(haptics.ImpactFeedbackStyle.Light));
}
