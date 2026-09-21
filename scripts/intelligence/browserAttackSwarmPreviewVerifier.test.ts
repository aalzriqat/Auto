import { describe, expect, it, vi } from "vitest";
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
  CONVEX_DEPLOY_KEY: "preview:team:project|secret",
  CONVEX_PREVIEW_NAME: "e2e-pr-350-preview-test",
  NEXT_PUBLIC_CONVEX_URL: "https://example-preview.convex.cloud",
  E2E_LOGIN_USER: "sales@example.test",
  E2E_APPROVER_USER: "manager@example.test",
  CLERK_SECRET_KEY: "unit-test-clerk-secret",
};

type SpawnResult = {
  status: number | null;
  error?: Error | undefined;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdio?: string;
    shell?: boolean;
    env?: Record<string, string | undefined>;
  },
) => SpawnResult;

function successSpawn(): SpawnResult {
  return { status: 0 };
}

describe("SCRUM-350 preview verifier", () => {
  it("executes SCRUM-143 through a real Node ESM process boundary", async () => {
    const spawn = vi.fn<SpawnFn>(() => successSpawn());

    const result = await verifyBrowserSwarmPreview(manifest, env, {
      spawn,
      cwd: "/repo",
    });

    expect(result.verified).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    const call = spawn.mock.calls[0];
    if (!call) throw new Error("spawn call missing");
    const [command, args, options] = call;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      "/repo/scripts/e2ePreviewBootstrap.mjs",
      "--assert-only",
    ]);
    expect(options).toMatchObject({
      cwd: "/repo",
      stdio: "inherit",
      shell: false,
    });
    if (!options.env) throw new Error("spawn env missing");
    expect(options.env.CONVEX_PREVIEW_NAME).toBe(manifest.previewName);
    expect(options.env.NEXT_PUBLIC_CONVEX_URL).toBe(manifest.expectedCloudUrl);
  });

  it("refuses when the runtime preview name differs from the signed run manifest", async () => {
    const spawn = vi.fn<SpawnFn>(() => successSpawn());

    await expect(
      verifyBrowserSwarmPreview(
        manifest,
        { ...env, CONVEX_PREVIEW_NAME: "e2e-another-preview" },
        { spawn },
      ),
    ).rejects.toThrow(/CONVEX_PREVIEW_NAME does not match/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses when the browser backend URL and manifest URL diverge", async () => {
    const spawn = vi.fn<SpawnFn>(() => successSpawn());

    await expect(
      verifyBrowserSwarmPreview(
        manifest,
        {
          ...env,
          NEXT_PUBLIC_CONVEX_URL: "https://another-preview.convex.cloud",
        },
        { spawn },
      ),
    ).rejects.toThrow(/NEXT_PUBLIC_CONVEX_URL does not match/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses manifests that do not explicitly require the preview marker", async () => {
    const spawn = vi.fn<SpawnFn>(() => successSpawn());

    await expect(
      verifyBrowserSwarmPreview(
        {
          ...manifest,
          requiresPreviewMarker: false,
        } as unknown as BrowserSwarmRunManifest,
        env,
        { spawn },
      ),
    ).rejects.toThrow(/does not require the SCRUM-143 preview marker/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when SCRUM-143's assertion process returns non-zero", async () => {
    const spawn = vi.fn<SpawnFn>(() => ({ status: 7 }));

    await expect(
      verifyBrowserSwarmPreview(manifest, env, { spawn }),
    ).rejects.toThrow(/failed with exit code 7/);
  });

  it("does not hide a failure to start the SCRUM-143 assertion process", async () => {
    const spawn = vi.fn<SpawnFn>(() => ({
      status: null,
      error: new Error("ENOENT"),
    }));

    await expect(
      verifyBrowserSwarmPreview(manifest, env, { spawn }),
    ).rejects.toThrow(/could not start/);
  });
});
