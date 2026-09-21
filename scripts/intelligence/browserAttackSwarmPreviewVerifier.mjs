import {
  PreviewTargetingError,
  assertPreviewTargeting,
  buildConvexRunArgs,
  resolveClerkUserId,
  runConvex,
} from "../e2ePreviewBootstrap.mjs";

function requireMatch(actual, expected, label) {
  if (!actual || !expected || String(actual).trim() !== String(expected).trim()) {
    throw new PreviewTargetingError(
      label + " does not match the browser swarm manifest; refusing preview execution.",
    );
  }
}

export async function verifyBrowserSwarmPreview(
  manifest,
  env = process.env,
  deps = {},
) {
  if (!manifest || manifest.version !== 1 || manifest.requiresPreviewMarker !== true) {
    throw new PreviewTargetingError(
      "Browser swarm manifest does not require the SCRUM-143 preview marker.",
    );
  }

  const deployKey = env.CONVEX_DEPLOY_KEY;
  const previewName = env.CONVEX_PREVIEW_NAME;
  const expectedCloudUrl = env.NEXT_PUBLIC_CONVEX_URL;

  assertPreviewTargeting({ deployKey, previewName, env });
  requireMatch(previewName, manifest.previewName, "CONVEX_PREVIEW_NAME");
  requireMatch(
    expectedCloudUrl?.replace(/\/$/, ""),
    manifest.expectedCloudUrl?.replace(/\/$/, ""),
    "NEXT_PUBLIC_CONVEX_URL",
  );

  const primaryEmail = env.E2E_LOGIN_USER;
  const approverEmail = env.E2E_APPROVER_USER;
  const clerkSecret = env.CLERK_SECRET_KEY;
  if (!primaryEmail || !approverEmail || !clerkSecret) {
    throw new PreviewTargetingError(
      "Browser swarm preview verification requires E2E_LOGIN_USER, E2E_APPROVER_USER and CLERK_SECRET_KEY.",
    );
  }

  const resolveId = deps.resolveClerkUserId ?? resolveClerkUserId;
  const run = deps.runConvex ?? runConvex;

  const primaryClerkUserId = await resolveId({
    email: primaryEmail,
    secretKey: clerkSecret,
  });
  const approverClerkUserId = await resolveId({
    email: approverEmail,
    secretKey: clerkSecret,
  });

  const args = buildConvexRunArgs({
    functionName: "e2eBootstrap:assertE2EBootstrap",
    argsJson: JSON.stringify({
      primaryClerkUserId,
      approverClerkUserId,
      expectedCloudUrl: manifest.expectedCloudUrl,
    }),
    previewName: manifest.previewName,
    deployKey,
    env,
  });

  run(args, "e2eBootstrap:assertE2EBootstrap");

  return {
    verified: true,
    summary:
      "SCRUM-143 marker, deployment identity, seeded organization and both E2E seats verified.",
  };
}
