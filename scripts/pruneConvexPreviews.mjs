// SCRUM-548: manual sweep of leaked Convex PREVIEW deployments.
//
// SCRUM-377 retires the preview each CI run creates, but runs that die before
// cleanup (and the window before `pin`) still leak previews that count against
// the team deployment quota. This is the manual backstop, run from
// .github/workflows/prune-convex-previews.yml.
//
// Invariant: a deployment is deleted only when ALL of these hold, checked on
// the listing AND again on a fresh read immediately before the delete:
//   - the token is a PROJECT token (a team token is refused: least privilege)
//     whose project equals PRUNE_EXPECTED_PROJECT_ID, which comes from trusted
//     repository configuration and never from the token itself; the script
//     fails closed when it is unset, and every deployment must carry that id;
//   - kind "cloud", deploymentType "preview", isDefault false, a well formed
//     random name, not on the protected (production) list;
//   - createTime is a plausible epoch-millisecond integer (not before 2020, not
//     more than 5 minutes ahead) at least PRUNE_MIN_AGE_HOURS old, and
//     identical in listing and re-read (a recreated deployment is not the one
//     that was planned).
// Dry run unless PRUNE_CONFIRM is exactly "PRUNE". The server-side list filters
// are not trusted: every condition is re-checked client-side.
//
// Failure policy: each candidate is handled on its own. A failed delete is
// "delete failed"; a delete that errors in transport is "unknown" (it may or may
// not have happened); a failed re-read is "skipped". None stops the sweep, one
// line is printed as each candidate is decided, and the run exits non-zero on
// any failed/unknown outcome, or when every candidate was skipped on re-read.
// A dry run performs the same read-only re-read and reports what would go.
// Messages carry fixed literals, HTTP statuses and deployment names only, never
// token or headers.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_NAME,
  PIN_TTL_MS,
  PROTECTED_DEPLOYMENTS,
  callManagementApi,
} from "./previewDeploymentLifecycle.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const MIN_PLAUSIBLE_CREATE_TIME = Date.UTC(2020, 0, 1);
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DELETIONS = 60;
const HARD_MAX_DELETIONS = 100;

export class PruneRefusal extends Error {}

function refuse(message) {
  throw new PruneRefusal(message);
}

function readToken(env) {
  const token = env.CONVEX_PREVIEW_PRUNE_TOKEN;
  if (typeof token !== "string" || token.length === 0) refuse("CONVEX_PREVIEW_PRUNE_TOKEN is missing.");
  // PowerShell-set secrets carry a trailing \r; refuse rather than trim.
  if (/\s/.test(token)) refuse("CONVEX_PREVIEW_PRUNE_TOKEN contains whitespace.");
  return token;
}

function readExpectedProjectId(env) {
  const raw = env.PRUNE_EXPECTED_PROJECT_ID;
  if (typeof raw !== "string" || !/^[1-9]\d{0,15}$/.test(raw)) {
    refuse("PRUNE_EXPECTED_PROJECT_ID is not configured (a positive integer is required).");
  }
  return raw;
}

function readMinAgeMs(env) {
  const raw = env.PRUNE_MIN_AGE_HOURS;
  // Default is the pin TTL: a younger preview may still be a live CI run.
  if (raw === undefined || raw === "") return PIN_TTL_MS;
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) < 1 || !Number.isFinite(Number(raw))) {
    refuse("PRUNE_MIN_AGE_HOURS must be a number of at least 1.");
  }
  return Number(raw) * HOUR_MS;
}

function readMaxDeletions(env) {
  const raw = env.PRUNE_MAX_DELETIONS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_DELETIONS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > HARD_MAX_DELETIONS) {
    refuse("PRUNE_MAX_DELETIONS must be an integer from 1 to " + HARD_MAX_DELETIONS + ".");
  }
  return Number(raw);
}

