import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
} from "./jevImpact.mjs";

/**
 * @typedef {Object} ShadowRuntime
 * @property {typeof buildChangeState} buildChangeState
 * @property {typeof buildJevQuestions} buildJevQuestions
 * @property {typeof callJev} callJev
 * @property {typeof deriveReviewMatrix} deriveReviewMatrix
 * @property {typeof deterministicInvariantImpact} deterministicInvariantImpact
 * @property {typeof extractCanonicalInvariants} extractCanonicalInvariants
 * @property {typeof extraDeterministicRequirementsForFiles} extraDeterministicRequirementsForFiles
 * @property {typeof normalizeJevResponse} normalizeJevResponse
 */

const DEFAULT_RUNTIME = Object.freeze({
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  extraDeterministicRequirementsForFiles,
  normalizeJevResponse,
});

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function inlineCode(value) {
  return `\`${String(value).replace(/[\r\n`]/g, " ")}\``;
}

function summaryText(value) {
  return String(value).replace(/[\r\n<>]/g, " ");
}

function redactSecret(value, secret) {
  const text = String(value);
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

export function buildSummaryMarkdown(payload) {
  const lines = [
    "## Jev Shadow Impact",
    "",
    `**Status:** ${payload.status}`,
    "",
    "Advisory only. This signal cannot remove, waive, or satisfy an existing AutoFlow deterministic gate.",
  ];

  if (payload.status === "ADVISORY_COMPLETE") {
    const topRisks = Object.entries(payload.risks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, probability]) => `- ${inlineCode(name)}: ${percent(probability)}`);
    const topInvariants = Object.entries(payload.invariantImpact)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, probability]) => `- ${inlineCode(id)}: ${percent(probability)}`);
    lines.push(
      "",
      `Model: ${inlineCode(payload.model)}`,
      `Input tokens: ${payload.usage.input_tokens}`,
      `Patch excerpt sent: ${payload.patchCharsSent} chars${payload.patchTruncated ? " (head/tail truncated)" : ""}`,
      "",
      "### Highest Jev risk probabilities",
      ...topRisks,
      "",
      "### Highest invariant-impact probabilities",
      ...topInvariants,
      "",
      "### Deterministic source-area impacts",
      ...(payload.deterministicImpact.length
        ? payload.deterministicImpact.map(
            (impact) =>
              `- ${inlineCode(impact.id)}: ${impact.matchingFiles
                .map((file) => inlineCode(file))
                .join(", ")}`,
          )
        : ["- none"]),
      "",
      "### Combined advisory review matrix",
      ...payload.reviewMatrix.combinedRequirements.map(
        (item) => `- ${inlineCode(item)}`,
      ),
    );
  } else if (payload.reason) {
    lines.push("", `Reason: ${inlineCode(summaryText(payload.reason))}`);
  }

  return `${lines.join("\n")}\n`;
}

async function writeArtifacts({ repoRoot, payload }) {
  const outputDir = path.join(repoRoot, "artifacts");
  const outputPath = path.join(outputDir, "jev-shadow-impact.json");
  const summaryPath = path.join(outputDir, "jev-shadow-summary.md");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
    writeFile(summaryPath, buildSummaryMarkdown(payload), "utf8"),
  ]);
  process.stdout.write(`Jev shadow result: ${payload.status}\n`);
  process.stdout.write(`Artifact: ${path.relative(repoRoot, outputPath)}\n`);
  return payload;
}

/**
 * @param {{
 *   repoRoot?: string,
 *   env?: Record<string, string | undefined>,
 *   runtimeOverrides?: Partial<ShadowRuntime>,
 * }} [options]
 */
export async function runJevShadowImpact({
  repoRoot = process.cwd(),
  env = process.env,
  runtimeOverrides = {},
} = {}) {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  const baseSha = env.BASE_SHA;
  const headSha = env.HEAD_SHA;
  const apiKey = env.TYPESAFE_API_KEY?.trim();

  if (!baseSha || !headSha) {
    return writeArtifacts({
      repoRoot,
      payload: {
        status: "ADVISORY_UNAVAILABLE",
        blocking: false,
        reason: "BASE_SHA or HEAD_SHA is missing",
      },
    });
  }

  if (!apiKey) {
    return writeArtifacts({
      repoRoot,
      payload: {
        status: "SKIPPED_NO_CREDENTIAL",
        blocking: false,
        reason: "TYPESAFE_API_KEY is unavailable to this trusted workflow context.",
        baseSha,
        headSha,
      },
    });
  }

  try {
    // The secret-bearing workflow executes the harness and canonical invariant
    // catalog from trusted main. Candidate code is Git data only. A PR must not
    // be able to shrink its own impact map by editing invariant metadata.
    const invariants = runtime.extractCanonicalInvariants(repoRoot);
    const change = runtime.buildChangeState({ repoRoot, baseSha, headSha });
    const deterministicImpact = runtime.deterministicInvariantImpact(
      change.changedFiles,
      invariants,
    );
    const extraDeterministicRequirements =
      runtime.extraDeterministicRequirementsForFiles(change.changedFiles);
    const changesCorrectnessGovernance =
      extraDeterministicRequirements.includes("review:correctness-governance");
    const questions = runtime.buildJevQuestions(invariants);
    const rawResponse = await runtime.callJev({
      apiKey,
      state: change.state,
      questions,
    });
    const jev = runtime.normalizeJevResponse(rawResponse, invariants);
    const reviewMatrix = runtime.deriveReviewMatrix({
      deterministicImpact,
      extraDeterministicRequirements,
      risks: jev.risks,
      invariantImpact: jev.invariantImpact,
    });

    return writeArtifacts({
      repoRoot,
      payload: {
        status: "ADVISORY_COMPLETE",
        blocking: false,
        authority:
          "Jev may add scrutiny only. Existing AutoFlow tests, invariant proofs, preview rehearsals, required checks, and reviewer decisions remain authoritative.",
        baseSha,
        headSha,
        changedFiles: change.changedFiles,
        patchTruncated: change.patchTruncated,
        patchCharsSent: change.patchCharsSent,
        model: jev.model,
        usage: jev.usage,
        risks: jev.risks,
        invariantImpact: jev.invariantImpact,
        deterministicImpact,
        changesCorrectnessGovernance,
        reviewMatrix,
      },
    });
  } catch (error) {
    const reason = redactSecret(
      error instanceof Error ? error.message : String(error),
      apiKey,
    ).slice(0, 1_000);
    return writeArtifacts({
      repoRoot,
      payload: {
        status: "ADVISORY_UNAVAILABLE",
        blocking: false,
        reason,
        baseSha,
        headSha,
      },
    });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runJevShadowImpact();
}
