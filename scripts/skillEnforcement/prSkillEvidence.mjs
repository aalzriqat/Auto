/**
 * Evaluation of a PR's "Skill evidence" section. I/O is supplied through
 * callbacks, so the same rules judge every PR. Both workflows use the base
 * branch's code, so a PR cannot edit its own judge.
 *
 * It verifies form only. The seats' own signed PR comments, not this check,
 * are the authoritative evidence that a review happened. It checks that the
 * evidence is present, well formed and internally consistent: Seat 1 is a different session and Opus 5.5
 * (or explicitly waived by owner-proxy ruling with expiry and scope), Seat 2 is gpt-6-sol
 * or gpt-6.1-sol (or Codex) at medium or lower with independent same-PR certification, the red run shows a failure, and certified SHAs are the
 * PR head or a commit in the PR's own range, and the red run names a test file
 * that is in the PR diff. It cannot prove the text is true; the links let the
 * owner verify.
 */
import { classifyPaths, requiredSkills } from "./policy.mjs";

export const SECTION = "## Skill evidence";
export const CANONICAL_ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/;
export const MAX_WAIVER_HORIZON_DAYS = 90;
export const MAX_WAIVER_HORIZON_MS = MAX_WAIVER_HORIZON_DAYS * 24 * 60 * 60 * 1000;
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LOCAL_SESSION = new RegExp(`^local:(${UUID})$`, "i");
const SESSION_ID = new RegExp(`^${UUID}$`, "i");
const PLACEHOLDER_WORDS = new Set(["", "n/a", "none", "-", "todo", "tbd", "pending", "placeholder", "mock", "dummy", "fake"]);
// A failure needs a non-zero count ("1 failed"), an upper-case FAIL, an AssertionError or a cross mark.
// "0 failed" and prose such as "no error" do not count.
const FAILURE_SIGNS = /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\bFAIL(?:ED)?\b|AssertionError|[✗✕×]/;
const SEAT1_MODEL = /^(?:claude-)?opus[\s-]5[.\s-]5(?:\s*\(.*\))?$/i;
const SEAT1_WAIVED = /^WAIVED(?:\s*\(.*\))?$/i;
// Exactly gpt-6-sol, gpt-6.1-sol or Codex; the dot is escaped so "gpt-6x1-sol" cannot match.
const SEAT2_MODEL = /^(?:gpt-6(?:\.1)?-sol|codex)(?:\s*\(.*\))?$/i;
const SEAT2_EFFORT = /^(?:low|medium)(?:\s*\(.*\))?$/i;

/**
 * A block is a placeholder only when it is the whole content: empty, a single
 * <angle-bracket instruction>, or one bare filler word. Real output may contain
 * generics (Promise<void>) or the word "pending".
 */
