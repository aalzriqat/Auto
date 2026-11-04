import { describe, expect, test } from "vitest";
import { discoverGuardedPilotMutations, discoverPilotSources } from "./pilotSourceDiscovery";

describe("pilot source discovery controls", () => {
  test("pilot-named export aliases preserve distinct names and nonliteral evidence stays unavailable", () => {
    const sources = new Map([
      ["lib/local.ts", "const off: boolean = true; export { off as REVIEW_PILOT_DISABLED, off as OTHER_PILOT_REQUIRED };"],
      ["lib/dynamic.ts", "const off = Boolean(true); export { off as DYNAMIC_PILOT_REFUSED };"],
      ["lib/barrel.ts", 'export * as switches from "./local";'],
      ["lib/alias.ts", 'import { REVIEW_PILOT_DISABLED } from "./local"; export const ALIAS_PILOT_DISABLED = REVIEW_PILOT_DISABLED;'],
    ]);
    const discovery = discoverPilotSources(sources, new Set());
    expect(discovery.declarations.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: true },
      { name: "OTHER_PILOT_REQUIRED", value: true },
      { name: "DYNAMIC_PILOT_REFUSED", value: null },
      { name: "ALIAS_PILOT_DISABLED", value: null },
    ]);
    expect([...discovery.exportedBy.get("OTHER_PILOT_REQUIRED") ?? []]).toEqual(["lib/local", "lib/barrel"]);
  });

  test("guard census resolves export, builder and guard aliases while ignoring other handlers and examples", () => {
    const sources = new Map([
      ["convex/functions.ts", "export const mutation = build(); export const internalMutation = build(); export const query = build();"],
      ["convex/_generated/server.d.ts", "export declare const mutation: unknown;"],
      ["convex/utils/reviewContainment.ts", "export function assertReviewAllowed() {} export function assertReviewEnabled() {}"],
      ["convex/review.ts", `
        import { mutation as command, internalMutation, query } from "./functions";
        import { assertReviewAllowed as refuse, assertReviewEnabled } from "./utils/reviewContainment";
        const local = command({ handler: () => { if (condition) refuse(); } });
        export { local as renamed };
        export const hidden = internalMutation({ handler: () => refuse() });
        export const reader = query({ handler: () => refuse() });
        export const unrelated = command({ args: refuse(), handler: () => "refuse()" });
        export const enabled = command({ handler() { assertReviewEnabled(); } });
        export function helper() { refuse(); }
      `],
      ["convex/raw.ts", `
        import * as server from "./_generated/server";
        import * as guards from "./utils/reviewContainment";
        export const raw = server.mutation({ handler: () => guards.assertReviewAllowed() });
      `],
      ["convex/review.test.ts", 'export const ignored = mutation({ handler: () => assertReviewAllowed() });'],
      ["convex/sub/nested.ts", 'export const ignored = mutation({ handler: () => assertReviewAllowed() });'],
    ]);
    expect([...discoverGuardedPilotMutations(sources)]).toEqual([
      ["review.renamed", ["assertReviewAllowed"]],
      ["review.enabled", ["assertReviewEnabled"]],
      ["raw.raw", ["assertReviewAllowed"]],
    ]);
  });
});
