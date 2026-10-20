/**
 * Pure evaluation of a PR's "Skill evidence" section. No I/O, so it is testable
 * and the same code judges every PR. The workflow runs it from the base branch
 * (pull_request_target), so a PR cannot edit its own judge.
 *
 * It checks that the evidence is present, well formed and internally
 * consistent (Seat 1 is a different session and Opus 5.5, Seat 2 is gpt-6-sol at
 * medium or lower, the red run actually shows a failure, certified SHAs belong
 * to the PR). It cannot prove the text is true; the links let the owner verify.
 */
import { classifyPaths, requiredSkills } from "./policy.mjs";

export const SECTION = "## Skill evidence";
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const PLACEHOLDER = /\b(todo|tbd|pending|placeholder|lorem)\b|<[^>\n]*>|^\s*(n\/a|none|-)?\s*$/i;

function section(body) {
  const i = body.indexOf(SECTION);
  if (i < 0) return null;
  const rest = body.slice(i + SECTION.length);
  const next = rest.search(/\n##\s(?!#)/);
  return { text: next < 0 ? rest : rest.slice(0, next), before: body.slice(0, i), after: next < 0 ? "" : rest.slice(next) };
}

const line = (text, label) =>
  text.match(new RegExp(`^[ \\t]*[-*]?[ \\t]*${label}[ \\t]*:[ \\t]*(.+)$`, "im"))?.[1].trim();

function fenced(text, label) {
  const m = text.match(new RegExp(`${label}[ \\t]*:?[^\\n]*\\n+\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\``, "i"));
  return m?.[1].trim();
}

/**
 * @param {{body:string, files:string[], isAncestor?:(sha:string)=>Promise<boolean>}} p
 * @returns {Promise<{required:boolean, ok:boolean, problems:string[]}>}
 */
export async function evaluate({ body, files, isAncestor }) {
  const classes = classifyPaths(files);
  const sensitive = classes.sensitive.length > 0;
  const gate = classes.gate.length > 0;
  if (!sensitive && !gate) return { required: false, ok: true, problems: [] };

  const problems = [];
  const sec = section(body ?? "");
  if (!sec) return { required: true, ok: false, problems: [`PR body has no "${SECTION}" section.`] };
  const t = sec.text;

  const skills = new Set(
    [...requiredSkills("commit", classes), ...requiredSkills("pr", classes)].map((s) => s.skill),
  );
  const claimed = (line(t, "Skills run") ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  for (const s of skills) if (!claimed.includes(s)) problems.push(`"Skills run" must list ${s}.`);

  if (sensitive) {
    const red = fenced(t, "Red run");
    if (!red || PLACEHOLDER.test(red)) problems.push('"Red run" needs a fenced block with the failing test output from before the fix.');
    else if (!/\b(fail(ed|ing|s)?|error|assert\w*|expected|✗|✕|red)\b/i.test(red))
      problems.push('"Red run" output does not show a failure.');
  }
  const simplify = fenced(t, "/simplify output");
  if (!simplify || PLACEHOLDER.test(simplify)) problems.push('"/simplify output" needs a fenced block with the real output.');

  const seat1Session = line(t, "Seat 1 session");
  const urls = seat1Session?.match(SESSION_URL) ?? [];
  if (urls.length !== 1) problems.push('"Seat 1 session" must be one https://claude.ai/code/session_… link.');
  else {
    const others = new Set(`${sec.before}\n${sec.after}`.match(SESSION_URL) ?? []);
    if (others.has(urls[0])) problems.push("Seat 1 session is the implementing session. Seat 1 must be a separate session.");
  }
  if (!/opus[\s-]*5[.\s-]*5/i.test(line(t, "Seat 1 model") ?? "")) problems.push('"Seat 1 model" must be Opus 5.5.');
  if (!/gpt-6-sol/i.test(line(t, "Seat 2 model") ?? "")) problems.push('"Seat 2 model" must be gpt-6-sol (Codex).');
  if (!/^(low|medium)\b/i.test(line(t, "Seat 2 effort") ?? "")) problems.push('"Seat 2 effort" must be low or medium.');

  for (const seat of ["Seat 1", "Seat 2"]) {
    const sha = line(t, `${seat} SHA`)?.match(/^[0-9a-f]{7,40}\b/i)?.[0];
    if (!sha) problems.push(`"${seat} SHA" must be the certified head SHA.`);
    else if (isAncestor && !(await isAncestor(sha))) problems.push(`${seat} SHA ${sha} is not part of this PR's history.`);
  }
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
- Seat 1 session: https://claude.ai/code/session_…
- Seat 1 model: claude-opus-5-5
- Seat 1 SHA: <head sha>
- Seat 2 model: gpt-6-sol
- Seat 2 effort: medium
- Seat 2 SHA: <head sha>`;
