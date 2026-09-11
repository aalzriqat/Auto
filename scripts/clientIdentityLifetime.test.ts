/**
 * The client-boundary identity ratchet (SCRUM-313).
 *
 * The server ratchet proves the BACKEND demands an identity. This one proves
 * the CLIENT supplies a stable one — and that every fingerprinted argument is
 * frozen alongside it. A required identity that the client regenerates per
 * attempt is not a guard; it is a slower way to post twice.
 *
 * The self-tests come first, as in `tenantWriteGuard.test.ts` and
 * `economicCommandCensus.test.ts`: a guard nobody has watched fail is not a
 * guard. They pin the three faults this analyzer actually had, each of which
 * produced a WRONG census before it was caught.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  ALTERNATE_IDENTITY_ARG,
  auditClientCallers,
  classifyKeyExpression,
  GENERATION_DISCRIMINATED,
  intentCarriesGeneration,
  isUnsafe,
  needsManualRead,
  serverFingerprints,
  type CallerFinding,
} from "./clientIdentityLifetime";

const REPO_ROOT = path.resolve(__dirname, "..");
const CONVEX_ROOT = path.join(REPO_ROOT, "convex");

/** The IDENTITY_GUARDED set, read from the server ratchet's own table. */
function identityGuardedCommands(): string[] {
  const src = fs.readFileSync(path.join(__dirname, "economicCommandCensus.test.ts"), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/"([\w.]+)":\s*\{\s*bucket:\s*"IDENTITY_GUARDED"/g)) out.push(m[1]);
  return out;
}

