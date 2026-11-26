import { expect } from "vitest";
import { assertStatementClosure } from "./sourceClosure";
import { parse, root } from "./source";
import { assertRuntimeControlForms, assertSecondBindingForms, assertReferenceForms, assertIntrinsicForms } from "./navigationProbes";
import ts from "typescript";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CENSUS_PIN_FILE, CENSUS_SUITE, CENSUS_DIRECTORY, EXECUTABLE_CLOSURE } from "./closurePins";

export const checkExecutableClosurePinsEveryBehaviouralStatementIncludingUnboundCallbacks = () => {
  expect(() => assertStatementClosure(parse("convex/supplierNavigation.scrum869.test.ts"), "convex/supplierNavigation.scrum869.test.ts")).not.toThrow();
};

export const checkExecutableClosurePinsCensusStatementHalf0IncludingItsOwnChecks = () => {
  assertCensusModuleClosure(0);
};

export const checkExecutableClosurePinsCensusStatementHalf1IncludingItsOwnChecks = () => {
  assertCensusModuleClosure(1);
};

export const checkExecutableClosurePinsSuiteSetupAndItsConfiguredEntryPoints = () => {
  expect(() => assertStatementClosure(parse("vitest.setup.ts"), "vitest.setup.ts")).not.toThrow();
  expect(() => assertStatementClosure(parse("vitest.config.ts"), "vitest.config.ts")).not.toThrow();
};

export const checkCensusFormHelpersRefuseEmptyEvidenceInsteadOfPassingVacuously = () => {
  expect(() => assertRuntimeControlForms([])).toThrow(/non-empty forms/);
  expect(() => assertSecondBindingForms([], /unused/)).toThrow(/non-empty forms/);
  expect(() => assertReferenceForms([], /unused/)).toThrow(/non-empty forms/);
  expect(() => assertIntrinsicForms([], /unused/)).toThrow(/non-empty forms/);
};

function assertClosureInsertions(forms: readonly string[]): void {
  if (forms.length === 0) throw new Error("closure probes require non-empty forms");
  const file = "convex/supplierNavigation.scrum869.test.ts";
  const original = parse(file).text;
  const anchor = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const changed = original.replace(anchor, anchor + "\n" + form);
    expect(changed, "closure probe must alter an executable body").not.toBe(original);
    expect(() => assertStatementClosure(ts.createSourceFile(file, changed, ts.ScriptTarget.Latest, true), file), form).toThrow(/EXECUTABLE_CLOSURE/);
  }
}

export const checkExecutableClosureRefusesIntrinsicIndirectionWithoutKnowingItsSpelling = () => {
  assertClosureInsertions([
    'Object.getPrototypeOf([]).toSorted = () => [];',
    'Reflect.get(Object, ["define", "Property"].join(""))(Object, "is", { value: () => true });',
    '({}).constructor.defineProperties(Object, { is: { value: () => true } });',
  ]);
};

function assertClosureLineEndings(file: string, ending?: "LF" | "CRLF", half?: 0 | 1): void {
  const source = parse(file).text;
  const lf = source.replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  let forms = [lf, crlf];
  if (ending === "LF") forms = [lf];
  if (ending === "CRLF") forms = [crlf];
  for (const text of forms) {
    expect(() => assertStatementClosure(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file, half), file + ": equivalent checkout line endings").not.toThrow();
  }
}

export const checkBehaviouralExecutableClosureAcceptsLFAndCRLFCheckouts = () => {
  assertClosureLineEndings("convex/supplierNavigation.scrum869.test.ts");
};

export const checkCensusExecutableClosureAcceptsLFCheckoutStatementHalf0 = () => {
  assertCensusModuleClosure(0, "LF");
};

export const checkCensusExecutableClosureAcceptsLFCheckoutStatementHalf1 = () => {
  assertCensusModuleClosure(1, "LF");
};

export const checkCensusExecutableClosureAcceptsCRLFCheckoutStatementHalf0 = () => {
  assertCensusModuleClosure(0, "CRLF");
};

export const checkCensusExecutableClosureAcceptsCRLFCheckoutStatementHalf1 = () => {
  assertCensusModuleClosure(1, "CRLF");
};

