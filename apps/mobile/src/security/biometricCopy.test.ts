/// <reference types="jest" />

import { getMobileFoundationString } from "@autoflow/shared";

import {
  biometricFailureStringKey,
  canRetryBiometrics,
  shouldOfferSystemSettings,
} from "./biometricCopy";
import { type BiometricFailure } from "./biometricUnlock";

const ALL_FAILURES: BiometricFailure[] = [
  "unsupported",
  "noHardware",
  "notEnrolled",
  "cancelled",
  "lockout",
  "lockoutPermanent",
  "enrolmentChanged",
  "failed",
];

describe("biometricFailureStringKey", () => {
  test("every failure has its own message, in both locales", () => {
    const english = new Set<string>();
    const arabic = new Set<string>();

    for (const failure of ALL_FAILURES) {
      const key = biometricFailureStringKey(failure);
      const en = getMobileFoundationString("en", key);
      const ar = getMobileFoundationString("ar", key);

      // A missing entry falls back to the key itself; catching that here is the
      // point, because the app defaults to Arabic.
      expect(en).not.toBe(key);
      expect(ar).not.toBe(key);
      expect(ar).not.toBe(en);

      english.add(en);
      arabic.add(ar);
    }

    expect(english.size).toBe(ALL_FAILURES.length);
    expect(arabic.size).toBe(ALL_FAILURES.length);
  });

  test("every message points the user at the password escape hatch, or at a fix", () => {
    // The states a user can act their way out of by signing in normally must say
    // so; the two "your phone cannot do this" states have nothing to offer but
    // the fix itself, and the lock screen renders the password button anyway.
    const mustMentionPassword: BiometricFailure[] = [
      "cancelled",
      "lockout",
      "lockoutPermanent",
      "enrolmentChanged",
      "failed",
    ];

    for (const failure of mustMentionPassword) {
      const key = biometricFailureStringKey(failure);
      expect(getMobileFoundationString("en", key).toLowerCase()).toContain("password");
      expect(getMobileFoundationString("ar", key)).toContain("كلمة المرور");
    }
  });
});

describe("shouldOfferSystemSettings", () => {
  test("only a missing enrolment is fixable in the phone's settings", () => {
    expect(shouldOfferSystemSettings("notEnrolled")).toBe(true);

    for (const failure of ALL_FAILURES.filter((f) => f !== "notEnrolled")) {
      expect(shouldOfferSystemSettings(failure)).toBe(false);
    }
  });
});

describe("canRetryBiometrics", () => {
  test("offers a retry before the first attempt and after a recoverable one", () => {
    expect(canRetryBiometrics(null)).toBe(true);
    expect(canRetryBiometrics("cancelled")).toBe(true);
    expect(canRetryBiometrics("failed")).toBe(true);
    expect(canRetryBiometrics("lockout")).toBe(true);
  });

  test("hides the retry when nothing about a retry could change the outcome", () => {
    expect(canRetryBiometrics("unsupported")).toBe(false);
    expect(canRetryBiometrics("noHardware")).toBe(false);
    expect(canRetryBiometrics("notEnrolled")).toBe(false);
    expect(canRetryBiometrics("lockoutPermanent")).toBe(false);
    expect(canRetryBiometrics("enrolmentChanged")).toBe(false);
  });
});
