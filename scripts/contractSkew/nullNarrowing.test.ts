import { describe, expect, test } from "vitest";
import { extractClientCalls } from "./clientPaths.mjs";

/**
 * SCRUM-178 v2 F5-2. A VALUE finding for null is raised only when the type the
 * checker assigns to the argument expression AT THE CALL SITE (flow-narrowed)
 * admits null.
 *
 * Root cause (found while reproducing): for a shorthand property `{ quoteId }`
 * the extractor asked `getTypeOfSymbolAtLocation(valueSymbol, prop.name)`. That
 * API narrows only when the location is an expression referencing the symbol;
 * the NAME of a shorthand assignment is a declaration name, so it returned the
 * binding's DECLARED type (`string | null`) and discarded the guard. Explicit
 * `{ quoteId: quoteId }` goes through the identifier path and was already right.
 */
type Node = {
  kind: string;
  fields?: Map<string, { node: Node }>;
  values?: Set<unknown>;
  nodes?: Node[];
  node?: Node;
};
type Call = { identifier: string; payload: Node | null };

const FIXTURE = "scripts/contractSkew/__fixtures__/narrowing.tsx";
const calls = extractClientCalls([FIXTURE], "tsconfig.json").calls as unknown as Call[];

const strip = (n?: Node): Node | undefined => {
  let cur = n;
  while (cur?.kind === "assertion") cur = cur.node;
  return cur;
};
const admitsNull = (n?: Node): boolean => {
  const cur = strip(n);
  if (!cur) return false;
  if (cur.kind === "literal") return [...(cur.values ?? [])].some((v) => v === null);
  if (cur.kind === "variants") return (cur.nodes ?? []).some(admitsNull);
  return false;
};
const field = (fn: string, name: string) => {
  const call = calls.find((c) => c.identifier === `narrow:${fn}`);
  expect(call, `no extracted call for narrow:${fn}`).toBeDefined();
  const payload = strip(call!.payload!);
  const entry = payload?.fields?.get(name);
  expect(entry, `${fn}: no field ${name}`).toBeDefined();
  return entry!.node;
};

describe("a guarded value is not a null send", () => {
  test("guard then call inside try (shorthand)", () => {
    expect(admitsNull(field("guardThenTry", "quoteId"))).toBe(false);
  });
  test("`||` guard with three operands (shorthand)", () => {
    for (const name of ["orgId", "vehicleId", "note"]) {
      expect(admitsNull(field("orGuardThree", name)), name).toBe(false);
    }
  });
  test("guard then call inside an async closure", () => {
    expect(admitsNull(field("guardThenClosure", "customerId"))).toBe(false);
  });
  test("guard then explicit `name: value` property", () => {
    expect(admitsNull(field("guardThenExplicit", "targetPlan"))).toBe(false);
  });
  test("a guarded literal union keeps its exact domain, without null", () => {
    const node = strip(field("guardedLiteral", "status"));
    expect(node?.kind).toBe("literal");
    expect([...(node?.values ?? [])].sort()).toEqual(["A", "B"]);
  });
});

describe("a value that can really be null is still a null send", () => {
  test("NEGATIVE: no guard", () => {
    expect(admitsNull(field("noGuard", "quoteId"))).toBe(true);
  });
  test("NEGATIVE: guard on a different variable", () => {
    expect(admitsNull(field("guardOther", "quoteId"))).toBe(true);
  });
  test("NEGATIVE: reassigned to null after the guard is never read as proven non-null", () => {
    // A reassigned `let` is deliberately read as an opaque value (unproven), which
    // is the conservative side: it must not become a clean, provable non-null.
    const node = strip(field("reassigned", "quoteId"));
    expect(admitsNull(node) || node?.kind === "opaqueValue").toBe(true);
  });
  test("NEGATIVE: a guard that does not exit", () => {
    expect(admitsNull(field("guardNoReturn", "quoteId"))).toBe(true);
  });
});
