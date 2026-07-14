import type { Locale } from "@autoflow/shared";
import * as SecureStore from "expo-secure-store";
import { Dimensions, Platform } from "react-native";

import { buildMarketplaceClientFingerprint } from "./marketplaceUtils";

const FINGERPRINT_STORAGE_KEY = "autoflow-mobile-marketplace-fingerprint";
let fallbackVisitorIdCounter = 0;

function cryptoHex(byteLength: number): string | null {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    return null;
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createVisitorId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const randomPart = cryptoHex(16);
  if (randomPart) {
    return `${Date.now().toString(36)}-${randomPart}`;
  }

  fallbackVisitorIdCounter += 1;
  return `${Date.now().toString(36)}-${fallbackVisitorIdCounter.toString(36)}`;
}

function getTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

export async function getMarketplaceClientFingerprint(locale: Locale): Promise<string> {
  let visitorId = await SecureStore.getItemAsync(FINGERPRINT_STORAGE_KEY);
  if (!visitorId) {
    visitorId = createVisitorId();
    await SecureStore.setItemAsync(FINGERPRINT_STORAGE_KEY, visitorId);
  }

  const screen = Dimensions.get("screen");
  const screenSize = `${Math.round(screen.width)}x${Math.round(screen.height)}@${screen.scale}`;

  return buildMarketplaceClientFingerprint({
    visitorId,
    locale,
    timeZone: getTimeZone(),
    platform: Platform.OS,
    screenSize,
  });
}
