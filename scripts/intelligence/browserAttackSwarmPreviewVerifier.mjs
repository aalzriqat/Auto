function requireMatch(actual, expected, label) {
  if (!actual || !expected || String(actual).trim() !== String(expected).trim()) {
    throw new Error(
      label + " does not match the browser swarm manifest; refusing preview execution.",
    );
  }
}

function assertManifestShape(manifest) {
  if (manifest?.version !== 1 || manifest?.requiresPreviewMarker !== true) {
    throw new Error(
      "Browser swarm manifest does not require the SCRUM-143 preview marker.",
    );
  }
}

/**
 * The trusted workflow performs the server-side SCRUM-143 assertion before
 * any candidate frontend is started. This runtime verifier binds that
 * pre-attestation to the same preview name and URL carried by the immutable
 * manifest, without needing any reusable Convex or Clerk credential here.
 *
 * @param {import("./browserAttackSwarm").BrowserSwarmRunManifest} manifest
 * @param {Record<string, string | undefined>} [env]
 */
export async function verifyBrowserSwarmPreview(
  manifest,
  env = process.env,
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

  if (env.BROWSER_SWARM_PREVIEW_ATTESTED !== "1") {
    throw new Error(
      "Trusted SCRUM-143 preview attestation is missing; refusing browser execution.",
    );
  }

  return {
    verified: true,
    summary:
      "Trusted preflight attested the SCRUM-143 marker, deployment identity, seeded organization and both E2E seats.",
  };
}
