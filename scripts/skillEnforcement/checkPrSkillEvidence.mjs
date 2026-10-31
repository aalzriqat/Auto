/**
 * CI entry for the `skill-evidence` check. Env: GH_TOKEN, REPO (owner/name),
 * PR_NUMBER. Reads the PR body and files live through the REST API (the event
 * payload goes stale on re-runs). Runs from the base branch only. Uses fetch,
 * not a CLI, so no executable is resolved through PATH.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  TEMPLATE,
  CANONICAL_ISO_DATE,
  MAX_WAIVER_HORIZON_DAYS,
  MAX_WAIVER_HORIZON_MS,
  isPlaceholder,
  isPlaceholderSession,
} from "./prSkillEvidence.mjs";

const API = "https://api.github.com";
const FORM_ONLY =
  "This check verifies form only, identity separation and report consistency. Metadata and GitHub account association cannot cryptographically prove human authorship or model execution; the seats' own signed PR comments and session links allow human verification.";

export const AUTHORIZED_RULINGS = new Set([
  "SCRUM-760 c24127",
  "SCRUM-760 c24128",
]);

const reportLine = (body, label) => {
  const matches = [...String(body).matchAll(new RegExp(`^${label}: ?(.+)$`, "gim"))];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
};

const HEX_SHA40 = /^[0-9a-f]{40}$/i;

export function loadSkillWaivers(filePath = ".github/skill-waivers.json") {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed?.waivers)) {
      throw new TypeError("Invalid skill-waivers schema: 'waivers' array required");
    }
    for (const w of parsed.waivers) {
      if (
        typeof w !== "object" ||
        w === null ||
        typeof w.pr !== "number" ||
        !Number.isInteger(w.pr) ||
        w.pr <= 0 ||
        typeof w.head !== "string" ||
        !HEX_SHA40.test(w.head.trim()) ||
        typeof w.seat !== "string" ||
        !w.seat.trim() ||
        typeof w.ruling !== "string" ||
        !w.ruling.trim() ||
        typeof w.expires !== "string" ||
        !CANONICAL_ISO_DATE.test(w.expires.trim()) ||
        Number.isNaN(Date.parse(w.expires.trim()))
      ) {
        throw new TypeError("Invalid skill-waivers entry: pr, full 40-character head SHA, seat, ruling, and valid ISO expires are required");
      }
    }
    return parsed.waivers;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function verifyLocalReview({ url, session, sha }, { repo, pr, head, fetchImpl, token }) {
  // Never fetch a caller-supplied URL: validate the same-PR reference, then use
  // a fixed GitHub API endpoint. PR text and report text are data, never code.
  const prefix = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const id = url?.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(id)) return ["Seat 1 review must link to an issue comment on this PR."];
  if (sha !== head.toLowerCase()) return ["Local review must certify the full current PR head SHA."];
  const comment = await getJson(fetchImpl, token, `/repos/${repo}/issues/comments/${id}`);
  if (comment?.html_url !== url || comment?.issue_url !== `${API}/repos/${repo}/issues/${pr}`) {
    return ["Seat 1 review comment does not belong to this PR."];
  }
  if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment?.author_association)) {
    return ["Local review must be published by a repository owner, member or collaborator."];
  }
  const body = comment?.body;
  if (typeof body !== "string" || body.includes("<!--")) {
    return ["Local Claude report fields must be visible, not inside HTML comments."];
  }
  const valid = reportLine(body, "Local Claude session")?.toLowerCase() === session &&
    reportLine(body, "Local Claude model") === "claude-opus-5-5" &&
    reportLine(body, "Local Claude effort") === "high" &&
    reportLine(body, "Local Claude SHA")?.toLowerCase() === sha &&
    reportLine(body, "Local Claude verdict") === "CERTIFY" &&
    reportLine(body, "Signed")?.length >= 5;
  return valid ? [] : ["Local Claude signed report must match the session, Opus 5.5 high, current head SHA and CERTIFY verdict."];
}

function validateWaiverCommentAccess(comment, url, repo, pr, seat) {
  if (comment?.html_url !== url || comment?.issue_url !== `${API}/repos/${repo}/issues/${pr}`) {
    return [`${seat} waiver comment does not belong to this PR.`];
  }
  if (comment?.author_association !== "OWNER") {
    return [`${seat} waiver must be published by the repository owner (author association OWNER).`];
  }
  const body = comment?.body;
  if (typeof body !== "string" || body.includes("<!--")) {
    return [`${seat} waiver fields must be visible, not inside HTML comments.`];
  }
  return [];
}

function validateWaiverExpiry(expires, seat) {
  if (!expires) {
    return [`${seat} waiver must declare an explicit ISO expiration date.`];
  }
  const trimmed = expires.trim();
  if (!CANONICAL_ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    return [`${seat} waiver has an invalid expiration date (must be canonical ISO-8601 UTC date or datetime).`];
  }
  const expiryMs = Date.parse(trimmed);
  if (expiryMs <= Date.now()) {
    return [`${seat} waiver expired on ${trimmed}.`];
  }
  if (expiryMs > Date.now() + MAX_WAIVER_HORIZON_MS) {
    return [`${seat} waiver expiration date ${trimmed} exceeds maximum policy horizon of ${MAX_WAIVER_HORIZON_DAYS} days.`];
  }
  return [];
}

function validateWaiverRuling(commentRuling, declaredRuling, seat, waivers = []) {
  if (!commentRuling) {
    return [`${seat} waiver comment must declare an authorized Ruling.`];
  }
  const trimmed = commentRuling.trim();
  const isAuthorized = AUTHORIZED_RULINGS.has(trimmed) || waivers.some((w) => w.ruling?.trim() === trimmed);
  if (!isAuthorized) {
    return [`${seat} waiver ruling "${commentRuling}" is not an authorized ruling from the trusted base.`];
  }
  if (declaredRuling && trimmed !== declaredRuling.trim()) {
    return [`${seat} waiver ruling "${commentRuling}" does not match declared ruling "${declaredRuling}".`];
  }
  return [];
}

function validateWaiverHead(commentSha, head, seat) {
  if (!commentSha || !HEX_SHA40.test(commentSha.trim())) {
    return [`${seat} waiver comment must declare the full 40-character Head SHA.`];
  }
  if (head && commentSha.trim().toLowerCase() !== head.trim().toLowerCase()) {
    return [`${seat} waiver comment certifies ${commentSha}, which does not match PR head ${head}.`];
  }
  return [];
}

/**
 * @param {{ url?: string, ruling?: string, sha?: string, seat: string }} evidence
 * @param {{ repo: string, pr: string|number, head: string, fetchImpl: typeof fetch, token: string, waivers?: any[] }} context
 */
