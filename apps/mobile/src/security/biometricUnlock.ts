import * as SecureStore from "expo-secure-store";

/**
 * Biometric unlock — LOCAL access control over an existing Clerk session.
 *
 * ## What this is, and what it deliberately is not
 *
 * A fingerprint is not an authentication factor as far as Clerk is concerned:
 * the backend never learns that one was presented, and a rooted device can
 * report "success" for free. So this module never treats a biometric result as
 * proof of identity, never sends it anywhere, and never stores the user's
 * password. The user signs in with Clerk once, normally; from then on this gate
 * decides whether the *already-established* session is handed back to whoever
 * is holding the phone. The threat it addresses is "someone picked up an
 * unlocked phone", not "someone is impersonating a user to the server".
 *
 * ## Why the gate is bound to an OS keystore item
 *
 * A gate that is only a JavaScript boolean gives one guarantee (a bystander
 * cannot get past it) and fakes another: it cannot tell that the phone's
 * fingerprint enrolment changed since the user opted in, so it keeps trusting a
 * finger that was added after the fact.
 *
 * So arming the gate writes a marker to `expo-secure-store` with
 * `requireAuthentication: true`, and unlocking READS that marker back. On
 * Android that generates an AES key in the AndroidKeyStore with
 * `setUserAuthenticationRequired(true)` (see expo-secure-store's
 * `AESEncryptor.initializeKeyStoreEntry`); on iOS it is a keychain item with
 * `biometryCurrentSet`. Two consequences, both of which we want:
 *
 * 1. The biometric check is performed by the OS on the way to the key material,
 *    not by us. Reading the marker is not something we can accidentally
 *    short-circuit.
 * 2. Enrolling a new fingerprint or re-registering a face permanently
 *    invalidates that key. expo-secure-store catches the resulting
 *    `KeyPermanentlyInvalidatedException` and RESOLVES WITH `null` rather than
 *    rejecting (`SecureStoreModule.readJSONEncodedItem`), which is exactly the
 *    signal we need: a `null` marker on an armed gate means "enrolment changed"
 *    and the gate disarms itself.
 *
 * The marker's *value* is not a secret and is not used as one — the security
 * property comes entirely from the key that has to be unwrapped to read it.
 *
 * ## Honest limits
 *
 * The Clerk session token itself still lives in Clerk's own (unauthenticated)
 * SecureStore cache, because that cache is read and rewritten on every token
 * refresh; putting `requireAuthentication` on it would demand a fingerprint
 * roughly once a minute on Android, where "user authentication is required for
 * all operations". So an attacker who can modify the app or read another app's
 * keychain is not stopped by this gate. Nobody holding an unlocked phone can do
 * either of those things, which is the population this feature is for.
 */

/** How the phone can prove the owner is present. Drives the prompt wording. */
export type BiometricKind = "face" | "fingerprint";

/**
 * Everything that can go wrong, in the exact granularity the UI needs. Each one
 * maps to its own message; none of them ever strands the user, because the lock
 * screen always offers a password sign-in alongside whatever this says.
 */
export type BiometricFailure =
  /** The native module is not in this binary (an OTA reached an older APK). */
  | "unsupported"
  /** No fingerprint reader / face camera at all. */
  | "noHardware"
  /** Hardware exists, nothing enrolled — offer to open system settings. */
  | "notEnrolled"
  /** The user dismissed the OS prompt. */
  | "cancelled"
  /** Too many attempts; the sensor is cooling down. */
  | "lockout"
  /** Too many attempts; needs a device PIN/pattern unlock to recover. */
  | "lockoutPermanent"
  /** Biometric enrolment changed since opt-in. The gate has disarmed itself. */
  | "enrolmentChanged"
  /** Anything else. Deliberately the fallback: unknown means "not unlocked". */
  | "failed";

export type UnlockResult = { ok: true } | { ok: false; reason: BiometricFailure };

