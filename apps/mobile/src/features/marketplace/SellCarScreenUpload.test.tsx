/// <reference types="jest" />

// The photo-upload contract lives in its own file: these tests replace
// globalThis.fetch and drive the image picker, and sharing a module instance with
// the render/auth-gating tests in SellCarScreen.test.tsx made the two sets
// interfere with each other.

import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useConvexAuth, useMutation } from "convex/react";

jest.mock("convex/react", () => ({
  useConvexAuth: jest.fn(),
  useMutation: jest.fn(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock("../../permissions/mediaPermissions", () => ({
  ensurePhotoLibraryPermission: jest.fn().mockResolvedValue({ granted: true }),
}));

import { launchImageLibraryAsync } from "expo-image-picker";

import { api } from "../../convexApi";
import { LocaleProvider } from "../../providers/LocaleProvider";
import { ThemeProvider } from "../../providers/ThemeProvider";
import { SellCarScreen } from "./SellCarScreen";

const mockUseConvexAuth = useConvexAuth as jest.MockedFunction<typeof useConvexAuth>;
const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;

function renderScreen() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <SellCarScreen />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

describe("SellCarScreen photo upload", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockUseConvexAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      isRefreshing: false,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads a picked photo through generate -> POST -> confirm, keeping the confirmed storage id", async () => {
    const generateUploadUrl = jest.fn().mockResolvedValue("https://convex.test/upload-slot");
    const confirmUpload = jest.fn().mockResolvedValue({ url: "https://convex.test/stored.jpg" });
    mockUseMutation.mockImplementation(
      ((ref: unknown) => {
        if (ref === api.marketplaceListings.generateListingImageUploadUrl) return generateUploadUrl;
        if (ref === api.marketplaceListings.confirmListingImageUpload) return confirmUpload;
        return jest.fn();
      }) as unknown as typeof useMutation,
    );

    (launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///tmp/car.jpg", mimeType: "image/jpeg", fileSize: 2048 }],
    });

    const blob = { type: "image/jpeg", size: 2048 } as unknown as Blob;
    const fetchMock = jest
      .fn()
      // 1st call reads the picked file, 2nd is the upload POST.
      .mockResolvedValueOnce({ blob: async () => blob })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ storageId: "kg2_storage_abc" }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { getByText } = await renderScreen();
    fireEvent.press(getByText("رفع صور"));

    // Ownership is only recorded once confirm runs, and createListing rejects
    // any image id without that claim — so confirm must receive the id the
    // upload actually returned.
    await waitFor(() =>
      expect(confirmUpload).toHaveBeenCalledWith({ storageId: "kg2_storage_abc" }),
    );

    // The backend re-validates type and size before issuing the slot, so both
    // must come from the picked asset rather than being assumed.
    expect(generateUploadUrl).toHaveBeenCalledWith({ mimeType: "image/jpeg", sizeInBytes: 2048 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://convex.test/upload-slot",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "image/jpeg" } }),
    );
  });

  test("keeps uploading the rest of the batch when one photo fails, and reports the failure count", async () => {
    const generateUploadUrl = jest
      .fn()
      // First asset's slot request fails; the second must still be attempted.
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue("https://convex.test/upload-slot");
    const confirmUpload = jest.fn().mockResolvedValue({ url: "https://convex.test/stored.jpg" });
    mockUseMutation.mockImplementation(
      ((ref: unknown) => {
        if (ref === api.marketplaceListings.generateListingImageUploadUrl) return generateUploadUrl;
        if (ref === api.marketplaceListings.confirmListingImageUpload) return confirmUpload;
        return jest.fn();
      }) as unknown as typeof useMutation,
    );

    (launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file:///tmp/a.jpg", mimeType: "image/jpeg", fileSize: 1000 },
        { uri: "file:///tmp/b.jpg", mimeType: "image/jpeg", fileSize: 2000 },
      ],
    });

    globalThis.fetch = jest.fn().mockImplementation(async (input: unknown) =>
      typeof input === "string" && input.startsWith("file://")
        ? { blob: async () => ({ type: "image/jpeg", size: 1500 }) }
        : { ok: true, json: async () => ({ storageId: "kg2_second_ok" }) },
    ) as unknown as typeof fetch;

    const { getByText } = await renderScreen();
    fireEvent.press(getByText("رفع صور"));

    // The surviving asset still reaches confirm...
    await waitFor(() => expect(confirmUpload).toHaveBeenCalledWith({ storageId: "kg2_second_ok" }));
    expect(generateUploadUrl).toHaveBeenCalledTimes(2);
    // ...and the seller is told exactly one photo needs retrying.
    expect(getByText("تعذّر رفع صورة واحدة. الرجاء إضافتها مرة أخرى.")).toBeTruthy();
  });

  test("rejects a disallowed image type client-side, before requesting an upload slot", async () => {
    const generateUploadUrl = jest.fn();
    mockUseMutation.mockImplementation(
      ((ref: unknown) =>
        ref === api.marketplaceListings.generateListingImageUploadUrl
          ? generateUploadUrl
          : jest.fn()) as unknown as typeof useMutation,
    );

    (launchImageLibraryAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///tmp/clip.gif", mimeType: "image/gif", fileSize: 1024 }],
    });
    globalThis.fetch = jest.fn().mockResolvedValueOnce({
      blob: async () => ({ type: "image/gif", size: 1024 }),
    }) as unknown as typeof fetch;

    const { getByText } = await renderScreen();
    fireEvent.press(getByText("رفع صور"));

    await waitFor(() => expect(getByText("يُسمح فقط بصور JPEG أو PNG أو WEBP.")).toBeTruthy());
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });
});
