import { describe, expect, test } from "vitest";
import { compareContracts, SEVERITY, blockersForRelease, pathsOverlap } from "./compare.mjs";
import { declaredPaths } from "./declaredPaths.mjs";

/**
 * The two shapes in this file are not hypotheticals. Both reached production:
 *
 *   #227 / SCRUM-177 — the client began sending `expectedCurrency` to two
 *   opening-balance mutations whose deployed validators did not declare it.
 *   Both entry paths were refused for ~33.5 hours.
 *
 *   #235 / SCRUM-59 — the client began sending `rowId` INSIDE
 *   `vehicles: v.array(v.object({...}))`. Caught before merging; the window was
 *   held to ~11m37s by manual coordination, which is mitigation, not control.
 *
 * Fixture 3 exists so the control stays usable: an additive optional argument
 * breaks nobody, and a detector that flags every backend change gets switched
 * off within a week.
 *
 * Fixture 4 exists so the control stays honest: a known key carrying an `any`
 * value is shape-safe but NOT value-verified, and must report as neither PASS
 * nor BREAKING.
 */

/** A Convex validator entry, as the live function spec actually encodes it. */
const field = (fieldType: unknown, optional = false) => ({ fieldType, optional });
const str = { type: "string" };
const obj = (value: Record<string, unknown>) => ({ type: "object", value });
const arr = (value: unknown) => ({ type: "array", value });

const spec = (identifier: string, args: unknown) => ({
  functions: [{ identifier, args, functionType: "Mutation", visibility: { kind: "public" } }],
});

type Sent = Map<string, { optional: boolean; valueKind: string; provenance: string }>;
/**
 * Fixtures model explicit literal properties unless they say otherwise, so the
 * default provenance is LITERAL — the payload demonstrably reaches Convex.
 * Pass a third element to model a field that is only an OPTIONAL member of a
 * shared type, which is uncertainty rather than a defect.
 */
const sent = (entries: Array<[string, string] | [string, string, string]>): Sent =>
  new Map(
    entries.map(([p, kind, provenance]) => [
      p,
      { optional: false, valueKind: kind, provenance: provenance ?? "LITERAL" },
    ])
  );

const call = (identifier: string, s: Sent, unknowns: string[] = []) => ({
  identifier,
  file: "components/Fixture.tsx",
  line: 1,
  sent: s,
  unknowns,
  casts: [],
});

