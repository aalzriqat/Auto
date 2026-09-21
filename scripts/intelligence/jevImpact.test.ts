import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
} from "../autoflowInvariantCatalog";
import {
  JEV_ENDPOINT,
  MAX_JEV_RESPONSE_CHARS,
  assertCommitSha,
  buildChangeState,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  globMatches,
  normalizeJevResponse,
  parseNameStatus,
  truncatePatch,
} from "./jevImpact.mjs";
import {
  buildSummaryMarkdown,
  runJevShadowImpact,
} from "./runJevShadowImpact.mjs";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRepoRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "autoflow-jev-"));
  tempDirectories.push(directory);
  return directory;
}

function responseWithJson(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  const raw = JSON.stringify(body);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: new Headers({ "content-length": String(raw.length) }),
    text: vi.fn(async () => raw),
  } as unknown as Response;
}

function lowRiskScores() {
  return {
    economic: 0.1,
    tenancy: 0.1,
    authorization: 0.1,
    replay: 0.1,
    concurrency: 0.1,
    reversal: 0.1,
    lifecycle: 0.1,
    completeness: 0.1,
    externalInput: 0.1,
    uiAuthority: 0.1,
  };
}

describe("Jev shadow impact mapper", () => {
  test("uses the canonical SCRUM-342 catalog instead of maintaining a second invariant registry", () => {
    const extracted = extractCanonicalInvariants();
    const canonical = AUTOFLOW_INVARIANTS.filter(isActiveInvariant);

    expect(extracted.map((entry) => entry.id).sort()).toEqual(
      canonical.map((entry) => entry.id).sort(),
    );
    expect(extracted.map((entry) => entry.statement).sort()).toEqual(
      canonical.map((entry) => entry.statement).sort(),
    );
    const extractedRequired = Object.fromEntries(
      extracted.map((entry) => [
        entry.id,
        entry.requirements
          .filter((requirement) => requirement.status === "REQUIRED")
          .map((requirement) => requirement.obligation)
          .sort(),
      ]),
    );
    const canonicalRequired = Object.fromEntries(
      canonical.map((entry) => [
        entry.id,
        entry.requirements
          .filter((requirement) => requirement.status === "REQUIRED")
          .map((requirement) => requirement.obligation)
          .sort(),
      ]),
    );
    expect(extractedRequired).toEqual(canonicalRequired);
  });

  test("rejects non-exact refs before invoking git", () => {
    expect(() => assertCommitSha("main", "test ref")).toThrow(/40-character/);
    expect(() => assertCommitSha("a".repeat(40), "test ref")).not.toThrow();
  });

  test("creates one Jev Noul question for every active invariant", () => {
    const invariants = extractCanonicalInvariants();
    const questions = buildJevQuestions(invariants);
    const invariantQuestions = Object.keys(questions).filter((key) =>
      key.startsWith("invariant__"),
    );

    expect(invariantQuestions).toHaveLength(invariants.length);
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(
      true,
    );
  });

  test("fails closed if two invariant IDs normalize to the same Jev question key", () => {
    const base = extractCanonicalInvariants()[0]!;
    expect(() =>
      buildJevQuestions([
        { ...base, id: "ACC-1" },
        { ...base, id: "ACC_1" },
      ]),
    ).toThrow(/question key collision/);
  });

  test("maps changed files deterministically through canonical sourceAreas", () => {
    const impacts = deterministicInvariantImpact(
      ["convex/accounting/posting.ts", "components/applications/cockpit/Foo.tsx"],
      extractCanonicalInvariants(),
    );
    const ids = impacts.map((impact) => impact.id);

    expect(ids).toContain("ACC-1");
    expect(ids).toContain("ACC-2");
    expect(ids).toContain("UI-1");
    expect(
      impacts.find((impact) => impact.id === "ACC-1")?.requiredObligations,
    ).toContain("REPLAY");
  });

  test("glob matching keeps one-star within a path segment and two-star recursive", () => {
    expect(globMatches("convex/accounting*.ts", "convex/accountingPhase2.ts")).toBe(true);
    expect(globMatches("convex/accounting*.ts", "convex/x/accounting.ts")).toBe(false);
    expect(globMatches("components/**", "components/a/b/c.tsx")).toBe(true);
    expect(globMatches("components/?pp.tsx", "components/app.tsx")).toBe(true);
    expect(globMatches("components/?pp.tsx", "components/deep/app.tsx")).toBe(false);
  });

  test("buildChangeState uses NUL-delimited Git records so unusual filenames cannot distort impact mapping", async () => {
    const repoRoot = await tempRepoRoot();
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    git(["init"]);
    git(["config", "user.email", "jev-test@example.com"]);
    git(["config", "user.name", "Jev Test"]);
    await writeFile(path.join(repoRoot, "README.md"), "base\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    await mkdir(path.join(repoRoot, "convex/accounting"), { recursive: true });
    const unusualPath = "convex/accounting/fee\tguard.ts";
    await writeFile(path.join(repoRoot, unusualPath), "export const fee = 1;\n", "utf8");
    git(["add", unusualPath]);
    git(["commit", "-m", "change"]);
    const headSha = git(["rev-parse", "HEAD"]);

    const change = buildChangeState({
      repoRoot,
      baseSha,
      headSha,
      maxPatchChars: 512,
    });

    expect(change.changedFiles).toContain(unusualPath);
    expect(change.state.patchExcerpt).toContain("fee");
    expect(change.patchCharsSent).toBeLessThanOrEqual(512);
  });

  test("rename status considers both old and new paths", () => {
    expect(
      parseNameStatus("R100\0convex/old.ts\0convex/new.ts\0M\0app/page.tsx\0"),
    ).toEqual(["convex/old.ts", "convex/new.ts", "app/page.tsx"]);
    expect(() => parseNameStatus("M\tapp/page.tsx\n")).toThrow(/NUL-delimited/);
    expect(() => parseNameStatus("R100\0only-old-path\0")).toThrow(/incomplete/);
  });

  test("large diffs retain both head and tail and explicitly mark the omitted middle", () => {
    const patch = `${"A".repeat(100)}${"B".repeat(100)}`;
    const result = truncatePatch(patch, 120);

    expect(result.truncated).toBe(true);
    expect(result.excerpt).toContain("MIDDLE OF DIFF OMITTED");
    expect(result.excerpt).toContain("AAAA");
    expect(result.excerpt).toContain("BBBB");
    expect(result.excerpt.length).toBeLessThanOrEqual(120);
  });

  test("tiny diff budgets never overflow by accidentally appending the whole tail", () => {
    const result = truncatePatch("secret-patch-body", 8);
    expect(result.truncated).toBe(true);
    expect(result.excerpt).toHaveLength(8);
    expect(result.excerpt).not.toContain("secret-patch-body");
    expect(() => truncatePatch("x", -1)).toThrow(/non-negative/);
  });

  test("Jev can add scrutiny but cannot subtract deterministic requirements", () => {
    const matrix = deriveReviewMatrix({
      extraDeterministicRequirements: ["review:correctness-governance"],
      deterministicImpact: [
        {
          id: "ACC-1",
          severity: "CRITICAL",
          matchingFiles: ["convex/accounting/foo.ts"],
          requiredObligations: ["POSITIVE", "NEGATIVE", "REPLAY"],
        },
      ],
      risks: {
        ...lowRiskScores(),
        economic: 0.99,
        replay: 0.92,
        concurrency: 0.76,
        lifecycle: 0.42,
      },
      invariantImpact: { "ACC-1": 0.97, "CONC-1": 0.81, "TEN-1": 0.02 },
    });

    expect(matrix.combinedRequirements).toContain("review:correctness-governance");
    expect(matrix.combinedRequirements).toContain("proof:POSITIVE");
    expect(matrix.combinedRequirements).toContain("proof:NEGATIVE");
    expect(matrix.combinedRequirements).toContain("proof:REPLAY");
    expect(matrix.combinedRequirements).toContain("review-invariant:ACC-1");
    expect(matrix.combinedRequirements).toContain("review-invariant:CONC-1");
    expect(matrix.combinedRequirements).toContain("proof:CONCURRENCY");
  });

  test("invalid thresholds and probabilities fail closed rather than suppressing scrutiny", () => {
    expect(() =>
      deriveReviewMatrix({
        risks: lowRiskScores(),
        invariantImpact: {},
        candidateThreshold: 0.8,
        escalationThreshold: 0.7,
      }),
    ).toThrow(/cannot exceed/);
    expect(() =>
      deriveReviewMatrix({
        risks: { ...lowRiskScores(), economic: Number.NaN },
        invariantImpact: {},
      }),
    ).toThrow(/finite probability/);
    expect(() =>
      deriveReviewMatrix({
        risks: lowRiskScores(),
        invariantImpact: { "ACC-1": 1.01 },
      }),
    ).toThrow(/finite probability/);
  });

  test("rejects malformed Jev Noul values rather than treating them as proof", () => {
    const invariants = extractCanonicalInvariants();
    const questions = buildJevQuestions(invariants);
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.2 }]),
    );
    answers.risk__economic = { type: "noul", noul: 2 };

    expect(() =>
      normalizeJevResponse(
        {
          model: "test",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers,
        },
        invariants,
      ),
    ).toThrow(/invalid Noul/);
  });

  test("rejects unexpected answer keys instead of accepting provider schema drift", () => {
    const invariants = extractCanonicalInvariants();
    const questions = buildJevQuestions(invariants);
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.2 }]),
    );
    answers.unexpected = { type: "noul", noul: 0.2 };

    expect(() =>
      normalizeJevResponse(
        { model: "test", usage: { input_tokens: 1, output_tokens: 0 }, answers },
        invariants,
      ),
    ).toThrow(/unexpected answer key/);
  });

  test("rejects a response that omits token usage so cost telemetry cannot silently disappear", () => {
    const invariants = extractCanonicalInvariants();
    const questions = buildJevQuestions(invariants);
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.2 }]),
    );

    expect(() =>
      normalizeJevResponse({ model: "test", answers }, invariants),
    ).toThrow(/token usage/);
  });

  test("rejects array-shaped answers and unsafe token counters", () => {
    const invariants = extractCanonicalInvariants();
    expect(() =>
      normalizeJevResponse(
        { model: "test", usage: { input_tokens: 1, output_tokens: 0 }, answers: [] },
        invariants,
      ),
    ).toThrow(/missing answers/);

    const questions = buildJevQuestions(invariants);
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.2 }]),
    );
    expect(() =>
      normalizeJevResponse(
        {
          model: "test",
          usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 },
          answers,
        },
        invariants,
      ),
    ).toThrow(/token usage/);
  });

  test("sends the API credential only to the fixed TypeSafe endpoint and never in the JSON body", async () => {
    const fetchImpl = vi.fn(async () =>
      responseWithJson({ answers: {} }),
    ) as unknown as typeof fetch;

    await callJev({
      apiKey: "  synthetic-secret  ",
      state: { safe: true },
      questions: {},
      fetchImpl,
    });

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.headers.Authorization).toBe("Bearer synthetic-secret");
    expect(init.body).not.toContain("synthetic-secret");
  });

  test("refuses oversized, invalid, failed, and invalid-timeout provider responses", async () => {
    const oversized = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(MAX_JEV_RESPONSE_CHARS + 1),
      }),
      text: vi.fn(async () => "{}"),
    })) as unknown as typeof fetch;
    await expect(
      callJev({ apiKey: "x", state: {}, questions: {}, fetchImpl: oversized }),
    ).rejects.toThrow(/maximum allowed size/);

    const invalidJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: vi.fn(async () => "not-json"),
    })) as unknown as typeof fetch;
    await expect(
      callJev({ apiKey: "x", state: {}, questions: {}, fetchImpl: invalidJson }),
    ).rejects.toThrow(/not valid JSON/);

    const failed = vi.fn(async () =>
      responseWithJson({}, { ok: false, status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      callJev({ apiKey: "x", state: {}, questions: {}, fetchImpl: failed }),
    ).rejects.toThrow(/HTTP 503/);

    await expect(
      callJev({ apiKey: "x", state: {}, questions: {}, timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/);
  });
});

