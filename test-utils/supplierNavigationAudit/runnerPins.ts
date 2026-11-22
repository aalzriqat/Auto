import { RUNNER_FINGERPRINTS, RUNNER_IMPORTS, RUNNER_TYPES } from "./runnerPolicyFixtures";
import { parse, updateTable } from "./source";
import { navigationStatementName, navigationFingerprint } from "./fingerprints";
import { expect } from "vitest";
import ts from "typescript";
import { refuseRunnerOverrides, runnerRegistration, runnerStatementName, runnerRefusal } from "./runnerSyntax";
import { assertAdmittedRunnerReferences } from "./runnerReferences";

// These enclosing statements include auth destructuring, all writes, branches,
// scope creation and both vehicles -> project calls. Hashes are reviewed constants.
const FORWARDING_FINGERPRINTS = [
  {
    "file": "convex/supplierStatement.ts",
    "name": "import:./utils/tenancy",
    "hash": "e36e85a1915b7b3a4e9b84a31e8ea2441edd3b330e1a1470ecbbf4a3eabeffff"
  },
  {
    "file": "convex/supplierStatement.ts",
    "name": "settled",
    "hash": "85ff2fcef110f5d542e317a5b044a9e35de8903321f7c558e666d91bd6a632cf"
  },
  {
    "file": "convex/supplierStatement.ts",
    "name": "outstanding",
    "hash": "e84fa1f7f16f19f24a4d488b95ba9a030bf4f1497e7bb703e88d702781ca90ab"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "import:./utils/tenancy",
    "hash": "e36e85a1915b7b3a4e9b84a31e8ea2441edd3b330e1a1470ecbbf4a3eabeffff"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "vehicles",
    "hash": "3bc0fc56ddf4c03525bc1712ab10c59b49f598b99c840f8c22cf3c18e4d6249e"
  },
  {
    "file": "convex/supplierRelationships.ts",
    "name": "project",
    "hash": "7591f078011da2d81b09b41c7f7a579c7ec5b603dd017b522a3615464c65983b"
  }
];

export function assertForwardingFingerprints(): void {
  for (const pin of FORWARDING_FINGERPRINTS) {
    const source = parse(pin.file);
    const node = source.statements.find(statement => navigationStatementName(statement, source) === pin.name);
    const message = `${pin.file}:${pin.name}: permission forwarding fingerprint changed; re-derive role provenance and every caller cell before reviewing this pin. ${updateTable}`;
    expect(node, message).toBeDefined();
    expect(node && navigationFingerprint(node, source), message).toBe(pin.hash);
  }
}

export type RunnerPinPart = "envelope" | "even" | "odd";

export function assertRunnerFingerprints(source: ts.SourceFile, part?: RunnerPinPart): void {
  if (part === undefined || part === "envelope") {
    refuseRunnerOverrides(source);
    assertAdmittedRunnerReferences(source);
  }
  if (part === "envelope") return;
  const imports = source.statements.filter(ts.isImportDeclaration);
  expect(imports.map(node => navigationFingerprint(node, source)), "behavioural runner imports changed; review these statements: " + imports.map(node => node.getText(source)).join(" | ")).toStrictEqual(RUNNER_IMPORTS);
  const declarations: { name: string; node: ts.Statement }[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) || runnerRegistration(node, source)) continue;
    const name = runnerStatementName(node, source);
    if (!name) runnerRefusal(source, node, "unrecognized top-level statement");
    declarations.push({ name, node });
  }
  const types = declarations.filter(({node}) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
  expect(types.map(({name, node}) => ({name, kind: ts.SyntaxKind[node.kind]})), "review the type declaration inventory").toStrictEqual(RUNNER_TYPES);
  const runtime = declarations.filter(({node}) => !ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node));
  expect(runtime.map(declaration => declaration.name), "caller runner helpers: closed declaration set changed; rerun the runner mutants before reviewing these pins")
    .toStrictEqual(RUNNER_FINGERPRINTS.map(pin => pin.name));
  for (const [index, pin] of RUNNER_FINGERPRINTS.entries()) {
    if (part === "even" && index % 2 !== 0 || part === "odd" && index % 2 !== 1) continue;
    const node = runtime.find(declaration => declaration.name === pin.name)?.node;
    expect(node && navigationFingerprint(node, source), `${source.fileName}:${pin.name}: runner fingerprint changed; rerun the runner mutants before reviewing this pin`).toBe(pin.hash);
  }
}

const CACHE_FINGERPRINTS = [
  {
    "name": "createSupplierReadCache",
    "hash": "726b88e82ce936b95ac2a97c2de7da0e89c04489724f154a0e19061643fbfa88"
  },
  {
    "name": "readCached",
    "hash": "9c6e8ba9459ea6cbb07a0021de203bba752846d6496d40ff19e77b8ebe2ceebd"
  }
];

export function assertCacheFingerprints(source: ts.SourceFile): void {
  for (const pin of CACHE_FINGERPRINTS) {
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === pin.name);
    expect(node && navigationFingerprint(node, source), "supplier read cache / " + pin.name + ": rerun identity and cache mutants before reviewing this supplier-specific pin").toBe(pin.hash);
  }
}