describe("SCRUM-178 contract skew detector", () => {
  test("FIXTURE 1 (#227 shape): a required argument the live backend does not declare is BREAKING", () => {
    // Production at the time declared only orgId + lines. The deployed frontend
    // sent expectedCurrency as well, and Convex refuses undeclared fields.
    const live = spec(
      "accountingCutover.js:draftOpeningBalance",
      obj({ orgId: field(str), lines: field(arr(obj({ accountId: field(str) }))) })
    );
    const result = compareContracts(
      [
        call(
          "accountingCutover:draftOpeningBalance",
          sent([
            ["orgId", "string"],
            ["lines", "array"],
            ["lines[*]", "object"],
            ["lines[*].accountId", "string"],
            ["expectedCurrency", "string"],
          ])
        ),
      ],
      live
    );

    const breaking = result.breaking;
    expect(breaking).toHaveLength(1);
    expect(breaking[0]).toMatchObject({
      severity: SEVERITY.BREAKING,
      dimension: "SHAPE",
      path: "expectedCurrency",
    });
    expect(breaking[0].detail).toMatch(/declares no such field/);
  });

  test("FIXTURE 2 (#235 shape): a NESTED field inside an array element is BREAKING, reported at its full path", () => {
    // ⚠️ The whole reason this detector uses the TypeChecker. Both sides agree
    // on `vehicles`; the incompatibility is one level down, inside the element.
    // A top-level-only comparison passes this fixture while production breaks.
    const live = spec(
      "vehicles.js:importBulk",
      obj({
        orgId: field(str),
        vehicles: field(arr(obj({ make: field(str), vin: field(str) }))),
      })
    );
    const result = compareContracts(
      [
        call(
          "vehicles:importBulk",
          sent([
            ["orgId", "string"],
            ["vehicles", "array"],
            ["vehicles[*]", "object"],
            ["vehicles[*].make", "string"],
            ["vehicles[*].vin", "string"],
            ["vehicles[*].rowId", "number"],
          ])
        ),
      ],
      live
    );

    const paths = result.breaking.map((f: { path: string }) => f.path);
    expect(paths).toContain("vehicles[*].rowId");
    // Reported at the nested path, never collapsed to the parent — "vehicles"
    // alone would be indistinguishable from a compatible call.
    expect(paths).not.toContain("vehicles");
  });

  test("FIXTURE 3: an additive OPTIONAL backend argument the client omits is NOT flagged", () => {
    // Noise control. This is the common, safe backend change; if it alerts,
    // the whole control becomes something people mute.
    const live = spec(
      "vehicles.js:importBulk",
      obj({
        orgId: field(str),
        vehicles: field(arr(obj({ make: field(str) }))),
        note: field(str, true), // newly added, optional
      })
    );
    const result = compareContracts(
      [
        call(
          "vehicles:importBulk",
          sent([
            ["orgId", "string"],
            ["vehicles", "array"],
            ["vehicles[*]", "object"],
            ["vehicles[*].make", "string"],
          ])
        ),
      ],
      live
    );

    expect(result.breaking).toHaveLength(0);
    expect(result.needsEvidence).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });

  test("FIXTURE 4: a KNOWN key carrying an `any` value is shape-safe but TYPE_UNKNOWN — neither PASS nor BREAKING", () => {
    // The distinction this fixture defends: `make` cannot hide an undeclared
    // KEY, so the shape is safe. But an `any` can still carry `123` into a
    // `v.string()`, which Convex refuses. Calling this PASS would assert a
    // verification the code does not support.
    const live = spec("vehicles.js:importBulk", obj({ make: field(str) }));
    const result = compareContracts(
      [call("vehicles:importBulk", sent([["make", "any"]]))],
      live
    );

    expect(result.breaking).toHaveLength(0);
    expect(result.needsEvidence).toHaveLength(1);
    expect(result.needsEvidence[0]).toMatchObject({
      severity: SEVERITY.TYPE_UNKNOWN,
      dimension: "VALUE",
      path: "make",
    });
    expect(result.needsEvidence[0].detail).toMatch(/shape-safe, value NOT verified/);
    // And it must not be mistaken for a clean run.
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("an `any` value where the backend declares an OBJECT is SHAPE_UNKNOWN — keys can hide inside it", () => {
    // The other half of fixture 4. Same opaque value, different declared kind,
    // and therefore a different verdict: here undeclared fields really can be
    // concealed, so it escalates from value-uncertainty to shape-uncertainty.
    const live = spec(
      "vehicles.js:importBulk",
      obj({ vehicles: field(arr(obj({ make: field(str) }))) })
    );
    const result = compareContracts(
      [call("vehicles:importBulk", sent([["vehicles", "any"]]))],
      live
    );

    expect(result.breaking).toHaveLength(0);
    expect(result.needsEvidence[0]).toMatchObject({
      severity: SEVERITY.SHAPE_UNKNOWN,
      dimension: "SHAPE",
      path: "vehicles",
    });
  });

  test("a backend field the client never sends is BREAKING in the other direction", () => {
    // Backend deployed AHEAD of frontend: it now requires something the live
    // client does not send. Same class, opposite order.
    const live = spec("a.js:b", obj({ orgId: field(str), expectedCurrency: field(str) }));
    const result = compareContracts([call("a:b", sent([["orgId", "string"]]))], live);

    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toMatchObject({ path: "expectedCurrency", dimension: "SHAPE" });
    expect(result.breaking[0].detail).toMatch(/requires this field/);
  });

  test("a client call to a function the live deployment does not expose is BREAKING", () => {
    const result = compareContracts(
      [call("ghost:missing", sent([["orgId", "string"]]))],
      spec("a.js:b", obj({ orgId: field(str) }))
    );
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0].path).toBe("<function>");
  });

  test("the scope boundary is stated in the result, not left to the reader", () => {
    const result = compareContracts([], spec("a.js:b", obj({})));
    expect(result.scope.notCovered).toMatch(/HTTP action/);
  });

  test("declaredPaths flattens two levels of array nesting", () => {
    const { paths } = declaredPaths(
      obj({
        vehicles: field(
          arr(obj({ valuations: field(arr(obj({ companyName: field(str, true) }))) }))
        ),
      })
    );
    expect([...paths.keys()]).toContain("vehicles[*].valuations[*].companyName");
    expect(paths.get("vehicles[*].valuations[*].companyName")?.optional).toBe(true);
  });

  // ── Literal unions: assignability is not verification ────────────────────
  //
  // `acquisitionPosting` really is `v.union(v.literal("OPENING_STOCK"),
  // v.literal("PURCHASE"))` in production. A coarse "both are strings" check
  // calls every string a match, including the one Convex refuses.
  const literalUnion = {
    type: "union",
    value: [
      { type: "literal", value: "CASH" },
      { type: "literal", value: "CHEQUE" },
    ],
  };
  const litCall = (kind: string, literals: Array<string | number> | null) => ({
    identifier: "a:b",
    file: "components/Fixture.tsx",
    line: 1,
    sent: new Map([["method", { optional: false, valueKind: kind, literals: literals ? new Set(literals) : null }]]),
    unknowns: [],
    casts: [],
  });

  test("a client literal INSIDE the accepted set is verified", () => {
    const result = compareContracts([litCall("string", ["CASH"])], spec("a.js:b", obj({ method: field(literalUnion) })));
    expect(result.findings).toHaveLength(0);
    expect(result.verdict).toBe("PASS");
  });

  test("a client union that is a SUBSET of the accepted set is verified", () => {
    const result = compareContracts(
      [litCall("string", ["CASH", "CHEQUE"])],
      spec("a.js:b", obj({ method: field(literalUnion) }))
    );
    expect(result.findings).toHaveLength(0);
  });

  test("a client literal OUTSIDE the accepted set is BREAKING, even though both are strings", () => {
    const result = compareContracts([litCall("string", ["MAYBE"])], spec("a.js:b", obj({ method: field(literalUnion) })));
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toMatchObject({ dimension: "VALUE", path: "method" });
    expect(result.breaking[0].detail).toMatch(/MAYBE/);
    expect(result.verdict).toBe("FAIL");
  });

  test("a client typed plain `string` against a literal union is TYPE_UNKNOWN, not verified", () => {
    // Widest realistic case: assignable, unprovable. Calling this PASS would be
    // the exact overclaim the two-dimension split exists to prevent.
    const result = compareContracts([litCall("string", null)], spec("a.js:b", obj({ method: field(literalUnion) })));
    expect(result.breaking).toHaveLength(0);
    expect(result.needsEvidence[0]).toMatchObject({ severity: SEVERITY.TYPE_UNKNOWN, path: "method" });
    expect(result.needsEvidence[0].detail).toMatch(/wider than an enumeration/);
    expect(result.verdict).toBe("UNKNOWN");
  });

  // ── Run-level verdict and coverage ───────────────────────────────────────

  test("an UNRESOLVED client call site denies PASS and is reported with file and line", () => {
    // "We missed a wrapper" must never render as green. This is the control's
    // own failure mode one level up.
    const result = compareContracts(
      [call("a:b", sent([["orgId", "string"]]))],
      spec("a.js:b", obj({ orgId: field(str) })),
      [{ identifier: "sales:record", file: "components/Wrapped.tsx", line: 42, reason: "hook result is not bound to a simple name" }]
    );
    expect(result.breaking).toHaveLength(0);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.coverage).toMatchObject({
      clientCallSitesFound: 2,
      clientCallSitesResolved: 1,
      clientCallSitesUnresolved: 1,
    });
    expect(result.coverage.unresolvedSites[0]).toMatchObject({
      identifier: "sales:record",
      file: "components/Wrapped.tsx",
      line: 42,
    });
  });

  test("PASS requires zero breaking AND complete coverage", () => {
    const result = compareContracts(
      [call("a:b", sent([["orgId", "string"]]))],
      spec("a.js:b", obj({ orgId: field(str) }))
    );
    expect(result.verdict).toBe("PASS");
    expect(result.coverage.clientCallSitesUnresolved).toBe(0);
    expect(result.coverage.clientCallSitesResolved).toBe(result.coverage.clientCallSitesFound);
  });

  test("a BREAKING finding outranks coverage gaps — the verdict is FAIL, not UNKNOWN", () => {
    const result = compareContracts(
      [call("a:b", sent([["orgId", "string"], ["ghost", "string"]]))],
      spec("a.js:b", obj({ orgId: field(str) })),
      [{ identifier: "x:y", file: "f.tsx", line: 1, reason: "unresolved" }]
    );
    expect(result.verdict).toBe("FAIL");
  });

  test("a REQUIRED field inside an OPTIONAL parent is not required of the payload", () => {
    // Regression: the first whole-repo run produced four BREAKING findings of
    // the form "the backend requires depositResolution.treatment and the client
    // does not send it". Production declares `depositResolution` optional and
    // `treatment` required WITHIN it, so omitting the whole object is legal.
    // Optionality has to be inherited or the control fabricates outages.
    const live = spec(
      "sales.js:create",
      obj({
        orgId: field(str),
        depositResolution: field(obj({ treatment: field(str), reason: field(str, true) }), true),
      })
    );
    const result = compareContracts([call("sales:create", sent([["orgId", "string"]]))], live);
    expect(result.breaking).toHaveLength(0);
    expect(result.verdict).toBe("PASS");
  });

  test("an OPTIONAL type member the backend does not declare is SHAPE_UNKNOWN, not BREAKING", () => {
    // Regression for thirteen fabricated findings in the first whole-repo run.
    // `wizardData.vehicleItems` is a member of a shared wizard type that this
    // call site never assigns, so Convex never receives it. Type membership is
    // not transmission, and calling it BREAKING invents an outage.
    const live = spec("wizardDrafts.js:saveDraft", obj({ wizardData: field(obj({ vehicleId: field(str) })) }));
    const result = compareContracts(
      [
        call(
          "wizardDrafts:saveDraft",
          sent([
            ["wizardData", "object"],
            ["wizardData.vehicleId", "string"],
            ["wizardData.vehicleItems", "array", "TYPE_OPTIONAL"],
          ])
        ),
      ],
      live
    );
    expect(result.breaking).toHaveLength(0);
    expect(result.needsEvidence[0]).toMatchObject({
      severity: SEVERITY.SHAPE_UNKNOWN,
      path: "wizardData.vehicleItems",
      provenance: "TYPE_OPTIONAL",
    });
    expect(result.verdict).toBe("UNKNOWN");
  });

  test("a NON-optional resolved property the backend does not declare stays BREAKING", () => {
    // The other side of the same rule: a required member of a resolved type is
    // always present, so its absence from the validator is a real defect. This
    // is how the #235 shape survives the downgrade.
    const live = spec("wizardDrafts.js:saveDraft", obj({ wizardData: field(obj({ vehicleId: field(str) })) }));
    const result = compareContracts(
      [
        call(
          "wizardDrafts:saveDraft",
          sent([
            ["wizardData", "object"],
            ["wizardData.vehicleId", "string"],
            ["wizardData.ghost", "string", "TYPE_REQUIRED"],
          ])
        ),
      ],
      live
    );
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0]).toMatchObject({ path: "wizardData.ghost", provenance: "TYPE_REQUIRED" });
  });

  // ── Release-intersection blocker ─────────────────────────────────────────

  test("pathsOverlap: ancestor, descendant and equality overlap; siblings do not", () => {
    expect(pathsOverlap("vehicles[*]", "vehicles[*].rowId")).toBe(true);   // ancestor contains change
    expect(pathsOverlap("vehicles[*].rowId", "vehicles[*]")).toBe(true);   // change contains gap
    expect(pathsOverlap("vehicles[*].rowId", "vehicles[*].rowId")).toBe(true);
    expect(pathsOverlap("vehicles[*].valuations[*]", "vehicles[*].rowId")).toBe(false); // siblings
    expect(pathsOverlap("vehicleData", "vehicle")).toBe(false); // prefix but not a path ancestor
  });

  test("an UNKNOWN that intersects the changed path blocks the release", () => {
    const live = spec("vehicles.js:importBulk", obj({ vehicles: field(arr(obj({ make: field(str) }))) }));
    const result = compareContracts(
      [call("vehicles:importBulk", sent([["vehicles", "any"]]))],
      live
    );
    const gate = blockersForRelease(result, [
      { identifier: "vehicles:importBulk", path: "vehicles[*].rowId" },
    ]);
    expect(gate.blocked).toBe(true);
    expect(gate.intersectingUnknowns).toHaveLength(1);
  });

  test("a legacy UNKNOWN elsewhere does NOT block an unrelated release", () => {
    // The repo's steady state is UNKNOWN. If every legacy gap blocked every
    // release, the control would be an obstacle and would be switched off.
    const live = spec(
      "vehicles.js:importBulk",
      obj({ vehicles: field(arr(obj({ make: field(str), valuations: field(arr(obj({ x: field(str) })), true) }))) })
    );
    const result = compareContracts(
      [
        call(
          "vehicles:importBulk",
          sent([
            ["vehicles", "array"],
            ["vehicles[*]", "object"],
            ["vehicles[*].make", "string"],
            ["vehicles[*].valuations", "any"],
          ])
        ),
      ],
      live
    );
    expect(result.breaking).toHaveLength(0);
    expect(result.verdict).toBe("UNKNOWN");
    const gate = blockersForRelease(result, [
      { identifier: "vehicles:importBulk", path: "vehicles[*].rowId" },
    ]);
    expect(gate.blocked).toBe(false);
    expect(gate.unrelatedUnknowns).toBeGreaterThan(0);
  });

  test("a BREAKING finding blocks a release whatever paths it touches", () => {
    const result = compareContracts(
      [call("a:b", sent([["ghost", "string"]]))],
      spec("a.js:b", obj({ orgId: field(str, true) }))
    );
    const gate = blockersForRelease(result, [{ identifier: "other:fn", path: "unrelated" }]);
    expect(gate.blocked).toBe(true);
  });

  test("a v.any() field accepts anything beneath it without a false positive", () => {
    const live = spec("a.js:b", obj({ meta: field({ type: "any" }) }));
    const result = compareContracts(
      [call("a:b", sent([["meta", "object"], ["meta.whatever", "string"]]))],
      live
    );
    expect(result.breaking).toHaveLength(0);
  });
});