export type BiometricAvailability =
  | { available: true; kind: BiometricKind }
  | { available: false; reason: Extract<BiometricFailure, "unsupported" | "noHardware" | "notEnrolled"> };

/**
 * Plain-flag storage: "the user opted in". Not a secret and not the gate — the
 * gate is the authenticated marker below. Flipping this by hand only causes the
 * lock screen to appear; it cannot make the keystore hand anything over.
 */
const ARMED_KEY = "autoflow-mobile-biometric-armed";

/** The keystore-bound marker. Its value carries no meaning; its readability does. */
const GATE_KEY = "autoflow-mobile-biometric-gate";
const GATE_MARKER = "armed";

/**
 * A dedicated keychain service so the authenticated key never shares an alias
 * with the app's ordinary SecureStore writes (locale, theme, Clerk's token
 * cache). expo-secure-store warns that `requireAuthentication` "would not work
 * in tandem with the keychainService value used for the other non-authenticated
 * operations".
 */
const GATE_KEYCHAIN_SERVICE = "autoflow-biometric-gate";

type AuthenticateOptions = {
  promptMessage?: string;
  cancelLabel?: string;
  fallbackLabel?: string;
  requireConfirmation?: boolean;
  disableDeviceFallback?: boolean;
};

type LocalAuthenticationModule = {
  hasHardwareAsync: () => Promise<boolean>;
  isEnrolledAsync: () => Promise<boolean>;
  supportedAuthenticationTypesAsync: () => Promise<number[]>;
  authenticateAsync: (
    options?: AuthenticateOptions,
  ) => Promise<{ success: true } | { success: false; error: string; warning?: string }>;
  AuthenticationType: { FINGERPRINT: number; FACIAL_RECOGNITION: number; IRIS: number };
};

let cachedModule: LocalAuthenticationModule | null | undefined;

/**
 * Resolves expo-local-authentication once. `null` means "not in this binary",
 * which is the normal state for every phone running the current APK: an OTA can
 * deliver this JavaScript to a build that has no such native module, where the
 * import itself throws. Mirrors `loadHaptics` / `resolveExpoImage`.
 */
export function loadLocalAuthentication(): LocalAuthenticationModule | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require("expo-local-authentication") as LocalAuthenticationModule;
  } catch (error) {
    console.error("expo-local-authentication is unavailable in this build", error);
    cachedModule = null;
  }

  return cachedModule;
}

/** Test seam: forget the resolved module. */
export function resetLocalAuthenticationCache() {
  cachedModule = undefined;
}

/**
 * Maps `authenticateAsync`'s error string onto our failure set.
 *
 * Note what Android CANNOT tell us: expo-local-authentication folds both
 * `BiometricPrompt.ERROR_LOCKOUT` and `ERROR_LOCKOUT_PERMANENT` into the single
 * string `"lockout"` (`LocalAuthenticationModule.convertErrorCode`). So this
 * returns the temporary variant, and the copy for it stays true for both by
 * telling the user to wait *or* fall back to their password. The permanent case
 * is only distinguishable through expo-secure-store — see
 * {@link classifySecureStoreError}.
 */
export function classifyLocalAuthError(error: string): BiometricFailure {
  switch (error) {
    case "user_cancel":
    case "app_cancel":
    case "system_cancel":
    case "user_fallback":
      return "cancelled";
    case "lockout":
      return "lockout";
    case "not_enrolled":
    case "passcode_not_set":
      return "notEnrolled";
    case "not_available":
      return "noHardware";
    default:
      return "failed";
  }
}

/**
 * The searchable text of a rejection, without ever falling back to a coerced
 * `String(value)`: an object with no `message` stringifies to "[object Object]",
 * which is not something to run substring matches against.
 */
function readErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * Maps an expo-secure-store rejection onto our failure set.
 *
 * These prefixes are not localized OS text — expo-secure-store builds the
 * message itself as `"$errorType. $errString"` from a fixed English enum in
 * `AuthenticationPrompt.convertErrorCode`, so matching on the prefix is stable.
 * It is also strictly better than expo-local-authentication here: it is the only
 * layer that distinguishes Android's temporary lockout from its permanent one.
 *
 * iOS surfaces `OSStatus` codes instead, so only cancellation (`-128`,
 * `errSecUserCanceled`) is recognised there; everything else lands on `failed`,
 * which is the safe direction — it keeps the app locked and shows the password
 * escape hatch.
 */
export function classifySecureStoreError(error: unknown): BiometricFailure {
  const message = readErrorText(error).toLowerCase();

  // Order matters: "lockout permanent" also contains "lockout".
  if (message.includes("lockout permanent")) return "lockoutPermanent";
  if (message.includes("lockout")) return "lockout";
  if (message.includes("cancel") || message.includes("-128")) return "cancelled";
  if (message.includes("no biometrics")) return "notEnrolled";
  if (message.includes("hardware not present") || message.includes("no hardware")) return "noHardware";
  return "failed";
}

/** Picks the wording for the OS prompt from what the phone actually offers. */
export function biometricKindFromTypes(
  types: readonly number[] | null | undefined,
  authenticationType: LocalAuthenticationModule["AuthenticationType"],
): BiometricKind {
  const supported = types ?? [];
  const facial =
    supported.includes(authenticationType.FACIAL_RECOGNITION) ||
    supported.includes(authenticationType.IRIS);
  return facial ? "face" : "fingerprint";
}

/**
 * Capability probe. Runs no prompt, so it is safe to call on render — the
 * settings screen uses it to decide whether to offer the toggle at all, and the
 * lock screen uses it to explain a failure before the OS gets a chance to.
 */
export async function getBiometricAvailability(): Promise<BiometricAvailability> {
  const auth = loadLocalAuthentication();
  if (!auth) {
    return { available: false, reason: "unsupported" };
  }

  try {
    if (!(await auth.hasHardwareAsync())) {
      return { available: false, reason: "noHardware" };
    }

    if (!(await auth.isEnrolledAsync())) {
      return { available: false, reason: "notEnrolled" };
    }

    const types = await auth.supportedAuthenticationTypesAsync();
    return { available: true, kind: biometricKindFromTypes(types, auth.AuthenticationType) };
  } catch (error) {
    console.error("Failed to read biometric capabilities", error);
    return { available: false, reason: "unsupported" };
  }
}

/** Has the user opted in on this device? Never throws; unknown means "no". */
export async function isBiometricUnlockArmed(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ARMED_KEY)) === "1";
  } catch (error) {
    console.error("Failed to read the biometric unlock preference", error);
    return false;
  }
}

/** Opting out clears BOTH the flag and the keystore-bound marker. */
export async function disarmBiometricUnlock(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(GATE_KEY, { keychainService: GATE_KEYCHAIN_SERVICE });
  } catch (error) {
    console.error("Failed to clear the biometric gate marker", error);
  }

  try {
    await SecureStore.deleteItemAsync(ARMED_KEY);
  } catch (error) {
    console.error("Failed to clear the biometric unlock preference", error);
  }
}

/**
 * Both prompt wordings, so the caller does not have to probe the hardware
 * itself just to pick one. Whichever the phone actually offers is chosen here,
 * from `supportedAuthenticationTypesAsync`.
 */
export type BiometricPrompts = { face: string; fingerprint: string };

export type ArmOptions = {
  prompts: BiometricPrompts;
  cancelLabel: string;
  fallbackLabel: string;
};

/**
 * Opt in. Verifies the user can actually pass a biometric check BEFORE arming
 * anything, so nobody ends up behind a gate they cannot open, then writes the
 * keystore-bound marker.
 *
 * If the marker cannot be written — an OEM that fails on
 * `setUserAuthenticationRequired`, a device with only Class 2 biometrics, no
 * device passcode — we do NOT fall back to arming a JavaScript-only gate. A gate
 * the OS is not backing would look identical to the user while silently losing
 * enrolment-change invalidation, and the honest alternative (their password) is
 * already there.
 */
