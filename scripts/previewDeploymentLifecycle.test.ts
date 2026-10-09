import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PIN_TTL_MS,
  carriesPreviewIdentity,
  deletePreview,
  deploymentNameFromUrl,
  describeObserved,
  main,
  pinPreview,
} from "./previewDeploymentLifecycle.mjs";

// A realistic PlatformDeploymentResponse for a preview (see the Convex OpenAPI).
const FIXTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), "scripts", "__fixtures__", "convexPreviewDeployment.json"), "utf8"),
) as Record<string, unknown>;
const SECRET = "unit-test-secret-bytes";
const DEPLOY_KEY = "preview:team-one:project-two|" + SECRET;
const PREVIEW_NAME = "e2e-pr-377-abcdef1234";
const DEPLOYMENT = "elegant-butterfly-952";
const CREATED_AT = 1_790_000_000_000;
const NOW = 1_790_000_060_000;

type Call = { method: string; url: string; body?: unknown; auth?: string };

function preview(overrides: Record<string, unknown> = {}) {
  return {
    ...FIXTURE,
    name: DEPLOYMENT,
    reference: "preview/" + PREVIEW_NAME,
    previewIdentifier: null,
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
  } as unknown as NodeJS.ProcessEnv;
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
    [
    "another run's preview",
    { reference: "preview/e2e-pr-999-0000000000", previewIdentifier: "e2e-pr-999-0000000000" },
  ],
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

  it("does not guess a deployment when creation failed before URL capture", async () => {
    const { calls, fetchImpl } = api(preview());
    const unpinned = env({ CONVEX_PREVIEW_URL: undefined, CONVEX_PREVIEW_CREATED_AT: undefined });
    await expect(pinPreview({ env: unpinned, fetchImpl })).rejects.toThrow();
    await expect(deletePreview({ env: unpinned, fetchImpl })).rejects.toThrow();
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
    const { calls, fetchImpl } = api(
      preview({ reference: "preview/someone-else", previewIdentifier: "someone-else" }),
    );
    await expect(pinPreview({ env: env({ GITHUB_ENV: ghEnv }), fetchImpl, now: () => NOW })).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
    expect(readFileSync(ghEnv, "utf8")).toBe("");
  });

  describe("preview identity (reference or previewIdentifier)", () => {
    const REF = "preview/" + PREVIEW_NAME;

    it("accepts the Convex reference when previewIdentifier is null: pin and delete succeed", async () => {
      const current = preview({ previewIdentifier: null });
      const pinned = api(current);
      await expect(pinPreview({ env: env(), fetchImpl: pinned.fetchImpl, now: () => NOW })).resolves.toMatchObject({
        deploymentName: DEPLOYMENT,
      });
      expect(writes(pinned.calls)).toHaveLength(1);
      const deleted = api(current);
      await expect(deletePreview({ env: env(), fetchImpl: deleted.fetchImpl })).resolves.toMatchObject({ deleted: true });
      expect(writes(deleted.calls)).toHaveLength(1);
    });

    it("accepts a matching reference when previewIdentifier is a different string", async () => {
      const { fetchImpl } = api(preview({ previewIdentifier: "something-else-entirely" }));
      await expect(deletePreview({ env: env(), fetchImpl })).resolves.toMatchObject({ deleted: true });
    });

    it("accepts a matching previewIdentifier when reference differs (the old contract)", async () => {
      const { fetchImpl } = api(preview({ reference: "preview/another-name", previewIdentifier: PREVIEW_NAME }));
      await expect(deletePreview({ env: env(), fetchImpl })).resolves.toMatchObject({ deleted: true });
    });

    it("refuses when both mismatch, and the message carries the sanitized observed values", async () => {
      const { calls, fetchImpl } = api(preview({ reference: "preview/other", previewIdentifier: 42 }));
      await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow(
        /observed reference: preview\/other; previewIdentifier: number/,
      );
      expect(writes(calls)).toEqual([]);
      const nulls = api(preview({ reference: undefined, previewIdentifier: null }));
      await expect(deletePreview({ env: env(), fetchImpl: nulls.fetchImpl })).rejects.toThrow(
        /observed reference: undefined; previewIdentifier: null/,
      );
    });

    it.each([
      ["a longer name sharing the prefix", REF + "x"],
      ["a prefix of the name", REF.slice(0, -1)],
      ["an upper-case scheme", "PREVIEW/" + PREVIEW_NAME],
      ["a padded reference", " " + REF],
      ["a trailing newline", REF + "\n"],
      ["a name with a trailing /preview but no scheme", PREVIEW_NAME + "/preview"],
      ["a non-string", { toString: () => REF }],
    ])("never matches %s", async (_label, reference) => {
      expect(carriesPreviewIdentity({ reference, previewIdentifier: null }, PREVIEW_NAME)).toBe(false);
      const { calls, fetchImpl } = api(preview({ reference, previewIdentifier: null }));
      await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow(/preview identifier/);
      expect(writes(calls)).toEqual([]);
    });

    it("does not match case-folded or padded previewIdentifier values either", () => {
      for (const previewIdentifier of [PREVIEW_NAME.toUpperCase(), PREVIEW_NAME + " ", [PREVIEW_NAME]]) {
        expect(carriesPreviewIdentity({ previewIdentifier }, PREVIEW_NAME)).toBe(false);
      }
      expect(carriesPreviewIdentity({ reference: REF }, "")).toBe(false);
      expect(carriesPreviewIdentity(null, PREVIEW_NAME)).toBe(false);
    });

    it.each([
      ["a production deployment", { deploymentType: "prod" }],
      ["a default deployment", { isDefault: true }],
    ])("a matching reference never rescues %s", async (_label, overrides) => {
      const { calls, fetchImpl } = api(preview({ previewIdentifier: null, ...overrides }));
      await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow();
      expect(writes(calls)).toEqual([]);
    });

    it.each([
      ["kind absent", { kind: undefined }, /observed kind: undefined/],
      ["isDefault absent", { isDefault: undefined }, /observed isDefault: undefined/],
      ["isDefault null", { isDefault: null }, /observed isDefault: null/],
      ["isDefault the string false", { isDefault: "false" }, /observed isDefault: string/],
    ])("refuses when %s: no PATCH, no delete POST", async (_label, overrides, message) => {
      const pinned = api(preview(overrides));
      await expect(pinPreview({ env: env(), fetchImpl: pinned.fetchImpl, now: () => NOW })).rejects.toThrow(message);
      expect(pinned.calls.map((c) => c.method)).toEqual(["GET"]);
      const deleted = api(preview(overrides));
      await expect(deletePreview({ env: env(), fetchImpl: deleted.fetchImpl })).rejects.toThrow(message);
      expect(deleted.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("control: the complete response (kind cloud, isDefault false) pins and deletes", async () => {
      const pinned = api(preview({ kind: "cloud", isDefault: false }));
      await pinPreview({ env: env(), fetchImpl: pinned.fetchImpl, now: () => NOW });
      expect(pinned.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
      const deleted = api(preview({ kind: "cloud", isDefault: false }));
      await expect(deletePreview({ env: env(), fetchImpl: deleted.fetchImpl })).resolves.toMatchObject({ deleted: true });
      expect(deleted.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    });

    it("refuses when the other identity field is malformed, even if one field matches", async () => {
      expect(carriesPreviewIdentity({ reference: REF, previewIdentifier: 42 }, PREVIEW_NAME)).toBe(false);
      expect(carriesPreviewIdentity({ reference: 42, previewIdentifier: PREVIEW_NAME }, PREVIEW_NAME)).toBe(false);
      for (const overrides of [{ previewIdentifier: 42 }, { reference: 42, previewIdentifier: PREVIEW_NAME }]) {
        const { calls, fetchImpl } = api(preview(overrides));
        await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow(/preview identifier/);
        expect(calls.map((c) => c.method)).toEqual(["GET"]);
      }
    });

    it.each([
      ["a createTime that differs from the recorded one", { createTime: CREATED_AT + 1 }],
      ["a missing createTime", { createTime: undefined }],
    ])("with only the reference matching, delete refuses %s", async (_label, overrides) => {
      const { calls, fetchImpl } = api(preview({ previewIdentifier: null, ...overrides }));
      await expect(deletePreview({ env: env(), fetchImpl })).rejects.toThrow();
      expect(writes(calls)).toEqual([]);
    });

    it("a matching reference never rescues a protected deployment name", async () => {
      const { calls, fetchImpl } = api(preview({ name: "kindly-hound-172", previewIdentifier: null }));
      await expect(
        deletePreview({ env: env({ CONVEX_PREVIEW_URL: "https://kindly-hound-172.convex.cloud" }), fetchImpl }),
      ).rejects.toThrow(/protected/);
      expect(calls).toEqual([]);
    });

    it("sanitizes observed values: strips control characters and newlines, caps the length", () => {
      expect(describeObserved("a\nb\r\u0000c\u001b[31md e")).toBe("a?b??c??31md?e");
      expect(describeObserved("preview/ok_1.2:3-4")).toBe("preview/ok_1.2:3-4");
      expect(describeObserved("x".repeat(500))).toHaveLength(80);
      expect(describeObserved(null)).toBe("null");
      expect(describeObserved(undefined)).toBe("undefined");
      expect(describeObserved({ a: 1 })).toBe("object");
      expect(describeObserved(7)).toBe("number");
    });
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
    expect(lines).toHaveLength(4);
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

/**
 * The argument object of every `resolveConvexPreview…({ … })` call in a script,
 * with JavaScript comments removed and braces balanced, so a commented-out or
 * nested-brace argument cannot hide from the check.
 */
function inlineResolverCalls(script: string): string[] {
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const calls: string[] = [];
  for (const match of code.matchAll(/resolveConvexPreview(?:Credentials|Authority)\(\{/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      if (code[end] === "}" && --depth === 0) break;
    }
    calls.push(code.slice(start, end + 1));
  }
  return calls;
}

describe("inlineResolverCalls", () => {
  it("sees through nesting and comments", () => {
    const [call] = inlineResolverCalls(
      "await resolveConvexPreviewCredentials({\n  fetchImpl: wrap({ n: 1 }),\n  // expectedConvexCloudUrl: process.env.X,\n  expectedConvexCloudUrl: undefined,\n});",
    );
    expect(call).toContain("expectedConvexCloudUrl: undefined");
    expect(call).not.toContain("process.env.X");
    expect(call.endsWith("}")).toBe(true);
  });
});

describe("SCRUM-377 every preview-creating workflow retires its preview", () => {
  const dir = path.join(process.cwd(), ".github", "workflows");
  const creators = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }))
    .filter((w) => w.text.includes("--preview-create"));

  it("finds the known creators", () => {
    expect(creators.map((w) => w.file).sort()).toEqual([
      "browser-attack-swarm.yml",
      "deal-scenarios-e2e.yml",
      "hunt-preview.yml",
      "preview-attestation-fault-probe.yml",
      "trusted-accounting-rehearsal.yml",
      "trusted-main-e2e.yml",
    ]);
  });

  // SCRUM-768: the hunt preview exists to OUTLIVE its run (a person hunts on
  // it for hours), so "delete at the end of the same run" cannot hold for it.
  // Its contract — pin right after create, 12 h expiry backstop, one strict
  // teardown dispatch — is pinned in scripts/huntPreviewWorkflow.test.ts.
  const RUN_SCOPED_EXEMPT = new Set(["hunt-preview.yml"]);

  it.each(creators.filter((w) => !RUN_SCOPED_EXEMPT.has(w.file)).map((w) => [w.file, w.text]))("%s pins what it created and deletes last", (_file, text) => {
    const jobs = (parse(text) as { jobs: Record<string, Job> }).jobs;
    const steps = Object.entries(jobs).flatMap(([id, job]) => (job.steps ?? []).map((s) => ({ id, s })));
    // Shell comments do not execute, and neither do the arguments of the `:`
    // no-op, so a commented-out or `: `-prefixed command is no command.
    const executable = (s: Step) =>
      (s.run ?? "")
        .split("\n")
        .map((line) => line.replace(/(^|\s)#.*$/, ""))
        .filter((line) => !/^\s*:(\s|$)/.test(line))
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
    const urlVars = [...executable(creator).matchAll(/--cmd-url-env-var-name (\w+)/g)];
    expect(urlVars, "exactly one --cmd-url-env-var-name").toHaveLength(1);
    const urlVar = urlVars[0][1];
    const cmds = [...executable(creator).matchAll(/--cmd '([^']*)'/g)];
    expect(cmds, "exactly one --cmd").toHaveLength(1);
    const cmd = cmds[0][1];
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
    // (The resolver also refuses a call without it at runtime; this catches a
    // miswired variable before a run does.)
    for (const { s } of steps) {
      const run = executable(s);
      const inline = inlineResolverCalls(run);
      for (const call of inline) {
        const named = [...call.matchAll(/expectedConvexCloudUrl\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
        expect(named, s.name).toHaveLength(1);
        expect(named[0], s.name).toMatch(/^process\.env\.(CONVEX_PREVIEW_URL|NEXT_PUBLIC_CONVEX_URL)$/);
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
      // `always()` first, the created-preview guard present, and nothing else
      // beyond conditions the pin job itself ran under: whenever a preview was
      // created those all held, so no extra clause can skip its deletion.
      const conjuncts = (text: unknown) =>
        String(text ?? "").split("&&").map((part) => part.trim()).filter(Boolean);
      const delConjuncts = conjuncts(delJob.if);
      const pinConjuncts = new Set(conjuncts(pinJob.if));
      const createdGuard = `needs.${steps[pin].id}.outputs.cleanup_preview_created_at != ''`;
      expect(delConjuncts[0]).toBe("always()");
      expect(delConjuncts).toContain(createdGuard);
      expect(
        delConjuncts.filter((c) => c !== "always()" && c !== createdGuard && !pinConjuncts.has(c)),
      ).toEqual([]);
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

describe("SCRUM-768 strict teardown (delete --strict)", () => {
  /** GET answers the preview until a delete POST lands, then 404 if `honour`. */
  function deletingApi(honour: boolean) {
    const calls: Call[] = [];
    let gone = false;
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url });
      if (init.method === "GET") {
        return gone ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(preview()), { status: 200 });
      }
      if (honour) gone = true;
      return new Response("", { status: 200 });
    };
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("exits 0 when the preview is deleted and re-reads as gone", async () => {
    const { calls, fetchImpl } = deletingApi(true);
    const lines: string[] = [];
    await expect(main(["delete", "--strict"], { env: env(), fetchImpl, write: (l: string) => lines.push(l) })).resolves.toBe(0);
    expect(lines).toEqual(["Deleted preview " + DEPLOYMENT + "."]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("exits 1 when the deployment still exists after the delete call", async () => {
    const { fetchImpl } = deletingApi(false);
    const lines: string[] = [];
    await expect(main(["delete", "--strict"], { env: env(), fetchImpl, write: (l: string) => lines.push(l) })).resolves.toBe(1);
    expect(lines[0]).toMatch(/^::error::Preview teardown failed: .*still exists/);
  });

  it("exits 1 on a refusal the warn-only path would swallow (createTime mismatch)", async () => {
    const { calls, fetchImpl } = api(preview({ createTime: CREATED_AT + 1 }));
    const lines: string[] = [];
    await expect(main(["delete", "--strict"], { env: env(), fetchImpl, write: (l: string) => lines.push(l) })).resolves.toBe(1);
    expect(writes(calls)).toEqual([]);
    expect(lines[0]).toMatch(/^::error::/);
    // The same refusal stays a warning without --strict.
    await expect(main(["delete"], { env: env(), fetchImpl, write: () => {} })).resolves.toBe(0);
  });

  // A mistyped but well-formed name reads 404; "already gone" would report
  // success while the real hunt preview stayed alive.
  it("exits 1 and deletes nothing when the named deployment is not found", async () => {
    const { calls, fetchImpl } = api(null);
    const lines: string[] = [];
    await expect(main(["delete", "--strict"], { env: env(), fetchImpl, write: (l: string) => lines.push(l) })).resolves.toBe(1);
    expect(writes(calls)).toEqual([]);
    expect(lines[0]).toMatch(/^::error::Preview teardown failed: .*was not found, so nothing was deleted/);
    // The warn-only path keeps treating it as already gone.
    await expect(main(["delete"], { env: env(), fetchImpl, write: () => {} })).resolves.toBe(0);
  });

  it("pin --strict exits 1 when shortening the expiry fails; plain pin only warns", async () => {
    const { fetchImpl } = api(preview(), 500);
    const now = () => CREATED_AT;
    const lines: string[] = [];
    await expect(main(["pin", "--strict"], { env: env(), fetchImpl, now, write: (l: string) => lines.push(l) })).resolves.toBe(1);
    expect(lines[0]).toMatch(/^::error::Preview pin failed: Shortening the expiry .* failed with HTTP 500/);
    const warned: string[] = [];
    await expect(main(["pin"], { env: env(), fetchImpl, now, write: (l: string) => warned.push(l) })).resolves.toBe(0);
    expect(warned[0]).toMatch(/^::warning::/);
  });

  it("pin --strict exits 0 and reports the 12 h expiry when the PATCH succeeds", async () => {
    const { calls, fetchImpl } = api(preview());
    const lines: string[] = [];
    await expect(
      main(["pin", "--strict"], { env: env(), fetchImpl, now: () => CREATED_AT, write: (l: string) => lines.push(l) }),
    ).resolves.toBe(0);
    expect(writes(calls).map((c) => c.method)).toEqual(["PATCH"]);
    expect(lines[0]).toMatch(/^Pinned preview /);
  });

  it("exits 1 and never calls the API for the production deployment", async () => {
    const { calls, fetchImpl } = api(preview());
    const lines: string[] = [];
    await expect(
      main(["delete", "--strict"], {
        env: env({ CONVEX_PREVIEW_URL: "https://kindly-hound-172.convex.cloud" }),
        fetchImpl,
        write: (l: string) => lines.push(l),
      }),
    ).resolves.toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
