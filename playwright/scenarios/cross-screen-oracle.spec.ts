import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { FACTS, allAgree, fingerprint, judgeAll, type Reading } from "../../scripts/intelligence/crossScreenOracle";
import { resolveOrgId } from "../utils";
import { attest, convexDeploymentOf, servedDeployments } from "./formExplorer/attestedPreview";

/**
 * The cross-screen consistency oracle (SCRUM-617, SCRUM-760 gate G6). It READS
 * only: it opens screens, reads the figure each shows for one fact and lets the
 * fixed rules in scripts/intelligence/crossScreenOracle decide whether they
 * agree. It never types, clicks anything that mutates, or consults a model.
 *
 * Opt-in (CROSS_SCREEN_ORACLE=1) and attested-preview only, like the form
 * explorer. Once opted in, a screen it cannot read is a FAILURE, not a skip
 * (SCRUM-760 R4): a wrong selector must fail loudly, not pass quietly.
 *
 * Readers here are bound to the markup as of main 857eba9db. They have not been
 * exercised against a signed-in preview from this branch.
 */

const num = (text: string | null | undefined): number | null => {
  const m = /\d[\d,]*/.exec((text ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
  return m ? Number(m[0].replace(/,/g, "")) : null;
};

async function open(page: Page, orgId: string, route: string) {
  await page.goto(`/${orgId}${route}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function readDashboard(page: Page, orgId: string): Promise<Reading[]> {
  await open(page, orgId, "/dashboard");
  const card = page.locator("h3", { hasText: /leads/i }).first().locator("xpath=..");
  const big = card.locator("div.text-4xl").first();
  const tile = (label: RegExp) => card.locator("p", { hasText: label }).first().locator("xpath=preceding-sibling::div[1]");
  const still = card.locator("div.text-sm.font-medium").filter({ hasText: /\d/ }).first();
  const bell = page.locator("button:has(svg.lucide-bell) span").first();
  return [
    { surface: "dashboard.totalLeads", value: num(await big.textContent({ timeout: 15_000 }).catch(() => null)) },
    { surface: "dashboard.tileNew", value: num(await tile(/^\s*new\s*$/i).textContent({ timeout: 5_000 }).catch(() => null)) },
    { surface: "dashboard.tileQualified", value: num(await tile(/qualified/i).textContent({ timeout: 5_000 }).catch(() => null)) },
    { surface: "dashboard.stillActive", value: num(await still.textContent({ timeout: 5_000 }).catch(() => null)) },
    // No badge means zero unread; a missing bell button means unreadable.
    { surface: "nav.bellBadge", value: (await page.locator("button:has(svg.lucide-bell)").count()) === 0 ? null : num(await bell.textContent({ timeout: 2_000 }).catch(() => "0")) ?? 0 },
  ];
}

async function readNotifications(page: Page, orgId: string): Promise<Reading[]> {
  await open(page, orgId, "/notifications");
  const more = page.getByRole("button", { name: /load more|المزيد/i });
  for (let i = 0; i < 200 && (await more.isVisible().catch(() => false)); i++) {
    await more.click();
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
  const feed = page.locator("div.border.rounded-md.divide-y").first();
  const ready = await feed.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
  // An unread row is the only one that carries the mark-as-read (check) control.
  return [{ surface: "notifications.unreadRows", value: ready ? await feed.locator("button:has(svg.lucide-check)").count() : null }];
}

test.describe("Cross-screen consistency oracle (read-only)", () => {
  test.use({ actionTimeout: 15_000, navigationTimeout: 45_000 });

  test("the same fact shown on several screens agrees", async ({ page, baseURL }, testInfo) => {
    test.skip(process.env.CROSS_SCREEN_ORACLE !== "1", "Opt-in: set CROSS_SCREEN_ORACLE=1 (attested disposable preview only).");

    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));
    const attestation = await attest(page, baseURL, sockets);
    // Opted in but refused: a run that cannot happen is a failure, never a skip (R4).
    expect(attestation.refusal, attestation.refusal ?? "").toBeUndefined();
    const orgId = await resolveOrgId(page);
    expect(orgId, "the app must open the attested QA organization").toBe(attestation.orgId);
    const expected = convexDeploymentOf(process.env.NEXT_PUBLIC_CONVEX_URL);
    expect(servedDeployments(sockets).filter((d) => d !== expected)).toEqual([]);

    const readings = [...(await readDashboard(page, orgId!)), ...(await readNotifications(page, orgId!))];
    const verdicts = judgeAll(readings);

    mkdirSync(testInfo.outputDir, { recursive: true });
    writeFileSync(
      testInfo.outputPath("cross-screen-scenarios.json"),
      JSON.stringify(
        verdicts.map((v) => ({
          id: v.fact,
          fingerprint: fingerprint(v),
          facts: [v.fact],
          surfaces: FACTS.find((f) => f.id === v.fact)?.surfaces.map((s) => `${s.route}#${s.id}`) ?? [],
          expected: "AGREE",
          observed: v,
        })),
        null,
        2,
      ),
    );
    expect(allAgree(verdicts), JSON.stringify(verdicts.filter((v) => v.result !== "AGREE"), null, 2)).toBe(true);
  });
});