export async function armBiometricUnlock(options: ArmOptions): Promise<UnlockResult> {
  const auth = loadLocalAuthentication();
  if (!auth) {
    return { ok: false, reason: "unsupported" };
  }

  const availability = await getBiometricAvailability();
  if (!availability.available) {
    return { ok: false, reason: availability.reason };
  }

  const promptMessage = options.prompts[availability.kind];

  let attempt: Awaited<ReturnType<LocalAuthenticationModule["authenticateAsync"]>>;
  try {
    attempt = await auth.authenticateAsync({
      promptMessage,
      cancelLabel: options.cancelLabel,
      fallbackLabel: options.fallbackLabel,
      // A confirm tap after a face scan is friction on a gate the user crosses
      // every launch; the OS treats this as a hint either way.
      requireConfirmation: false,
      // Left at the OS default so a phone whose sensor is momentarily
      // unavailable can still take the device PIN rather than dead-ending.
      // It is the same secret that protects the phone this gate assumes is
      // already in the owner's hands, and the keystore write below still
      // demands a real biometric, so this cannot arm a gate on a PIN alone.
      disableDeviceFallback: false,
    });
  } catch (error) {
    console.error("Biometric enrolment check failed", error);
    return { ok: false, reason: "failed" };
  }

  if (!attempt.success) {
    return { ok: false, reason: classifyLocalAuthError(attempt.error) };
  }

  try {
    await SecureStore.setItemAsync(GATE_KEY, GATE_MARKER, {
      requireAuthentication: true,
      keychainService: GATE_KEYCHAIN_SERVICE,
      authenticationPrompt: promptMessage,
    });
  } catch (error) {
    console.error("The keystore refused to back a biometric gate on this device", error);
    return { ok: false, reason: classifySecureStoreError(error) };
  }

  try {
    await SecureStore.setItemAsync(ARMED_KEY, "1");
  } catch (error) {
    console.error("Failed to save the biometric unlock preference", error);
    // The marker exists but the preference does not, so nothing would ever ask
    // for it. Roll back rather than leave a half-armed gate behind.
    await disarmBiometricUnlock();
    return { ok: false, reason: "failed" };
  }

  return { ok: true };
}

/**
 * Cross the gate. Exactly one OS prompt in every path: the authenticated read
 * IS the prompt, so the user is never asked twice for the same unlock.
 */
export async function unlockWithBiometrics(prompts: BiometricPrompts): Promise<UnlockResult> {
  const availability = await getBiometricAvailability();
  if (!availability.available) {
    // Every biometric was removed from the phone, which also destroyed the
    // keystore key. Disarm so the next launch asks for a password instead of
    // re-running a check that can no longer succeed.
    if (availability.reason === "notEnrolled") {
      await disarmBiometricUnlock();
    }

    return { ok: false, reason: availability.reason };
  }

  let marker: string | null;
  try {
    marker = await SecureStore.getItemAsync(GATE_KEY, {
      requireAuthentication: true,
      keychainService: GATE_KEYCHAIN_SERVICE,
      authenticationPrompt: prompts[availability.kind],
    });
  } catch (error) {
    console.error("Biometric unlock failed", error);
    const reason = classifySecureStoreError(error);
    if (reason === "notEnrolled") {
      await disarmBiometricUnlock();
    }

    return { ok: false, reason };
  }

  if (marker === null) {
    // Documented expo-secure-store behaviour: a key invalidated by a biometric
    // enrolment change resolves `null` instead of rejecting. The gate must not
    // keep trusting an enrolment it was never armed against.
    await disarmBiometricUnlock();
    return { ok: false, reason: "enrolmentChanged" };
  }

  return { ok: true };
}
