/**
 * Evaluation of a PR's "Skill evidence" section. I/O is supplied through
 * callbacks, so the same rules judge every PR. Both workflows use the base
 * branch's code, so a PR cannot edit its own judge.
 *
 * It verifies form only. The seats' own signed PR comments, not this check,
 * are the authoritative evidence that a review happened. It checks that the
 * evidence is present, well formed and internally consistent: Seat 1 is a different session and Opus 5.5, Seat 2 is gpt-6-sol
 * at medium or lower, the red run shows a failure, and certified SHAs are the
 * PR head or a commit in the PR's own range, and the red run names a test file
 * that is in the PR diff. It cannot prove the text is true; the links let the
 * owner verify.
 */
import { classifyPaths, requiredSkills } from "./policy.mjs";

export const SECTION = "## Skill evidence";
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LOCAL_SESSION = new RegExp(`^local:(${UUID})$`, "i");
const SESSION_ID = new RegExp(`^${UUID}$`, "i");
const PLACEHOLDER_WORDS = new Set(["", "n/a", "none", "-", "todo", "tbd", "pending", "placeholder"]);
// A failure needs a non-zero count ("1 failed"), an upper-case FAIL, an AssertionError or a cross mark.
// "0 failed" and prose such as "no error" do not count.
const FAILURE_SIGNS = /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\bFAIL(?:ED)?\b|AssertionError|[✗✕×]/;
const SEAT1_MODEL = /^(?:claude-)?opus[\s-]5[.\s-]5(?:\s*\(.*\))?$/i;
const SEAT2_MODEL = /^gpt-6-sol(?:\s*\(.*\))?$/i;
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

async function checkSeats(t, otherSessionText, localReview) {
  const problems = [];
  const sessionText = line(t, "Seat 1 session") ?? "";
  const local = sessionText.match(LOCAL_SESSION)?.[1].toLowerCase();
  if (local) {
    const implementer = line(t, "Implementer session") ?? "";
    if (!SESSION_ID.test(implementer)) problems.push('Local review needs an explicit "Implementer session" UUID.');
    if (local === implementer.toLowerCase() || otherSessionText.toLowerCase().includes(local)) {
      problems.push("Seat 1 session is the implementing session. Seat 1 must be a separate session.");
    }
    const sha = line(t, "Seat 1 SHA")?.match(/^[0-9a-f]{40}\b/i)?.[0].toLowerCase();
    if (!sha) problems.push("Local review needs the full 40-character Seat 1 SHA.");
    if (!localReview) problems.push("Local review could not be verified against its signed PR comment.");
    else problems.push(...await localReview({ url: line(t, "Seat 1 review"), session: local, sha }));
  } else {
    const urls = sessionText.match(SESSION_URL) ?? [];
    if (urls.length !== 1) {
      problems.push('"Seat 1 session" must be one https://claude.ai/code/session_… link or local:<UUID>.');
    } else if ((otherSessionText.match(SESSION_URL) ?? []).includes(urls[0])) {
      problems.push("Seat 1 session is the implementing session. Seat 1 must be a separate session.");
    }
  }
  if (!SEAT1_MODEL.test(line(t, "Seat 1 model") ?? "")) problems.push('"Seat 1 model" must be Opus 5.5.');
  if (!SEAT2_MODEL.test(line(t, "Seat 2 model") ?? "")) problems.push('"Seat 2 model" must be gpt-6-sol (Codex).');
  if (!SEAT2_EFFORT.test(line(t, "Seat 2 effort") ?? "")) problems.push('"Seat 2 effort" must be low or medium.');
  return problems;
}

async function checkShas(t, isPrCommit) {
  const problems = [];
  for (const seat of ["Seat 1", "Seat 2"]) {
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
 * localReview?:(evidence:{url:string|undefined,session:string,sha:string|undefined})=>Promise<string[]>}} p
 * `commitText` is the PR commit messages, which carry the implementing session link.
 * @returns {Promise<{required:boolean, ok:boolean, problems:string[]}>}
 */
export async function evaluate({ body, files, isPrCommit, commitText = "", localReview }) {
  const classes = classifyPaths(files);
  if (classes.sensitive.length === 0 && classes.gate.length === 0) return { required: false, ok: true, problems: [] };
  const sec = section(body ?? "");
  if (!sec) return { required: true, ok: false, problems: [`PR body has no "${SECTION}" section.`] };
  const problems = [
    ...checkSkills(sec.text, classes),
    ...checkOutputs(sec.text, files, classes),
    ...(await checkSeats(sec.text, `${withoutSeat1Line(body)}\n${commitText}`, localReview)),
    ...(await checkShas(sec.text, isPrCommit)),
  ];
  return { required: true, ok: problems.length === 0, problems };
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
- Seat 1 session: local:<UUID> OR https://claude.ai/code/session_…
- Implementer session: <UUID, required for local reviews>
- Seat 1 review: <same-PR signed issue-comment URL, required for local reviews>
- Seat 1 model: claude-opus-5-5
- Seat 1 SHA: <head sha>
- Seat 2 model: gpt-6-sol
- Seat 2 effort: medium
- Seat 2 SHA: <head sha>`;
