import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { mainNavigation, settingsNavigation } from "../../lib/navigation";
import { USER_AUTH_FILE, authenticatedConvexClient, testDataSuffix } from "../utils";
import { newContainedContext } from "../containedContext";
import { probe, TENANT_REFUSAL } from "../../scripts/intelligence/browserSwarmBoundaryOracle";
import { requireReadyScreen } from "./readiness";
import { SCREEN_AUDIT_ROUTES as routes, ROLE_ROUTE_GUARDS as routePermissions, auditDestination } from "../fixtures/screenAuditRoutes";
import { convexDeploymentOf, servedDeployments } from "../scenarios/formExplorer/attestedPreview";

const seatSchema = z.object({
  userId: z.string().min(1), membershipId: z.string().min(1), roleId: z.string().min(1),
  roleName: z.string().min(1), permissions: z.array(z.string()), isSystemOwnerRole: z.boolean(),
});
const attestationSchema = z.object({
  orgId: z.string().min(1), deploymentIdentity: z.string().startsWith("VERIFIED"),
  primary: seatSchema, approver: seatSchema,
});
type Attestation = z.infer<typeof attestationSchema>;

async function attachPublicEvidence(testInfo: TestInfo, name: "role-cell.json" | "tenant-boundary.json", evidence: unknown) {
  const body = JSON.stringify(evidence, null, 2);
  await writeFile(testInfo.outputPath(name), body, "utf8");
  await testInfo.attach(name, { contentType: "application/json", body });
}

// Separate CLI entry: re-reads exact product role authority; never reseeds or
// changes the scripted suite's stricter finance attestation.
const HUNT_CLI = `
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const m = await import(pathToFileURL(resolve("scripts/e2ePreviewBootstrap.mjs")).href);
const spawn = (command, args, options) => process.platform === "win32"
  ? spawnSync(process.execPath, [resolve("node_modules/convex/bin/main.js"), ...args.slice(2)], options)
  : spawnSync(command, args, options);
`;
const READ_HUNT = HUNT_CLI + `
await m.assertHuntPreview("OWNER", process.env.HUNT_AUDIT_ROLE, process.env,
  { run: (args, label) => m.runConvex(args, label, spawn) });`;
const ISOLATE_HUNT = HUNT_CLI + `
await m.isolateHuntApprover(process.env,
  { run: (args, label) => m.runConvex(args, label, spawn) });`;

async function openHuntPage(page: Page, baseURL: string | undefined, route: string) {
  const app = new URL(baseURL ?? "");
  expect(["localhost", "127.0.0.1"]).toContain(app.hostname);
  const expectedDeployment = convexDeploymentOf(process.env.NEXT_PUBLIC_CONVEX_URL);
  expect(expectedDeployment).toBeTruthy();
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  const response = await page.goto(route);
  expect(response, "navigation must return an actual response").not.toBeNull();
  expect(response!.status()).toBeLessThan(400);
  expect(new URL(page.url()).origin).toBe(app.origin);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect.poll(() => servedDeployments(sockets)).toContain(expectedDeployment);
  expect(servedDeployments(sockets).filter((deployment) => deployment !== expectedDeployment)).toEqual([]);
  return { sockets, expectedDeployment };
}

const navigation = [...mainNavigation, ...settingsNavigation];
const viewports = [
  { name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 375, height: 812 },
];
let attestation: Attestation;

test.beforeAll(() => {
  for (const item of navigation) {
    expect(routes as readonly string[], `navigation route ${item.href} must have an audit cell`).toContain(item.href.slice(1));
  }
  expect(process.env.CONVEX_PREVIEW_NAME, "role audit requires an explicitly named disposable preview").toBeTruthy();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", READ_HUNT], {
    env: process.env, encoding: "utf8", timeout: 180_000,
  });
  expect(result.status, "exact-role backend attestation must execute successfully").toBe(0);
  attestation = attestationSchema.parse(JSON.parse(result.stdout.trim()));
  expect(attestation.primary.roleName).toBe("OWNER");
  expect(attestation.approver.roleName).toBe(process.env.HUNT_AUDIT_ROLE);
});

