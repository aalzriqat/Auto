import { describe, expect, it } from "vitest";
import {
  dealerManifestResponse,
  emptyAnalyticsScriptResponse,
  VERCEL_ANALYTICS_SCRIPT_PATH,
} from "./dealerAssets";

describe("dealer asset responses", () => {
  it("returns the dealer manifest with the manifest content type", async () => {
    const response = dealerManifestResponse();
    const manifest = await response.json();

    expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
    expect(manifest).toMatchObject({
      name: "AutoFlow Dealer Website",
      start_url: "/",
      scope: "/",
    });
  });

  it("returns an empty JavaScript response for stale analytics script URLs", async () => {
    const response = emptyAnalyticsScriptResponse();

    expect(response.headers.get("Content-Type")).toContain("application/javascript");
    expect(await response.text()).toBe("");
  });

  it("matches only the Vercel analytics hash script shape", () => {
    expect(VERCEL_ANALYTICS_SCRIPT_PATH.test("/f3bb466bbfbc190d/script.js")).toBe(true);
    expect(VERCEL_ANALYTICS_SCRIPT_PATH.test("/inventory/script.js")).toBe(false);
  });
});