describe("an array element is checked exactly as hard as a top-level field", () => {
  /**
   * ⚠️ It was not. `declaredPaths` passed the literal set to `record()` for
   * object fields and omitted it for array elements, so
   * `v.array(v.union(v.literal("ACTIVE"), v.literal("SOLD")))` recorded
   * `literals: null` — "not a whitelist". `compare.mjs` then skipped the
   * subset check and fell through to the coarse table, where `union` accepts
   * `string`.
   *
   * The result was the worst possible answer: the SAME union that reports
   * UNKNOWN as a top-level field reported a clean PASS as an array element,
   * with zero findings. This is the "both are strings" reasoning the module's
   * own docstring says it exists to prevent, alive one level down.
   *
   * `convex/schema.ts` and `convex/websites.ts` both declare
   * `v.array(v.union(v.literal("en"), v.literal("ar")))` today, and
   * role/status/tag arrays are a common Convex shape, so this is not
   * hypothetical.
   *
   * These assert PARITY rather than a specific verdict: whatever a top-level
   * field of that union does, the array element must do too. That formulation
   * cannot rot as the verdict vocabulary changes.
   */
  const UNION = {
    type: "union",
    value: [
      { type: "literal", value: "ACTIVE" },
      { type: "literal", value: "SOLD" },
    ],
  };
  const specWith = (fieldType: unknown, name: string) => ({
    url: "https://x.convex.cloud",
    functions: [
      {
        identifier: "w.js:save",
        functionType: "Mutation",
        args: { type: "object", value: { [name]: { fieldType, optional: false } } },
      },
    ],
  });
  const callWith = (sent: Map<string, unknown>) => ({
    identifier: "w:save",
    file: "x.tsx",
    line: 1,
    casts: [],
    unknowns: [],
    sent,
  });

  const topLevel = (value: unknown) =>
    compareContracts([callWith(new Map([["status", value]]))], specWith(UNION, "status"), []);

  const inArray = (value: unknown) =>
    compareContracts(
      [
        callWith(
          new Map([
            ["statuses", { valueKind: "array", provenance: "LITERAL" }],
            ["statuses[*]", value],
          ])
        ),
      ],
      specWith({ type: "array", value: UNION }, "statuses"),
      []
    );

  test("the literal set survives into the array element path", () => {
    const { paths } = declaredPaths(specWith({ type: "array", value: UNION }, "statuses").functions[0].args);
    const element = paths.get("statuses[*]");
    expect(element?.literals).not.toBeNull();
    expect([...(element?.literals ?? [])].sort()).toEqual(["ACTIVE", "SOLD"]);
  });

  test("a value outside the enumeration is breaking inside an array too", () => {
    const outside = { valueKind: "literal", literals: new Set(["MAYBE"]), provenance: "LITERAL" };
    expect(inArray(outside).breaking).toHaveLength(topLevel(outside).breaking.length);
    expect(inArray(outside).breaking).toHaveLength(1);
    expect(inArray(outside).breaking[0].path).toBe("statuses[*]");
  });

  test("an opaque string is unproven inside an array too, never a clean PASS", () => {
    const opaque = { valueKind: "string", provenance: "LITERAL" };
    expect(inArray(opaque).verdict).toBe(topLevel(opaque).verdict);
    expect(inArray(opaque).verdict).not.toBe("PASS");
  });

  test("a value inside the enumeration still passes — the fix must not over-correct", () => {
    const inside = { valueKind: "literal", literals: new Set(["ACTIVE"]), provenance: "LITERAL" };
    expect(inArray(inside).breaking).toHaveLength(0);
    expect(inArray(inside).verdict).toBe(topLevel(inside).verdict);
  });
});