export async function verifyOwnerWaiver({ url, ruling, sha, seat }, { repo, pr, head, fetchImpl, token, waivers = [] }) {
  const prefix = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const id = url?.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(id)) return [`${seat} waiver must link to an issue comment on this PR.`];
  if (!sha || !HEX_SHA40.test(sha.trim()) || (head && sha.trim().toLowerCase() !== head.toLowerCase())) {
    return [`${seat} waiver must address the full current PR head SHA.`];
  }

  const comment = await getJson(fetchImpl, token, `/repos/${repo}/issues/comments/${id}`);
  const accessProblems = validateWaiverCommentAccess(comment, url, repo, pr, seat);
  if (accessProblems.length > 0) return accessProblems;

  const body = comment.body;
  const waiverSeat = reportLine(body, "Owner waiver") ?? reportLine(body, "Waived seat") ?? reportLine(body, "Seat");
  if (waiverSeat?.trim().toLowerCase() !== seat?.trim().toLowerCase()) {
    return [`${seat} waiver comment must declare "${seat}" as the waived seat.`];
  }

  const proxy = reportLine(body, "Proxy") ?? reportLine(body, "Actor-proxy") ?? reportLine(body, "Authority");
  if (!proxy || !/^owner-proxy$/i.test(proxy.trim())) {
    return [`${seat} waiver comment must declare Proxy: owner-proxy.`];
  }

  const verdict = reportLine(body, "Verdict");
  if (verdict?.trim().toUpperCase() !== "WAIVED") {
    return [`${seat} waiver verdict must be WAIVED.`];
  }

  const rulingProblems = validateWaiverRuling(reportLine(body, "Ruling") ?? reportLine(body, "Waiver ruling"), ruling, seat, waivers);
  if (rulingProblems.length > 0) return rulingProblems;

  const headProblems = validateWaiverHead(reportLine(body, "Head SHA") ?? reportLine(body, "SHA"), head, seat);
  if (headProblems.length > 0) return headProblems;

  return validateWaiverExpiry(reportLine(body, "Expires"), seat);
}

