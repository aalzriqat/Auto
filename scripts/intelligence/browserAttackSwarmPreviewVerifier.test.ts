import { describe, expect, it, vi } from "vitest";
import { verifyBrowserSwarmPreview } from "./browserAttackSwarmPreviewVerifier.mjs";

const manifest = {
  version: 1,
  runId: "pr-350-preview-test",
  previewName: "e2e-pr-350-preview-test",
  expectedCloudUrl: "https://example-preview.convex.cloud",
  requiresPreviewMarker: true,
  workers: [],
};

const env = {
  CONVEX_DEPLOY_KEY: "preview:team:project|secret",
  CONVEX_PREVIEW_NAME: "e2e-pr-350-preview-test",
  NEXT_PUBLIC_CONVEX_URL: "https://example-preview.convex.cloud",
  E2E_LOGIN_USER: "sales@example.test",
  E2E_APPROVER_USER: "manager@example.test",
  CLERK_SECRET_KEY: "unit-test-clerk-secret",
};

describe("SCRUM-350 preview verifier", () => {
  it("reuses the SCRUM-143 assertion path and reports verified only after it succeeds", async () => {
    const runConvex = vi.fn();
    const resolveClerkUserId = vi
      .fn()
      .mockResolvedValueOnce("user_PRIMARY123")
      .mockResolvedValueOnce("user_APPROVER123");

    const result = await verifyBrowserSwarmPreview(manifest, env, {
      runConvex,
      resolveClerkUserId,
    });

    expect(result.verified).toBe(true);
    expect(resolveClerkUserId).toHaveBeenCalledTimes(2);
    expect(runConvex).toHaveBeenCalledTimes(1);

    const [args, label] = runConvex.mock.calls[0];
    expect(label).toBe("e2eBootstrap:assertE2EBootstrap");
    expect(args).toContain("e2eBootstrap:assertE2EBootstrap");
    expect(args).toContain("--preview-name");
    expect(args).toContain(manifest.previewName);

    const argsJson = args[4];
    expect(JSON.parse(argsJson)).toEqual({
      primaryClerkUserId: "user_PRIMARY123",
      approverClerkUserId: "user_APPROVER123",
      expectedCloudUrl: manifest.expectedCloudUrl,
    });
  });

  it("refuses when the runtime preview name differs from the signed run manifest", async () => {
    const runConvex = vi.fn();
    const resolveClerkUserId = vi.fn();

    await expect(
      verifyBrowserSwarmPreview(
        manifest,
        { ...env, CONVEX_PREVIEW_NAME: "e2e-another-preview" },
        { runConvex, resolveClerkUserId },
      ),
    ).rejects.toThrow(/CONVEX_PREVIEW_NAME does not match/);

    expect(resolveClerkUserId).not.toHaveBeenCalled();
    expect(runConvex).not.toHaveBeenCalled();
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
        { ...manifest, requiresPreviewMarker: false },
        env,
      ),
    ).rejects.toThrow(/does not require the SCRUM-143 preview marker/);
  });
});
