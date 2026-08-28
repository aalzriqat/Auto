/**
 * The mobile coverage path rebase, tested against the shapes `sed` got wrong.
 *
 * ⚠️ The rewrite this replaces was `sed -i 's|^SF:|SF:apps/mobile/|'`. It is
 * correct for the paths jest emits today and wrong for everything else
 * (SCRUM-185 review): absolute paths get a prefix glued in front, already-rebased
 * paths get a second one, and a second application produces
 * `apps/mobile/apps/mobile/...`. Nothing re-ran it, so the defect was latent —
 * but latency was a property of the workflow, not of the rewrite, and the next
 * person to wrap a retry around it would have inherited a silent coverage loss.
 *
 * Idempotence is asserted directly rather than argued: every case is applied
 * twice and the second application must change nothing.
 */
import { describe, expect, test } from "vitest";
import { normalizeMobilePath, normalizeMobileCoverage } from "./normalizeMobileCoveragePaths.mjs";

describe("paths that must be REBASED", () => {
  test("the shape jest actually emits", () => {
    expect(normalizeMobilePath("app/_layout.tsx")).toEqual({ path: "apps/mobile/app/_layout.tsx" });
    expect(normalizeMobilePath("src/features/dashboard/index.ts")).toEqual({
      path: "apps/mobile/src/features/dashboard/index.ts",
    });
  });

  test("a workspace import that traverses UP but stays inside the repository", () => {
    // jest can emit this for a package imported across the workspace. Joined and
    // normalised it lands on a real repository file, so it is rebased, not
    // refused — refusing it would drop genuine coverage.
    expect(normalizeMobilePath("../../packages/shared/src/index.ts")).toEqual({
      path: "packages/shared/src/index.ts",
    });
  });

  test("Windows separators are normalised", () => {
    expect(normalizeMobilePath("app\\(app)\\account.tsx")).toEqual({
      path: "apps/mobile/app/(app)/account.tsx",
    });
  });
});

describe("paths that must be REFUSED", () => {
  test("an absolute POSIX path", () => {
    const result = normalizeMobilePath("/etc/passwd");
    expect(result.error).toMatch(/absolute path/);
    expect(result.path).toBeUndefined();
  });

  test("an absolute Windows path", () => {
    const result = normalizeMobilePath("C:/Users/runner/thing.ts");
    expect(result.error).toMatch(/absolute path/);
  });

  test("a path that escapes the repository root", () => {
    // `apps/mobile/` + four levels up lands outside the repository. A coverage
    // record cannot be about a file that is not in this repository.
    const result = normalizeMobilePath("../../../../outside/thing.ts");
    expect(result.error).toMatch(/escapes the repository root/);
  });
});

describe("idempotence — the property `sed` did not have", () => {
  test("an already-rebased path is left exactly as it is", () => {
    expect(normalizeMobilePath("apps/mobile/app/_layout.tsx")).toEqual({
      path: "apps/mobile/app/_layout.tsx",
    });
  });

  test("applying the rewrite twice changes nothing the second time", () => {
    const original = [
      "SF:app/_layout.tsx",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "SF:src/haptics.ts",
      "DA:1,0",
      "LF:1",
      "LH:0",
      "end_of_record",
      "",
    ].join("\n");

    const once = normalizeMobileCoverage(original);
    const twice = normalizeMobileCoverage(once.text);

    expect(once.rewritten).toBe(2);
    expect(once.text).toContain("SF:apps/mobile/app/_layout.tsx");
    expect(once.text).toContain("SF:apps/mobile/src/haptics.ts");

    // The property that matters: the second pass is a no-op.
    expect(twice.text).toBe(once.text);
    expect(twice.rewritten).toBe(0);
    expect(twice.unchanged).toBe(2);
    expect(twice.text).not.toContain("apps/mobile/apps/mobile");
  });

  test("a third pass is still a no-op", () => {
    const once = normalizeMobileCoverage("SF:app/x.tsx\nend_of_record\n");
    const thrice = normalizeMobileCoverage(normalizeMobileCoverage(once.text).text);

    expect(thrice.text).toBe(once.text);
  });
});

describe("whole-document rewriting", () => {
  test("non-SF lines are untouched", () => {
    const original = ["TN:", "SF:app/x.tsx", "FN:1,thing", "DA:1,1", "end_of_record"].join("\n");
    const { text } = normalizeMobileCoverage(original);

    expect(text.split("\n")).toEqual([
      "TN:",
      "SF:apps/mobile/app/x.tsx",
      "FN:1,thing",
      "DA:1,1",
      "end_of_record",
    ]);
  });

  test("a refused path is reported and the line is left alone rather than corrupted", () => {
    const { text, errors, rewritten } = normalizeMobileCoverage(
      ["SF:/etc/passwd", "SF:app/ok.tsx", "end_of_record"].join("\n")
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/absolute path/);
    expect(text).toContain("SF:/etc/passwd");
    expect(text).toContain("SF:apps/mobile/app/ok.tsx");
    expect(rewritten).toBe(1);
  });
});
