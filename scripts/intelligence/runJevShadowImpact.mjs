import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  normalizeJevResponse,
} from "./jevImpact.mjs";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "artifacts");
const outputPath = path.join(outputDir, "jev-shadow-impact.json");
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
await mkdir(outputDir, { recursive: true });

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function inlineCode(value) {
  return `\`${String(value).replace(/[\r\n`]/g, " ")}\``;
}

function summaryText(value) {
  return String(value).replace(/[\r\n<>]/g, " ");
}

async function appendSummary(payload) {
  if (!summaryPath) return;
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
      `Model: \`${payload.model}\``,
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
    lines.push("", `Reason: ${summaryText(payload.reason)}`);
  }

  await writeFile(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
}

async function finish(payload) {
  // Never serialize the request state, raw patch, API key, or Authorization header.
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await appendSummary(payload);
  process.stdout.write(`Jev shadow result: ${payload.status}\n`);
  process.stdout.write(`Artifact: ${path.relative(repoRoot, outputPath)}\n`);
}

const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA;
const apiKey = process.env.TYPESAFE_API_KEY;

if (!baseSha || !headSha) {
  await finish({
    status: "ADVISORY_UNAVAILABLE",
    blocking: false,
    reason: "BASE_SHA or HEAD_SHA is missing",
  });
  process.exit(0);
}

if (!apiKey) {
  await finish({
    status: "SKIPPED_NO_CREDENTIAL",
    blocking: false,
    reason:
      "TYPESAFE_API_KEY is unavailable to this trusted workflow context.",
    baseSha,
    headSha,
  });
  process.exit(0);
}

try {
  const invariants = extractCanonicalInvariants(repoRoot, headSha);
  const change = buildChangeState({ repoRoot, baseSha, headSha });
  const deterministicImpact = deterministicInvariantImpact(
    change.changedFiles,
    invariants,
  );
  const questions = buildJevQuestions(invariants);
  const rawResponse = await callJev({
    apiKey,
    state: change.state,
    questions,
  });
  const jev = normalizeJevResponse(rawResponse, invariants);
  const reviewMatrix = deriveReviewMatrix({
    deterministicImpact,
    risks: jev.risks,
    invariantImpact: jev.invariantImpact,
  });

  await finish({
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
    reviewMatrix,
  });
} catch (error) {
  await finish({
    status: "ADVISORY_UNAVAILABLE",
    blocking: false,
    reason: error instanceof Error ? error.message : String(error),
    baseSha,
    headSha,
  });
}