describe("a required field is still required once its optional parent IS sent", () => {
  /**
   * ⚠️ The inverse of a fix I made earlier, and it was found by the
   * cross-family reviewer. Optionality is inherited so that a required field
   * inside an OMITTED optional parent is not demanded of the payload — that
   * removed four fabricated BREAKING findings and was correct. But the
   * inheritance was unconditional, so it also stopped demanding the field when
   * the parent IS sent, which is exactly when the backend does demand it.
   *
   * `profile: v.optional(v.object({ bio: v.string() }))` with a client sending
   * `{ profile: {} }` reported a clean PASS. Convex rejects it: "Object does
   * not contain required field 'bio'". 82 paths across 19 functions in the live
   * spec are required-within-an-optional-parent, so this is not a corner.
   *
   * The rule is conditional, and the condition is provable: demand the child
   * only when the client PROVES it sends the parent and the parent's shape was
   * resolved. Omitted parent, or opaque parent, and we still say nothing.
   */
  const PROFILE = {
    type: "object",
    value: { bio: { fieldType: { type: "string" }, optional: false } },
  };
  const spec = {
    url: "https://x.convex.cloud",
    functions: [
      {
        identifier: "w.js:save",
        functionType: "Mutation",
        args: { type: "object", value: { profile: { fieldType: PROFILE, optional: true } } },
      },
    ],
  };
  const call = (sent: Map<string, unknown>, unknowns: string[] = []) => ({
    identifier: "w:save",
    file: "x.tsx",
    line: 1,
    casts: [],
    unknowns,
    sent,
  });

  test("parent proven sent, required child omitted -> BREAKING", () => {
    const result = compareContracts(
      [call(new Map([["profile", { valueKind: "object", provenance: "LITERAL" }]]))],
      spec,
      []
    );
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0].path).toBe("profile.bio");
  });

  test("parent NOT sent -> silent, as before", () => {
    // This is the case the inheritance rule exists for. It must stay silent.
    const result = compareContracts([call(new Map())], spec, []);
    expect(result.breaking).toHaveLength(0);
  });

  test("parent only POSSIBLY sent (optional in the client type) -> not breaking", () => {
    // Type membership is not proof of transmission.
    const result = compareContracts(
      [call(new Map([["profile", { valueKind: "object", provenance: "TYPE_OPTIONAL" }]]))],
      spec,
      []
    );
    expect(result.breaking).toHaveLength(0);
  });

  test("parent sent but its shape is opaque -> not breaking", () => {
    // We cannot see inside it, so we cannot claim the child is missing.
    const result = compareContracts(
      [call(new Map([["profile", { valueKind: "object", provenance: "LITERAL" }]]), ["profile"])],
      spec,
      []
    );
    expect(result.breaking).toHaveLength(0);
  });

  test("parent sent AND child sent -> silent", () => {
    const result = compareContracts(
      [
        call(
          new Map([
            ["profile", { valueKind: "object", provenance: "LITERAL" }],
            ["profile.bio", { valueKind: "string", provenance: "LITERAL" }],
          ])
        ),
      ],
      spec,
      []
    );
    expect(result.breaking).toHaveLength(0);
  });
});

