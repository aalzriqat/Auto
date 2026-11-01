import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildPilotJourneyCensus } from "./pilotJourneyCensus";

const fixtureRoots: string[] = [];

function writeSource(root: string, file: string, source: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pilot-census-")) {
      throw new Error(`Unexpected fixture path: ${root}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reachable UI API bindings link both ways while unknown and unreferenced paths stay visible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-census-"));
  fixtureRoots.push(root);
  writeSource(root, "app/(dashboard)/[orgId]/sales/page.tsx",
    'import { SalesPanel } from "@/components/SalesPanel"; export default function Page() { return SalesPanel; }');
  writeSource(root, "components/SalesPanel.tsx", `
    import { api as convexApi } from "@/convex/_generated/api";
    import "@/components/MissingPanel";
    type ReferenceOnly = typeof convexApi.sales.submit;
    const namespace = convexApi.sales;
    export const SalesPanel = () => [convexApi.sales.submit, convexApi.sales["other"]];
  `);
  writeSource(root, "convex/sales.ts", `
    import { mutation as write, query } from "./_generated/server";
    import { socialBulkMutation } from "./functions";
    export const submit = write({ handler: async () => true });
    export const list = query({ handler: async () => [] });
    export const bulk = socialBulkMutation({ handler: async () => true });
  `);

  const census = buildPilotJourneyCensus(root);
  expect(census.routes).toEqual([expect.objectContaining({
    route: "/[orgId]/sales",
    apiIds: ["sales.submit"],
  })]);
  expect(census.publicEndpoints).toEqual([
    expect.objectContaining({ id: "sales.bulk", kind: "mutation", webRoutes: [] }),
    expect.objectContaining({ id: "sales.list", kind: "query", webRoutes: [] }),
    expect.objectContaining({ id: "sales.submit", kind: "mutation", webRoutes: ["/[orgId]/sales"] }),
  ]);
  expect(census.publicEndpoints.find((endpoint) => endpoint.id === "sales.submit")?.webSites)
    .toHaveLength(1);
  expect(census.unknowns.map((unknown) => unknown.kind).sort())
    .toEqual(["dynamic-api", "indirect-api", "missing-local-module"]);
});

test("an API binding without a public declaration remains unresolved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-census-"));
  fixtureRoots.push(root);
  writeSource(root, "app/(dashboard)/[orgId]/collections/page.tsx", `
    import { api } from "@/convex/_generated/api";
    export default function Page() { void import("@/components/Lazy"); return api.collections.collect; }
  `);

  const census = buildPilotJourneyCensus(root);
  expect(census.routes[0]?.apiIds).toEqual(["collections.collect"]);
  expect(census.unknowns.map((unknown) => unknown.kind).sort())
    .toEqual(["dynamic-import", "unresolved-api"]);
});
