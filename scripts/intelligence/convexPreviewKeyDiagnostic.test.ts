import { describe, expect, it, vi } from "vitest";
import {
  diagnosePreviewKeyScope,
  previewNamesForPr,
} from "./convexPreviewKeyDiagnostic.mjs";

const DEPLOY_KEY = "preview:team-one:project-two|deploy-key-secret";
const KEY_A = "preview:team-one:project-two|secret-for-a";
const KEY_B = "preview:team-one:project-two|secret-for-b";
const NAMES = ["e2e-pr-7-aaaaaaaaaa", "e2e-pr-7-bbbbbbbbbb"] as const;

type Claims = Record<string, Record<string, unknown>>;

/**
 * A fake control plane plus two fake deployments. `accepts[host]` lists the
 * admin keys that deployment's get_config_hashes answers 200 for; every other
 * key gets 401.
 */
function fakeConvex(claims: Claims, accepts: Record<string, string[]>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    if (target.pathname === "/api/claim_preview_deployment") {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(claims[body.identifier]), { status: 200 });
    }
    if (target.pathname === "/api/get_config_hashes") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const key = auth.replace(/^Convex /, "");
      const ok = (accepts[target.hostname] ?? []).includes(key);
      return new Response("{}", { status: ok ? 200 : 401 });
    }
    return new Response("{}", { status: 404 });
  });
}

const CLAIMS: Claims = {
  [NAMES[0]]: {
    deploymentName: "dep-a",
    instanceUrl: "https://dep-a.convex.cloud",
    adminKey: KEY_A,
    isNewDeployment: false,
  },
  [NAMES[1]]: {
    deploymentName: "dep-b",
    instanceUrl: "https://dep-b.convex.cloud",
    adminKey: KEY_B,
    isNewDeployment: false,
  },
};

describe("Convex preview key-scope diagnostic", () => {
  it("derives the swarm and rehearsal preview names the trusted lanes use", () => {
    const names = previewNamesForPr("327");
    expect(names.swarm).toMatch(/^e2e-pr-327-[0-9a-f]+$/);
    expect(names.rehearsal).toMatch(/^e2e-pr-327-[0-9a-f]+$/);
    expect(names.swarm).not.toBe(names.rehearsal);
    expect(() => previewNamesForPr("7; rm -rf /")).toThrow(/PR number/);
  });

  it("reports DEPLOYMENT_SCOPED only when each key works on its own preview and nowhere else", async () => {
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fakeConvex(CLAIMS, {
        "dep-a.convex.cloud": [KEY_A],
        "dep-b.convex.cloud": [KEY_B],
      }) as typeof fetch,
    });

    expect(report.verdict).toBe("DEPLOYMENT_SCOPED");
    expect(report.previews.map((p) => p.keyEqualsDeployKey)).toEqual([false, false]);
    expect(report.previews.map((p) => p.prefixEqualsDeployKeyPrefix)).toEqual([true, true]);
    expect(report.keyAEqualsKeyB).toBe(false);
    expect(report.probes).toEqual({
      keyAOnA: 200,
      keyAOnB: 401,
      keyBOnB: 200,
      keyBOnA: 401,
      deployKeyOnA: 401,
    });
  });

  it("reports NOT_DEPLOYMENT_SCOPED when a claimed key also opens the other preview", async () => {
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fakeConvex(CLAIMS, {
        "dep-a.convex.cloud": [KEY_A],
        "dep-b.convex.cloud": [KEY_A, KEY_B],
      }) as typeof fetch,
    });
    expect(report.verdict).toBe("NOT_DEPLOYMENT_SCOPED");
  });

  it("reports NOT_DEPLOYMENT_SCOPED when the claim hands back the deploy key itself", async () => {
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fakeConvex(
        { ...CLAIMS, [NAMES[0]]: { ...CLAIMS[NAMES[0]], adminKey: DEPLOY_KEY } },
        { "dep-a.convex.cloud": [DEPLOY_KEY], "dep-b.convex.cloud": [KEY_B] },
      ) as typeof fetch,
    });
    expect(report.previews[0].keyEqualsDeployKey).toBe(true);
    expect(report.verdict).toBe("NOT_DEPLOYMENT_SCOPED");
  });

  it("stops before probing when a claim created a preview instead of reusing one", async () => {
    const fetchImpl = fakeConvex(
      { ...CLAIMS, [NAMES[1]]: { ...CLAIMS[NAMES[1]], isNewDeployment: true } },
      { "dep-a.convex.cloud": [KEY_A], "dep-b.convex.cloud": [KEY_B] },
    );
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(report.verdict).toBe("INCONCLUSIVE_PREVIEW_MISSING");
    expect(report.probes).toBeNull();
    const probed = fetchImpl.mock.calls.some(([url]) =>
      String(url).includes("get_config_hashes"),
    );
    expect(probed).toBe(false);
  });

  it("never lets key or secret bytes into the report", async () => {
    const masked: string[] = [];
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fakeConvex(CLAIMS, {
        "dep-a.convex.cloud": [KEY_A],
        "dep-b.convex.cloud": [KEY_B],
      }) as typeof fetch,
      onAdminKeys: (keys: string[]) => masked.push(...keys),
    });
    // The claimed keys leave only through the masking callback.
    expect(masked).toEqual([KEY_A, KEY_B]);
    const serialized = JSON.stringify(report);
    for (const secret of [
      DEPLOY_KEY,
      KEY_A,
      KEY_B,
      "deploy-key-secret",
      "secret-for-a",
      "secret-for-b",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("records a network failure as a status label, never an error message", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("get_config_hashes")) {
        throw new Error("connect failed with " + String(new Headers(init?.headers).get("authorization")));
      }
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(CLAIMS[body.identifier]), { status: 200 });
    });
    const report = await diagnosePreviewKeyScope({
      deployKey: DEPLOY_KEY,
      previewNames: NAMES,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(report.probes?.keyAOnA).toBe("NETWORK_ERROR");
    expect(report.verdict).toBe("INCONCLUSIVE_PROBE_FAILED");
    expect(JSON.stringify(report)).not.toContain("secret-for-a");
  });
});
