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

  test("the census actually inspected client callers", () => {
    // Guards against the whole suite passing because the walker found nothing.
    expect(findings.length).toBeGreaterThan(30);
    expect(findings.some((f) => f.file.startsWith("apps/mobile/"))).toBe(true);
    expect(findings.some((f) => f.file.startsWith("components/"))).toBe(true);
  });
});
