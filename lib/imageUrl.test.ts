import { describe, expect, it } from "vitest";
import { safeImageSrc } from "./imageUrl";

describe("safeImageSrc", () => {
  describe("allows the URL shapes AutoFlow actually produces", () => {
    it("keeps a Convex storage URL, which is what every persisted image is", () => {
      // convex/vehicles.ts, marketplaceListings.ts and websiteProjection.ts all
      // resolve imageIds through ctx.storage.getUrl(), which returns this shape.
      const url =
        "https://kindly-hound-172.convex.cloud/api/storage/9f1c2b7e-4d3a-4a71-9c0e-2b5f6a8d1e34";
      expect(safeImageSrc(url)).toBe(url);
    });

    it("keeps a blob: URL, which is what an upload preview is", () => {
      // VehicleDialog.handleUpload pushes URL.createObjectURL(file).
      const url = "blob:https://app.autoflow.test/2f8a1c60-7b44-4f1e-9a2d-8c5e3b7f0a91";
      expect(safeImageSrc(url)).toBe(url);
    });

    it("keeps a plain https image URL", () => {
      expect(safeImageSrc("https://cdn.example.com/car.jpg")).toBe(
        "https://cdn.example.com/car.jpg"
      );
    });

    it("keeps http, so a local/dev-served image still renders", () => {
      expect(safeImageSrc("http://localhost:3000/car.jpg")).toBe("http://localhost:3000/car.jpg");
    });

    it("keeps a root-relative path, which inherits the page scheme", () => {
      expect(safeImageSrc("/images/placeholder.png")).toBe("/images/placeholder.png");
    });

    it("keeps a protocol-relative URL", () => {
      expect(safeImageSrc("//cdn.example.com/car.jpg")).toBe("//cdn.example.com/car.jpg");
    });

    it("trims surrounding whitespace rather than rejecting the URL", () => {
      expect(safeImageSrc("  https://cdn.example.com/car.jpg  ")).toBe(
        "https://cdn.example.com/car.jpg"
      );
    });
  });

  describe("rejects script-bearing and non-image schemes", () => {
    it("rejects javascript:", () => {
      expect(safeImageSrc("javascript:alert(1)")).toBeUndefined();
    });

    it("rejects javascript: regardless of case", () => {
      expect(safeImageSrc("JaVaScRiPt:alert(1)")).toBeUndefined();
    });

    it("rejects javascript: hidden behind leading whitespace", () => {
      // Browsers strip leading ASCII whitespace before parsing the scheme, so a
      // naive `startsWith("javascript:")` check would pass this straight through.
      expect(safeImageSrc("   javascript:alert(1)")).toBeUndefined();
    });

    it("rejects javascript: split by an embedded control character", () => {
      // Browsers also strip TAB/LF/CR from inside the scheme: this parses as
      // `javascript:`. This is the bypass that makes naive prefix checks unsafe.
      expect(safeImageSrc("java\tscript:alert(1)")).toBeUndefined();
      expect(safeImageSrc("java\nscript:alert(1)")).toBeUndefined();
      expect(safeImageSrc("java\rscript:alert(1)")).toBeUndefined();
      expect(safeImageSrc("java\u0000script:alert(1)")).toBeUndefined();
    });

    it("rejects vbscript:", () => {
      expect(safeImageSrc("vbscript:msgbox(1)")).toBeUndefined();
    });

    it("rejects data: URLs, including image types AutoFlow never emits", () => {
      expect(safeImageSrc("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBeUndefined();
      expect(safeImageSrc("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=")).toBeUndefined();
    });

    it("rejects file:", () => {
      expect(safeImageSrc("file:///etc/passwd")).toBeUndefined();
    });

    it("rejects an unknown scheme rather than defaulting to allow", () => {
      expect(safeImageSrc("autoflow-app://open")).toBeUndefined();
    });

    it("rejects a bare relative reference with no scheme and no leading slash", () => {
      expect(safeImageSrc("car.jpg")).toBeUndefined();
    });
  });

  describe("rejects absent and empty values", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   "],
    ])("rejects %s", (_label, value) => {
      expect(safeImageSrc(value as string | null | undefined)).toBeUndefined();
    });

    it("rejects a non-string value defensively", () => {
      expect(safeImageSrc(42 as unknown as string)).toBeUndefined();
      expect(safeImageSrc({} as unknown as string)).toBeUndefined();
    });
  });
});
