import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { callJev } from "../../scripts/intelligence/jevImpact.mjs";
import { resolveOrgId } from "../utils";
import { pilotExplorerSeed, pilotExplorerStarts, pilotExplorerTitle, withLocalePage, type PilotExplorerStart } from "../fixtures/pilotHunt";
import { isCommitActionName } from "./jevExplorerActions";
import { attest, convexDeploymentOf, servedDeployments } from "./formExplorer/attestedPreview";

/**
 * A random explorer (SCRUM-595): walk the dashboard by clicking what is on
 * screen, with Jev choosing the next element when TYPESAFE_API_KEY is set and a
 * seeded random pick when it is not. Findings are advisory. Fixed code
 * checks record what they see as annotations plus a JSON report; Jev's own
 * opinion of a screen is recorded beside them and never decides anything
 * (the SCRUM-350 rule: Jev may suggest, only fixed checks may declare).
 *
 * It is NOT read-only, so it runs only on an attested disposable preview.
 * Nothing whose name reads as a commit (save, submit, confirm, delete, post,
 * approve, refund …) is clicked, every dialog it opens is dismissed with
 * Escape, and the screens known to write on view are never reached. Some
 * effects still write by being mounted: the floating messenger marks messages
 * delivered on every page, and a Facebook conversation opened from the leads
 * list syncs its history. Those touch only the attested preview's QA data
 * (Codex AF-430-04).
 *
 * It refuses to run anywhere but a local app whose backend is proven to be the
 * seeded disposable preview, because every screen Jev judges is sent to
 * TypeSafe (Codex AF-430-03).
 */

const STEPS = Number(process.env.JEV_EXPLORER_STEPS ?? 40);
const SEED = Number(process.env.JEV_EXPLORER_SEED ?? Date.now() % 100_000);
if (!Number.isInteger(STEPS) || STEPS < 1 || STEPS > 100) {
  throw new Error("JEV_EXPLORER_STEPS must be an integer from 1 to 100.");
}

/**
 * Screens that write just by being looked at: opening a conversation marks it
 * read (ChatThread / FloatingChatWindow → directMessages.markRead), opening an
 * empty Facebook DM in the social inbox syncs its history from Facebook and
 * stores it (SocialConversationDialog → fetchFbConversationHistory), and a
 * notification link marks the notification read on click. None is reached,
 * whatever its name (Codex AF-430-04).
 */
const WRITES_ON_VIEW = /\/(messages|notifications|social-inbox)(\/|$|\?)/;
const BROKEN_TEXT =/\bNaN\b|\bundefined\b|\[object Object\]/;
const ERROR_BOUNDARY = /Something went wrong|Application error|حدث خطأ ما/i;

type Finding = { step: number; url: string; check: string; detail: string };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

// Jev answers a few questions per call well, so a large screen is asked in
// parallel batches rather than cut to its first dozen elements.
const JEV_SCAN_LIMIT = 200;
const JEV_BATCH = 12;
const JEV_MAX_BATCHES = 8;

/** First-visit tours that cover the screen and swallow the walk's clicks. */
const TOUR_KEYS = [
  "messenger_onboarding_seen_v1",
  "global_search_onboarding_seen_v1",
  "feature_spotlight_seen_v3",
  "dealer_website_onboarding_seen_v1",
];