export function isPlaceholder(block) {
  const t = String(block ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (PLACEHOLDER_WORDS.has(t)) return true;
  return t.startsWith("<") && t.endsWith(">") && !t.slice(1, -1).includes("<") && !t.includes("\n");
}

const CLAUDE_SESSION_RE = /^https:\/\/claude\.ai\/code\/session_([a-z0-9]+)$/i;
const LOCAL_SESSION_RE = /^(?:local:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Normalizes a session identifier or URL to a canonical lowercase token.
 * Returns null if the session is not in a recognized canonical format.
 */
export function canonicalSessionId(session) {
  if (!session || typeof session !== "string") return null;
  const s = session.trim();
  const claudeMatch = CLAUDE_SESSION_RE.exec(s);
  if (claudeMatch) return claudeMatch[1].toLowerCase();
  const localMatch = LOCAL_SESSION_RE.exec(s);
  if (localMatch) return localMatch[1].toLowerCase();
  return null;
}

/**
 * Validates that a session ID or URL does not use trivial placeholder / mock patterns
 * (e.g. repeating characters like session_1111111111111111 or local:00000000-0000-0000-0000-000000000000),
 * and confirms that the session conforms to a supported canonical format.
 */
export function isPlaceholderSession(session) {
  if (!session) return true;
  const s = String(session).trim();
  if (isPlaceholder(s)) return true;
  if (/(?:mock|dummy|placeholder|fake|example)/i.test(s)) return true;
  const canonical = canonicalSessionId(s);
  if (!canonical) return true;
  const rawId = canonical.replaceAll("-", "").toLowerCase();
  const distinct = new Set(rawId);
  return distinct.size <= 2;
}

function section(body) {
  const i = body.indexOf(SECTION);
  if (i < 0) return null;
  const rest = body.slice(i + SECTION.length);
  const next = rest.search(/\n##\s(?!#)/);
  const text = next < 0 ? rest : rest.slice(0, next);
  return { text };
}

const withoutSeat1Line = (body) =>
  String(body).split("\n").filter((l) => !/^[ \t]*[-*]?[ \t]*Seat 1 session[ \t]*:/i.test(l)).join("\n");

const line = (text, label) =>
  text.match(new RegExp(String.raw`^[ \t]*[-*]?[ \t]*${label}[ \t]*:[ \t]*(.+)$`, "im"))?.[1].trim();

export function localReviewUrl(body) {
  const text = section(body ?? "")?.text;
  return text && LOCAL_SESSION.test(line(text, "Seat 1 session") ?? "") ? line(text, "Seat 1 review") : undefined;
}

export function referencedCommentUrls(body) {
  const text = section(body ?? "")?.text;
  if (!text) return [];
  const urls = [];
  const s1Review = line(text, "Seat 1 review");
  if (s1Review) urls.push(s1Review);
  const s1Waiver = line(text, "Seat 1 waiver") ?? line(text, "Seat 1 waiver review");
  if (s1Waiver) urls.push(s1Waiver);
  const s2Review = line(text, "Seat 2 review");
  if (s2Review) urls.push(s2Review);
  return urls;
}

/**
 * The fenced block that belongs to this item: it must open on the label's line
 * or before the next list item. A fence further down the section, under another
 * label, is not this item's.
 */
function fenced(text, label) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.toLowerCase().replace(/^[\s*-]+/, "").startsWith(label.toLowerCase()));
  if (at < 0) return undefined;
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      const close = lines.findIndex((l, j) => j > i && l.trimStart().startsWith("```"));
      return close < 0 ? undefined : lines.slice(i + 1, close).join("\n").trim();
    }
    if (/^\s*[-*]\s/.test(lines[i])) return undefined;
  }
  return undefined;
}

function checkSkills(t, classes) {
  const needed = new Set([...requiredSkills("commit", classes), ...requiredSkills("pr", classes)].map((s) => s.skill));
  const claimed = new Set((line(t, "Skills run") ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean));
  return [...needed].filter((s) => !claimed.has(s)).map((s) => `"Skills run" must list ${s}.`);
}

const NO_BEHAVIOUR_CHANGE = /no behaviou?r change/i;

/**
 * A change that touches only test files and docs has no failing test to show.
 * It may replace the red run with a one-line reason, but only when no changed
 * file is money or permission source and both seat SHA lines confirm "no
 * behaviour change" for that SHA. Any sensitive source file needs a real red run.
 */
function noBehaviourChange(t, classes) {
  if (classes.behaviour.length > 0) return false;
  const reason = line(t, "Red run")?.match(/^no behaviou?r change\b\s*[:\u2013-]?\s*(.*)$/i)?.[1] ?? null;
  if (reason === null || reason.length < 10 || isPlaceholder(reason)) return false;
  return ["Seat 1 SHA", "Seat 2 SHA"].every((l) => NO_BEHAVIOUR_CHANGE.test(line(t, l) ?? ""));
}