describe("analyzer self-tests — the faults this census actually had", () => {
  test("FAULT 1: a comment containing a comma must not hide the identity", () => {
    // Splitting an object literal on commas WITHOUT stripping comments glues a
    // comment tail onto the next property's key. `playwright/utils.ts` carries
    // the comment "a fresh identity per seeded vehicle, so repeated setup runs"
    // directly above its idempotencyKey, and the census reported that caller as
    // having NO identity at all.
    const findings = auditClientCallers(
      REPO_ROOT,
      ["vehicles.create"],
      new Map([["vehicles.create", ["vin"]]])
    ).findings;
    const seeded = findings.find((f) => f.file === "playwright/utils.ts");
    expect(seeded, "playwright fixture caller should be found").toBeDefined();
    expect(seeded!.keyLifetime).not.toBe("ABSENT");
  });

  test("FAULT 2: a key arriving via a spread is UNKNOWN, never ABSENT", () => {
    // `CollectionsTab` builds a `common` object holding the key and spreads it.
    // Reporting that as ABSENT would be a fabricated finding — the analyzer
    // cannot see through a spread, and must say so rather than guess.
    const findings = auditClientCallers(
      REPO_ROOT,
      ["collections.createReceivable"],
      new Map()
    ).findings;
    const viaSpread = findings.filter((f) => f.keyLifetime === "VIA_SPREAD");
    expect(viaSpread.length).toBeGreaterThan(0);
    for (const f of viaSpread) expect(needsManualRead(f)).toBe(true);
  });

  test("FAULT 3: an alternate identity argument counts as an identity", () => {
    // `vehicles.importBulk` identifies an upload with `importId`, reused for
    // every chunk and every retry. Demanding the literal name `idempotencyKey`
    // would report a correctly-guarded caller as unguarded.
    expect(ALTERNATE_IDENTITY_ARG["vehicles.importBulk"]).toBe("importId");
  });

  test("FAULT 4: a `.renew(...)` key is PER_ATTEMPT, not a passing caller", () => {
    // The fault this ratchet was BLIND to, and the reason it is worth having a
    // ratchet you also attack. `useCommandIdentity.renew()` minted a fresh uuid
    // on every call — a per-attempt key by construction — but at the call site
    // it was indistinguishable from the retained `.for()`, so the analyzer
    // classified it LITERAL_OR_DERIVED and reported ZERO per-attempt callers
    // while BOTH `deposits.release` callers used exactly that mechanism. The
    // census was not wrong about the code it read; it could not see the one
    // mechanism this codebase actually used.
    //
    // `renew` has since been removed outright, which is precisely why this case
    // is pinned on the CLASSIFIER rather than on the tree: a self-test that
    // reads the current repository stops testing anything the moment the
    // repository is fixed.
    expect(classifyKeyExpression("commandId.renew(intent)", false)).toBe("PER_ATTEMPT");
    expect(classifyKeyExpression("commandId.renew(`release:${id}`)", false)).toBe("PER_ATTEMPT");
    expect(
      isUnsafe({
        command: "deposits.release",
        file: "synthetic.tsx",
        line: 1,
        keyLifetime: classifyKeyExpression("commandId.renew(intent)", false),
        keyExpression: "commandId.renew(intent)",
        volatileFingerprintArgs: [],
      })
    ).toBe(true);
    // The safe sibling must NOT be swept up with it, or the ratchet is just
    // noise: `.for()` returns the SAME key until it is retired.
    expect(classifyKeyExpression("commandId.for(intent)", false)).toBe("LITERAL_OR_DERIVED");
  });

  test("FAULT 5: a key built from a VOLATILE primitive is PER_ATTEMPT (Sonnet MAX F2)", () => {
    // The SECOND blind spot of exactly the FAULT 4 shape, found by the Sonnet
    // MAX seat at c06a989b8 by reading one paragraph up from the classifier:
    // this file already named Date.now(), Math.random() and performance.now()
    // as values that differ on every evaluation — and consulted that list only
    // for fingerprint arguments, never for the key. So a template that embeds
    // one of them looked LITERAL_OR_DERIVED to the ratchet built to catch
    // per-attempt minting, and the population-level test would have reported a
    // clean [] over such a caller. No caller does this today; that is exactly
    // why it is pinned on the CLASSIFIER and not on the tree.
    expect(
      classifyKeyExpression("`release-deposit:${depositId}:gen${generation}:${Date.now()}`", false)
    ).toBe("PER_ATTEMPT");
    expect(classifyKeyExpression("`release-deposit:${depositId}:${Math.random()}`", false)).toBe("PER_ATTEMPT");
    expect(classifyKeyExpression("`k-${performance.now()}`", false)).toBe("PER_ATTEMPT");
    expect(classifyKeyExpression("`k-${new Date()}`", false)).toBe("PER_ATTEMPT");
    // And the safe shape stays safe: a generation-bearing intent with no
    // volatile primitive is DERIVED, so the fix cannot be a blanket that
    // sweeps every template literal into PER_ATTEMPT.
    expect(
      classifyKeyExpression("`release-deposit:${depositId}:${resolution}:gen${generation}`", false)
    ).toBe("LITERAL_OR_DERIVED");
    expect(classifyKeyExpression("commandId.for(intent)", false)).toBe("LITERAL_OR_DERIVED");
  });

  test("minting inside a retained holder is still PER_ATTEMPT", () => {
    // Ordering matters in the classifier. An expression can read a ref AND mint
    // (`keyRef.current = crypto.randomUUID()`); minting is the property that
    // decides safety, so it is tested first. Checking the retained shape first
    // would let this hide behind the ref.
    expect(classifyKeyExpression("(keyRef.current = crypto.randomUUID())", false)).toBe("PER_ATTEMPT");
    expect(classifyKeyExpression("keyRef.current", false)).toBe("RETAINED");
  });

  test("the volatility rule catches a recomputed fingerprint input", () => {
    // The half that is easy to miss: a retained key plus a moving `date` does
    // not fix the command, it converts a silent double-post into a rejection.
    const synthetic: CallerFinding = {
      command: "expenses.create",
      file: "synthetic.tsx",
      line: 1,
      keyLifetime: "RETAINED",
      keyExpression: "keyRef.current",
      volatileFingerprintArgs: ["date"],
    };
    expect(isUnsafe(synthetic)).toBe(true);
  });
});

