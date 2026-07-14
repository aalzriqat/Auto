/// <reference types="jest" />

import * as SecureStore from "expo-secure-store";
import { Dimensions, Platform, type ScaledSize } from "react-native";

import { getMarketplaceClientFingerprint } from "./marketplaceFingerprint";

const getItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;

function screen(width: number, height: number, scale: number): ScaledSize {
  return { width, height, scale, fontScale: 1 };
}

describe("marketplace mobile fingerprint", () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  afterEach(() => {
    jest.restoreAllMocks();
    getItemAsync.mockReset();
    setItemAsync.mockReset();

    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  });

  test("reuses the persisted visitor id when one exists", async () => {
    jest.spyOn(Dimensions, "get").mockReturnValue(screen(375, 812, 3));
    getItemAsync.mockResolvedValueOnce("visitor-id");

    await expect(getMarketplaceClientFingerprint("en")).resolves.toBe(
      `visitor-id:en:${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}:${Platform.OS}:375x812@3`,
    );
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  test("stores a generated random UUID when no visitor id exists", async () => {
    jest.spyOn(Dimensions, "get").mockReturnValue(screen(390, 844, 3));
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "uuid-1" },
    });
    getItemAsync.mockResolvedValueOnce(null);
    setItemAsync.mockResolvedValueOnce(undefined);

    const fingerprint = await getMarketplaceClientFingerprint("ar");

    expect(fingerprint).toBe(
      `uuid-1:ar:${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}:${Platform.OS}:390x844@3`,
    );
    expect(setItemAsync).toHaveBeenCalledWith("autoflow-mobile-marketplace-fingerprint", "uuid-1");
  });

  test("uses crypto byte entropy when random UUID is unavailable", async () => {
    jest.spyOn(Dimensions, "get").mockReturnValue(screen(390, 844, 3));
    jest.spyOn(Date, "now").mockReturnValue(36);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
          return bytes;
        },
      },
    });
    getItemAsync.mockResolvedValueOnce(null);
    setItemAsync.mockResolvedValueOnce(undefined);

    const fingerprint = await getMarketplaceClientFingerprint("ar");

    expect(fingerprint).toBe(
      `10-000102030405060708090a0b0c0d0e0f:ar:${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}:${Platform.OS}:390x844@3`,
    );
    expect(setItemAsync).toHaveBeenCalledWith(
      "autoflow-mobile-marketplace-fingerprint",
      "10-000102030405060708090a0b0c0d0e0f",
    );
  });

  test("falls back when crypto and timezone APIs are unavailable", async () => {
    const dateTimeFormat = Intl.DateTimeFormat;
    jest.spyOn(Dimensions, "get").mockReturnValue(screen(320.4, 568.6, 2));
    jest.spyOn(Date, "now").mockReturnValue(0);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      value: function ThrowingDateTimeFormat() {
        throw new Error("timezone unavailable");
      },
    });
    getItemAsync.mockResolvedValueOnce(null);
    setItemAsync.mockResolvedValueOnce(undefined);

    try {
      await expect(getMarketplaceClientFingerprint("en")).resolves.toBe(`0-1:en:unknown:${Platform.OS}:320x569@2`);
      expect(setItemAsync).toHaveBeenCalledWith("autoflow-mobile-marketplace-fingerprint", "0-1");
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        value: dateTimeFormat,
      });
    }
  });

  test("uses an unknown timezone when the runtime returns an empty timezone", async () => {
    const dateTimeFormat = Intl.DateTimeFormat;
    jest.spyOn(Dimensions, "get").mockReturnValue(screen(375, 667, 2));
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      value: function EmptyTimeZoneDateTimeFormat() {
        return {
          resolvedOptions: () => ({ timeZone: "" }),
        };
      },
    });
    getItemAsync.mockResolvedValueOnce("visitor-id");

    try {
      await expect(getMarketplaceClientFingerprint("en")).resolves.toBe(
        `visitor-id:en:unknown:${Platform.OS}:375x667@2`,
      );
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        value: dateTimeFormat,
      });
    }
  });
});
