import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PIN_TTL_MS,
  deletePreview,
  deploymentNameFromUrl,
  main,
  pinPreview,
} from "./previewDeploymentLifecycle.mjs";

const SECRET = "unit-test-secret-bytes";
const DEPLOY_KEY = "preview:team-one:project-two|" + SECRET;
const PREVIEW_NAME = "e2e-pr-377-abcdef1234";
const DEPLOYMENT = "elegant-butterfly-952";
const CREATED_AT = 1_790_000_000_000;
const NOW = 1_790_000_060_000;

type Call = { method: string; url: string; body?: unknown; auth?: string };

function preview(overrides: Record<string, unknown> = {}) {
  return {
    name: DEPLOYMENT,
    kind: "cloud",
    deploymentType: "preview",
    previewIdentifier: PREVIEW_NAME,
    isDefault: false,
    createTime: CREATED_AT,
    expiresAt: CREATED_AT + 5 * 24 * 60 * 60 * 1000,
    deploymentUrl: "https://" + DEPLOYMENT + ".convex.cloud",
    ...overrides,
  };
}

/** A Management API double: GET answers `current`, writes are recorded. */
function api(current: Record<string, unknown> | null, writeStatus = 200) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      method: String(init.method),
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    if (init.method === "GET") {
      return current
        ? new Response(JSON.stringify(current), { status: 200 })
        : new Response("not found", { status: 404 });
    }
    return new Response("", { status: writeStatus });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    CONVEX_PREVIEW_DEPLOY_KEY: DEPLOY_KEY,
    CONVEX_PREVIEW_NAME: PREVIEW_NAME,
    CONVEX_PREVIEW_URL: "https://" + DEPLOYMENT + ".convex.cloud",
    CONVEX_PREVIEW_CREATED_AT: String(CREATED_AT),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("SCRUM-377 preview deployment lifecycle", () => {
  it("deletes exactly this run's preview after re-confirming it", async () => {
    const { calls, fetchImpl } = api(preview());
    await expect(deletePreview({ env: env(), fetchImpl })).resolves.toEqual({
      deploymentName: DEPLOYMENT,
      deleted: true,
    });
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([
      "GET https://api.convex.dev/v1/deployments/" + DEPLOYMENT,
      "POST https://api.convex.dev/v1/deployments/" + DEPLOYMENT + "/delete",
    ]);
    expect(calls.every((c) => c.auth === "Bearer " + DEPLOY_KEY)).toBe(true);
  });

  it.each([
    ["a production deployment", { deploymentType: "prod" }],
    ["a dev deployment", { deploymentType: "dev" }],
    ["a default deployment", { isDefault: true }],
    ["a non-cloud deployment", { kind: "local" }],
    ["another run's preview identifier", { previewIdentifier: "e2e-pr-999-0000000000" }],
    ["a preview recreated by a newer run", { createTime: CREATED_AT + 1 }],
    ["a response naming a different deployment", { name: "other-animal-1" }],
    ["a response without createTime", { createTime: undefined }],
  ])("never deletes %s", async (_label, overrides) => {
    const { calls, fetchImpl } = api(preview(overrides));
    await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
  });

  it("refuses the production deployment and non-canonical URLs before any request", async () => {
    for (const url of [
      "https://kindly-hound-172.convex.cloud",
      "https://elegant-butterfly-952.convex.site",
      "http://elegant-butterfly-952.convex.cloud",
      "https://elegant-butterfly-952.convex.cloud/x",
      "https://evil.example/elegant-butterfly-952.convex.cloud",
      "",
    ]) {
      const { calls, fetchImpl } = api(preview());
      await expect(deletePreview({ env: env({ CONVEX_PREVIEW_URL: url }), fetchImpl })).rejects.toThrow();
      expect(calls).toEqual([]);
    }
    expect(() => deploymentNameFromUrl("https://kindly-hound-172.convex.cloud")).toThrow(/protected/);
  });

  it("refuses a non-preview deploy key before any request", async () => {
    const { calls, fetchImpl } = api(preview());
    await expect(
      deletePreview({ env: env({ CONVEX_PREVIEW_DEPLOY_KEY: "prod:team-one:project-two|" + SECRET }), fetchImpl }),
    ).rejects.toThrow(/preview:team:project/);
    expect(calls).toEqual([]);
  });

  it("does nothing without a recorded createTime (pin never ran)", async () => {
    const { calls, fetchImpl } = api(preview());
    await expect(
      deletePreview({ env: env({ CONVEX_PREVIEW_CREATED_AT: undefined }), fetchImpl }),
    ).rejects.toThrow(/No recorded createTime/);
    expect(calls).toEqual([]);
  });

  it("treats an already-deleted preview as done", async () => {
    const { calls, fetchImpl } = api(null);
    await expect(deletePreview({ env: env(), fetchImpl })).resolves.toMatchObject({ deleted: false });
    expect(writes(calls)).toEqual([]);
  });

  it("pin records createTime and shortens the expiry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrum377-"));
    const ghEnv = path.join(dir, "env");
    const ghOut = path.join(dir, "out");
    writeFileSync(ghEnv, "");
    writeFileSync(ghOut, "");
    const { calls, fetchImpl } = api(preview());
    const result = await pinPreview({
      env: env({ CONVEX_PREVIEW_CREATED_AT: undefined, GITHUB_ENV: ghEnv, GITHUB_OUTPUT: ghOut }),
      fetchImpl,
      now: () => NOW,
    });
    expect(result).toEqual({ deploymentName: DEPLOYMENT, createdAt: CREATED_AT, expiresAt: NOW + PIN_TTL_MS });
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        method: "PATCH",
        url: "https://api.convex.dev/v1/deployments/" + DEPLOYMENT,
        body: { expiresAt: NOW + PIN_TTL_MS },
      }),
    ]);
    expect(readFileSync(ghEnv, "utf8")).toBe("CONVEX_PREVIEW_CREATED_AT=" + CREATED_AT + "\n");
    expect(readFileSync(ghOut, "utf8")).toBe("preview_created_at=" + CREATED_AT + "\n");
  });

  it("pin never lengthens an expiry that is already sooner", async () => {
    const { calls, fetchImpl } = api(preview({ expiresAt: NOW + 60_000 }));
    await pinPreview({ env: env(), fetchImpl, now: () => NOW });
    expect(writes(calls)).toEqual([]);
  });

  it("pin refuses, and records nothing, for a deployment that is not this run's preview", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrum377-"));
    const ghEnv = path.join(dir, "env");
    writeFileSync(ghEnv, "");
    const { calls, fetchImpl } = api(preview({ previewIdentifier: "someone-else" }));
    await expect(pinPreview({ env: env({ GITHUB_ENV: ghEnv }), fetchImpl, now: () => NOW })).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
    expect(readFileSync(ghEnv, "utf8")).toBe("");
  });

  it("only warns, exits 0, and never prints key bytes", async () => {
    const lines: string[] = [];
    const failing = (async () => {
      throw new Error("socket hang up " + SECRET);
    }) as unknown as typeof fetch;
    for (const command of ["pin", "delete", "bogus"]) {
      await expect(main([command], { env: env(), fetchImpl: failing, write: (l: string) => lines.push(l) })).resolves.toBe(0);
    }
    const http500 = api(preview(), 500);
    await main(["delete"], { env: env(), fetchImpl: http500.fetchImpl, write: (l: string) => lines.push(l) });
    expect(lines.length).toBe(4);
    expect(lines.every((l) => l.startsWith("::warning::"))).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("team-one");
  });
});

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
};
const KEY = "${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}";

