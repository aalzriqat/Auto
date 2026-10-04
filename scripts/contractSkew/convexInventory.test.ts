import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inventoryConvexEntryPoints } from "./convexInventory.mjs";

/**
 * SCRUM-178 v2, Codex CS2-4: the SDK inventory is derived by MEANING (the
 * checker resolves each parameter's type), not by matching the word
 * `FunctionReference` in the parameter's source text.
 *
 * ⚠️ These ran RED against the regex version first: an alias-typed parameter
 * (`ref: RefArg`) never contains the word, so `newHook` was missed.
 */
type Inventory = { version: string; keys: Map<string, string> };
const inventory = (root: string) => inventoryConvexEntryPoints(root) as unknown as Inventory;

const MOCK_DTS = `
export type FunctionReference<T extends "query" | "mutation" | "action" = "query"> = {
  _type: T; _args: unknown; _returnType: unknown; _visibility: "public"; _componentPath: string | undefined;
};
export type PaginatedQueryReference = FunctionReference<"query">;

type RefArg = FunctionReference<"query">;
type RefUnion = RefArg | null;
type RefList = ReadonlyArray<RefArg>;
type Plain = { name: string };

export declare function directHook(ref: FunctionReference<"query">): void;
export declare function aliasedHook(ref: RefArg): void;
export declare function unionHook(ref: RefUnion): void;
export declare function listHook(refs: RefList): void;
export declare function constrainedHook<R extends RefArg>(ref: R): void;
export declare function nestedHook(options: { query: RefArg }): void;
export declare function notAReference(value: Plain, count: number): void;
export declare function noParameters(): void;
export declare class Client {
  aliasedMethod(ref: RefArg): void;
  plainMethod(value: Plain): void;
}
export interface Surface {
  viaInterface(ref: RefArg): void;
}
`;

const roots: string[] = [];
const mockPackage = (dts: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), "skew-inv-"));
  roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mock-root" }));
  const pkg = path.join(root, "node_modules", "convex");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "convex", version: "0.0.0-mock" }));
  writeFileSync(path.join(pkg, "dist", "index.d.ts"), dts);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("CS2-4: the inventory resolves parameter types, it does not grep their text", () => {
  const keys = [...inventory(mockPackage(MOCK_DTS)).keys.keys()].sort();

  test("an alias-typed parameter is found (the regression)", () => {
    expect(keys).toContain("aliasedHook");
  });
  test("a direct FunctionReference parameter is found (control)", () => {
    expect(keys).toContain("directHook");
  });
  test("a union, an array of aliases, a generic constraint and a nested option are found", () => {
    expect(keys).toEqual(expect.arrayContaining(["unionHook", "listHook", "constrainedHook", "nestedHook"]));
  });
  test("class and interface members use the Owner.method key", () => {
    expect(keys).toEqual(expect.arrayContaining(["Client.aliasedMethod", "Surface.viaInterface"]));
  });
  test("parameters that are not references are NOT listed (control)", () => {
    expect(keys).not.toContain("notAReference");
    expect(keys).not.toContain("noParameters");
    expect(keys).not.toContain("Client.plainMethod");
  });
  test("the exact set", () => {
    expect(keys).toEqual(
      [
        "Client.aliasedMethod",
        "Surface.viaInterface",
        "aliasedHook",
        "constrainedHook",
        "directHook",
        "listHook",
        "nestedHook",
        "unionHook",
      ].sort(),
    );
  });
});

describe("CS2-4: the pinned convex package still yields the same inventory", () => {
  const result = inventory(process.cwd());
  // The 54 keys the regex version produced for convex 1.42.1 (recorded before
  // the rewrite). The checker version must produce exactly this set.
  const EXPECTED_1_42_1 = [
    "ConvexClient.action", "ConvexClient.mutation", "ConvexClient.onPaginatedUpdate_experimental",
    "ConvexClient.onUpdate", "ConvexClient.query", "ConvexHttpClient.action",
    "ConvexHttpClient.consistentQuery", "ConvexHttpClient.mutation", "ConvexHttpClient.query",
    "ConvexReactClient.action", "ConvexReactClient.mutation", "ConvexReactClient.prewarmQuery",
    "ConvexReactClient.query", "ConvexReactClient.watchQuery", "createFunctionHandle",
    "createMutation", "Crons.cron", "Crons.daily", "Crons.hourly", "Crons.interval",
    "Crons.monthly", "Crons.weekly", "fetchAction", "fetchMutation", "fetchQuery",
    "GenericActionCtx.runAction", "GenericActionCtx.runMutation", "GenericActionCtx.runQuery",
    "GenericMutationCtx.runMutation", "GenericMutationCtx.runQuery", "GenericQueryCtx.runQuery",
    "getFunctionName", "insertAtBottomIfLoaded", "insertAtPosition", "insertAtTop",
    "optimisticallyUpdateValueInPaginatedQuery", "OptimisticLocalStore.getAllQueries",
    "OptimisticLocalStore.getQuery", "OptimisticLocalStore.setQuery", "preloadedQueryResult",
    "preloadQuery", "QueriesObserver.getLocalResults", "QueriesObserver.setQueries",
    "Scheduler.runAfter", "Scheduler.runAt", "useAction", "useMutation",
    "usePaginatedQuery_experimental", "usePaginatedQuery", "usePreloadedQuery", "useQueries",
    "useQueriesHelper", "useQuery_experimental", "useQuery",
  ];

  test("count is 54 on 1.42.1", () => {
    expect(result.version).toBe("1.42.1");
    expect(EXPECTED_1_42_1).toHaveLength(54);
    expect(result.keys.size).toBe(54);
  });
  test("the set is exactly the 54 the regex version produced (no key gained or lost)", () => {
    expect([...result.keys.keys()].sort()).toEqual([...EXPECTED_1_42_1].sort());
  });
});
