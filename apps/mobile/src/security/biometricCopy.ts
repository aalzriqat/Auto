import type { MobileFoundationStringKey } from "@autoflow/shared";

import type { BiometricFailure } from "./biometricUnlock";

/**
 * One message per failure, so the user is never told "something went wrong"
 * when the app knows exactly what happened. Kept as a pure lookup rather than a
 * chain of ternaries in the view so every branch is directly testable, in both
 * locales, without rendering anything.
 */
const FAILURE_STRING_KEYS = {
  unsupported: "biometricErrorUnsupported",
  noHardware: "biometricErrorNoHardware",
  notEnrolled: "biometricErrorNotEnrolled",
  cancelled: "biometricErrorCancelled",
  lockout: "biometricErrorLockout",
  lockoutPermanent: "biometricErrorLockoutPermanent",
  enrolmentChanged: "biometricErrorEnrolmentChanged",
  failed: "biometricErrorFailed",
} as const satisfies Record<BiometricFailure, MobileFoundationStringKey>;

export function biometricFailureStringKey(reason: BiometricFailure): MobileFoundationStringKey {
  return FAILURE_STRING_KEYS[reason];
}

/**
 * Whether the failure is something the user fixes in the phone's own settings.
 * Only "nothing is enrolled" qualifies — offering a settings shortcut for a
 * lockout or a cancellation would just send them somewhere that cannot help.
 */
export function shouldOfferSystemSettings(reason: BiometricFailure): boolean {
  return reason === "notEnrolled";
}

/**
 * Whether retrying the biometric check could plausibly succeed right now.
 * A missing sensor, a missing enrolment, an invalidated key and a permanent
 * lockout are all "not until something changes outside this app", so the lock
 * screen hides the retry button and leads with the password instead of inviting
 * the user to hammer a check that cannot pass.
 */
export function canRetryBiometrics(reason: BiometricFailure | null): boolean {
  if (reason === null) return true;
  return reason === "cancelled" || reason === "failed" || reason === "lockout";
}
