import { describe, expect, test } from "vitest";
import { extractClientCalls } from "./clientPaths.mjs";

/**
 * SCRUM-686. `const active = !!a.x && !!a.y; useQuery(fn, active ? { x: a.x as Id } : "skip")`
 * reported "client can send [null]" although `active` being true proves both
 * non-null. The truthiness proof must travel through a const boolean alias of
 * a `&&` chain. A cast is never evidence, `||`, `let` and unrelated guards are not
 * proof.
 */
type Node = {
  kind: string;
  fields?: Map<string, { node: Node }>;
  values?: Set<unknown>;
  nodes?: Node[];
  node?: Node;
};
type Call = { identifier: string; payload: Node | null };

const FIXTURE = "scripts/contractSkew/__fixtures__/skipGateAlias.tsx";
const calls = extractClientCalls([FIXTURE], "tsconfig.json").calls as unknown as Call[];

const strip = (n?: Node): Node | undefined => {
  let cur = n;
  while (cur?.kind === "assertion") cur = cur.node;
  return cur;
};
const admitsNull = (n?: Node): boolean => {
  const cur = strip(n);
  if (!cur) return false;
  if (cur.kind === "literal") return [...(cur.values ?? [])].some((v) => v === null || v === undefined);
  if (cur.kind === "variants") return (cur.nodes ?? []).some(admitsNull);
  return false;
};
const field = (fn: string, name: string) => {
  const call = calls.find((c) => c.identifier === `skipGate:${fn}`);
  expect(call, `no extracted call for skipGate:${fn}`).toBeDefined();
  const entry = strip(call!.payload!)?.fields?.get(name);
  expect(entry, `${fn}: no field ${name}`).toBeDefined();
  return entry!.node;
};

describe("a const `&&` guard alias gating a skip ternary proves non-null", () => {
  test("real ProfitApprovalNotice shape (cast args)", () => {
    expect(admitsNull(field("aliasGuard", "orgId"))).toBe(false);
    expect(admitsNull(field("aliasGuard", "vehicleId"))).toBe(false);
  });
  test("identifiers via != null / !== null / !!", () => {
    for (const k of ["a", "b", "c"]) expect(admitsNull(field("aliasGuardIdentifiers", k)), k).toBe(false);
  });
});

const admitsNullOnly = (n?: Node): boolean => {
  const cur = strip(n);
  if (!cur) return false;
  if (cur.kind === "literal") return [...(cur.values ?? [])].some((v) => v === null);
  if (cur.kind === "variants") return (cur.nodes ?? []).some(admitsNullOnly);
  return false;
};

describe("null comparisons through an alias", () => {
  test("`!= null` and `!== null` both remove null", () => {
    expect(admitsNull(field("aliasNullCompare", "orgId"))).toBe(false);
    expect(admitsNullOnly(field("aliasNullCompare", "vehicleId"))).toBe(false);
  });
});

describe("NEGATIVE controls still report null", () => {
  test("(a) `||` alias", () => {
    expect(admitsNull(field("aliasOr", "orgId"))).toBe(true);
    expect(admitsNull(field("aliasOr", "vehicleId"))).toBe(true);
  });
  test("(b) `let` alias", () => {
    expect(admitsNull(field("aliasLet", "orgId"))).toBe(true);
  });
  test("(c) cast with no guard", () => {
    expect(admitsNull(field("castNoGuard", "orgId"))).toBe(true);
  });
  test("alias fact dropped when the receiver is written", () => {
    // A written receiver is read as an opaque value (unproven) — the conservative
    // side. It must never become a clean, provably non-null field.
    const node = strip(field("aliasReceiverWritten", "orgId"));
    expect(admitsNull(node) || node?.kind === "opaqueValue").toBe(true);
  });
  test("guard on a different field", () => {
    expect(admitsNull(field("aliasGuardsOther", "orgId"))).toBe(true);
    expect(admitsNull(field("aliasGuardsOther", "vehicleId"))).toBe(false);
  });
});



const admitsUndefined = (n?: Node): boolean => {
  const cur = strip(n);
  if (!cur) return false;
  if (cur.kind === "literal") return [...(cur.values ?? [])].some((v) => v === undefined);
  if (cur.kind === "variants") return (cur.nodes ?? []).some(admitsUndefined);
  return false;
};
/** Anything that is NOT a provably-clean Id: null/undefined admitted, or an opaque/unresolved value. */
const notProvenClean = (n?: Node): boolean => {
  const cur = strip(n);
  return admitsNull(cur) || !cur || ["opaqueValue", "unresolved"].includes(cur.kind);
};

describe("SCRUM-686 Codex findings (fail closed)", () => {
  test("CS-686-1 `!== null` keeps undefined: a required id can still be absent", () => {
    expect(admitsUndefined(field("strictNullKeepsUndefined", "id"))).toBe(true);
    expect(admitsNullOnly(field("strictNullKeepsUndefined", "id"))).toBe(false);
  });
  test("CS-686-1 `!== undefined` keeps null", () => {
    expect(admitsNullOnly(field("strictUndefinedKeepsNull", "id"))).toBe(true);
    expect(admitsUndefined(field("strictUndefinedKeepsNull", "id"))).toBe(false);
  });
  test("CS-686-1 control: `!= null` stays clean", () => {
    expect(admitsNull(field("looseNullClean", "id"))).toBe(false);
  });
  test("CS-686-2 receiver mutated through another reference is not proof", () => {
    for (const fn of ["mutatedViaOther", "aliasedReceiver", "closureReceiver", "escapedAsArgument"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("CS-686-2 closure: a second parameter or any property write denies the fact", () => {
    for (const fn of ["sameObjectTwoParams", "singleParamOuterWrite"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("CS-686-2 closure control: a lone parameter with no property writes stays clean", () => {
    expect(notProvenClean(field("singleParamNoWriteClean", "id"))).toBe(false);
  });
  test("CS-686-2-R a write wrapped in `!` or `as` still denies the fact", () => {
    for (const fn of ["nonNullWrappedWrite", "asWrappedWrite", "elementNonNullWrappedWrite"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("F1/F2 a const alias of another reference, or `arguments`, lets the receiver escape", () => {
    for (const fn of ["constAliasOfParamEscapes", "constAliasOfSecondParam", "constAliasOfHolderEscapes", "argumentsEscape"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("F1 control: a const receiver built from a fresh literal stays clean", () => {
    expect(notProvenClean(field("constFreshObjectClean", "id"))).toBe(false);
  });
  test("F3 `??=`, destructuring and nested-closure writes deny the fact", () => {
    for (const fn of ["nullishAssignWrite", "destructuringWrite", "nestedClosureWrite"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("CS-686-2-R control: a wrapped read is not a write", () => {
    expect(notProvenClean(field("wrappedReadClean", "id"))).toBe(false);
  });
  test("CS-686-3 a local binding named `undefined` is not proof", () => {
    for (const fn of ["shadowedUndefinedParam", "shadowedUndefinedLocal"]) {
      expect(notProvenClean(field(fn, "id")), fn).toBe(true);
    }
  });
  test("CS-686-3 control: global `undefined` and `void 0` still prove non-undefined", () => {
    expect(admitsNull(field("globalUndefinedClean", "id"))).toBe(false);
    expect(admitsUndefined(field("globalUndefinedClean", "id"))).toBe(false);
    expect(admitsUndefined(field("voidZeroClean", "id"))).toBe(false);
  });
});