describe("Jev shadow runner", () => {
  test("writes an advisory-unavailable artifact when commit identity is missing", async () => {
    const repoRoot = await tempRepoRoot();
    const result = await runJevShadowImpact({ repoRoot, env: {} });
    const artifact = await readFile(
      path.join(repoRoot, "artifacts/jev-shadow-impact.json"),
      "utf8",
    );

    expect(result.status).toBe("ADVISORY_UNAVAILABLE");
    expect(artifact).toContain("BASE_SHA or HEAD_SHA is missing");
  });

  test("missing credentials preserve the deterministic workflow as an explicit skip, never a safe verdict", async () => {
    const repoRoot = await tempRepoRoot();
    const result = await runJevShadowImpact({
      repoRoot,
      env: { BASE_SHA: "a".repeat(40), HEAD_SHA: "b".repeat(40) },
    });

    expect(result.status).toBe("SKIPPED_NO_CREDENTIAL");
    expect(result.blocking).toBe(false);
  });

  test("whitespace-only credentials are treated as unavailable", async () => {
    const repoRoot = await tempRepoRoot();
    const result = await runJevShadowImpact({
      repoRoot,
      env: {
        BASE_SHA: "a".repeat(40),
        HEAD_SHA: "b".repeat(40),
        TYPESAFE_API_KEY: "   ",
      },
    });

    expect(result.status).toBe("SKIPPED_NO_CREDENTIAL");
  });

  test("complete shadow output is sanitized and preserves deterministic requirements", async () => {
    const repoRoot = await tempRepoRoot();
    const secret = "runner-secret";
    const result = await runJevShadowImpact({
      repoRoot,
      env: {
        BASE_SHA: "a".repeat(40),
        HEAD_SHA: "b".repeat(40),
        TYPESAFE_API_KEY: secret,
      },
      runtimeOverrides: {
        extractCanonicalInvariants: () => [
          {
            id: "ACC-1",
            title: "Accounting",
            severity: "CRITICAL",
            state: "PARTIAL",
            statement: "Accounting stays correct",
            sourceAreas: ["convex/accounting/**"],
            requirements: [{ obligation: "REPLAY", status: "REQUIRED" }],
          },
        ],
        buildChangeState: () => ({
          state: { patchExcerpt: "DO NOT SERIALIZE THIS PATCH" },
          changedFiles: ["package.json"],
          patchTruncated: false,
          patchCharsSent: 27,
        }),
        deterministicInvariantImpact: () => [
          {
            id: "ACC-1",
            severity: "CRITICAL",
            matchingFiles: ["convex/accounting/foo.ts"],
            requiredObligations: ["REPLAY"],
          },
        ],
        buildJevQuestions: () => ({ synthetic: { type: "noul" } } as any),
        callJev: vi.fn(async () => ({ never: "serialized" })) as any,
        normalizeJevResponse: () => ({
          model: "model`\nspoof",
          usage: { input_tokens: 12, output_tokens: 0 },
          risks: { ...lowRiskScores(), replay: 0.9 },
          invariantImpact: { "ACC-1": 0.9 },
        }),
      },
    });
    const artifact = await readFile(
      path.join(repoRoot, "artifacts/jev-shadow-impact.json"),
      "utf8",
    );
    const summary = await readFile(
      path.join(repoRoot, "artifacts/jev-shadow-summary.md"),
      "utf8",
    );

    expect(result.status).toBe("ADVISORY_COMPLETE");
    expect(result.reviewMatrix.combinedRequirements).toContain("proof:REPLAY");
    expect(result.reviewMatrix.combinedRequirements).toContain(
      "review:correctness-governance",
    );
    expect(artifact).not.toContain(secret);
    expect(artifact).not.toContain("DO NOT SERIALIZE THIS PATCH");
    expect(summary).not.toContain("model`\nspoof");
    expect(summary).toContain("model  spoof");
  });

  test("provider failures are advisory-unavailable and redact the credential from artifacts", async () => {
    const repoRoot = await tempRepoRoot();
    const secret = "provider-secret";
    const result = await runJevShadowImpact({
      repoRoot,
      env: {
        BASE_SHA: "a".repeat(40),
        HEAD_SHA: "b".repeat(40),
        TYPESAFE_API_KEY: secret,
      },
      runtimeOverrides: {
        extractCanonicalInvariants: () => [],
        buildChangeState: () => ({
          state: {},
          changedFiles: [],
          patchTruncated: false,
          patchCharsSent: 0,
        }),
        deterministicInvariantImpact: () => [],
        buildJevQuestions: () => ({}),
        callJev: vi.fn(async () => {
          throw new Error(`transport accidentally mentioned ${secret}`);
        }) as any,
      },
    });
    const artifact = await readFile(
      path.join(repoRoot, "artifacts/jev-shadow-impact.json"),
      "utf8",
    );

    expect(result.status).toBe("ADVISORY_UNAVAILABLE");
    expect(artifact).toContain("[REDACTED]");
    expect(artifact).not.toContain(secret);
  });

  test("summary formatting neutralizes provider-controlled model line breaks and markup", () => {
    const summary = buildSummaryMarkdown({
      status: "ADVISORY_UNAVAILABLE",
      reason: "bad\n<details>surprise</details>",
    });
    expect(summary).not.toContain("<details>");
    expect(summary).toContain("Reason: `bad  details surprise /details `");
  });
});