describe("SCRUM-313 client identity lifetime", () => {
  const identityGuarded = identityGuardedCommands();
  const fingerprints = serverFingerprints(CONVEX_ROOT);
  const { findings, commandsWithNoClientCaller } = auditClientCallers(
    REPO_ROOT,
    identityGuarded,
    fingerprints
  );

  test("the identity-guarded set is read, not hardcoded", () => {
    expect(identityGuarded.length).toBeGreaterThan(30);
    expect(identityGuarded).toContain("expenses.create");
  });

  test("no client caller mints its identity per ATTEMPT", () => {
    const perAttempt = findings
      .filter((f) => f.keyLifetime === "PER_ATTEMPT" || f.keyLifetime === "ABSENT")
      .map((f) => `${f.command} @ ${f.file}:${f.line} (${f.keyLifetime})`)
      .sort((a, b) => a.localeCompare(b));
    expect(perAttempt).toEqual([]);
  });

  test("no client caller recomputes a FINGERPRINTED argument across a retry", () => {
    const volatile = findings
      .filter((f) => f.volatileFingerprintArgs.length > 0)
      .map((f) => `${f.command} @ ${f.file}:${f.line} -> ${f.volatileFingerprintArgs.join(",")}`)
      .sort((a, b) => a.localeCompare(b));
    expect(volatile).toEqual([]);
  });

  test("server-only commands are ENUMERATED, not assumed", () => {
    // An absence claim needs a search of the space it claims. These five have
    // no client caller anywhere under components/, app/, hooks/, lib/,
    // apps/mobile/src/, playwright/ or cypress/ — verified, not inferred from a
    // grep that happened to return nothing.
    expect(commandsWithNoClientCaller.sort((a, b) => a.localeCompare(b))).toEqual([
      "collections.applyRetainedCredit",
      "financeDealCosts.openDealCustody",
      "financeDealCosts.recordCustodyMovement",
      "financeDealCosts.recordDealFee",
      "sourcingPayables.recordPartialPayment",
    ]);
  });

  test("every generation-discriminated caller puts the GENERATION in its intent", () => {
    // Found by mutation, not by review: deleting `:gen${generation}` from the
    // release intent survived the entire suite. Every other assertion here
    // measures the key's LIFETIME, and a permanent key scores perfectly on that
    // — which is precisely the shape of the original incident. So the intent's
    // CONTENT gets its own assertion.
    const generationCommands = Object.keys(GENERATION_DISCRIMINATED);
    const relevant = findings.filter((f) => generationCommands.includes(f.command));
    expect(relevant.length, "no generation-discriminated caller was inspected").toBeGreaterThan(0);
    const missing = relevant
      .filter((f) => f.carriesGeneration !== true)
      .map((f) => `${f.command} @ ${f.file}:${f.line} -> ${f.keyExpression}`)
      .sort((a, b) => a.localeCompare(b));
    expect(missing).toEqual([]);
  });

  test("the generation check REJECTS an intent without one", () => {
    // The self-test half: an assertion nobody has watched fail is not an
    // assertion. Both shapes are literal, so this keeps testing the analyzer
    // after the tree is fixed.
    const withGen = "const intent = `release-deposit:${id}:${resolution}:${method}:gen${generation}`;";
    const withoutGen = "const intent = `release-deposit:${id}:${resolution}:${method}`;";
    expect(intentCarriesGeneration(withGen, "commandId.for(intent)")).toBe(true);
    expect(intentCarriesGeneration(withoutGen, "commandId.for(intent)")).toBe(false);
    // An intent this analyzer cannot follow FAILS rather than passing unseen.
    expect(intentCarriesGeneration(withGen, "commandId.for(buildIntent(id))")).toBe(false);
    expect(intentCarriesGeneration("", "someKeyRef.current")).toBe(false);
  });

  test("neither command-identity hook offers a per-attempt mint", () => {
    // `renew` is gone from both clients, not merely unused. Leaving a
    // per-attempt mint on the identity API is an invitation with a docstring:
    // the next caller that finds content-based identity awkward reaches for it,
    // and the ratchet above only catches the call site AFTER it is written.
    // The generation-aware intent (`deposits.releaseCount`) is the replacement.
    const hooks = [
      "hooks/useCommandIdentity.ts",
      "apps/mobile/src/features/workspace/modules/moduleShared.tsx",
    ];
    for (const rel of hooks) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      // Prose ABOUT renew is required — the removal has to explain itself — so
      // this pins the declaration and the implementation, not the mention.
      expect(src, `${rel} declares renew on the identity type`).not.toMatch(
        /^\s*renew\s*:\s*\(/m
      );
      expect(src, `${rel} implements renew`).not.toMatch(/^\s*renew\s*\(\s*intentId/m);
    }
  });

  test("no client caller mints a per-attempt identity via `.renew(`", () => {
    // The population-level statement, complementing the classifier unit test.
    const roots = ["components", "app", "hooks", "lib", "apps/mobile/src"];
    const offenders: string[] = [];
    const walkAll = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", ".next", "_generated", ".expo"].includes(e.name)) continue;
          walkAll(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/\bcommandId\s*\.\s*renew\s*\(/.test(src)) {
            offenders.push(path.relative(REPO_ROOT, p).replace(/\\/g, "/"));
          }
        }
      }
    };
    for (const r of roots) walkAll(path.join(REPO_ROOT, r));
    expect(offenders.sort((a, b) => a.localeCompare(b))).toEqual([]);
  });

  test("the census actually inspected client callers", () => {
    // Guards against the whole suite passing because the walker found nothing.
    expect(findings.length).toBeGreaterThan(30);
    expect(findings.some((f) => f.file.startsWith("apps/mobile/"))).toBe(true);
    expect(findings.some((f) => f.file.startsWith("components/"))).toBe(true);
  });
});