/**
 * @param {{ url?: string, sha?: string, implementerSession?: string }} evidence
 * @param {{ repo: string, pr: string|number, head: string, fetchImpl: typeof fetch, token: string }} context
 */
export async function verifyCodexReview({ url, sha, implementerSession }, { repo, pr, head, fetchImpl, token }) {
  const prefix = `https://github.com/${repo}/pull/${pr}#issuecomment-`;
  const id = url?.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[1-9]\d*$/.test(id)) return ["Seat 2 review must link to an issue comment on this PR."];
  if (!sha || !HEX_SHA40.test(sha.trim()) || (head && sha.trim().toLowerCase() !== head.toLowerCase())) {
    return ["Seat 2 review must certify the full current PR head SHA."];
  }

  const comment = await getJson(fetchImpl, token, `/repos/${repo}/issues/comments/${id}`);
  if (comment?.html_url !== url || comment?.issue_url !== `${API}/repos/${repo}/issues/${pr}`) {
    return ["Seat 2 review comment does not belong to this PR."];
  }
  if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment?.author_association)) {
    return ["Seat 2 review must be published by a repository owner, member or collaborator."];
  }

  const body = comment?.body;
  if (typeof body !== "string" || body.includes("<!--")) {
    return ["Seat 2 review fields must be visible, not inside HTML comments."];
  }
  if (
    /Review-evidence correction|REVIEW-INTEGRITY HOLD|NOT certified|NOT a certification|Do not CERTIFY|REQUEST CHANGES|CHANGES REQUESTED/i.test(body)
  ) {
    return ["Seat 2 review comment is a review correction/rejection, not a certification."];
  }

  const verdict = reportLine(body, "Verdict");
  if (verdict?.trim().toUpperCase() !== "CERTIFY" && verdict?.trim().toUpperCase() !== "CERTIFIED") {
    return ["Seat 2 review comment must declare Verdict: CERTIFY."];
  }
  if (/\bpending\s+review\b/i.test(body) || /\bREVIEW\s+PENDING\b/i.test(body)) {
    return ["Seat 2 review comment indicates review is pending, not completed."];
  }

  const commentSha = reportLine(body, "Head SHA") ?? reportLine(body, "SHA");
  if (!commentSha || !HEX_SHA40.test(commentSha.trim()) || commentSha.trim().toLowerCase() !== head.toLowerCase()) {
    return [`Seat 2 review comment must certify full current PR head SHA ${head}.`];
  }

  const reviewer = reportLine(body, "Reviewer") ?? reportLine(body, "Signed");
  if (!reviewer || isPlaceholder(reviewer)) {
    return ["Seat 2 review comment must declare explicit Reviewer or Signed attribution."];
  }
  if (/implementer/i.test(reviewer)) {
    return ["Seat 2 review must be independent; implementer self-review is refused."];
  }

  const session = reportLine(body, "Session") ?? reportLine(body, "Codex session") ?? reportLine(body, "Reviewer session");
  if (!session || isPlaceholderSession(session)) {
    return ["Seat 2 review comment must declare an actual reviewer Session."];
  }
  if (implementerSession && session.trim().toLowerCase() === implementerSession.trim().toLowerCase()) {
    return ["Seat 2 reviewer session cannot match the implementer session."];
  }

  return [];
}

