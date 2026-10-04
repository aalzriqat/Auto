import { spawnSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

/**
 * The preview guard of jev-explorer.spec.ts (SCRUM-595, PR #430), copied
 * unchanged in behaviour so the form explorer (SCRUM-614) can reuse it without
 * editing that in-flight spec. Fold the two together once #430 has merged.
 *
 * The form explorer SUBMITS forms, so this is the only thing standing between
 * it and a real dealer's data: it must prove both that the configured backend
 * is the seeded disposable preview and that the served app actually talks to
 * it (Codex AF-430-03).
 */

export const PRODUCTION_DEPLOYMENT = "kindly-hound-172";

/**
 * Runs the bootstrap's own assertExistingE2EPreview, with its own argv checks
 * (runConvex), in a child: the bootstrap is an ES module Playwright's CommonJS
 * transform cannot load. On Windows the same validated `exec convex run …`
 * argv goes straight to the Convex CLI, since pnpm.cmd needs a shell.
 */
const LOCAL_ATTESTATION = `
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(resolve("scripts/e2ePreviewBootstrap.mjs")).href);
const spawn = (command, args, options) => {
  if (process.platform !== "win32") return spawnSync(command, args, options);
  if (args[0] !== "exec" || args[1] !== "convex" || args[2] !== "run") {
    throw new Error("Refusing to run anything but convex run for the preview attestation.");
  }
  return spawnSync(process.execPath, [resolve("node_modules/convex/bin/main.js"), ...args.slice(2)], options);
};
await m.assertExistingE2EPreview(process.env, { run: (args, label) => m.runConvex(args, label, spawn) });
`;

/**
 * The Convex URL proven to be the seeded disposable preview, with the seeded
 * QA organization the backend named, or undefined. An environment variable
 * saying "this was attested" is the caller's claim, not evidence, so the
 * backend itself is asked.
 */
export function attestedPreview(): { url: string | undefined; orgId: string | undefined } | undefined {
  if (!process.env.CONVEX_PREVIEW_NAME) return undefined;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", LOCAL_ATTESTATION], {
    env: process.env,
    encoding: "utf8",
    timeout: 180_000,
  });
  // assertE2EBootstrap returns { orgId, ... } and `convex run` prints it.
  if (res.status === 0) return { url: process.env.NEXT_PUBLIC_CONVEX_URL, orgId: /"orgId":\s*"([^"]+)"/.exec(res.stdout ?? "")?.[1] };
  const lines = (res.stderr || res.error?.message || "").split("\n").filter((l) => l.trim());
  const reason = (lines.find((l) => /Error/.test(l)) ?? lines.at(-1))?.trim() ?? `exit ${res.status}`;
  console.warn(`Preview attestation failed: ${reason}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Jev form explorer skipped::Preview attestation failed (${reason}); the explorer did not run.`);
  }
  return undefined;
}

/**
 * The Convex deployment a URL's host names, or undefined. The whole host must
 * be `<name>.convex.cloud`: `<preview>.convex.cloud.example.com` names nothing.
 */
export function convexDeploymentOf(url: string | undefined): string | undefined {
  try {
    return /^([a-z0-9-]+)\.convex\.cloud$/.exec(new URL(url ?? "").hostname)?.[1];
  } catch {
    return undefined;
  }
}

export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Every Convex socket the page has opened, as deployment names. */
export function servedDeployments(sockets: string[]): string[] {
  return sockets.filter((u) => u.includes(".convex.cloud")).map((u) => convexDeploymentOf(u) ?? u);
}

/**
 * Why this run must not write, or the seeded QA organization it may write to.
 * Checks, in order: a local app, a non-production configured backend, an
 * attested preview that names its QA organization, a page still on the local
 * app after loading, and a served app whose every Convex socket names that
 * same preview. `sockets` must already be collecting from `page`.
 */
export async function attest(
  page: Page,
  baseURL: string | undefined,
  sockets: string[],
): Promise<{ refusal: string; orgId?: undefined } | { refusal?: undefined; orgId: string }> {
  const app = new URL(baseURL ?? "http://localhost:3000");
  if (!["localhost", "127.0.0.1"].includes(app.hostname)) return { refusal: "Form explorer runs against a local app only." };
  if ((process.env.NEXT_PUBLIC_CONVEX_URL ?? "").includes(PRODUCTION_DEPLOYMENT)) {
    return { refusal: "Form explorer never runs against the production backend." };
  }
  const expected = convexDeploymentOf(process.env.NEXT_PUBLIC_CONVEX_URL);
  if (!expected) return { refusal: "Form explorer needs NEXT_PUBLIC_CONVEX_URL naming its preview deployment." };
  const attested = attestedPreview();
  if (!sameUrl(attested?.url, process.env.NEXT_PUBLIC_CONVEX_URL)) {
    return { refusal: "NEXT_PUBLIC_CONVEX_URL is not attested as the seeded disposable preview; not exploring." };
  }
  if (!attested?.orgId) return { refusal: "The preview attestation did not name the seeded QA organization; not exploring." };
  await page.goto("/");
  // A local server that redirects elsewhere is not the local app (Codex F614-02).
  if (new URL(page.url()).origin !== app.origin) return { refusal: `The local app redirected to ${new URL(page.url()).origin}; not exploring.` };
  await expect
    .poll(() => sockets.some((u) => u.includes(".convex.cloud")), { timeout: 30_000 })
    .toBe(true)
    .catch(() => undefined);
  const served = servedDeployments(sockets);
  if (served.length === 0) return { refusal: "Could not observe which backend the served app uses; not exploring." };
  if (served.some((d) => d === PRODUCTION_DEPLOYMENT || d !== expected)) {
    return { refusal: `The served app talks to ${[...new Set(served)].join(", ")}, not the preview ${expected}.` };
  }
  return { orgId: attested.orgId };
}
