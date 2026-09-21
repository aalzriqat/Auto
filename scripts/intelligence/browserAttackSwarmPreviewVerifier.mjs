import { spawnSync } from "node:child_process";
import path from "node:path";

const PREVIEW_ASSERTION_TIMEOUT_MS = 120_000;

function requireMatch(actual, expected, label) {
  if (!actual || !expected || String(actual).trim() !== String(expected).trim()) {
    throw new Error(
      label + " does not match the browser swarm manifest; refusing preview execution.",
    );
  }
}

function assertManifestShape(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.requiresPreviewMarker !== true) {
    throw new Error(
      "Browser swarm manifest does not require the SCRUM-143 preview marker.",
    );
  }
}

/**
 * Executes SCRUM-143's existing ESM bootstrap as a real Node process instead
 * of importing it through Playwright's transformed test loader.
 *
 * @param {import("./browserAttackSwarm").BrowserSwarmRunManifest} manifest
 * @param {Record<string, string | undefined>} [env]
 * @param {{
 *   spawn?: (
 *     command: string,
 *     args: string[],
 *     options: object,
 *   ) => { status: number | null, error?: Error | undefined },
 *   cwd?: string,
 * }} [deps]
 */
export async function verifyBrowserSwarmPreview(
  manifest,
  env = process.env,
  deps = {},
) {
  assertManifestShape(manifest);

  const previewName = env.CONVEX_PREVIEW_NAME;
  const expectedCloudUrl = env.NEXT_PUBLIC_CONVEX_URL;
  requireMatch(previewName, manifest.previewName, "CONVEX_PREVIEW_NAME");
  requireMatch(
    expectedCloudUrl?.replace(/\/$/, ""),
    manifest.expectedCloudUrl?.replace(/\/$/, ""),
    "NEXT_PUBLIC_CONVEX_URL",
  );

  const spawn = deps.spawn ?? spawnSync;
  const cwd = deps.cwd ?? process.cwd();
  const script = path.resolve(cwd, "scripts/e2ePreviewBootstrap.mjs");
  const result = spawn(process.execPath, [script, "--assert-only"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
    timeout: PREVIEW_ASSERTION_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(
      "SCRUM-143 preview assertion process could not start: " +
        result.error.message,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      "SCRUM-143 preview assertion failed with exit code " +
        String(result.status) +
        ".",
    );
  }

  return {
    verified: true,
    summary:
      "SCRUM-143 marker, deployment identity, seeded organization and both E2E seats verified.",
  };
}