export async function getJson(fetchImpl, token, path) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "skill-evidence" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function getPages(fetchImpl, token, path) {
  const all = [];
  // GitHub lists at most 3000 entries. Reading page 31 distinguishes exactly
  // 3000 (page 31 is empty) from more than 3000 (page 31 has rows).
  for (let page = 1; page <= 31; page++) {
    const rows = await getJson(fetchImpl, token, `${path}?per_page=100&page=${page}`);
    if (page === 31 && rows.length > 0) break;
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error(`${path} has more than 3000 entries; the check cannot read them all`);
}

/** Returns {exitCode, lines}. All I/O goes through the injected fetch. */
export async function check({ REPO, PR_NUMBER, GH_TOKEN }, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? "") || !/^\d+$/.test(PR_NUMBER ?? "") || !GH_TOKEN) {
    throw new Error("REPO, PR_NUMBER and GH_TOKEN are required");
  }
  const base = `/repos/${REPO}/pulls/${PR_NUMBER}`;
  const pr = await getJson(fetchImpl, GH_TOKEN, base);
  const fileRows = await getPages(fetchImpl, GH_TOKEN, `${base}/files`);
  const files = fileRows.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  // The PR's own range: head plus every commit GitHub lists for the PR.
  // A main commit from before the PR is not accepted as a certified SHA.
  const commits = await getPages(fetchImpl, GH_TOKEN, `${base}/commits`);
  const own = commits.map((c) => c.sha);
  const commitText = commits.map((c) => c.commit?.message ?? "").join("\n");
  own.push(pr.head.sha);
  const isPrCommit = async (sha) => own.some((c) => c.startsWith(sha.toLowerCase()));
  const waivers = loadSkillWaivers();
  const result = await evaluate({
    body: pr.body ?? "",
    files,
    isPrCommit,
    commitText,
    prNumber: PR_NUMBER,
    headSha: pr.head.sha,
    waivers,
    localReview: (evidence) => verifyLocalReview(evidence, {
      repo: REPO, pr: PR_NUMBER, head: pr.head.sha, fetchImpl, token: GH_TOKEN,
    }),
    ownerWaiver: (evidence) => verifyOwnerWaiver(evidence, {
      repo: REPO, pr: PR_NUMBER, head: pr.head.sha, fetchImpl, token: GH_TOKEN, waivers,
    }),
    codexReview: (evidence) => verifyCodexReview(evidence, {
      repo: REPO, pr: PR_NUMBER, head: pr.head.sha, fetchImpl, token: GH_TOKEN,
    }),
  });
  if (!result.required) {
    return { exitCode: 0, headSha: pr.head.sha, lines: ["skill-evidence: no money, permission or gate paths touched; not required."] };
  }
  if (result.ok) {
    const isWaived = result.waivedSeats?.has("Seat 1");
    const summary = isWaived
      ? "skill-evidence: section present and consistent. Seat 1: WAIVED (owner-proxy ruling SCRUM-760 c24127). Seat 2: CERTIFIED."
      : "skill-evidence: section present and consistent.";
    return { exitCode: 0, headSha: pr.head.sha, lines: [summary, FORM_ONLY] };
  }
  return {
    exitCode: 1,
    headSha: pr.head.sha,
    lines: [
      "skill-evidence: FAILED",
      ...result.problems.map((p) => `- ${p}`),
      "",
      FORM_ONLY,
      "",
      `Add this to the PR body and fill it in:\n\n${TEMPLATE}`,
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode, lines } = await check(process.env);
    for (const raw of lines) {
      for (const line of String(raw).split(/\r?\n/)) {
        const sanitized = line.replace(/[\x00-\x1f]/g, " ");
        (exitCode ? console.error : console.log)(sanitized);
      }
    }
    process.exitCode = exitCode;
  } catch (e) {
    const sanitizedError = String(e?.message ?? e).replace(/[\x00-\x1f]/g, " ");
    console.error(sanitizedError);
    process.exitCode = 1;
  }
}
