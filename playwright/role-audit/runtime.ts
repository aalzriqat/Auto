import { spawnSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { convexDeploymentOf, servedDeployments } from "../scenarios/formExplorer/attestedPreview";

const seatSchema = z.object({
  userId: z.string().min(1), membershipId: z.string().min(1), roleId: z.string().min(1),
  roleName: z.string().min(1), permissions: z.array(z.string()), isSystemOwnerRole: z.boolean(),
});
const attestationSchema = z.object({
  orgId: z.string().min(1), deploymentIdentity: z.string().startsWith("VERIFIED"),
  primary: seatSchema, approver: seatSchema,
  settingsState: z.string().min(2),
});
export type Attestation = z.infer<typeof attestationSchema>;

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
export const ISOLATE_HUNT = HUNT_CLI + `
await m.isolateHuntApprover(process.env,
  { run: (args, label) => m.runConvex(args, label, spawn) });`;

export async function openHuntPage(page: Page, baseURL: string | undefined, route: string) {
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

export function readHuntAttestation(): Attestation {
  expect(process.env.CONVEX_PREVIEW_NAME, "role audit requires an explicitly named disposable preview").toBeTruthy();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", READ_HUNT], {
    env: process.env, encoding: "utf8", timeout: 180_000,
  });
  if (result.status !== 0) {
    // The orchestrator captures this stream into the encrypted private log.
    // The CLI inherits its child's streams; correlate only bounded IDs from
    // this failed attestation, never its raw errors or successful seat data.
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.slice(-64 * 1024);
    const requestIds = [...new Set([...output.matchAll(/\[Request ID: ([a-f0-9]{8,64})\]/gi)].map((match) => match[1]))].slice(-3);
    for (const requestId of requestIds) process.stderr.write(`Preview attestation failed: [Request ID: ${requestId}]\n`);
  }
  expect(result.status, "exact-role backend attestation must execute successfully").toBe(0);
  return attestationSchema.parse(JSON.parse(result.stdout.trim()));
}
