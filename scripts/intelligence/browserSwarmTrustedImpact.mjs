import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChangeState,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
} from "./jevImpact.mjs";

const TRUSTED_IMPACT_VERSION = 1;

/**
 * @typedef {{
 *   buildChangeState: typeof buildChangeState,
 *   deterministicInvariantImpact: typeof deterministicInvariantImpact,
 *   extractCanonicalInvariants: typeof extractCanonicalInvariants,
 * }} TrustedImpactRuntime
 */

const DEFAULT_RUNTIME = Object.freeze({
  buildChangeState,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
});

function browserSeverity(value) {
  if (value !== "CRITICAL" && value !== "HIGH") {
    throw new Error(
      "Trusted browser impact encountered unsupported invariant severity: " +
        String(value),
    );
  }
  return value;
}

/**
 * Build the mandatory browser-swarm impact set from trusted repository state.
 *
 * This function intentionally has no Jev/model input. Candidate- or caller-
 * supplied missions may be additive later, but this deterministic set is the
 * floor and must never be removed or rewritten by candidate code.
 *
 * @param {{
 *   repoRoot?: string,
 *   baseSha: string,
 *   headSha: string,
 *   runtimeOverrides?: Partial<TrustedImpactRuntime>,
 * }} options
 */
export function buildTrustedBrowserSwarmImpact({
  repoRoot = process.cwd(),
  baseSha,
  headSha,
  runtimeOverrides = {},
}) {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const invariants = runtime.extractCanonicalInvariants(repoRoot);
  const change = runtime.buildChangeState({ repoRoot, baseSha, headSha });
  const deterministicImpact = runtime.deterministicInvariantImpact(
    change.changedFiles,
    invariants,
  );

  const impactedInvariants = deterministicImpact
    .map((impact) => ({
      id: impact.id,
      severity: browserSeverity(impact.severity),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    version: TRUSTED_IMPACT_VERSION,
    authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
    baseSha,
    headSha,
    changedFiles: [...change.changedFiles].sort((left, right) =>
      left.localeCompare(right),
    ),
    impactedInvariants,
    shouldRun: impactedInvariants.length > 0,
  };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   env?: Record<string, string | undefined>,
 *   runtimeOverrides?: Partial<TrustedImpactRuntime>,
 * }} [options]
 */
export async function writeTrustedBrowserSwarmImpact({
  repoRoot = process.cwd(),
  env = process.env,
  runtimeOverrides = {},
} = {}) {
  const baseSha = env.BASE_SHA;
  const headSha = env.HEAD_SHA;
  if (!baseSha || !headSha) {
    throw new Error(
      "Trusted browser swarm impact requires exact BASE_SHA and HEAD_SHA.",
    );
  }

  const payload = buildTrustedBrowserSwarmImpact({
    repoRoot,
    baseSha,
    headSha,
    runtimeOverrides,
  });
  const outputDir = path.join(repoRoot, "artifacts");
  const outputPath = path.join(
    outputDir,
    "browser-swarm-trusted-impact.json",
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stdout.write(
    "Trusted browser swarm impact: " +
      payload.impactedInvariants.length +
      " invariant(s)\n",
  );
  return payload;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await writeTrustedBrowserSwarmImpact();
}
