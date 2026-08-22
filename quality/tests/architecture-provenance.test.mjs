import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { validateBaselineProvenance } from "../architecture.mjs";
import {
  readOriginMainArchitectureBaseline,
  runArchitectureGit,
} from "../architecture-provenance.mjs";
import { resolveGitExecutable } from "../git-executable.mjs";
import { repositoryRoot } from "../maintainability-cli.mjs";

const SOURCE_COMMIT = "4ab1dd3a8d4c745c1b2f02a404234d0f07d96ce7";

function gitResult(exitCode, stdout = "", stderr = "") {
  return { exitCode, stderr, stdout };
}

function queuedGit(results) {
  const queue = [...results];
  return async () => {
    assert.notEqual(queue.length, 0, "unexpected Git provenance command");
    return queue.shift();
  };
}

function normalizeFileSystemPath(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

test("both guards use the validated Git override without consulting PATH", async () => {
  const configuredGit = resolveGitExecutable();
  const originalConfiguredGit = process.env.AUTOFLOW_GIT_EXECUTABLE;
  const originalPath = process.env.PATH;
  try {
    process.env.AUTOFLOW_GIT_EXECUTABLE = configuredGit;
    process.env.PATH = "";

    const architectureResult = await runArchitectureGit(process.cwd(), [
      "rev-parse",
      "--show-toplevel",
    ]);
    assert.equal(architectureResult.exitCode, 0, architectureResult.stderr);
    assert.equal(
      normalizeFileSystemPath(architectureResult.stdout.trim()),
      normalizeFileSystemPath(repositoryRoot(process.cwd())),
    );
  } finally {
    if (originalConfiguredGit === undefined) {
      delete process.env.AUTOFLOW_GIT_EXECUTABLE;
    } else {
      process.env.AUTOFLOW_GIT_EXECUTABLE = originalConfiguredGit;
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("the shared Git override rejects a relative executable", () => {
  assert.throws(
    () =>
      resolveGitExecutable({
        environment: { AUTOFLOW_GIT_EXECUTABLE: "git" },
      }),
    /must be an absolute path/,
  );
});

test("baseline provenance accepts an origin/main and HEAD ancestor", async () => {
  const executeGit = queuedGit([
    gitResult(0, "false\n"),
    gitResult(0),
    gitResult(0, `${SOURCE_COMMIT}\n`),
    gitResult(0),
    gitResult(0, `${SOURCE_COMMIT}\n`),
    gitResult(0),
  ]);

  assert.equal(
    await validateBaselineProvenance({
      rootDir: ".",
      sourceCommit: SOURCE_COMMIT,
      executeGit,
    }),
    SOURCE_COMMIT,
  );
});

test("origin/main baseline loading distinguishes bootstrap from an existing ratchet", async () => {
  const baselinePath = "quality/baselines/architecture.json";
  assert.equal(
    await readOriginMainArchitectureBaseline({
      rootDir: ".",
      baselinePath,
      executeGit: queuedGit([gitResult(0, "")]),
    }),
    null,
  );

  const baseline = { version: 1, cyclicModules: [], cyclicEdges: [] };
  const treeEntry = `100644 blob 0123456789012345678901234567890123456789\t${baselinePath}\0`;
  assert.deepEqual(
    await readOriginMainArchitectureBaseline({
      rootDir: ".",
      baselinePath,
      executeGit: queuedGit([
        gitResult(0, treeEntry),
        gitResult(0, JSON.stringify(baseline)),
      ]),
    }),
    baseline,
  );
});

test("origin/main baseline loading fails closed when the committed ratchet is unreadable", async (t) => {
  const baselinePath = "quality/baselines/architecture.json";
  const treeEntry = `100644 blob 0123456789012345678901234567890123456789\t${baselinePath}\0`;

  await t.test("Git cannot read the blob", async () => {
    await assert.rejects(
      readOriginMainArchitectureBaseline({
        rootDir: ".",
        baselinePath,
        executeGit: queuedGit([
          gitResult(0, treeEntry),
          gitResult(128, "", "cannot read blob"),
        ]),
      }),
      /Git could not run show origin\/main:quality\/baselines\/architecture\.json.*cannot read blob/s,
    );
  });

  await t.test("the blob is malformed JSON", async () => {
    await assert.rejects(
      readOriginMainArchitectureBaseline({
        rootDir: ".",
        baselinePath,
        executeGit: queuedGit([
          gitResult(0, treeEntry),
          gitResult(0, "{not-json"),
        ]),
      }),
      /origin\/main is not valid JSON/,
    );
  });
});

test("baseline provenance fails closed for shallow or incomplete history", async (t) => {
  await t.test("shallow repository", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([gitResult(0, "true\n")]),
      }),
      /clone is shallow.*fetch-depth: 0/s,
    );
  });

  await t.test("missing baseline commit", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([gitResult(0, "false\n"), gitResult(128)]),
      }),
      /sourceCommit .* is not available as a commit/,
    );
  });

  await t.test("missing origin main ref", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([
          gitResult(0, "false\n"),
          gitResult(0),
          gitResult(1),
        ]),
      }),
      /Required ref origin\/main is unavailable/,
    );
  });

  await t.test(
    "origin main does not resolve to a canonical commit",
    async () => {
      await assert.rejects(
        validateBaselineProvenance({
          rootDir: ".",
          sourceCommit: SOURCE_COMMIT,
          executeGit: queuedGit([
            gitResult(0, "false\n"),
            gitResult(0),
            gitResult(0, "not-a-commit\n"),
          ]),
        }),
        /did not resolve origin\/main to a full commit SHA/,
      );
    },
  );

  await t.test("branch-only source outside origin/main ancestry", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([
          gitResult(0, "false\n"),
          gitResult(0),
          gitResult(0, `${SOURCE_COMMIT}\n`),
          gitResult(1),
        ]),
      }),
      /not an ancestor of origin\/main/,
    );
  });

  await t.test("missing HEAD", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([
          gitResult(0, "false\n"),
          gitResult(0),
          gitResult(0, `${SOURCE_COMMIT}\n`),
          gitResult(0),
          gitResult(1),
        ]),
      }),
      /Required ref HEAD is unavailable/,
    );
  });

  await t.test("source commit outside HEAD ancestry", async () => {
    await assert.rejects(
      validateBaselineProvenance({
        rootDir: ".",
        sourceCommit: SOURCE_COMMIT,
        executeGit: queuedGit([
          gitResult(0, "false\n"),
          gitResult(0),
          gitResult(0, `${SOURCE_COMMIT}\n`),
          gitResult(0),
          gitResult(0, `${SOURCE_COMMIT}\n`),
          gitResult(1),
        ]),
      }),
      /not an ancestor of HEAD/,
    );
  });
});