async function candidates(page: Page): Promise<Array<{ el: Locator; name: string }>> {
  const all = page.locator(
    'main a[href^="/"], nav a[href^="/"], main button, [role="tab"], main [role="combobox"]',
  );
  const out: Array<{ el: Locator; name: string }> = [];
  // The same link often appears in nav and in main; ask about it once.
  const seen = new Set<string>();
  const count = Math.min(await all.count(), JEV_SCAN_LIMIT);
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.isDisabled().catch(() => true)) continue;
    const name = ((await el.getAttribute("aria-label")) || (await el.innerText().catch(() => "")))
      .trim()
      .slice(0, 80);
    if (!name || isCommitActionName(name)) continue;
    const href = await el.getAttribute("href").catch(() => null);
    if (href && WRITES_ON_VIEW.test(href)) continue;
    const key = `${name}\u0000${href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ el, name });
  }
  return out;
}

// "jev: true" only says a key was set. These say whether Jev actually answered,
// so a silent outage cannot pass for a Jev-guided walk.
const jevStats = {
  pickAsked: 0,
  pickAnswered: 0,
  candidatesOffered: 0,
  candidatesScored: 0,
  batchesFailed: 0,
  opinionAsked: 0,
  opinionAnswered: 0,
  maxOpinion: 0,
};

async function jevPick(names: string[], screen: string): Promise<number | undefined> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || names.length === 0) return undefined;
  const batches: number[][] = [];
  for (let start = 0; start < names.length && batches.length < JEV_MAX_BATCHES; start += JEV_BATCH) {
    batches.push(names.slice(start, start + JEV_BATCH).map((_, i) => start + i));
  }
  jevStats.pickAsked++;
  jevStats.candidatesOffered += batches.flat().length;
  // A failed batch drops only its own candidates; if every batch fails the
  // caller falls back to the seeded random pick (SCRUM-360).
  const answered = await Promise.all(
    batches.map(async (batch) => {
      const questions: Record<string, unknown> = {};
      for (const index of batch) {
        questions[`c${index}`] = {
          type: "noul",
          instructions: `Would clicking "${names[index]}" most likely reveal a screen state in a car-dealership app where a display or money defect could hide?`,
          criteria: { true: "It opens new data, a dialog, a tab or a detail view.", false: "It leads nowhere new." },
        };
      }
      try {
        const res = (await callJev({ apiKey, state: { screen: screen.slice(0, 3_000) }, questions })) as {
          answers?: Record<string, { noul?: number }>;
        };
        return { batch, answers: res.answers ?? {} };
      } catch {
        jevStats.batchesFailed++;
        return undefined;
      }
    }),
  );
  let best = -1;
  let bestScore = -1;
  for (const result of answered) {
    if (!result) continue;
    for (const index of result.batch) {
      const score = result.answers[`c${index}`]?.noul;
      if (typeof score !== "number") continue;
      jevStats.candidatesScored++;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
  }
  if (best >= 0) jevStats.pickAnswered++;
  return best >= 0 ? best : undefined;
}

async function jevOpinion(screen: string): Promise<number | undefined> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return undefined;
  jevStats.opinionAsked++;
  try {
    const res = (await callJev({
      apiKey,
      state: { screen: screen.slice(0, 4_000) },
      questions: {
        defect: {
          type: "noul",
          instructions:
            "Does this dealership-app screen text show a visible defect: a negative or impossible money amount, a raw code key instead of a label, English mixed into Arabic, a step numbered beyond its total, or contradictory statuses?",
          criteria: { true: "A visible defect is present.", false: "The screen reads as correct." },
        },
      },
    })) as { answers?: Record<string, { noul?: number }> };
    const p = res.answers?.defect?.noul;
    if (typeof p === "number") {
      jevStats.opinionAnswered++;
      jevStats.maxOpinion = Math.max(jevStats.maxOpinion, p);
    }
    return p;
  } catch {
    return undefined;
  }
}

async function observeScreen(page: Page, step: number, findings: Finding[]): Promise<string> {
  const screen = await page.locator("body").innerText().catch(() => "");
  if (ERROR_BOUNDARY.test(screen)) findings.push({ step, url: page.url(), check: "error-boundary", detail: "" });
  const broken = screen.match(BROKEN_TEXT);
  if (broken) findings.push({ step, url: page.url(), check: "raw-value", detail: broken[0] });
  const steps = screen.match(/Step (\d+) of (\d+)/);
  if (steps && Number(steps[1]) > Number(steps[2])) {
    findings.push({ step, url: page.url(), check: "step-count", detail: steps[0] });
  }
  const opinion = await jevOpinion(screen);
  if (opinion !== undefined && opinion >= 0.65) {
    findings.push({ step, url: page.url(), check: "jev-opinion", detail: `p=${opinion.toFixed(2)}` });
    await page.screenshot({ path: test.info().outputPath(`jev-${step}.png`), fullPage: true });
  }
  return screen;
}

async function dismissExplorerDialog(page: Page, step: number, findings: Finding[]): Promise<void> {
  // Any dialog or menu the click opened is looked at, then dismissed — never submitted.
  await page.waitForTimeout(600);
  if (await page.getByRole("dialog").first().isVisible().catch(() => false)) {
    const dialogText = await page.getByRole("dialog").first().innerText().catch(() => "");
    const bad = dialogText.match(BROKEN_TEXT);
    if (bad) findings.push({ step, url: page.url(), check: "raw-value-dialog", detail: bad[0] });
  }
  await page.keyboard.press("Escape").catch(() => undefined);
}

test.describe("Jev explorer (advisory)", () => {
  test.describe.configure({ timeout: 900_000 });

  // The seed stays out of the title: unset, it is time-derived and differs
  // between the runner and the worker, which then cannot find the test.
  // One walk of the pilot plan. The original random walk keeps its Dashboard
  // start, default viewport and default locale (no locale script, no viewport).
  type Walk = { label: string; attachment?: string; route: string; seed: number; locale?: PilotExplorerStart["locale"]; viewport?: PilotExplorerStart["viewport"] };

  // Every pilot start gets its own page with exactly one locale init script:
  // several addInitScript calls on one page run in an order Playwright does not
  // define. One test per start, so a failing start never skips the others and
  // each walk has its own timeout and seed.
  function pilotWalk(context: BrowserContext, baseURL: string | undefined, route: PilotExplorerStart["route"], locale: PilotExplorerStart["locale"], viewportName: PilotExplorerStart["viewport"]["name"]) {
    const start = pilotExplorerStarts().find(s => s.route === route && s.locale === locale && s.viewport.name === viewportName);
    if (!start) throw new Error(`No pilot explorer start ${route} ${locale} ${viewportName} in the plan.`);
    const walk: Walk = { label: pilotExplorerTitle(start), route, locale, viewport: start.viewport, seed: pilotExplorerSeed(SEED, start) };
    return withLocalePage(context, locale, start.viewport, page => explore(page, baseURL, walk));
  }

  async function explore(page: Page, baseURL: string | undefined, start: Walk) {
    test.info().annotations.push({ type: "seed", description: `${start.seed} (${STEPS} steps; ${start.label}; base seed ${SEED})` });
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));
    await page.addInitScript((keys) => {
      for (const key of keys) {
        try {
          localStorage.setItem(key, "1");
        } catch {
          // storage blocked: the tour shows and Escape dismisses it
        }
      }
    }, TOUR_KEYS);
    const attestation = await attest(page, baseURL, sockets);
    expect(attestation.refusal, attestation.refusal ?? "").toBeUndefined();
    const expectedDeployment = convexDeploymentOf(process.env.NEXT_PUBLIC_CONVEX_URL);

    // A button can navigate as well as a link can; refusing the page itself
    // (document and RSC payload) stops either from mounting a write-on-view screen.
    await page.route(
      (url) => WRITES_ON_VIEW.test(url.pathname),
      (route) => route.abort(),
    );

    const random = rng(start.seed);
    const findings: Finding[] = [];
    const orgId = await resolveOrgId(page);
    expect(orgId, "the app must open the attested QA organization").toBe(attestation.orgId);
    await page.goto(`/${orgId}/${start.route}`);
    if (start.locale) {
      await expect(page.locator("html")).toHaveAttribute("lang", start.locale);
      await expect(page.locator("html")).toHaveAttribute("dir", start.locale === "ar" ? "rtl" : "ltr");
    }
    const visited = new Set<string>();
    let step = 0;
    page.on("pageerror", (e) => findings.push({ step, url: page.url(), check: "uncaught", detail: e.message }));

    for (step = 0; step < STEPS; step++) {
      if (!page.url().includes(`/${orgId}/`)) await page.goto(`/${orgId}/${start.route}`);
      await page.waitForTimeout(1_200);
      // Also every frame of the app talks only to the verified backend.
      const stray = servedDeployments(sockets).find((d) => d !== expectedDeployment);
      if (stray) throw new Error(`The app opened a connection to ${stray}; stopping before Jev sees it.`);
      if (WRITES_ON_VIEW.test(new URL(page.url()).pathname)) {
        await page.goto(`/${orgId}/${start.route}`);
        continue;
      }

      visited.add(new URL(page.url()).pathname.replace(`/${orgId}`, ""));
      const screen = await observeScreen(page, step, findings);

      const options = await candidates(page);
      if (options.length === 0) {
        await page.goto(`/${orgId}/${start.route}`);
        continue;
      }
      const picked = (await jevPick(options.map((o) => o.name), screen)) ?? Math.floor(random() * options.length);
      const target = options[Math.min(picked, options.length - 1)];
      await target.el.click({ timeout: 5_000 }).catch(() => undefined);
      await dismissExplorerDialog(page, step, findings);
    }

    for (const f of findings) {
      test.info().annotations.push({ type: `advisory:${f.check}`, description: `#${f.step} ${f.url} ${f.detail}` });
    }
    await test.info().attach(start.attachment ?? `jev-explorer-${start.label.replaceAll(" ", "-")}.json`, {
      body: JSON.stringify(
        { start: { route: start.route, locale: start.locale, viewport: start.viewport }, seed: start.seed, baseSeed: SEED, steps: STEPS, jev: Boolean(process.env.TYPESAFE_API_KEY), jevStats, visited: [...visited].sort(), findings },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }

  test("random walk", async ({ page, baseURL }) => {
    await explore(page, baseURL, { label: "random walk", attachment: "jev-explorer-findings.json", route: "dashboard", seed: SEED });
  });

  // One test per pilot start (pilotExplorerStarts). The titles are literals on
  // purpose: each scenario record binds to exactly one active test title, which
  // a computed title cannot satisfy. scripts/pilotG8Coverage.test.ts requires
  // this list to equal the plan, so a start cannot be dropped or left untested.
  test("pilot explorer deals en desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "deals", "en", "desktop"));
  test("pilot explorer deals en phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "deals", "en", "phone"));
  test("pilot explorer deals ar desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "deals", "ar", "desktop"));
  test("pilot explorer deals ar phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "deals", "ar", "phone"));
  test("pilot explorer sales en desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "sales", "en", "desktop"));
  test("pilot explorer sales en phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "sales", "en", "phone"));
  test("pilot explorer sales ar desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "sales", "ar", "desktop"));
  test("pilot explorer sales ar phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "sales", "ar", "phone"));
  test("pilot explorer accounting en desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "accounting", "en", "desktop"));
  test("pilot explorer accounting en phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "accounting", "en", "phone"));
  test("pilot explorer accounting ar desktop", ({ context, baseURL }) => pilotWalk(context, baseURL, "accounting", "ar", "desktop"));
  test("pilot explorer accounting ar phone", ({ context, baseURL }) => pilotWalk(context, baseURL, "accounting", "ar", "phone"));});
