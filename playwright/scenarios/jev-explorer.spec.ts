import { test, type Locator, type Page } from "@playwright/test";
import { callJev } from "../../scripts/intelligence/jevImpact.mjs";
import { resolveOrgId } from "../utils";

/**
 * A random explorer (SCRUM-595): walk the dashboard by clicking what is on
 * screen, with Jev choosing the next element when TYPESAFE_API_KEY is set and a
 * seeded random pick when it is not. ADVISORY ONLY — it never fails. Fixed code
 * checks record what they see as annotations plus a JSON report; Jev's own
 * opinion of a screen is recorded beside them and never decides anything
 * (the SCRUM-350 rule: Jev may suggest, only fixed checks may declare).
 *
 * It does not change data: anything whose name reads as a commit (save,
 * submit, confirm, delete, post, approve, refund …) is never clicked, and any
 * dialog it opens is dismissed with Escape. It refuses to run anywhere but a
 * local app on a non-production backend, because every screen Jev judges is
 * sent to TypeSafe.
 */

const PRODUCTION_DEPLOYMENT = "kindly-hound-172";
const STEPS = Number(process.env.JEV_EXPLORER_STEPS ?? 40);
const SEED = Number(process.env.JEV_EXPLORER_SEED ?? Date.now() % 100_000);

const COMMIT_WORDS =
  /delete|remove|cancel|void|revers|refund|forfeit|post|close|approve|reject|confirm|submit|save|send|sign ?out|log ?out|archive|pay|transfer|disburse|finali[sz]e|record|import|upload|invite|حذف|إلغاء|تأكيد|حفظ|إرسال|خروج|اعتماد|رفض|ترحيل|دفع|تسجيل/i;
const BROKEN_TEXT = /\bNaN\b|\bundefined\b|\[object Object\]/;
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

async function candidates(page: Page): Promise<Array<{ el: Locator; name: string }>> {
  const all = page.locator(
    'main a[href^="/"], nav a[href^="/"], main button, [role="tab"], main [role="combobox"]',
  );
  const out: Array<{ el: Locator; name: string }> = [];
  const count = Math.min(await all.count(), 80);
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.isDisabled().catch(() => true)) continue;
    const name = ((await el.getAttribute("aria-label")) || (await el.innerText().catch(() => "")))
      .trim()
      .slice(0, 80);
    if (!name || COMMIT_WORDS.test(name)) continue;
    out.push({ el, name });
  }
  return out;
}

// "jev: true" only says a key was set. These say whether Jev actually answered,
// so a silent outage cannot pass for a Jev-guided walk.
const jevStats = { pickAsked: 0, pickAnswered: 0, opinionAsked: 0, opinionAnswered: 0, maxOpinion: 0 };

async function jevPick(names: string[], screen: string): Promise<number | undefined> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || names.length === 0) return undefined;
  const questions: Record<string, unknown> = {};
  names.slice(0, 12).forEach((name, i) => {
    questions[`c${i}`] = {
      type: "noul",
      instructions: `Would clicking "${name}" most likely reveal a screen state in a car-dealership app where a display or money defect could hide?`,
      criteria: { true: "It opens new data, a dialog, a tab or a detail view.", false: "It leads nowhere new." },
    };
  });
  jevStats.pickAsked++;
  try {
    const res = (await callJev({ apiKey, state: { screen: screen.slice(0, 3_000) }, questions })) as {
      answers?: Record<string, { noul?: number }>;
    };
    let best = -1;
    let bestScore = -1;
    for (const [k, v] of Object.entries(res.answers ?? {})) {
      const score = typeof v?.noul === "number" ? v.noul : -1;
      if (score > bestScore) {
        bestScore = score;
        best = Number(k.slice(1));
      }
    }
    if (best >= 0) jevStats.pickAnswered++;
    return best >= 0 ? best : undefined;
  } catch {
    return undefined; // a Jev outage only removes the suggestion (SCRUM-360)
  }
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

test.describe("Jev explorer (advisory)", () => {
  test.describe.configure({ timeout: 900_000 });

  test(`random walk, seed ${SEED}, ${STEPS} steps`, async ({ page, baseURL }) => {
    const host = new URL(baseURL ?? "http://localhost:3000").hostname;
    test.skip(!["localhost", "127.0.0.1"].includes(host), "Explorer runs against a local app only.");
    test.skip(
      (process.env.NEXT_PUBLIC_CONVEX_URL ?? "").includes(PRODUCTION_DEPLOYMENT),
      "Explorer never runs against the production backend.",
    );

    const random = rng(SEED);
    const findings: Finding[] = [];
    const orgId = await resolveOrgId(page);
    const visited = new Set<string>();
    let step = 0;
    page.on("pageerror", (e) => findings.push({ step, url: page.url(), check: "uncaught", detail: e.message }));

    for (step = 0; step < STEPS; step++) {
      if (!page.url().includes(`/${orgId}/`)) await page.goto(`/${orgId}/dashboard`);
      await page.waitForTimeout(1_200);

      visited.add(new URL(page.url()).pathname.replace(`/${orgId}`, ""));
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

      const options = await candidates(page);
      if (options.length === 0) {
        await page.goto(`/${orgId}/dashboard`);
        continue;
      }
      const picked = (await jevPick(options.map((o) => o.name), screen)) ?? Math.floor(random() * options.length);
      const target = options[Math.min(picked, options.length - 1)];
      await target.el.click({ timeout: 5_000 }).catch(() => undefined);
      // Any dialog or menu the click opened is looked at, then dismissed — never submitted.
      await page.waitForTimeout(600);
      if (await page.getByRole("dialog").first().isVisible().catch(() => false)) {
        const dialogText = await page.getByRole("dialog").first().innerText().catch(() => "");
        const bad = dialogText.match(BROKEN_TEXT);
        if (bad) findings.push({ step, url: page.url(), check: "raw-value-dialog", detail: bad[0] });
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    for (const f of findings) {
      test.info().annotations.push({ type: `advisory:${f.check}`, description: `#${f.step} ${f.url} ${f.detail}` });
    }
    await test.info().attach("jev-explorer-findings.json", {
      body: JSON.stringify(
        { seed: SEED, steps: STEPS, jev: Boolean(process.env.TYPESAFE_API_KEY), jevStats, visited: [...visited].sort(), findings },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });
});
