import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Exact content pins for the sources SCRUM-215 P3 was reviewed against.
 *
 * ## What this asserts — the whole claim, stated narrowly
 *
 *   The protected source files are byte-for-byte the owner-reviewed
 *   postimages, modulo CRLF→LF checkout normalization.
 *
 * That is all. It is a CHANGE-CONTROL ratchet, not a security boundary and not
 * a safety proof.
 *
 * ## What this deliberately does NOT claim
 *
 * It does not prove that all database access is recognized, that all predicate
 * spellings are recognized, that raw reads are structurally impossible, or that
 * the wrapper is semantically safe under any refactor. It cannot: it never
 * looks at the code's meaning at all. A file that matches its pin has not
 * changed; nothing more follows from a match.
 *
 * ## Why it is a hash and not an analyzer
 *
 * Five successive generations of a semantic recognizer were built for this
 * lane, reviewed, and defeated — each by a construct its author had not
 * enumerated: an unrunnable `git diff` baseline, occurrence counting beaten by a
 * net-zero swap, regexes beaten by three raw-read spellings and by a decoy
 * string literal, an AST walker beaten by `ctx[k]`, and finally a version that
 * refused computed access wholesale, beaten by `Reflect.get(ctx, "db")` plus a
 * predicate reassembled from `"REJ" + "ECTED"`. The lesson recorded in the Jira
 * history and in git is that "recognize every unsafe spelling" is not a
 * property a single-file, type-checker-less analyzer can hold. Pinning content
 * abandons recognition rather than extending it, so there is no sixth spelling
 * to find.
 *
 * The cost is intentional friction: any legitimate change to a pinned file
 * requires explicit owner authorization, renewal of the constants below, and a
 * fresh exact-SHA certification. A silently updated pin is the same as no
 * ratchet at all.
 */
describe("protected source content pins", () => {
  const repoRoot = path.resolve(__dirname, "..");

  /**
   * Complete file contents, with CRLF→LF applied and nothing else.
   *
   * Normalization is load-bearing rather than cosmetic: this repository has no
   * `.gitattributes` and `core.autocrlf=true`, so an identical commit is larger
   * on a Windows worktree than on a Linux runner. A raw byte hash would pass on
   * one and fail on the other. A bare `\r` is rejected rather than normalized —
   * it is not a checkout artifact, so silently folding it would let a real
   * content change hide inside the normalization step.
   */
  const normalized = (relativePath: string): string => {
    const raw = readFileSync(path.join(repoRoot, relativePath), "utf8");
    const text = raw.replace(/\r\n/g, "\n");
    expect(
      text.includes("\r"),
      `${relativePath} contains a bare CR, which checkout normalization does not explain.`
    ).toBe(false);
    return text;
  };

  const sha256 = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

  const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

  /**
   * The reviewed postimages.
   *
   * ⚠️ These are computed from the approved files themselves. Do not copy them
   * from a report, a Jira comment or a chat message — a truncated or restated
   * digest pins nothing.
   */
  const PINS = [
    {
      /**
       * Immutable for a structural reason, not an architectural one: it carries
       * seven historical non-indexed query filters that predate the repository's
       * Convex lint rule, and that guard evaluates the whole projected file.
       *
       * ⚠️ WHAT THIS FILE'S DELTA ACTUALLY IS, relative to the branch this PR
       * merges into — stated because the shorter story is misleading.
       *
       * Against `origin/main` this file differs by **32 insertions and 4
       * deletions**, not by one token:
       *
       *   1. `pendingDepositResolution` is extracted into an exported function
       *      from logic previously inlined in `applications.list`, and `list`
       *      now calls it. Behaviour-preserving, covered by
       *      `applications.test.ts` and `dealWorkspace.test.ts`.
       *   2. `dealCockpit`'s payload gains two additive fields,
       *      `documentRulesApply` and `supplierDisbursementConfirmedAt`.
       *
       * The "one token" description is true only against `fa9d48d09` on the
       * parked `agent/scrum-215-unified-deal-p0-p3` branch — a lineage that is
       * NOT an ancestor of main and whose combined candidate failed review. That
       * framing understated the reviewable surface roughly thirtyfold and lent
       * an owner authorization, granted for one token, to content that
       * authorization never covered. Read the 32 lines; do not take this
       * comment's word for their pedigree.
       */
      file: "convex/applications.ts",
      bytes: 214777,
      sha256: "2ae2518ea68d67d320a19d76402f55683d8030e1e10284ef86af2c9ad560eab6",
    },
    {
      /**
       * The P3 read-model wrapper. Pinned because it is the file that composes
       * the cash-custody flag and the appraisal provenance on top of an
       * authority it must not reinterpret.
       */
      file: "convex/dealWorkspace.ts",
      bytes: 9216,
      sha256: "1eb4f689e0082d3b4fbe591cc0a3bf62924734eedf3679c7d011981565aa7ab4",
    },
  ] as const;

  test.each(PINS)("$file is the reviewed postimage", ({ file, bytes, sha256: expected }) => {
    const text = normalized(file);
    // Length first: when a pin fails, "the file is 40 bytes longer" is a more
    // useful opening fact than two unequal digests.
    expect(byteLength(text)).toBe(bytes);
    expect(sha256(text)).toBe(expected);
  });

  /**
   * The one negative control kept.
   *
   * A pin nobody has watched fail is not a pin — this proves the assertion can
   * fail at all, which is the single thing a hash comparison can get wrong (a
   * digest computed over the wrong bytes, or compared against itself). It is
   * deliberately generic: an expanding taxonomy of semantic mutants is exactly
   * the load-bearing logic this ratchet replaced, and those five defeated
   * generations remain as review evidence in Jira and git history rather than
   * as code here.
   */
  test("a one-byte change to a pinned file changes its pin", () => {
    const text = normalized("convex/dealWorkspace.ts");
    const mutated = `${text} `;
    expect(byteLength(mutated)).not.toBe(byteLength(text));
    expect(sha256(mutated)).not.toBe(sha256(text));
  });
});