describe("a nullable enum keeps its enumeration", () => {
  /**
   * `literalValuesOf` abandoned the whitelist on ANY non-literal branch, so the
   * standard nullable enum `v.union(v.literal("A"), v.literal("B"), v.null())`
   * recorded "not a whitelist" and fell through to the coarse table, which
   * accepts any string. That made the nullable form MORE permissive than the
   * same union without the null branch: a clean PASS on a payload the backend
   * rejects. `v.null()` accepts exactly one value, so it belongs in the set
   * rather than being a reason to discard it.
   */
  const NULLABLE = {
    type: "union",
    value: [
      { type: "literal", value: "ACTIVE" },
      { type: "literal", value: "INACTIVE" },
      { type: "null" },
    ],
  };
  const spec = {
    url: "https://x.convex.cloud",
    functions: [
      {
        identifier: "w.js:save",
        functionType: "Mutation",
        args: { type: "object", value: { status: { fieldType: NULLABLE, optional: false } } },
      },
    ],
  };
  const callSending = (value: unknown) => [
    { identifier: "w:save", file: "x.tsx", line: 1, casts: [], unknowns: [], sent: new Map([["status", value]]) },
  ];

  test("the null branch is a value, not a reason to give up the whitelist", () => {
    const { paths } = declaredPaths(spec.functions[0].args);
    const literals = paths.get("status")?.literals;
    expect(literals).not.toBeNull();
    expect([...(literals ?? [])].map(String).sort()).toEqual(["ACTIVE", "INACTIVE", "null"]);
  });

  test("an opaque string is unproven, not a clean PASS", () => {
    const result = compareContracts(
      callSending({ valueKind: "string", provenance: "LITERAL" }),
      spec,
      []
    );
    expect(result.verdict).not.toBe("PASS");
  });

  test("a value outside the enumeration is still breaking", () => {
    const result = compareContracts(
      callSending({ valueKind: "literal", literals: new Set(["GARBAGE"]), provenance: "LITERAL" }),
      spec,
      []
    );
    expect(result.breaking).toHaveLength(1);
  });

  test("null itself is accepted", () => {
    const result = compareContracts(
      callSending({ valueKind: "literal", literals: new Set([null]), provenance: "LITERAL" }),
      spec,
      []
    );
    expect(result.breaking).toHaveLength(0);
  });
});
