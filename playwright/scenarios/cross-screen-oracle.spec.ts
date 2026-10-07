import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
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
 * Readers are structural, never keyed on label text, so the same run covers EN
 * and AR. A reader returns null (UNREADABLE) unless it observed a loaded and
 * settled screen: several of these screens render 0 while their query is still
 * loading, so "0" is only trusted after the value held steady.
 *
 * Bound to the markup as of main 857eba9db. Not yet exercised against a
 * signed-in preview from this branch.
 */

const num = (text: string | null | undefined): number | null => {
  const m = /\d[\d,]*/.exec((text ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
  return m ? Number(m[0].replace(/,/g, "")) : null;
};

const SETTLE_READS = 3;
const SETTLE_GAP_MS = 1_000;
const SETTLE_DEADLINE_MS = 30_000;

/** The reader's value once it has been identical SETTLE_READS times in a row; null if it never settles. */
async function settled<T>(read: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  let last: string | undefined;
  let streak = 0;
  let value: T | null = null;
  while (Date.now() < deadline) {
    value = await read().catch(() => null);
    const key = value === null ? undefined : JSON.stringify(value);
    streak = key !== undefined && key === last ? streak + 1 : key === undefined ? 0 : 1;
    last = key;
    if (streak >= SETTLE_READS) return value;
    await new Promise((r) => setTimeout(r, SETTLE_GAP_MS));
  }
  return null;
}

async function open(page: Page, orgId: string, route: string) {
  await page.goto(`/${orgId}${route}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

const text = (l: Locator) => l.textContent({ timeout: 2_000 }).catch(() => null);

/** The one Leads card (the Vehicles card has the same shape, so structure alone is not unique). */
const LEADS_CARD = "[data-testid='dashboard-leads-card']";

async function readDashboard(page: Page, orgId: string): Promise<Reading[]> {
  await open(page, orgId, "/dashboard");
  const figures = await settled(async () => {
    const cards = page.locator(LEADS_CARD);
    if ((await cards.count()) !== 1) return null;
    const card = cards.first();
    const tiles = card.locator("div.flex.gap-6 > div > div.text-xl");
    if ((await tiles.count()) !== 2) return null;
    const read = [
      num(await text(card.locator("div.text-4xl"))),
      num(await text(tiles.nth(0))),
      num(await text(tiles.nth(1))),
      num(await text(card.locator("div[class*='16a34a']"))),
    ];
    return read.some((v) => v === null) ? null : read;
  });
  const at = (i: number) => (figures ? figures[i] : null);
  return [
    { surface: "dashboard.totalLeads", value: at(0) },
    { surface: "dashboard.tileNew", value: at(1) },
    { surface: "dashboard.tileQualified", value: at(2) },
    { surface: "dashboard.stillActive", value: at(3) },
  ];
}

/**
 * Bell badge and Notifications rows are read from the same page load, so both
 * come from one settled snapshot. The bell shows no badge at zero, which is
 * indistinguishable from "still loading" until the feed itself has rendered.
 */
async function readNotifications(page: Page, orgId: string): Promise<Reading[]> {
  await open(page, orgId, "/notifications");
  const feed = page.locator("div.border.rounded-md.divide-y").first();
  const feedVisible = await feed.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
  const more = page.getByRole("button", { name: /load more|المزيد/i });
  const rowCount = () => feed.locator("> *").count();
  // The feed div exists while the first page is still loading; wait for a row or the empty state.
  if (feedVisible) await expect.poll(rowCount, { timeout: 15_000 }).toBeGreaterThan(0).catch(() => undefined);
  // Only the newest 50 rows are compared, so load until 50 are present or no more pages arrive.
  for (let i = 0; feedVisible && i < 20; i++) {
    const before = await rowCount();
    if (before >= 50) break;
    // Load more disappears while a page is in flight: wait briefly for it, else the feed is complete.
    const appeared = await more.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false);
    if (!appeared) break;
    await more.click();
    await expect.poll(rowCount, { timeout: 10_000 }).toBeGreaterThan(before).catch(() => undefined);
  }
  const snapshot = feedVisible
    ? await settled(async () => {
        const rows = feed.locator("> *");
        if ((await rows.count()) === 0) return null;
        // Self-check: every inbox row carries an Archive control; a lone child without one is the empty state.
        // Anything else means these selectors no longer describe the screen: UNREADABLE, not zero.
        const inbox = await rows.evaluateAll((els) => {
          const withArchive = els.filter((el) => el.querySelector("svg.lucide-archive") !== null);
          if (withArchive.length !== els.length) return els.length === 1 && withArchive.length === 0 ? { unread: 0 } : null;
          // The bell shows the newest 50 non-archived rows (convex/notifications.ts list).
          return { unread: els.slice(0, 50).filter((el) => el.querySelector("svg.lucide-check") !== null).length };
        });
        if (inbox === null) return null;
        const bellButton = page.locator("button:has(svg.lucide-bell)");
        if ((await bellButton.count()) !== 1) return null;
        const badge = bellButton.locator("> div");
        const bell = (await badge.count()) === 0 ? 0 : num(await text(badge.first()));
        return bell === null ? null : { bell, unread: inbox.unread };
      })
    : null;
  return [
    { surface: "nav.bellBadge", value: snapshot ? snapshot.bell : null },
    { surface: "notifications.unreadRows", value: snapshot ? snapshot.unread : null },
  ];
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
      testInfo.outputPath("cross-screen-observations.json"),
      JSON.stringify(
        verdicts.map((v) => ({
          fact: v.fact,
          fingerprint: fingerprint(v),
          surfaces: FACTS.find((f) => f.id === v.fact)?.surfaces.map((s) => `${s.route}#${s.id}`) ?? [],
          verdict: v,
        })),
        null,
        2,
      ),
    );
    expect(allAgree(verdicts), JSON.stringify(verdicts.filter((v) => v.result !== "AGREE"), null, 2)).toBe(true);
  });
});
