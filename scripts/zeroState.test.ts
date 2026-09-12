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
  OPERATIONAL_DIAGNOSTIC_TABLES,
  classifyTableRead,
  componentNames,
  decideZeroState,
  deploymentNameFromUrl,
  parseFunctionSpec,
  parseTableList,
  renderZeroStateSummary,
  schemaTableNames,
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

function healthy(overrides: Partial<ZeroStateInput> = {}): ZeroStateInput {
  return {
    phase: "post-deploy",
    expectedDeployment: "clever-mockingbird-719",
    credentialDeployment: "clever-mockingbird-719",
    reportedUrl: "https://clever-mockingbird-719.convex.cloud",
    reportedInstanceName: "clever-mockingbird-719",
    functionCount: 908,
    deploymentClass: null,
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
    const report = decideZeroState(healthy({ deploymentClass: "preview" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/AUTOFLOW_DEPLOYMENT_CLASS=preview/);
  });

  test("the two declared operational tables may hold cron-written rows — reported, not counted; the list is exactly those two", () => {
    expect([...OPERATIONAL_DIAGNOSTIC_TABLES].sort()).toEqual(["cronHeartbeats", "webhookLogs"]);
    const schema = [...SCHEMA, "cronHeartbeats", "webhookLogs"];
    const rs = [...reads(), { component: null, table: "cronHeartbeats", outcome: "NONEMPTY" as const }, { component: null, table: "webhookLogs", outcome: "NONEMPTY" as const }];
    const report = decideZeroState(healthy({ schemaTables: schema, listedTables: schema, reads: rs }));
    expect(report.verdict).toBe("ZERO");
    expect(report.counts).toMatchObject({ nonEmpty: 0, operational: 2 });
    expect(report.notes.join(" ")).toMatch(/operational diagnostics hold rows .* cronHeartbeats, webhookLogs/);
    // A table of the same name inside a COMPONENT is not the declared one.
    const inComponent = decideZeroState(healthy({ components: [{ name: "rateLimiter", tables: ["cronHeartbeats"] }], reads: [...reads().filter((r) => r.component !== "vehiclesByOrg" && r.table !== "rateLimits"), { component: "rateLimiter", table: "cronHeartbeats", outcome: "NONEMPTY" as const }] }));
    expect(inComponent.verdict).toBe("FAIL");
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
