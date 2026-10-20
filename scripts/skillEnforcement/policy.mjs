/**
 * Skill-enforcement policy: which paths are sensitive, which skills each step
 * needs. Shared by the Claude Code hook (skillGate.mjs) and the PR check
 * (checkPrSkillEvidence.mjs) so the two cannot drift. Skills rank below
 * AGENTS.md; this file only makes the table in .claude/skills/README.md
 * mechanical. It never replaces the two-seat review.
 */

/**
 * Default deny: every file under `convex/` is treated as money, permission,
 * tenancy or schema code unless it is generated or not source. A name list
 * missed claims.ts, customers.ts, branches.ts and others, and a missed file
 * takes the no-evidence pass, so the safe default is the whole backend.
 */
const BACKEND_EXEMPT_PREFIXES = ["convex/_generated/"];
const NON_SOURCE_EXTENSIONS = [".md", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico"];
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const GATE_EXACT = new Set(["AGENTS.md", "regression/rulings.json"]);
const GATE_PREFIXES = [".github/", ".claude/", "scripts/skillEnforcement/", "scripts/intelligence/"];
const GATE_SCRIPTS = ["assertRelease", "checkReleaseAuthority", "verifyZeroState", "rolloutProduction"];

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

function isGate(p) {
  if (GATE_EXACT.has(p) || GATE_PREFIXES.some((x) => p.startsWith(x))) return true;
  return p.startsWith("scripts/") && GATE_SCRIPTS.some((x) => p.slice("scripts/".length).startsWith(x));
}

function isMoney(p) {
  if (!p.startsWith("convex/") || BACKEND_EXEMPT_PREFIXES.some((x) => p.startsWith(x))) return false;
  return !NON_SOURCE_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));
}

/**
 * `sensitive` drives the hook and the PR check. `behaviour` is the part of it
 * that is not a test file: only a change with an empty `behaviour` list (test
 * files and docs) may use the "No behaviour change" form instead of a red run.
 */
export function classifyPaths(paths) {
  const out = { sensitive: [], behaviour: [], gate: [], code: [] };
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "");
    if (!p) continue;
    if (isGate(p)) out.gate.push(p);
    if (isMoney(p)) {
      out.sensitive.push(p);
      if (!TEST_FILE.test(p)) out.behaviour.push(p);
    }
    if (CODE_EXTENSIONS.some((e) => p.endsWith(e))) out.code.push(p);
  }
  return out;
}

/** Skills a step needs given what it touches. Returns [{skill, why}]. */
export function requiredSkills(step, classes) {
  const need = new Map();
  const add = (skill, why) => need.has(skill) || need.set(skill, why);
  const sensitive = classes.sensitive.length > 0;
  const gate = classes.gate.length > 0;
  if (step === "commit" || step === "push") {
    if (sensitive) {
      add("tdd", "money/permission code changed: a failing-first test is required");
      add("blast-radius", "money/permission code changed");
    }
    if (gate) add("blast-radius", "gate or production-safeguard file changed");
  }
  if (step === "pr") {
    add("technical-writing", "PR body is a document");
    add("unslop", "PR body is prose");
    if (sensitive || gate) {
      add("two-axis-review", "run before requesting review seats");
      add("engineering-principles", "money/gate change: verify before declaring done");
    }
  }
  return [...need].map(([skill, why]) => ({ skill, why }));
}

const normSkill = (s) => String(s).replace(/^\/+/, "").split(":").pop();
const COMMAND_MARKER = /<command-name>\/?([^<\s]+)<\/command-name>/g;

function parseLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function userTexts(msg) {
  if (typeof msg?.content === "string") return [msg.content];
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
}

/**
 * Skills invoked in a Claude Code JSONL transcript. Two sources count, and only
 * these two:
 *  - an assistant `Skill` tool call whose tool_result came back without error
 *    (an unknown or failed skill is not an invocation);
 *  - a `<command-name>/skill</command-name>` marker in a user-role message that
 *    is not a tool result, which is how the harness records a typed /skill.
 * Assistant prose that merely contains the marker text counts for nothing.
 */
export function invokedSkills(transcriptText) {
  const calls = new Map(); // tool_use id -> skill
  const answered = new Set();
  const seen = new Set();
  for (const rec of transcriptText.split("\n").map(parseLine)) {
    const msg = rec?.message;
    const role = msg?.role ?? rec?.type;
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    if (role === "assistant") {
      for (const b of blocks) {
        if (b?.type === "tool_use" && b.name === "Skill" && b.input?.skill && b.id) {
          calls.set(b.id, normSkill(b.input.skill));
        }
      }
    } else if (role === "user") {
      for (const b of blocks) {
        if (b?.type === "tool_result" && b.tool_use_id && !b.is_error) answered.add(b.tool_use_id);
      }
      for (const t of userTexts(msg)) for (const m of t.matchAll(COMMAND_MARKER)) seen.add(normSkill(m[1]));
    }
  }
  for (const [id, skill] of calls) if (answered.has(id)) seen.add(skill);
  return seen;
}