test("public owner-only mutation respects actual role and preserves refused state", async ({ page, baseURL }) => {
  const orgId = attestation.orgId as Id<"organizations">;
  await openHuntPage(page, baseURL, `/${orgId}/notifications`);
  const client = await authenticatedConvexClient(page);
  const before = await client.query(api.orgSettings.get, { orgId });
  expect(before).not.toBeNull();
  const originalName = before?.dealershipName;
  if (attestation.approver.isSystemOwnerRole) {
    // A positive control prevents network failures from masquerading as denials.
    const name = "QA TEST owner authority positive control";
    try {
      await client.mutation(api.orgSettings.upsert, { orgId, dealershipName: name });
      expect((await client.query(api.orgSettings.get, { orgId }))?.dealershipName).toBe(name);
    } finally {
      await client.mutation(api.orgSettings.upsert, { orgId, dealershipName: originalName ?? "" });
    }
  } else {
    let refusal: unknown;
    try {
      await client.mutation(api.orgSettings.upsert, { orgId, dealershipName: "QA TEST forbidden role write" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConvexError);
    if (!(refusal instanceof ConvexError)) throw new Error("The public mutation did not return a structured authorization refusal.");
    expect(refusal.data).toMatchObject({ code: "FORBIDDEN" });
    const after = await client.query(api.orgSettings.get, { orgId });
    expect(after).toEqual(before);
  }
});

for (const locale of ["en", "ar"] as const) {
  for (const viewport of viewports) {
    for (const route of routes) {
      test(`${locale} ${viewport.name} /${route}`, async ({ page, baseURL }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setViewportSize(viewport);
        await page.addInitScript((language) => localStorage.setItem("autoflow-locale", language), locale);
        const orgId = attestation.orgId as Id<"organizations">;
        const { sockets, expectedDeployment } = await openHuntPage(page, baseURL, `/${orgId}/${route}`);
        const html = page.locator("html");
        await expect(html).toHaveAttribute("lang", locale);
        await expect(html).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.getByRole("banner")).toBeVisible();
        const client = await authenticatedConvexClient(page);
        const membership = await client.query(api.memberships.getMyMembership, { orgId });
        expect(membership._id).toBe(attestation.approver.membershipId);
        expect(membership.roleId).toBe(attestation.approver.roleId);
        expect(membership.roleName).toBe(attestation.approver.roleName);
        expect([...membership.permissions].sort()).toEqual([...attestation.approver.permissions].sort());
        const destination = auditDestination(route, membership.roleName);
        const requestedPath = `/${orgId}/${route}`;
        const expectedPath = `/${orgId}/${destination}`;
        const allowed = destination.startsWith("settings/") ? attestation.approver.isSystemOwnerRole
          : (routePermissions[destination] ?? []).every((permission) => membership.permissions.includes(permission));
        const denied = page.getByRole("heading", { name: locale === "ar" ? "الوصول غير مسموح" : "Access Not Allowed", exact: true });
        if (allowed) {
          await requireReadyScreen(page, 15_000, expectedPath);
          await expect(denied).toHaveCount(0);
          await expect(page.locator("main")).toBeVisible();
        } else {
          await expect(denied).toBeVisible();
        }
        // Readiness above excludes known visible loading states for allowed pages.
        await expect(page.locator("main")).not.toHaveText(/^\s*$/);
        expect(await page.locator("main").innerText()).not.toMatch(/\bNaN\b|\bundefined\b|\[object Object\]|Something went wrong|Application error|حدث خطأ ما/);
        if (viewport.name === "phone") {
          await page.getByRole("button", { name: locale === "ar" ? "تبديل قائمة التنقل" : "Toggle navigation menu", exact: true }).click();
        }
        for (const item of navigation) {
          const visible = item.ownerOnly ? attestation.approver.isSystemOwnerRole
            : item.anyPermission ? item.anyPermission.some((permission) => membership.permissions.includes(permission))
              : !item.permission || membership.permissions.includes(item.permission);
          const link = page.locator(`nav a[href="/${orgId}${item.href}"]:visible`);
          if (visible) await expect(link.first()).toBeVisible();
          else await expect(link).toHaveCount(0);
        }
        if (viewport.name === "phone") await page.keyboard.press("Escape");
        expect(servedDeployments(sockets)).toContain(expectedDeployment);
        expect(servedDeployments(sockets).filter((deployment) => deployment !== expectedDeployment)).toEqual([]);
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("role-locale-route.png"), fullPage: true });
        const observedPath = new URL(page.url()).pathname;
        expect(observedPath).toBe(expectedPath);
        await attachPublicEvidence(testInfo, "role-cell.json", {
          sha: process.env.GITHUB_SHA, preview: expectedDeployment, orgId,
          role: attestation.approver, locale, viewport, route,
          requestedPath, expectedPath, observedPath,
          expected: allowed ? "ALLOWED_ROUTE" : "DENIED_ROUTE", observed: "MATCHED",
        });
      });
    }
  }
}