const TEST_FILE_TOKEN = /[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?/g;
const REVIEW_AXES = /reuse|simplif|efficien|altitude|no changes|no findings/i;
const MIN_SIMPLIFY_LENGTH = 40;

const inDiff = (token, files) => {
  const t = token.replace(/^\.\//, "");
  return files.some((f) => f === t || f.endsWith(`/${t}`));
};

function checkRedRun(t, files, classes) {
  if (noBehaviourChange(t, classes)) return [];
  const red = fenced(t, "Red run");
  if (red === undefined || isPlaceholder(red)) {
    return ['"Red run" needs a fenced block with the failing test output from before the fix.'];
  }
  if (!FAILURE_SIGNS.test(red)) return ['"Red run" output does not show a failure.'];
  if (!(red.match(TEST_FILE_TOKEN) ?? []).some((tok) => inDiff(tok, files))) {
    return ['"Red run" must name a test file in this PR (a path that appears in the PR diff) and show its failure.'];
  }
  return [];
}

function checkOutputs(t, files, classes) {
  const problems = classes.sensitive.length > 0 ? checkRedRun(t, files, classes) : [];
  const simplify = fenced(t, "/simplify output");
  if (simplify === undefined || isPlaceholder(simplify) || simplify.length < MIN_SIMPLIFY_LENGTH || !REVIEW_AXES.test(simplify)) {
    problems.push('"/simplify output" needs a fenced block with the real output: at least 40 characters that name what was reviewed (reuse, simplification, efficiency, altitude, or no changes/findings).');
  }
  return problems;
}

async function checkLocalSeat(t, otherSessionText, local, localReview) {
  const problems = [];
  const implementer = line(t, "Implementer session") ?? "";
  if (!SESSION_ID.test(implementer)) problems.push('Local review needs an explicit "Implementer session" UUID.');
  if (local === implementer.toLowerCase() || otherSessionText.toLowerCase().includes(local)) {
    problems.push("Seat 1 session is the implementing session. Seat 1 must be a separate session.");
  }
  const sha = line(t, "Seat 1 SHA")?.match(/^[0-9a-f]{40}\b/i)?.[0].toLowerCase();
  if (!sha) problems.push("Local review needs the full 40-character Seat 1 SHA.");
  if (!localReview) problems.push("Local review could not be verified against its signed PR comment.");
  else problems.push(...await localReview({ url: line(t, "Seat 1 review"), session: local, sha }));
  return problems;
}

async function checkCommentWaiver(waiverUrl, ruling, headSha, ownerWaiver) {
  if (!ownerWaiver) {
    return ["Seat 1 waiver could not be verified against its signed PR comment."];
  }
  return await ownerWaiver({ url: waiverUrl, ruling, seat: "Seat 1", sha: headSha });
}

function checkRegistryWaiver(waivers, prNumber, headSha, ruling) {
  const matching = (waivers ?? []).find(
    (w) => Number(w.pr) === Number(prNumber) &&
           String(w.seat ?? "").trim().toLowerCase() === "seat 1" &&
           (!headSha || String(w.head ?? "").trim().toLowerCase() === String(headSha).trim().toLowerCase())
  );
  if (!matching) {
    return ["Waived Seat 1 must link to an owner-proxy waiver comment or be registered in skill-waivers.json."];
  }
  const problems = [];
  if (ruling && matching.ruling && matching.ruling.trim() !== ruling.trim()) {
    problems.push(`Seat 1 waiver in skill-waivers.json specifies ruling "${matching.ruling}", which does not match declared ruling "${ruling}".`);
  }
  const expires = matching.expires;
  const expiryMs = Date.parse(expires ?? "");
  if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
    problems.push(`Seat 1 waiver for PR ${matching.pr} expired on ${expires}.`);
    return problems;
  }
  if (!CANONICAL_ISO_DATE.test(String(expires).trim())) {
    problems.push(`Seat 1 waiver for PR ${matching.pr} has an invalid expiration date in skill-waivers.json.`);
    return problems;
  }
  if (expiryMs > Date.now() + MAX_WAIVER_HORIZON_MS) {
    problems.push(`Seat 1 waiver for PR ${matching.pr} expiration date ${expires} exceeds maximum policy horizon of ${MAX_WAIVER_HORIZON_DAYS} days.`);
  }
  return problems;
}

async function checkWaivedSeat1(t, options) {
  const { ownerWaiver, waivers = [], prNumber, headSha } = options;
  const problems = [];
  const ruling = line(t, "Seat 1 waiver ruling") ?? line(t, "Seat 1 ruling") ?? line(t, "Waiver ruling");
  if (!ruling || isPlaceholder(ruling)) {
    problems.push('Waived Seat 1 requires an explicit "Seat 1 waiver ruling" (e.g. SCRUM-760 c24127).');
  }
  const waiverUrl = line(t, "Seat 1 waiver") ?? line(t, "Seat 1 waiver review");
  if (waiverUrl) {
    problems.push(...await checkCommentWaiver(waiverUrl, ruling, headSha, ownerWaiver));
  } else {
    problems.push(...checkRegistryWaiver(waivers, prNumber, headSha, ruling));
  }
  return problems;
}

async function checkStandardSeat1(t, otherSessionText, seat1Model, localReview) {
  const problems = [];
  const sessionText = line(t, "Seat 1 session") ?? "";
  if (isPlaceholderSession(sessionText)) {
    problems.push('"Seat 1 session" is an unverified placeholder session pattern.');
  } else {
    const local = sessionText.match(LOCAL_SESSION)?.[1].toLowerCase();
    if (local) {
      problems.push(...await checkLocalSeat(t, otherSessionText, local, localReview));
    } else {
      const urls = sessionText.match(SESSION_URL) ?? [];
      if (urls.length !== 1) {
        problems.push('"Seat 1 session" must be one https://claude.ai/code/session_… link or local:<UUID>.');
      } else if ((otherSessionText.match(SESSION_URL) ?? []).includes(urls[0])) {
        problems.push("Seat 1 session is the implementing session. Seat 1 must be a separate session.");
      }
    }
  }
  if (!SEAT1_MODEL.test(seat1Model)) {
    problems.push('"Seat 1 model" must be Opus 5.5.');
  }
  return problems;
}

async function checkSeat2(t, isWaived, codexReview) {
  const problems = [];
  const seat2Model = line(t, "Seat 2 model") ?? "";
  if (!SEAT2_MODEL.test(seat2Model)) {
    problems.push('"Seat 2 model" must be gpt-6-sol or gpt-6.1-sol (Codex).');
  }
  const seat2Effort = line(t, "Seat 2 effort") ?? "";
  if (!SEAT2_EFFORT.test(seat2Effort)) {
    problems.push('"Seat 2 effort" must be low or medium.');
  }

  const seat2Review = line(t, "Seat 2 review");
  const implementerSession = line(t, "Implementer session") ?? line(t, "Implementer");
  if (isWaived) {
    if (!implementerSession || isPlaceholder(implementerSession) || !canonicalSessionId(implementerSession)) {
      problems.push('Waived Seat 1 requires a declared "Implementer session" UUID for reviewer independence verification.');
    }
    if (!seat2Review || isPlaceholder(seat2Review)) {
      problems.push('When Seat 1 is waived, "Seat 2 review" must link to an independent Codex review comment on this PR.');
    } else if (codexReview) {
      const sha = line(t, "Seat 2 SHA")?.match(/^[0-9a-f]{7,40}\b/i)?.[0];
      problems.push(...await codexReview({ url: seat2Review, sha, implementerSession }));
    }
  } else if (seat2Review && !isPlaceholder(seat2Review) && codexReview) {
    const sha = line(t, "Seat 2 SHA")?.match(/^[0-9a-f]{7,40}\b/i)?.[0];
    problems.push(...await codexReview({ url: seat2Review, sha, implementerSession }));
  }
  return problems;
}

async function checkSeats(t, otherSessionText, options) {
  const opts = typeof options === "function" ? { localReview: options } : (options ?? {});
  const problems = [];
  const waivedSeats = new Set();

  const seat1Model = line(t, "Seat 1 model") ?? "";
  const isSeat1Waived = SEAT1_WAIVED.test(seat1Model) || line(t, "Seat 1") === "WAIVED" || line(t, "Seat 1 status") === "WAIVED";

  if (isSeat1Waived) {
    waivedSeats.add("Seat 1");
    problems.push(...await checkWaivedSeat1(t, opts));
  } else {
    problems.push(...await checkStandardSeat1(t, otherSessionText, seat1Model, opts.localReview));
  }

  problems.push(...await checkSeat2(t, waivedSeats.has("Seat 1"), opts.codexReview));
  return { problems, waivedSeats };
}

async function checkShas(t, isPrCommit, waivedSeats = new Set()) {
  const problems = [];
  for (const seat of ["Seat 1", "Seat 2"]) {
    if (waivedSeats.has(seat)) continue;
    const sha = line(t, `${seat} SHA`)?.match(/^[0-9a-f]{7,40}\b/i)?.[0];
    if (!sha) problems.push(`"${seat} SHA" must be the certified head SHA.`);
    else if (isPrCommit && !(await isPrCommit(sha))) {
      problems.push(`${seat} SHA ${sha} is not the PR head or a commit in this PR's own range.`);
    }
  }
  return problems;
}

/**
 * @param {{body:string, files:string[], isPrCommit?:(sha:string)=>Promise<boolean>, commitText?:string,
 * localReview?:(evidence:{url:string|undefined,session:string,sha:string|undefined})=>Promise<string[]>,
 * ownerWaiver?:(evidence:{url:string|undefined,ruling:string|undefined,seat:string,sha:string|undefined})=>Promise<string[]>,
 * codexReview?:(evidence:{url:string|undefined,sha:string|undefined})=>Promise<string[]>,
 * waivers?:Array<{pr:number,head?:string,seat?:string,ruling?:string,expires?:string,authority?:string,reason?:string}>,
 * prNumber?:number|string, headSha?:string}} p
 * `commitText` is the PR commit messages, which carry the implementing session link.
 * @returns {Promise<{required:boolean, ok:boolean, problems:string[], waivedSeats:Set<string>}>}
 */
export async function evaluate({
  body,
  files,
  isPrCommit,
  commitText = "",
  localReview,
  ownerWaiver,
  codexReview,
  waivers = [],
  prNumber,
  headSha,
}) {
  const classes = classifyPaths(files);
  if (classes.sensitive.length === 0 && classes.gate.length === 0) return { required: false, ok: true, problems: [] };
  const sec = section(body ?? "");
  if (!sec) return { required: true, ok: false, problems: [`PR body has no "${SECTION}" section.`] };
  const seatsResult = await checkSeats(sec.text, `${withoutSeat1Line(body)}\n${commitText}`, {
    localReview,
    ownerWaiver,
    codexReview,
    waivers,
    prNumber,
    headSha,
  });
  const problems = [
    ...checkSkills(sec.text, classes),
    ...checkOutputs(sec.text, files, classes),
    ...seatsResult.problems,
    ...(await checkShas(sec.text, isPrCommit, seatsResult.waivedSeats)),
  ];
  return { required: true, ok: problems.length === 0, problems, ...(seatsResult.waivedSeats.size > 0 ? { waivedSeats: seatsResult.waivedSeats } : {}) };
}

export const TEMPLATE = `${SECTION}
- Skills run: tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop
- Red run:
\`\`\`
<failing test output before the fix>
\`\`\`
- /simplify output:
\`\`\`
<real output>
\`\`\`
- Seat 1 session: local:<UUID> OR https://claude.ai/code/session_… (OR Seat 1 model: WAIVED)
- Implementer session: <UUID, required for local reviews>
- Seat 1 review: <same-PR signed issue-comment URL, required for local reviews>
- Seat 1 model: claude-opus-5-5 (OR WAIVED)
- Seat 1 waiver ruling: <e.g. SCRUM-760 c24127, required if Seat 1 waived>
- Seat 1 waiver: <same-PR owner waiver comment URL, if Seat 1 waived>
- Seat 1 SHA: <head sha, required if Seat 1 not waived>
- Seat 2 model: gpt-6.1-sol
- Seat 2 effort: medium
- Seat 2 review: <same-PR signed Codex review comment URL, required if Seat 1 waived>
- Seat 2 SHA: <head sha>`;