const callApi = (fetchImpl, token, method, pathname) =>
  callManagementApi(fetchImpl, token, method, pathname, undefined, {
    maxBytes: MAX_RESPONSE_BYTES,
    Refusal: PruneRefusal,
  });

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return refuse("Convex Management API returned invalid JSON.");
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Compare as normalized integer strings; a non-integer id never matches.
const sameProject = (value, expected) =>
  (typeof value === "string" || Number.isSafeInteger(value)) && String(value) === expected;

const refused = (reason) => ({ outcome: "refused", reason });

/**
 * The single eligibility predicate (listing and re-read). Returns null when the
 * deployment is a candidate, otherwise { outcome, reason }. `young` marks the
 * one reason that is otherwise valid, so the listing can still de-duplicate it.
 */
function ineligibleReason(d, expectedProjectId, nowMs, minAgeMs) {
  if (!isObject(d)) return refused("malformed entry");
  if (typeof d.name !== "string" || !DEPLOYMENT_NAME.test(d.name)) return refused("malformed name");
  if (PROTECTED_DEPLOYMENTS.has(d.name)) return refused("protected deployment");
  if (d.kind !== "cloud") return refused("not a cloud deployment");
  if (d.deploymentType !== "preview") return refused("not a preview");
  if (d.isDefault !== false) return refused("default deployment");
  if (!sameProject(d.projectId, expectedProjectId)) return refused("other project");
  if (!Number.isSafeInteger(d.createTime)) return refused("missing createTime");
  if (d.createTime < MIN_PLAUSIBLE_CREATE_TIME || d.createTime > nowMs + FUTURE_SKEW_MS) {
    return { outcome: "skipped", reason: "implausible createTime" };
  }
  if (nowMs - d.createTime < minAgeMs) return { outcome: "skipped", reason: "too young", young: true };
  return null;
}

// previewIdentifier is free text from the deploying branch/run: keep it inert
// in logs and in the markdown table.
const safeText = (v) =>
  typeof v === "string" && v ? v.replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 60) : "-";

function ageHours(createTime, now) {
  return Number.isSafeInteger(createTime) ? Math.round(((now - createTime) / HOUR_MS) * 10) / 10 : null;
}

function row(d, action, nowMs) {
  return {
    name: isObject(d) && typeof d.name === "string" ? safeText(d.name) : "?",
    previewIdentifier: safeText(d?.previewIdentifier),
    ageHours: ageHours(d?.createTime, nowMs),
    action,
  };
}

function render(rows, mode) {
  const header = "| Deployment | Preview identifier | Age (h) | Action |\n| --- | --- | --- | --- |";
  const body = rows.map(
    (r) => "| " + r.name + " | " + r.previewIdentifier + " | " + (r.ageHours ?? "-") + " | " + r.action + " |",
  );
  return "### Convex preview prune (" + mode + ")\n\n" + [header, ...body].join("\n") + "\n";
}