describe("SCRUM-377 every preview-creating workflow retires its preview", () => {
  const dir = path.join(process.cwd(), ".github", "workflows");
  const creators = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }))
    .filter((w) => w.text.includes("--preview-create"));

  it("finds the known creators", () => {
    expect(creators.map((w) => w.file).sort()).toEqual([
      "browser-attack-swarm.yml",
      "trusted-accounting-rehearsal.yml",
      "trusted-main-e2e.yml",
    ]);
  });

  it.each(creators.map((w) => [w.file, w.text]))("%s pins what it created and deletes last", (_file, text) => {
    const jobs = (parse(text) as { jobs: Record<string, Job> }).jobs;
    const steps = Object.entries(jobs).flatMap(([id, job]) => (job.steps ?? []).map((s) => ({ id, s })));
    // Shell comment lines do not execute; a commented-out command is no command.
    const executable = (s: Step) =>
      (s.run ?? "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
    const only = (needle: string) => {
      const hits = steps.flatMap(({ s }, i) => (executable(s).includes(needle) ? [i] : []));
      expect(hits, needle).toHaveLength(1);
      return hits[0];
    };
    const creates = only("--preview-create");
    const pin = only("previewDeploymentLifecycle.mjs pin");
    const del = only("previewDeploymentLifecycle.mjs delete");
    const creator = steps[creates].s;
    const pinStep = steps[pin].s;
    const delStep = steps[del].s;

    // The identity comes from the creating command's own --cmd, and the pin
    // runs directly after it, even when that command failed.
    // ...and it is the variable the CLI actually fills with that URL.
    const urlVar = /--cmd-url-env-var-name (\w+)/.exec(executable(creator))?.[1];
    expect(urlVar, "--cmd-url-env-var-name").toBeTruthy();
    const cmd = /--cmd '([^']*)'/.exec(executable(creator))?.[1] ?? "";
    expect(cmd).toContain(`echo "CONVEX_PREVIEW_URL=$${urlVar}" >> "$GITHUB_ENV"`);
    expect(steps[pin].id).toBe(steps[creates].id);
    expect(pin).toBe(creates + 1);
    expect(pinStep.if ?? "").toMatch(/^always\(\) && /);
    expect(pinStep.if).toContain("env.CONVEX_PREVIEW_URL != ''");
    // No disjunction, and no literal `false` operand that could disable it.
    expect(pinStep.if).not.toMatch(/\|\||(^|&&|\()\s*(false|0)\s*(&&|\)|$)/);
    expect(pinStep.env?.CONVEX_PREVIEW_DEPLOY_KEY).toBe(KEY);
    expect(delStep.env?.CONVEX_PREVIEW_DEPLOY_KEY).toBe(KEY);

    // Every lookup by preview name, in any job, can return a newer run's
    // replacement, so each one must name the deployment this run created.
    for (const { s } of steps) {
      const run = executable(s);
      const inline = run.match(/resolveConvexPreview(Credentials|Authority)\(\{[^}]*\}/g) ?? [];
      for (const call of inline) {
        expect(call, s.name).toMatch(/expectedConvexCloudUrl: process\.env\.(CONVEX_PREVIEW_URL|NEXT_PUBLIC_CONVEX_URL),/);
      }
      if (run.includes("scripts/intelligence/convexPreviewAuthority.mjs") && inline.length === 0) {
        expect(s.env?.CONVEX_PREVIEW_URL, s.name).toBe("${{ env.CONVEX_PREVIEW_URL }}");
      }
    }

    const delJobId = steps[del].id;
    if (delJobId === steps[creates].id) {
      // Same job: the delete is its final step and runs whatever came before.
      expect(del).toBeGreaterThan(pin);
      expect(delStep.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
      expect(jobs[delJobId].steps?.at(-1)).toBe(delStep);
    } else {
      // Separate job: it waits for every other job, whatever their outcome,
      // and receives exactly what the pin step published.
      const delJob = jobs[delJobId];
      const pinJob = jobs[steps[pin].id];
      expect(delJob.if).toBe(`always() && needs.${steps[pin].id}.outputs.cleanup_preview_created_at != ''`);
      expect(delJob.steps?.at(-1)).toBe(delStep);
      const needs = [delJob.needs ?? []].flat().sort();
      expect(needs).toEqual(Object.keys(jobs).filter((id) => id !== delJobId).sort());
      expect(pinJob.outputs).toMatchObject({
        cleanup_preview_name: `\${{ steps.${pinStep.id}.outputs.preview_name }}`,
        cleanup_convex_url: `\${{ steps.${pinStep.id}.outputs.convex_cloud_url }}`,
        cleanup_preview_created_at: `\${{ steps.${pinStep.id}.outputs.preview_created_at }}`,
      });
      const from = `needs.${steps[pin].id}.outputs`;
      expect(delStep.env).toMatchObject({
        CONVEX_PREVIEW_NAME: `\${{ ${from}.cleanup_preview_name }}`,
        CONVEX_PREVIEW_URL: `\${{ ${from}.cleanup_convex_url }}`,
        CONVEX_PREVIEW_CREATED_AT: `\${{ ${from}.cleanup_preview_created_at }}`,
      });
    }
  });
});
