/**
 * Zero-state verifier — the fail-closed rules (SCRUM-313 B4 / SCRUM-231).
 *
 * The CLI output shapes below were captured on a real disposable preview
 * (`proficient-snail-903`, 2026-09-12) — including the trap that a table which
 * does NOT exist prints the same sentence as an empty one.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CRON_SELF_REPORT_SOURCES,
  DIAGNOSTIC_ROW_BOUND,
  HEARTBEAT_JOB_NAMES,
  OPERATIONAL_DIAGNOSTIC_TABLES,
  classifyMarkerRead,
  classifyTableRead,
  componentNames,
  decideZeroState,
  deploymentNameFromUrl,
  parseFunctionSpec,
  parseTableList,
  renderZeroStateSummary,
  schemaTableNames,
  validateDiagnosticRow,
  validateDiagnosticRows,
  type MarkerRead,
  type TableRead,
  type ZeroStateInput,
} from "./zeroState";

const NOISE = "(node:123) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

describe("parsing the CLI's real output shapes", () => {
  test("a fresh deployment lists no tables", () => {
    expect(parseTableList("", "There are no tables in the clever-mockingbird-719 deployment's database.\n", 0)).toEqual({ ok: true, tables: [] });
  });
  test("a deployed schema lists one table name per line, noise ignored", () => {
    expect(parseTableList("accountingEvents\norganizations\n", NOISE, 0)).toEqual({ ok: true, tables: ["accountingEvents", "organizations"] });
  });
  test("a listing that exits non-zero, prints nothing, or prints non-names is a refusal, never an empty list", () => {
    expect(parseTableList("", "", 0).ok).toBe(false);
    expect(parseTableList("", NOISE, 0).ok).toBe(false);
    expect(parseTableList("organizations\n", "", 1).ok).toBe(false);
    expect(parseTableList("Error: not authorized\n", "", 0).ok).toBe(false);
    // The no-tables sentence on stdout is not the shape the CLI produces; silence plus the wrong stream is not proof.
    expect(parseTableList("", "There are no tables in the x deployment's database.\n", 1).ok).toBe(false);
  });
  test("a limit-one read is EMPTY only on the exact stderr sentence with empty stdout, NONEMPTY on a document table, UNREADABLE otherwise", () => {
    expect(classifyTableRead("", `${NOISE}There are no documents in this table.\n`, 0)).toBe("EMPTY");
    expect(classifyTableRead("_id | _creationTime | name\n---|---|---\nk97... | 1 | Acme\n", NOISE, 0)).toBe("NONEMPTY");
    expect(classifyTableRead("", "There are no documents in this table.\n", 1)).toBe("UNREADABLE");
    // Silence on both streams — a denied or hung read — is not an empty table.
    expect(classifyTableRead("", "", 0)).toBe("UNREADABLE");
    expect(classifyTableRead("", NOISE, 0)).toBe("UNREADABLE");
    expect(classifyTableRead("Error: Unauthorized\n", "", 0)).toBe("UNREADABLE");
    expect(classifyTableRead("", "Error: Unauthorized\n", 0)).toBe("UNREADABLE");
  });
  test("function-spec yields the count and the reporting deployment's URL", () => {
    expect(parseFunctionSpec(JSON.stringify({ functions: [{}, {}], url: "https://x-1.convex.cloud" }), 0)).toEqual({ ok: true, functionCount: 2, url: "https://x-1.convex.cloud" });
    expect(parseFunctionSpec(JSON.stringify({ functions: [] }), 0)).toEqual({ ok: true, functionCount: 0, url: null });
    expect(parseFunctionSpec("not json", 0).ok).toBe(false);
    expect(parseFunctionSpec("{}", 0).ok).toBe(false);
    expect(parseFunctionSpec("{\"functions\":[]}", 2).ok).toBe(false);
  });
  test("the repository's own schema and component config are the scope, and they are not empty", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "convex", "schema.ts"), "utf8");
    const tables = schemaTableNames(schema);
    expect(tables.length).toBeGreaterThan(100);
    expect(tables).toContain("organizations");
    expect(tables).toContain("e2ePreviewBootstrap");
    expect(tables).toContain("financeDealFees");
    const config = fs.readFileSync(path.join(__dirname, "..", "convex", "convex.config.ts"), "utf8");
    expect(componentNames(config)).toEqual([
      "rateLimiter", "vehiclesByOrg", "vehicleQualityByOrg", "customersByOrg", "leadsByOrg", "membershipsByOrg",
      "instagramEventsByOrg", "facebookEventsByOrg", "socialContactsByOrg",
    ]);
  });
  test("a deployment name is read from its cloud URL and nothing else", () => {
    expect(deploymentNameFromUrl("https://clever-mockingbird-719.convex.cloud")).toBe("clever-mockingbird-719");
    expect(deploymentNameFromUrl("https://evil.example.com/clever-mockingbird-719.convex.cloud")).toBeNull();
    expect(deploymentNameFromUrl(null)).toBeNull();
  });
});

const SCHEMA = ["organizations", "financeDealFees", "e2ePreviewBootstrap"];
const COMPONENTS = [{ name: "rateLimiter", tables: ["rateLimits"] }, { name: "vehiclesByOrg", tables: ["btree", "btreeNode"] }];

function reads(outcome: TableRead["outcome"] = "EMPTY"): TableRead[] {
  return [
    ...SCHEMA.map((table) => ({ component: null, table, outcome })),
    ...COMPONENTS.flatMap((c) => c.tables.map((table) => ({ component: c.name, table, outcome }))),
  ];
}

const ABSENT: MarkerRead = { state: "VERIFIED_ABSENT", deployment: "clever-mockingbird-719", deploymentKind: "prod" };

// Real CLI output, captured 2026-09-12 on fantastic-blackbird-16 / proficient-snail-903.
const ENV_ABSENT_STDERR = NOISE + '✖ Environment variable "AUTOFLOW_DEPLOYMENT_CLASS" not found (on dev deployment fantastic-blackbird-16)\n';
const ENV_DENIED_STDERR = NOISE + "✖ Deployment “no-such-deployment-000” not found. To create a new deployment, use npx convex deployment create aalzriqat:auto:no-such-deployment-000 --select\n";
const HEARTBEAT_ROWS = [
  '{ "_creationTime": 1789207446758.1921, "_id": "nd72xj13gsdxz6c7w3fqpdmrb58e91re", "detail": "0 expired of 0 scanned", "jobName": "reconcile-expired-subscriptions", "ranAt": 1789207446758, "success": true }',
  '{ "_creationTime": 1789207446757.7534, "_id": "nd788tqmdkdbnmzjp7e5t6remh8e92tx", "detail": "Triggered alarms for 0 tasks.", "jobName": "check-upcoming-tasks", "ranAt": 1789207446757, "success": true }',
];
const CRON_REPORT_ROW =
  '{ "_creationTime": 1789206846920.4004, "_id": "n17h3qfrveeh9d2vbt0wwm5g518e90eb", "createdAt": 1789206846920, "source": "social-auto-reply-retry", "status": "success", "summary": "Retried 0 pending auto-replies: 0 succeeded, 0 failed." }';
// The shape webhookInboxIntake writes for a verified provider delivery (schema-valid, NOT a cron self-report).
const CLERK_ROW =
  '{ "_creationTime": 1789206846921.1, "_id": "n17clerk000000000000000000000001", "createdAt": 1789206846921, "eventId": "evt_1", "payloadSha256": "ab", "receiveCount": 1, "lastReceivedAt": 1789206846921, "source": "clerk", "status": "received", "summary": "user.created" }';

function healthy(overrides: Partial<ZeroStateInput> = {}): ZeroStateInput {
  return {
    phase: "post-deploy",
    expectedDeployment: "clever-mockingbird-719",
    credentialDeployment: "clever-mockingbird-719",
    reportedUrl: "https://clever-mockingbird-719.convex.cloud",
    reportedInstanceName: "clever-mockingbird-719",
    functionCount: 908,
    marker: ABSENT,
    schemaTables: SCHEMA,
    listedTables: SCHEMA,
    components: COMPONENTS,
    reads: reads(),
    storage: "EMPTY",
    scheduledFunctions: "NONEMPTY",
    ...overrides,
  };
}

describe("post-deploy verdict — fail closed", () => {
  test("CONTROL: functions deployed, every schema table listed, every listed and component table empty, storage empty → ZERO", () => {
    const report = decideZeroState(healthy());
    expect(report.verdict).toBe("ZERO");
    expect(report.reasons).toEqual([]);
    expect(report.counts).toMatchObject({ functions: 908, listedTables: 3, schemaTables: 3, componentTables: 3, empty: 6, nonEmpty: 0, operational: 0, unreadable: 0 });
    expect(report.notes.join(" ")).toMatch(/READ-ONLY COMMANDS \/ WRITE-CAPABLE CREDENTIAL/);
    expect(report.notes.join(" ")).toMatch(/_scheduled_functions holds entries — expected/);
  });

  test("one document anywhere fails it, and the table is named", () => {
    const rs = reads();
    rs[1] = { ...rs[1], outcome: "NONEMPTY" };
    const report = decideZeroState(healthy({ reads: rs }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/1 table\(s\) hold documents: financeDealFees/);
  });

  test("a document in a COMPONENT table fails it", () => {
    const rs = reads();
    const i = rs.findIndex((r) => r.component === "rateLimiter");
    rs[i] = { ...rs[i], outcome: "NONEMPTY" };
    const report = decideZeroState(healthy({ reads: rs }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/rateLimiter\/rateLimits/);
  });

  test("an unreadable table is not zero", () => {
    const rs = reads();
    rs[0] = { ...rs[0], outcome: "UNREADABLE" };
    const report = decideZeroState(healthy({ reads: rs }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/could not be read: organizations.*Unreadable is not zero/);
  });

  test("an unreadable component listing is not zero", () => {
    const report = decideZeroState(healthy({ components: [{ name: "rateLimiter", tables: null }, COMPONENTS[1]] }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/component rateLimiter's table listing could not be read/);
  });

  test("a listed table that was never read fails it — the scope is the listing, not the reads that happened to run", () => {
    const report = decideZeroState(healthy({ reads: reads().filter((r) => r.table !== "organizations") }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/1 listed table\(s\) were never read \(organizations\)/);
  });

  test("a schema table missing from the listing is a failure post-deploy, not a zero-row pass", () => {
    const report = decideZeroState(healthy({ listedTables: ["organizations", "financeDealFees"], reads: reads().filter((r) => r.table !== "e2ePreviewBootstrap") }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/1 table\(s\) the deployed schema declares are not listed .*e2ePreviewBootstrap/);
    expect(report.reasons.join(" ")).toMatch(/absence of an E2E marker row could not be verified/);
  });

  test("zero functions after a push is a failed push, not a clean deployment", () => {
    const report = decideZeroState(healthy({ functionCount: 0 }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/no functions are deployed/);
  });

  test("files in the store fail it; an unreadable store fails it", () => {
    expect(decideZeroState(healthy({ storage: "NONEMPTY" })).reasons.join(" ")).toMatch(/_storage\) holds files/);
    expect(decideZeroState(healthy({ storage: "UNREADABLE" })).reasons.join(" ")).toMatch(/_storage\) could not be read/);
  });

  test("the E2E preview marker fails it", () => {
    const report = decideZeroState(healthy({ marker: { state: "PRESENT", value: "preview" } }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/AUTOFLOW_DEPLOYMENT_CLASS=preview/);
  });

  test("B4-MARKER: a marker read that FAILED is not an absent marker — UNREADABLE fails, and says so", () => {
    const report = decideZeroState(healthy({ marker: { state: "UNREADABLE", reason: "env get exited 1" } }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/marker could not be read \(env get exited 1\); a failed read is not a verified absence/);
  });

  test("a PRESENT marker with any other value fails too, without echoing the value", () => {
    const report = decideZeroState(healthy({ marker: { state: "PRESENT", value: "sentinel-zq7" } }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/unexpected value \(not shown\)/);
    expect(report.reasons.join(" ")).not.toMatch(/sentinel-zq7/);
  });

  test("the not-found sentence names the deployment it looked at; a different name is an identity failure", () => {
    const report = decideZeroState(healthy({ marker: { state: "VERIFIED_ABSENT", deployment: "kindly-hound-172", deploymentKind: "prod" } }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/environment read answered for kindly-hound-172, not clever-mockingbird-719/);
  });

  const DIAG_SCHEMA = [...SCHEMA, "cronHeartbeats", "webhookLogs"];
  const verified = (rows: number, provenance: Record<string, number>): TableRead["diagnostics"] => ({ state: "VERIFIED", rows, provenance, reasons: [] });

  test("the two declared tables may hold rows ONLY when every row was VERIFIED as a cron self-report — disclosed by provenance and count; the list is exactly those two", () => {
    expect([...OPERATIONAL_DIAGNOSTIC_TABLES].sort()).toEqual(["cronHeartbeats", "webhookLogs"]);
    const rs = [
      ...reads(),
      { component: null, table: "cronHeartbeats", outcome: "NONEMPTY" as const, diagnostics: verified(18, { "heartbeat:check-upcoming-tasks": 12, "heartbeat:reconcile-expired-subscriptions": 6 }) },
      { component: null, table: "webhookLogs", outcome: "NONEMPTY" as const, diagnostics: verified(3, { "cron-report:social-auto-reply-retry": 3 }) },
    ];
    const report = decideZeroState(healthy({ schemaTables: DIAG_SCHEMA, listedTables: DIAG_SCHEMA, reads: rs }));
    expect(report.verdict).toBe("ZERO");
    expect(report.counts).toMatchObject({ nonEmpty: 0, operational: 2, diagnosticRows: 21 });
    expect(report.notes.join(" ")).toMatch(/cronHeartbeats: 18 row\(s\) VERIFIED as cron self-reports .* heartbeat:check-upcoming-tasks ×12, heartbeat:reconcile-expired-subscriptions ×6/);
    expect(report.notes.join(" ")).toMatch(/webhookLogs: 3 row\(s\) VERIFIED .* cron-report:social-auto-reply-retry ×3/);
  });

  test("B4-DIAGNOSTICS: a declared table with rows that were NOT validated fails — the name is not an exemption", () => {
    const rs = [...reads(), { component: null, table: "webhookLogs", outcome: "NONEMPTY" as const }];
    const report = decideZeroState(healthy({ schemaTables: DIAG_SCHEMA, listedTables: DIAG_SCHEMA, reads: rs }));
    expect(report.verdict).toBe("FAIL");
    expect(report.counts).toMatchObject({ nonEmpty: 1, operational: 0 });
    expect(report.reasons.join(" ")).toMatch(/webhookLogs holds documents and its rows were never validated/);
  });

  test("B4-DIAGNOSTICS: a REJECTED or UNREADABLE validation fails and carries the rule that was broken", () => {
    const rejected: TableRead["diagnostics"] = { state: "REJECTED", rows: 4, provenance: { "cron-report:social-auto-reply-retry": 3 }, reasons: ["webhookLogs row 4: source is not a cron self-report source."] };
    const r1 = decideZeroState(healthy({ schemaTables: DIAG_SCHEMA, listedTables: DIAG_SCHEMA, reads: [...reads(), { component: null, table: "webhookLogs", outcome: "NONEMPTY" as const, diagnostics: rejected }] }));
    expect(r1.verdict).toBe("FAIL");
    expect(r1.reasons.join(" ")).toMatch(/webhookLogs holds 4 row\(s\) that were NOT verified as cron diagnostics \(REJECTED\): webhookLogs row 4: source is not a cron self-report source/);
    const unreadable: TableRead["diagnostics"] = { state: "UNREADABLE", rows: 0, provenance: {}, reasons: ["the bounded read of cronHeartbeats exited 1."] };
    const r2 = decideZeroState(healthy({ schemaTables: DIAG_SCHEMA, listedTables: DIAG_SCHEMA, reads: [...reads(), { component: null, table: "cronHeartbeats", outcome: "NONEMPTY" as const, diagnostics: unreadable }] }));
    expect(r2.verdict).toBe("FAIL");
    expect(r2.reasons.join(" ")).toMatch(/cronHeartbeats holds 0 row\(s\) that were NOT verified .*\(UNREADABLE\)/);
  });

  test("a table of the same name inside a COMPONENT is not the declared one, even with a VERIFIED validation attached", () => {
    const inComponent = decideZeroState(
      healthy({
        components: [{ name: "rateLimiter", tables: ["cronHeartbeats"] }],
        reads: [...reads().filter((r) => r.component !== "vehiclesByOrg" && r.table !== "rateLimits"), { component: "rateLimiter", table: "cronHeartbeats", outcome: "NONEMPTY" as const, diagnostics: verified(1, { "heartbeat:check-upcoming-tasks": 1 }) }],
      })
    );
    expect(inComponent.verdict).toBe("FAIL");
    expect(inComponent.reasons.join(" ")).toMatch(/rateLimiter\/cronHeartbeats/);
  });

  test("scheduled functions never fail it", () => {
    expect(decideZeroState(healthy({ scheduledFunctions: "NONEMPTY" })).verdict).toBe("ZERO");
    expect(decideZeroState(healthy({ scheduledFunctions: "UNREADABLE" })).verdict).toBe("ZERO");
  });
});

describe("identity — three read-backs, any disagreement fails", () => {
  test("credential bound to another deployment", () => {
    const report = decideZeroState(healthy({ credentialDeployment: "kindly-hound-172" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/credential addresses kindly-hound-172, not clever-mockingbird-719/);
  });
  test("function metadata reported by another deployment", () => {
    const report = decideZeroState(healthy({ reportedUrl: "https://kindly-hound-172.convex.cloud" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/reported by kindly-hound-172/);
  });
  test("the deployment answers to another name", () => {
    const report = decideZeroState(healthy({ reportedInstanceName: "kindly-hound-172" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/answers to kindly-hound-172/);
  });
  test("no read-back at all cannot be certified", () => {
    const report = decideZeroState(healthy({ credentialDeployment: null, reportedUrl: null, reportedInstanceName: null }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/no identity read-back succeeded/);
  });
  test("account login (no credential) with the other two read-backs agreeing is enough", () => {
    expect(decideZeroState(healthy({ credentialDeployment: null })).verdict).toBe("ZERO");
  });
});

describe("the marker read — PRESENT / VERIFIED_ABSENT / UNREADABLE from the CLI's real shapes", () => {
  test("the not-found sentence on stderr with exit 0 is a VERIFIED absence, and names the deployment", () => {
    expect(classifyMarkerRead(NOISE, ENV_ABSENT_STDERR, 0)).toEqual({ state: "VERIFIED_ABSENT", deployment: "fantastic-blackbird-16", deploymentKind: "dev" });
  });
  test("the value on stdout is PRESENT", () => {
    expect(classifyMarkerRead(NOISE + "preview\n", "", 0)).toEqual({ state: "PRESENT", value: "preview" });
  });
  test("exit 1 (denied / unknown deployment) is UNREADABLE — exit status is checked before any sentence", () => {
    expect(classifyMarkerRead("", ENV_DENIED_STDERR, 1).state).toBe("UNREADABLE");
    // Even a perfectly-formed absence sentence is refused when the exit status is not 0.
    expect(classifyMarkerRead(NOISE, ENV_ABSENT_STDERR, 1)).toMatchObject({ state: "UNREADABLE", reason: /exited 1/ });
    expect(classifyMarkerRead("preview\n", "", 2).state).toBe("UNREADABLE");
  });
  test("a timeout (no status) is UNREADABLE", () => {
    expect(classifyMarkerRead("", "", null)).toMatchObject({ state: "UNREADABLE", reason: /timed out/ });
  });
  test("silence with exit 0 is UNREADABLE — silence is not absence", () => {
    expect(classifyMarkerRead(NOISE, NOISE, 0)).toMatchObject({ state: "UNREADABLE", reason: /silence is not a verified absence/ });
  });
  test("the not-found sentence for a DIFFERENT variable is UNREADABLE", () => {
    expect(classifyMarkerRead("", ENV_ABSENT_STDERR.replace("AUTOFLOW_DEPLOYMENT_CLASS", "SOMETHING_ELSE"), 0).state).toBe("UNREADABLE");
  });
  test("a value plus an error on stderr, or several lines, is UNREADABLE", () => {
    expect(classifyMarkerRead("preview\n", "✖ warning\n", 0).state).toBe("UNREADABLE");
    expect(classifyMarkerRead("a\nb\n", "", 0).state).toBe("UNREADABLE");
  });
  test("a verified-absent marker is checked for disagreement but never satisfies identity on its own — it echoes the selector", () => {
    const report = decideZeroState(healthy({ credentialDeployment: null, reportedUrl: null, reportedInstanceName: null }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/no identity read-back succeeded/);
  });
});

describe("diagnostic rows — provenance is validated row by row, from the CLI's real jsonl shapes", () => {
  test("the declarations are pinned: exactly two heartbeat writers, exactly six cron-only sources", () => {
    expect([...HEARTBEAT_JOB_NAMES].sort()).toEqual(["check-upcoming-tasks", "reconcile-expired-subscriptions"]);
    expect([...CRON_SELF_REPORT_SOURCES].sort()).toEqual(["fi-commission-recognition", "fixed-asset-depreciation", "marketplace-weekly-report", "prepaid-expense-amortization", "social-auto-reply-retry", "subscription-reminder"]);
    for (const provider of ["clerk", "whatsapp", "resend", "payment", "instagram", "facebook", "instagram-oauth", "facebook-oauth", "notification-email", "marketplace-whatsapp"]) {
      expect(CRON_SELF_REPORT_SOURCES.has(provider)).toBe(false);
    }
    expect(DIAGNOSTIC_ROW_BOUND).toBe(500);
  });

  test("CONTROL: real heartbeat rows and a real cron self-report row are VERIFIED with provenance counts", () => {
    const hb = validateDiagnosticRows("cronHeartbeats", NOISE + HEARTBEAT_ROWS.join("\n") + "\n", NOISE, 0);
    expect(hb).toEqual({ state: "VERIFIED", rows: 2, provenance: { "heartbeat:reconcile-expired-subscriptions": 1, "heartbeat:check-upcoming-tasks": 1 }, reasons: [] });
    const wl = validateDiagnosticRows("webhookLogs", CRON_REPORT_ROW + "\n", "", 0);
    expect(wl).toEqual({ state: "VERIFIED", rows: 1, provenance: { "cron-report:social-auto-reply-retry": 1 }, reasons: [] });
  });

  test("a schema-valid PROVIDER delivery (Clerk) in webhookLogs is REJECTED — same table, not diagnostics", () => {
    const r = validateDiagnosticRows("webhookLogs", CLERK_ROW + "\n", "", 0);
    expect(r.state).toBe("REJECTED");
    expect(r.reasons[0]).toMatch(/webhookLogs row 1: unexpected field/);
    expect(r.reasons.join(" ")).not.toMatch(/user\.created|evt_1/);
  });

  test("mixed contents after a valid first row are REJECTED — one harmless row hides nothing", () => {
    const r = validateDiagnosticRows("webhookLogs", CRON_REPORT_ROW + "\n" + CLERK_ROW + "\n", "", 0);
    expect(r.state).toBe("REJECTED");
    expect(r.rows).toBe(2);
    expect(r.provenance).toEqual({ "cron-report:social-auto-reply-retry": 1 });
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/row 2/);
  });

  test("a self-report-shaped row under a provider/tenant source is REJECTED; the inbox lifecycle statuses are REJECTED", () => {
    const asPayment = CRON_REPORT_ROW.replace('"social-auto-reply-retry"', '"payment"');
    expect(validateDiagnosticRow("webhookLogs", JSON.parse(asPayment))).toEqual({ ok: false, reason: "source is not a cron self-report source" });
    const received = CRON_REPORT_ROW.replace('"status": "success"', '"status": "received"');
    expect(validateDiagnosticRow("webhookLogs", JSON.parse(received))).toMatchObject({ ok: false, reason: /inbox lifecycle state/ });
    const dead = CRON_REPORT_ROW.replace('"status": "success"', '"status": "dead_letter"');
    expect(validateDiagnosticRow("webhookLogs", JSON.parse(dead)).ok).toBe(false);
  });

  test("the Instagram token-refresh cron is admitted ONLY by its exact empty-deployment summary; any other instagram row is refused", () => {
    const base = JSON.parse(CRON_REPORT_ROW.replace('"social-auto-reply-retry"', '"instagram"')) as Record<string, unknown>;
    expect(validateDiagnosticRow("webhookLogs", { ...base, summary: "Instagram token refresh cron: refreshed 0/0 token(s) in this page." })).toEqual({ ok: true, provenance: "cron-report:instagram-token-refresh(empty)" });
    expect(validateDiagnosticRow("webhookLogs", { ...base, summary: "Instagram token refresh cron: refreshed 1/1 token(s) in this page." }).ok).toBe(false);
    expect(validateDiagnosticRow("webhookLogs", { ...base, summary: "Instagram token refresh cron: refreshed 0/0 token(s) in this page.", status: "error" }).ok).toBe(false);
    expect(validateDiagnosticRow("webhookLogs", base).ok).toBe(false);
  });

  test("an error self-report may carry only the error string; a cron error row is still a cron row", () => {
    const err = { ...(JSON.parse(CRON_REPORT_ROW) as Record<string, unknown>), status: "error", error: "boom" };
    expect(validateDiagnosticRow("webhookLogs", err)).toEqual({ ok: true, provenance: "cron-report:social-auto-reply-retry" });
    expect(validateDiagnosticRow("webhookLogs", { ...err, error: 5 }).ok).toBe(false);
  });

  test("heartbeats: an undeclared job name, a wrong type, or an extra field is REJECTED", () => {
    const row = JSON.parse(HEARTBEAT_ROWS[1]) as Record<string, unknown>;
    expect(validateDiagnosticRow("cronHeartbeats", { ...row, jobName: "backfill-ledger" })).toEqual({ ok: false, reason: "jobName is not a declared heartbeat writer" });
    expect(validateDiagnosticRow("cronHeartbeats", { ...row, success: "true" }).ok).toBe(false);
    expect(validateDiagnosticRow("cronHeartbeats", { ...row, orgId: "j57abc" })).toEqual({ ok: false, reason: "unexpected field orgId" });
    const { detail: _detail, ...noDetail } = row;
    expect(validateDiagnosticRow("cronHeartbeats", noDetail).ok).toBe(true);
    expect(validateDiagnosticRow("cronHeartbeats", { ...row, detail: 1 }).ok).toBe(false);
  });

  test("a table that is not declared, or a non-object row, is never diagnostics", () => {
    expect(validateDiagnosticRow("organizations", JSON.parse(CRON_REPORT_ROW)).ok).toBe(false);
    expect(validateDiagnosticRow("webhookLogs", "text").ok).toBe(false);
    expect(validateDiagnosticRow("webhookLogs", [1]).ok).toBe(false);
    expect(validateDiagnosticRow("webhookLogs", null).ok).toBe(false);
  });

  test("more rows than the bound is REJECTED, not sampled", () => {
    const lines = Array.from({ length: DIAGNOSTIC_ROW_BOUND + 1 }, () => CRON_REPORT_ROW).join("\n");
    const r = validateDiagnosticRows("webhookLogs", lines, "", 0);
    expect(r.state).toBe("REJECTED");
    expect(r.rows).toBe(DIAGNOSTIC_ROW_BOUND + 1);
    expect(r.reasons[0]).toMatch(/more than 500 rows/);
    expect(validateDiagnosticRows("webhookLogs", Array.from({ length: DIAGNOSTIC_ROW_BOUND }, () => CRON_REPORT_ROW).join("\n"), "", 0).state).toBe("VERIFIED");
  });

  test("an unparseable line, a failed read, silence, or stderr output is UNREADABLE — never a partial pass", () => {
    expect(validateDiagnosticRows("webhookLogs", CRON_REPORT_ROW + "\nShowing the 1 most recently created documents.\n", "", 0)).toMatchObject({ state: "UNREADABLE", rows: 2 });
    expect(validateDiagnosticRows("webhookLogs", "", "", 1).state).toBe("UNREADABLE");
    expect(validateDiagnosticRows("webhookLogs", "", "", null).state).toBe("UNREADABLE");
    expect(validateDiagnosticRows("webhookLogs", NOISE, "There are no documents in this table.\n", 0)).toMatchObject({ state: "UNREADABLE", reasons: [expect.stringMatching(/refusing to reconcile silence/)] });
    expect(validateDiagnosticRows("webhookLogs", CRON_REPORT_ROW + "\n", "✖ something\n", 0).state).toBe("UNREADABLE");
  });
});

describe("pre-deploy — absence is infrastructure evidence only", () => {
  test("no functions, no tables, empty store → ABSENT_INFRASTRUCTURE, labelled", () => {
    const report = decideZeroState(healthy({ phase: "pre-deploy", functionCount: 0, listedTables: [], reads: [], components: [], storage: "EMPTY" }));
    expect(report.verdict).toBe("ABSENT_INFRASTRUCTURE");
    expect(report.notes.join(" ")).toMatch(/INFRASTRUCTURE evidence only/);
  });
  test("anything already deployed or stored fails the pre-deploy claim", () => {
    expect(decideZeroState(healthy({ phase: "pre-deploy", functionCount: 3, listedTables: [], reads: [], components: [] })).verdict).toBe("FAIL");
    expect(decideZeroState(healthy({ phase: "pre-deploy", functionCount: 0, listedTables: ["organizations"], reads: [], components: [] })).verdict).toBe("FAIL");
    expect(decideZeroState(healthy({ phase: "pre-deploy", functionCount: 0, listedTables: [], reads: [], components: [], storage: "UNREADABLE" })).verdict).toBe("FAIL");
  });
});

describe("the summary carries names and counts, never documents, and says what it is", () => {
  test("renders the verdict, the checkpoint disclaimer and the credential label", () => {
    const md = renderZeroStateSummary({
      report: decideZeroState(healthy()), phase: "post-deploy", expectedDeployment: "clever-mockingbird-719",
      releaseSha: "4dd8a0ad80d14c1a584fb353586a3973bd8a0cee", authMode: "deploy-key",
    });
    expect(md).toMatch(/^## Zero-state verified/);
    expect(md).toMatch(/ONE-TIME LAUNCH CHECKPOINT/);
    expect(md).toMatch(/nothing here resets, imports or retries/);
    expect(md).toMatch(/WRITE-CAPABLE CREDENTIAL/);
  });
});