// Last: the marker-gated seed fixture isolates the approver in B.
// Public Team, billing and financial posting actions stay outside this explorer.
// Both directions then have a genuine outsider, not a second member of A.
test("isolated tenants deny public reads, writes and foreign row IDs in both directions", async ({ page, browser, baseURL }, testInfo) => {
  const orgA = attestation.orgId as Id<"organizations">;
  const contextA = await newContainedContext(browser, { storageState: USER_AUTH_FILE });
  try {
    const pageA = await contextA.newPage();
    await openHuntPage(pageA, baseURL, `/${orgA}/customers`);
    const primary = await authenticatedConvexClient(pageA);
    expect((await primary.query(api.memberships.getMyMembership, { orgId: orgA })).roleName).toBe("OWNER");
    const pageB = page;
    await openHuntPage(pageB, baseURL, `/${orgA}/customers`);
    const secondary = await authenticatedConvexClient(pageB);
    expect((await secondary.query(api.memberships.getMyMembership, { orgId: orgA })).roleName).toBe(attestation.approver.roleName);
    const suffix = testDataSuffix();
    const canaryA = `QA TEST A ${suffix}`;
    const customerA = await primary.mutation(api.customers.create, { orgId: orgA, firstName: "QA TEST", lastName: canaryA });
    const isolation = spawnSync(process.execPath, ["--input-type=module", "-e", ISOLATE_HUNT], {
      env: process.env, encoding: "utf8", timeout: 180_000,
    });
    expect(isolation.status, "the marker-gated isolation fixture must execute").toBe(0);
    const isolated = z.object({ orgA: z.string().min(1), orgB: z.string().min(1),
      deploymentIdentity: z.string().startsWith("VERIFIED") }).parse(JSON.parse(isolation.stdout.trim()));
    expect(isolated.orgA).toBe(orgA);
    const orgB = isolated.orgB as Id<"organizations">;
    expect(orgB).not.toBe(orgA);
    const canaryB = `QA TEST B ${suffix}`;
    const customerB = await secondary.mutation(api.customers.create, { orgId: orgB, firstName: "QA TEST", lastName: canaryB });
    const mineA = await primary.query(api.organizations.listMine, {});
    const mineB = await secondary.query(api.organizations.listMine, {});
    expect(mineA.map((org) => org?._id)).toEqual([orgA]);
    expect(mineB.map((org) => org?._id)).toEqual([orgB]);
    expect((await secondary.query(api.memberships.getMyMembership, { orgId: orgB })).roleName).toBe("OWNER");
    // Genuine positive write and read controls on B distinguish a valid owner
    // session from a transport failure or an unusable fixture.
    await secondary.mutation(api.organizations.update, { orgId: orgB, name: `QA TEST B control ${suffix}` });
    const beforeA = { org: await primary.query(api.organizations.get, { orgId: orgA }),
      customer: await primary.query(api.customers.get, { orgId: orgA, customerId: customerA }) };
    const beforeB = { org: await secondary.query(api.organizations.get, { orgId: orgB }),
      customer: await secondary.query(api.customers.get, { orgId: orgB, customerId: customerB }) };
    expect(beforeA.customer.lastName).toBe(canaryA);
    expect(beforeB.customer.lastName).toBe(canaryB);
    const attempts: { direction: string; operation: string; outcome: string }[] = [];
    for (const actor of [
      { direction: "A to B", client: primary, own: orgA, foreign: orgB, foreignCustomer: customerB },
      { direction: "B to A", client: secondary, own: orgB, foreign: orgA, foreignCustomer: customerA },
    ]) {
      const calls: [string, () => Promise<unknown>][] = [
        ["foreign organization read", () => actor.client.query(api.organizations.get, { orgId: actor.foreign })],
        ["foreign customer read", () => actor.client.query(api.customers.get, { orgId: actor.foreign, customerId: actor.foreignCustomer })],
        ["foreign row under own org", () => actor.client.query(api.customers.get, { orgId: actor.own, customerId: actor.foreignCustomer })],
        ["foreign organization update", () => actor.client.mutation(api.organizations.update, { orgId: actor.foreign, name: "QA TEST forbidden cross-tenant rename" })],
        ["foreign customer delete", () => actor.client.mutation(api.customers.softDelete, { orgId: actor.foreign, customerId: actor.foreignCustomer })],
        ["foreign row delete under own org", () => actor.client.mutation(api.customers.softDelete, { orgId: actor.own, customerId: actor.foreignCustomer })],
      ];
      for (const [operation, call] of calls) {
        const result = await probe(call, TENANT_REFUSAL, AbortSignal.timeout(60_000));
        attempts.push({ direction: actor.direction, operation, outcome: result.kind });
        expect(result.kind, `${actor.direction}: ${operation}`).toBe("REFUSED");
      }
    }
    expect({ org: await primary.query(api.organizations.get, { orgId: orgA }),
      customer: await primary.query(api.customers.get, { orgId: orgA, customerId: customerA }) }).toEqual(beforeA);
    expect({ org: await secondary.query(api.organizations.get, { orgId: orgB }),
      customer: await secondary.query(api.customers.get, { orgId: orgB, customerId: customerB }) }).toEqual(beforeB);
    for (const locale of ["en", "ar"] as const) {
      for (const viewport of viewports) {
        for (const actor of [
          { page: pageA, foreign: orgB, canary: canaryB, direction: "A-to-B" },
          { page: pageB, foreign: orgA, canary: canaryA, direction: "B-to-A" },
        ]) {
          await actor.page.setViewportSize(viewport);
          // Set on this origin, then reload the attempted foreign route.
          await actor.page.evaluate((language) => localStorage.setItem("autoflow-locale", language), locale);
          await actor.page.goto(`/${actor.foreign}/customers`);
          await expect(actor.page).not.toHaveURL((url) => url.pathname.startsWith(`/${actor.foreign}/`));
          await expect(actor.page.locator("html")).toHaveAttribute("lang", locale);
          await expect(actor.page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
          await expect(actor.page.locator("body")).not.toContainText(actor.canary);
          await actor.page.screenshot({ path: testInfo.outputPath(`${actor.direction}-${locale}-${viewport.name}.png`), fullPage: true });
        }
      }
    }
    await attachPublicEvidence(testInfo, "tenant-boundary.json", {
      sha: process.env.GITHUB_SHA, preview: process.env.NEXT_PUBLIC_CONVEX_URL,
      auditedRoleBeforeIsolation: attestation.approver.roleName, actualProbeRoles: { A: "OWNER", B: "OWNER" },
      orgA, orgB, attempts, stateUnchanged: true,
      scope: "Organization and customer public APIs, both directions; mixed-ID delete can refuse at role authority before row ownership. Not all financial relationships.",
    });
  } finally {
    await contextA.close();
  }
});
