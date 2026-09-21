import { describe, expect, it } from "vitest";
import type { BrowserSwarmRunManifest } from "./browserAttackSwarm";
import { verifyBrowserSwarmPreview } from "./browserAttackSwarmPreviewVerifier.mjs";

const manifest: BrowserSwarmRunManifest = {
  version: 1,
  runId: "pr-350-preview-test",
  previewName: "e2e-pr-350-preview-test",
  expectedCloudUrl: "https://example-preview.convex.cloud",
  requiresPreviewMarker: true,
  workers: [],
};

const env = {
  BROWSER_SWARM_PREVIEW_ATTESTED: "1",
  CONVEX_PREVIEW_NAME: "e2e-pr-350-preview-test",
  NEXT_PUBLIC_CONVEX_URL: "https://example-preview.convex.cloud",
};

describe("SCRUM-350 preview verifier", () => {
  it("accepts only the trusted workflow's pre-attested preview identity", async () => {
    const result = await verifyBrowserSwarmPreview(manifest, env);
    expect(result.verified).toBe(true);
    expect(result.summary).toMatch(/Trusted preflight attested/);
  });

  it("refuses when the runtime preview name differs from the signed run manifest", async () => {
    await expect(
      verifyBrowserSwarmPreview(manifest, {
        ...env,
        CONVEX_PREVIEW_NAME: "e2e-another-preview",
      }),
    ).rejects.toThrow(/CONVEX_PREVIEW_NAME does not match/);
  });

  it("refuses when the browser backend URL and manifest URL diverge", async () => {
    await expect(
      verifyBrowserSwarmPreview(manifest, {
        ...env,
        NEXT_PUBLIC_CONVEX_URL: "https://another-preview.convex.cloud",
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_CONVEX_URL does not match/);
  });

  it("refuses manifests that do not explicitly require the preview marker", async () => {
    await expect(
      verifyBrowserSwarmPreview(
        {
          ...manifest,
          requiresPreviewMarker: false,
        } as unknown as BrowserSwarmRunManifest,
        env,
      ),
    ).rejects.toThrow(/does not require the SCRUM-143 preview marker/);
  });

  it("fails closed without the trusted server-side preview attestation", async () => {
    const { BROWSER_SWARM_PREVIEW_ATTESTED: _removed, ...unattested } = env;
    await expect(
      verifyBrowserSwarmPreview(manifest, unattested),
    ).rejects.toThrow(/attestation is missing/);
  });
});