function assertReservedClosureInsertion(file: string): void {
  const source = parse(file);
  for (const form of [
    'const EXECUTABLE_CLOSURE = console.info("SCRUM943_INSERTION");',
    'const ORDINARY_PROBE = console.info("SCRUM943_INSERTION");',
    'export { test as hiddenTest } from "vitest";',
    'const holder = { ["effect"]: console.info("SCRUM943_INSERTION") };',
  ]) {
    const changed = ts.createSourceFile(file, source.text + "\n" + form, ts.ScriptTarget.Latest, true);
    expect(() => assertStatementClosure(changed, file), file + ": only the owning literal table can be exempt").toThrow(/EXECUTABLE_CLOSURE/);
  }
}

export const checkClosureRefusesReservedNameInsertionInTheBehaviouralSuite = () => {
  assertReservedClosureInsertion("convex/supplierNavigation.scrum869.test.ts");
};

export const checkClosureRefusesASecondPinTableInTheCensusSuite = () => {
  assertReservedClosureInsertion(CENSUS_PIN_FILE);
  assertReservedClosureInsertion(CENSUS_SUITE);
};

export const checkClosureRefusesReservedNameInsertionInSetup = () => {
  assertReservedClosureInsertion("vitest.setup.ts");
};

export const checkClosureRefusesReservedNameInsertionInConfig = () => {
  assertReservedClosureInsertion("vitest.config.ts");
};

export const checkClosurePinsImportedFixtureAndCensusHelperImplementations = () => {
  for (const file of ["test-utils/convexTest.ts", "test-utils/supplierFixture.ts", "scripts/autoflowInvariantCatalog.ts"]) {
    assertStatementClosure(parse(file), file);
    assertReservedClosureInsertion(file);
  }
};

export const checkClosurePinsTheCacheBehaviouralOracle = () => {
  const file = "convex/utils/supplierReadCache.test.ts";
  assertStatementClosure(parse(file), file);
  assertReservedClosureInsertion(file);
};

export const checkClosurePinsTheAuthenticationBehaviouralOracle = () => {
  const file = "convex/utils/tenancy.test.ts";
  assertStatementClosure(parse(file), file);
  assertReservedClosureInsertion(file);

};

function assertSuiteLoaderRefusals(suite: string): void {
  for (const directive of ["vitest-environment node", 'jest-environment-options {"url":"https://example.test"}', "vitest-pool threads", "module-tag hidden"]) {
    const text = "// @" + directive + "\n" + parse(suite).text;
    expect(() => assertStatementClosure(ts.createSourceFile(suite, text, ts.ScriptTarget.Latest, true), suite)).toThrow(/loader directives/);
  }
}

export const checkClosureRefusesLoaderCommentsInTheBehaviouralSuite = () => { assertSuiteLoaderRefusals("convex/supplierNavigation.scrum869.test.ts"); };

export const checkClosureRefusesLoaderCommentsInTheCensusSuite = () => { assertSuiteLoaderRefusals("scripts/intelligence/supplierNavigationDoors.test.ts"); };

export const checkClosureRefusesLoaderCommentsInTheAuthenticationSuite = () => { assertSuiteLoaderRefusals("convex/utils/tenancy.test.ts"); };

export const checkClosureRefusesSetupMaskingConfigInheritanceAndComputedConfiguration = () => {
  for (const [file, form] of [
    ["vitest.setup.ts", 'vi.mock("node:fs", () => ({ readFileSync: () => "old source" }));'],
    ["vitest.setup.ts", 'Object.defineProperty(process, "getBuiltinModule", { value: () => ({}) });'],
    ["vitest.config.ts", 'export { default } from "./other.config";'],
    ["vitest.config.ts", 'const inherited = { extends: "./other.config.ts" };'],
    ["vitest.config.ts", 'const config = { ["setup" + "Files"]: ["./other.setup.ts"] };'],
  ]) {
    const source = parse(file!);
    expect(() => assertStatementClosure(ts.createSourceFile(file!, source.text + "\n" + form, ts.ScriptTarget.Latest, true), file!)).toThrow(/EXECUTABLE_CLOSURE/);
  }
};

