// @vitest-environment node
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attest, attestedPreview, convexDeploymentOf, LOCAL_CONVEX_DEPLOYMENT, servedDeployments } from "../playwright/scenarios/formExplorer/attestedPreview";

// Only the subprocess boundary is replaced. Target/identity validation inside
// the bootstrap is exercised separately in e2ePreviewBootstrap.test.ts.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const LOCAL_URL = "http://127.0.0.1:3210";
const CLOUD_URL = "https://synthetic-preview-123.convex.cloud";

beforeEach(() => {
  for (const key of ["CONVEX_PREVIEW_NAME", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "GITHUB_ACTIONS"]) vi.stubEnv(key, "");
  vi.stubEnv("AUTOFLOW_LOCAL_CONVEX_CI", "1");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", LOCAL_URL);
  spawn.mockReturnValue({ pid: 1, output: [], stdout: '{"orgId":"synthetic-qa-org"}', stderr: "", status: 0, signal: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); spawn.mockReset(); });

describe("explorer backend attestation", () => {
  const pageAt = (url: string) => ({ goto: vi.fn<Page["goto"]>().mockResolvedValue(null), url: () => url });

  it.each([
    [LOCAL_URL, "ws://127.0.0.1:3210/api/sync"],
    [CLOUD_URL, "wss://synthetic-preview-123.convex.cloud/api/sync"],
  ])("the shared explorer and oracle guard accepts proven backend %s and its observed socket", async (url, socket) => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", url);
    if (url === CLOUD_URL) vi.stubEnv("CONVEX_PREVIEW_NAME", "e2e-synthetic");
    expect(await attest(pageAt("http://localhost:3000/"), "http://localhost:3000", [socket])).toEqual({ orgId: "synthetic-qa-org" });
  });

  it("the shared guard refuses a redirected app, a different served backend and an absent QA identity", async () => {
    const sockets = ["ws://127.0.0.1:3210/api/sync"];
    expect((await attest(pageAt("https://example.invalid/"), "http://localhost:3000", sockets)).refusal).toMatch(/redirected/);
    expect((await attest(pageAt("http://localhost:3000/"), "http://localhost:3000", [...sockets, "wss://other-preview-9.convex.cloud/api/sync"])).refusal).toMatch(/served app talks/);
    spawn.mockReturnValue({ pid: 1, output: [], stdout: "{}", stderr: "", status: 0, signal: null });
    expect((await attest(pageAt("http://localhost:3000/"), "http://localhost:3000", sockets)).refusal).toMatch(/did not name the seeded QA organization/);
  });

  it("attests the runner-local backend through the bootstrap without a cloud preview name", () => {
    vi.stubEnv("CONVEX_SELF_HOSTED_URL", LOCAL_URL);
    vi.stubEnv("CONVEX_SELF_HOSTED_ADMIN_KEY", "synthetic-admin-key");
    expect(attestedPreview()).toEqual({ url: LOCAL_URL, orgId: "synthetic-qa-org" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("a local CI switch cannot substitute for a successful backend attestation", () => {
    spawn.mockReturnValue({ pid: 1, output: [], stdout: "", stderr: "synthetic private failure", status: 1, signal: null });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(attestedPreview()).toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("EXPLORER_BACKEND_ATTESTATION_FAILED");
  });

  it("loopback without the explicit CI switch is refused even with a preview name", () => {
    vi.stubEnv("AUTOFLOW_LOCAL_CONVEX_CI", "");
    vi.stubEnv("CONVEX_PREVIEW_NAME", "e2e-synthetic");
    expect(attestedPreview()).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a cloud preview still requires its name and successful bootstrap proof", () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", CLOUD_URL);
    expect(attestedPreview()).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    vi.stubEnv("CONVEX_PREVIEW_NAME", "e2e-synthetic");
    expect(attestedPreview()).toEqual({ url: CLOUD_URL, orgId: "synthetic-qa-org" });
    spawn.mockReturnValue({ pid: 1, output: [], stdout: "", stderr: "", status: 1, signal: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(attestedPreview()).toBeUndefined();
  });

  it("recognizes the exact local HTTP and websocket origins and retains cloud mismatch evidence", () => {
    expect(convexDeploymentOf(LOCAL_URL)).toBe(LOCAL_CONVEX_DEPLOYMENT);
    expect(servedDeployments(["ws://127.0.0.1:3210/api/sync", "wss://synthetic-preview-123.convex.cloud/api/sync"]))
      .toEqual([LOCAL_CONVEX_DEPLOYMENT, "synthetic-preview-123"]);
    for (const url of ["http://localhost:3210", "http://127.0.0.1:3211", "http://user@127.0.0.1:3210", "https://synthetic-preview-123.convex.cloud.example.com", "invalid"]) {
      expect(convexDeploymentOf(url)).toBeUndefined();
    }
  });
});