export async function prune({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  write = (line) => {
    process.stdout.write(line + "\n");
  },
} = {}) {
  const rows = [];
  const emit = (list, mode) => {
    const table = render(list, mode);
    write(table);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, table, "utf8");
  };
  try {
    const token = readToken(env);
    const expectedProjectId = readExpectedProjectId(env);
    const minAgeMs = readMinAgeMs(env);
    const maxDeletions = readMaxDeletions(env);
    const confirmed = env.PRUNE_CONFIRM === "PRUNE";
    const nowMs = now();
    const addRow = (d, action) => {
      const r = row(d, action, nowMs);
      rows.push(r);
      write("[prune] " + r.name + ": " + action);
    };

    const details = await callApi(fetchImpl, token, "GET", "/token_details");
    if (!details.ok) refuse("Token check failed with HTTP " + details.status + ".");
    const t = parseJson(details.raw);
    if (!isObject(t) || t.type !== "projectToken") {
      refuse("Token is not a project token; refusing (a team token is too broad).");
    }
    if (!sameProject(t.projectId, expectedProjectId)) {
      refuse("Token project does not match PRUNE_EXPECTED_PROJECT_ID; refusing.");
    }

    // The server-side filter is not trusted: the per-row project check guards
    // against the listing returning another project's rows.
    const listed = await callApi(
      fetchImpl,
      token,
      "GET",
      "/projects/" + encodeURIComponent(String(expectedProjectId)) + "/list_deployments?deploymentType=preview&isDefault=false",
    );
    if (!listed.ok) refuse("Listing deployments failed with HTTP " + listed.status + ".");
    const list = parseJson(listed.raw);
    if (!Array.isArray(list)) refuse("Deployment list was not an array.");

    const candidates = [];
    const seen = new Set();
    for (const d of list) {
      const why = ineligibleReason(d, expectedProjectId, nowMs, minAgeMs);
      if (why && !why.young) {
        addRow(d, why.outcome + ": " + why.reason);
      } else if (!seen.has(d.name)) {
        seen.add(d.name);
        if (why) addRow(d, why.outcome + ": " + why.reason);
        else candidates.push(d);
      }
    }
    candidates.sort((a, b) => a.createTime - b.createTime); // oldest first

    // Fresh read right before the delete; a thrown request is "skipped".
    const recheck = async (d) => {
      try {
        const reread = await callApi(fetchImpl, token, "GET", "/deployments/" + encodeURIComponent(d.name));
        if (reread.status === 404) return { skip: "already gone" };
        if (!reread.ok) return { skip: "re-read failed (HTTP " + reread.status + ")" };
        let current;
        try {
          current = JSON.parse(reread.raw);
        } catch {
          return { skip: "re-read was not JSON" };
        }
        const why = ineligibleReason(current, expectedProjectId, nowMs, minAgeMs);
        if (why || current.name !== d.name) {
          return { skip: "re-read failed checks (" + (why?.reason ?? "name mismatch") + ")" };
        }
        if (current.createTime !== d.createTime) return { skip: "createTime changed since listing" };
        return { ok: true };
      } catch {
        return { skip: "re-read request errored" };
      }
    };

    // The delete outcome as an action; a thrown request is "unknown".
    const remove = async (d) => {
      try {
        const res = await callApi(fetchImpl, token, "POST", "/deployments/" + encodeURIComponent(d.name) + "/delete");
        if (res.status === 404) return { action: "skipped: already gone" };
        if (res.ok) return { action: "deleted" };
        return { action: "delete failed (HTTP " + res.status + ")", failed: true };
      } catch {
        return { action: "unknown: delete request errored, it may or may not have happened", failed: true };
      }
    };

    let failures = 0;
    let attempted = 0;
    let eligible = 0;
    for (const d of candidates) {
      if (attempted >= maxDeletions) {
        addRow(d, "deferred: deletion cap " + maxDeletions + " reached");
        continue;
      }
      attempted += 1;
      const checked = await recheck(d);
      if (checked.skip) {
        addRow(d, "skipped: " + checked.skip);
        continue;
      }
      eligible += 1;
      if (!confirmed) {
        addRow(d, "would delete");
        continue;
      }
      const removed = await remove(d);
      if (removed.failed) failures += 1;
      addRow(d, removed.action);
    }
    const allSkipped = attempted > 0 && eligible === 0;
    emit(rows, confirmed ? "PRUNE" : "dry run");
    if (failures > 0) write("::error::" + failures + " deployment delete(s) failed or are unknown.");
    if (allSkipped) write("::error::Every candidate was skipped on re-read; nothing could be verified.");
    return { exitCode: failures > 0 || allSkipped ? 1 : 0, rows };
  } catch (error) {
    const message = error instanceof PruneRefusal ? error.message : "Unexpected failure.";
    write("::error::Convex preview prune refused: " + message);
    if (rows.length > 0) {
      // Partial progress must still be visible after a mid-run failure.
      emit(rows, "aborted");
    }
    return { exitCode: 1, rows };
  }
}

export async function main(options = {}) {
  const { exitCode } = await prune(options);
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