export const checkClosureRefusesCompilerAnnotationsInsidePinnedStatements = () => {
  const file = "vitest.setup.ts";
  const source = parse(file);
  const text = source.text.replace('import("@testing-library/react")', 'import(/* @vite-ignore */ "@testing-library/react")');
  expect(text).not.toBe(source.text);
  expect(() => assertStatementClosure(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file)).toThrow(/EXECUTABLE_CLOSURE/);
};

const EXECUTION_INPUTS: readonly { file: string; hash: string }[] = [
  {
    "file": "package.json",
    "hash": "747788cef736708740733c5b5ecec4e1f8c65e10297ccfec886fd12b646c9a3a"
  },
  {
    "file": "pnpm-lock.yaml",
    "hash": "3f4fdda4159a1c35b361b556612b3ba87ee0d578ade58d24d5e4f193b6ffa6c2"
  },
  {
    "file": "pnpm-workspace.yaml",
    "hash": "2f92d8dd5bb9fa5bb13ccbce2a62a97fb5bec03bb56c5d9ec2b85b9c0426aeb9"
  },
  {
    "file": "tsconfig.json",
    "hash": "b15e17e569303d2a798ee15a2b17017f43aebd08776a4c7b21afd8b755cda8b6"
  },
  {
    "file": "convex/tsconfig.json",
    "hash": "da06ccd21d118b2b5f6dec67b124ca861e790e0b5ef1ea7f173ac8712c1bb93e"
  },
  {
    "file": "patches/expo-sharing.patch",
    "hash": "0eddd9192c3a88ec6dbc7a5ea7425cf4e1e0b759b9d9c296a2fd22c60ca12b3a"
  },
  {
    "file": "patches/query-string@7.1.3.patch",
    "hash": "fe47b885269a14c517ab79b9f7e5d0b46666cf13e5a80856685262c20aa00da5"
  }
];

function assertExecutionInput(file: string, text: string): void {
  const pin = EXECUTION_INPUTS.find(entry => entry.file === file);
  const actual = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
  if (!pin || pin.hash !== actual) throw new Error(file + ": EXECUTABLE_CLOSURE execution input changed");
}

function assertConfigNames(files: readonly string[]): void {
  const configs = files.filter(file => /^(?:vite|vitest)\.(?:config|workspace)\.(?:[cm]?[jt]s|json)$/.test(file) ||
    /^(?:\.npmrc|\.?pnpmfile\.[cm]?js)$/.test(file));
  expect(configs.toSorted(), "EXECUTABLE_CLOSURE refuses alternate configuration and install hooks").toStrictEqual(["vitest.config.ts"]);
}

export const checkClosurePinsModuleResolutionInstallationAndConfigDiscoveryInputs = () => {
  const filesystem = process.getBuiltinModule("fs");
  expect(EXECUTION_INPUTS.length).toBeGreaterThan(0);
  assertConfigNames(filesystem.readdirSync(root));
  for (const pin of EXECUTION_INPUTS) {
    const text = filesystem.readFileSync(join(root, pin.file), "utf8");
    assertExecutionInput(pin.file, text);
    expect(() => assertExecutionInput(pin.file, text + "\n ")).toThrow(/execution input changed/);
  }
  for (const name of ["vitest.config.mts", "vitest.workspace.ts", "vite.config.js", ".pnpmfile.cjs", ".npmrc"]) {
    expect(() => assertConfigNames(["vitest.config.ts", name])).toThrow(/alternate configuration/);
  }
};

function assertCensusModuleClosure(half: 0 | 1, ending?: "LF" | "CRLF"): void {
  const filesystem = process.getBuiltinModule("fs");
  const entries = filesystem.readdirSync(join(root, CENSUS_DIRECTORY), { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !entry.name.endsWith(".ts"))) {
    throw new Error("EXECUTABLE_CLOSURE contains an unexpected audit source entry");
  }
  const installed = [CENSUS_SUITE, ...entries.map(entry => CENSUS_DIRECTORY + "/" + entry.name)];
  const pinned = new Set(EXECUTABLE_CLOSURE.map(pin => pin.file));
  if (installed.length !== pinned.size || installed.some(file => !pinned.has(file))) {
    throw new Error("EXECUTABLE_CLOSURE does not match the full audit source inventory");
  }
  for (const file of installed) {
    if (ending) assertClosureLineEndings(file, ending, half);
    else assertStatementClosure(parse(file), file, half);
  }
}
