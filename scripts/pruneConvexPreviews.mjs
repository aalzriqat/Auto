// SCRUM-548: manual sweep of leaked Convex PREVIEW deployments.
//
// SCRUM-377 retires the preview each CI run creates, but runs that die before
// cleanup (and the window before `pin`) still leak previews that count against
// the team deployment quota. This is the manual backstop, run from
// .github/workflows/prune-convex-previews.yml.
//
// Invariant: a deployment is deleted only when ALL of these hold, checked on
// the listing AND again on a fresh read immediately before the delete:
//   - the token is a PROJECT token (a team token is refused: least privilege),
//     and the deployment belongs to that project;
//   - kind "cloud", deploymentType "preview", isDefault false, a well formed
//     random name, not on the protected (production) list;
//   - createTime is a positive integer at least PRUNE_MIN_AGE_HOURS old, and
//     identical in listing and re-read (a recreated deployment is not the one
//     that was planned).
// Dry run unless PRUNE_CONFIRM is exactly "PRUNE". The server-side list filters
// are not trusted: every condition is re-checked client-side.
//
// Failure policy: a failed delete does not stop the sweep (the remaining
// previews still free quota) but the run exits non-zero. Messages carry fixed
// literals, HTTP statuses and deployment names only, never token or headers.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_NAME,
  PROTECTED_DEPLOYMENTS,
  callManagementApi,
} from "./previewDeploymentLifecycle.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MIN_AGE_HOURS = 3;
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

function readMinAgeMs(env) {
  const raw = env.PRUNE_MIN_AGE_HOURS;
  if (raw === undefined || raw === "") return DEFAULT_MIN_AGE_HOURS * HOUR_MS;
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

/** Why this deployment may not be deleted, or null if it is a candidate. */
function ineligibleReason(d, projectId) {
  if (!isObject(d)) return "malformed entry";
  if (typeof d.name !== "string" || !DEPLOYMENT_NAME.test(d.name)) return "malformed name";
  if (PROTECTED_DEPLOYMENTS.has(d.name)) return "protected deployment";
  if (d.kind !== "cloud") return "not a cloud deployment";
  if (d.deploymentType !== "preview") return "not a preview";
  if (d.isDefault !== false) return "default deployment";
  if (d.projectId !== projectId) return "other project";
  if (!Number.isSafeInteger(d.createTime) || d.createTime <= 0) return "missing createTime";
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
  let failures = 0;
  const emit = (list, mode) => {
    const table = render(list, mode);
    write(table);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, table, "utf8");
  };
  try {
    const token = readToken(env);
    const minAgeMs = readMinAgeMs(env);
    const maxDeletions = readMaxDeletions(env);
    const confirmed = env.PRUNE_CONFIRM === "PRUNE";
    const nowMs = now();

    const details = await callApi(fetchImpl, token, "GET", "/token_details");
    if (!details.ok) refuse("Token check failed with HTTP " + details.status + ".");
    const t = parseJson(details.raw);
    if (!isObject(t) || t.type !== "projectToken") {
      refuse("Token is not a project token; refusing (a team token is too broad).");
    }
    const projectId = t.projectId;
    const validId =
      (typeof projectId === "string" && /^[A-Za-z0-9_-]+$/.test(projectId)) ||
      (Number.isSafeInteger(projectId) && projectId > 0);
    if (!validId) refuse("Token details carry no usable projectId.");

    const listed = await callApi(
      fetchImpl,
      token,
      "GET",
      "/projects/" + encodeURIComponent(String(projectId)) + "/list_deployments?deploymentType=preview&isDefault=false",
    );
    if (!listed.ok) refuse("Listing deployments failed with HTTP " + listed.status + ".");
    const list = parseJson(listed.raw);
    if (!Array.isArray(list)) refuse("Deployment list was not an array.");

    const candidates = [];
    const seen = new Set();
    for (const d of list) {
      const reason = ineligibleReason(d, projectId);
      if (reason) {
        rows.push(row(d, "refused: " + reason, nowMs));
      } else if (seen.has(d.name)) {
        continue;
      } else if (nowMs - d.createTime < minAgeMs) {
        seen.add(d.name);
        rows.push(row(d, "skipped: too young", nowMs));
      } else {
        seen.add(d.name);
        candidates.push(d);
      }
    }
    candidates.sort((a, b) => a.createTime - b.createTime); // oldest first

    let attempted = 0;
    for (const d of candidates) {
      const push = (action) => rows.push(row(d, action, nowMs));
      if (attempted >= maxDeletions) {
        push("deferred: deletion cap " + maxDeletions + " reached");
        continue;
      }
      attempted += 1;
      if (!confirmed) {
        push("would delete");
        continue;
      }
      const endpoint = "/deployments/" + encodeURIComponent(d.name);
      const reread = await callApi(fetchImpl, token, "GET", endpoint);
      if (reread.status === 404) {
        push("skipped: already gone");
        continue;
      }
      if (!reread.ok) {
        push("skipped: re-read failed (HTTP " + reread.status + ")");
        continue;
      }
      let current;
      try {
        current = JSON.parse(reread.raw);
      } catch {
        push("skipped: re-read was not JSON");
        continue;
      }
      const why = ineligibleReason(current, projectId);
      if (why || current.name !== d.name) {
        push("skipped: re-read failed checks (" + (why ?? "name mismatch") + ")");
        continue;
      }
      if (current.createTime !== d.createTime) {
        push("skipped: createTime changed since listing");
        continue;
      }
      const res = await callApi(fetchImpl, token, "POST", endpoint + "/delete");
      if (res.status === 404) push("skipped: already gone");
      else if (res.ok) push("deleted");
      else {
        failures += 1;
        push("delete failed (HTTP " + res.status + ")");
      }
    }

    emit(rows, confirmed ? "PRUNE" : "dry run");
    if (failures > 0) write("::error::" + failures + " deployment delete(s) failed.");
    return { exitCode: failures > 0 ? 1 : 0, rows };
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
