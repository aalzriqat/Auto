import { describe, expect, test, vi } from "vitest";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
} from "../autoflowInvariantCatalog";
import {
  assertCommitSha,
  buildJevQuestions,
  callJev,
  deriveReviewMatrix,
  deterministicInvariantImpact,
  extractCanonicalInvariants,
  globToRegExp,
  normalizeJevResponse,
  parseNameStatus,
  truncatePatch,
} from "./jevImpact.mjs";

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
    expect(globToRegExp("convex/accounting*.ts").test("convex/accountingPhase2.ts")).toBe(
      true,
    );
    expect(globToRegExp("convex/accounting*.ts").test("convex/x/accounting.ts")).toBe(
      false,
    );
    expect(globToRegExp("components/**").test("components/a/b/c.tsx")).toBe(true);
  });

  test("rename status considers both old and new paths", () => {
    expect(
      parseNameStatus("R100\tconvex/old.ts\tconvex/new.ts\nM\tapp/page.tsx\n"),
    ).toEqual(["convex/old.ts", "convex/new.ts", "app/page.tsx"]);
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
        economic: 0.99,
        tenancy: 0.01,
        authorization: 0.01,
        replay: 0.92,
        concurrency: 0.76,
        reversal: 0.1,
        lifecycle: 0.42,
        completeness: 0.1,
        externalInput: 0.1,
        uiAuthority: 0.1,
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

  test("sends the API credential only in Authorization and never in the JSON request body", async () => {
    const json = vi.fn(async () => ({ answers: {} }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json,
    })) as unknown as typeof fetch;

    await callJev({
      apiKey: "synthetic-secret",
      state: { safe: true },
      questions: {},
      fetchImpl,
    });

    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer synthetic-secret");
    expect(init.body).not.toContain("synthetic-secret");
  });
});
