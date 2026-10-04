import { expect, test, type Locator, type Page } from "@playwright/test";
import { callJev } from "../../scripts/intelligence/jevImpact.mjs";
import {
  baselineValue,
  classifyErrorToast,
  hostileValue,
  judge,
  kindOf,
  phonePair,
  rulesFor,
  type Attempt,
  type Field,
  type Outcome,
  type Rule,
  type Verdict,
} from "../../scripts/intelligence/jevFormOracle";
import { resolveOrgId } from "../utils";
import { refusalReason, servedDeployments, convexDeploymentOf } from "./formExplorer/attestedPreview";

/**
 * The Jev form explorer (SCRUM-614). Where jev-explorer.spec.ts only clicks
 * and never commits, this one types hostile input into create forms, presses
 * the form's own Save, and lets FIXED rules (scripts/intelligence/jevFormOracle)
 * decide whether the app's answer is a defect. Jev only picks which form,
 * field and input to try next; with no TYPESAFE_API_KEY a seeded random order
 * is used instead. ADVISORY: it reports, it never fails the run.
 *
 * It WRITES, so it is opt-in (JEV_FORM_EXPLORER=1) and runs only on an
 * attested disposable preview behind the same guard as the click explorer.
 * Only the forms in FORMS can be submitted — customers, leads and tasks, none
 * of which posts money or reaches anyone outside the app — and every record it
 * creates carries "QA TEST" and a run tag.
 */

const MAX_ATTEMPTS = Number(process.env.JEV_FORM_EXPLORER_ATTEMPTS ?? 30);
const SEED = Number(process.env.JEV_FORM_EXPLORER_SEED ?? Date.now() % 100_000);
// "QA TEST F614-…" is the prefix agreed with the #430 scenario lane, which
// shares this preview org and looks its own records up by exact name.
const RUN = `F614-${(Date.now() % 1_000_000).toString(36).toUpperCase()}`;

/** The only screens it may submit on. Each entry is reviewed by a person. */
type FormSpec = {
  id: string;
  route: "customers" | "leads" | "tasks";
  trigger: RegExp;
  title: RegExp;
  submit: RegExp;
  success: RegExp;
  /** Fills required controls the explorer cannot type into (pickers). */
  prepare?: (dialog: Locator, page: Page) => Promise<boolean>;
};

const FORMS: FormSpec[] = [
  {
    id: "customer",
    route: "customers",
    trigger: /^Add Customer$/,
    title: /^Add Customer$/,
    submit: /^Add Customer$/,
    success: /Customer added successfully/,
  },
  {
    id: "task",
    route: "tasks",
    trigger: /^Schedule Task$/,
    title: /^Create Task$/,
    submit: /^Create Task$/,
    success: /Task created successfully/,
  },
  {
    id: "lead",
    route: "leads",
    trigger: /^Add Lead$/,
    title: /^Add Lead$/,
    submit: /^Add Lead$/,
    success: /Lead added successfully/,
    // The customer picker is required: choose the customer this run seeded,
    // never a record another lane created.
    prepare: async (dialog, page) => {
      await dialog.getByRole("button", { name: /Select customer/ }).click();
      await page.getByPlaceholder(/^Search/).last().fill(`QA TEST ${RUN}-SEED`);
      const option = page.locator('[data-testid^="searchable-option-"]').first();
      if (!(await option.isVisible({ timeout: 8_000 }).catch(() => false))) return false;
      await option.click();
      return true;
    },
  },
];

/** Screens that write just by being viewed (jev-explorer.spec.ts, Codex AF-430-04). */
const WRITES_ON_VIEW = /\/(messages|notifications|social-inbox)(\/|$|\?)/;
const DUPLICATE_WARNING = /already exists|already has an open lead|موجود|مسجل مسبق/i;

type Candidate = { form: FormSpec; field: Field; rule: Rule };
type Record_ = {
  n: number;
  form: string;
  field: string;
  rule: Rule;
  outcome: Outcome;
  verdict: Verdict;
  toast?: string;
  screenshot?: string;
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RULE_TEXT: Record<Rule, string> = {
  "blank-required": "only spaces",
  "too-long": "2,000 characters of text",
  markup: "an HTML tag with an onerror script",
  unicode: "Arabic text with an emoji",
  "garbage-phone": "letters and punctuation instead of a phone number",
  "garbage-email": "a malformed email address",
  negative: "a negative number",
  "dup-exact": "an existing phone number again",
  "dup-variant": "an existing phone number again but in +962 international format instead of 07 local format",
};

const jevStats = { pickAsked: 0, pickAnswered: 0 };

/** Jev's suggestion of which candidate to try next, or undefined. Never a verdict. */
async function jevPick(cands: Candidate[]): Promise<number | undefined> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || cands.length === 0) return undefined;
  const questions: Record<string, unknown> = {};
  cands.slice(0, 12).forEach((c, i) => {
    questions[`c${i}`] = {
      type: "noul",
      instructions: `In a car-dealership CRM, would saving the "${c.form.id}" form with ${RULE_TEXT[c.rule]} in its "${c.field.label}" field most likely expose a validation, duplicate-detection or data-normalization defect?`,
      criteria: { true: "Likely to expose a defect.", false: "Likely handled correctly." },
    };
  });
  jevStats.pickAsked++;
  try {
    const res = (await callJev({ apiKey, state: { form: cands[0]?.form.id }, questions })) as {
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

test.describe("Jev form explorer (advisory, writes to the preview)", () => {
  test.describe.configure({ timeout: 1_800_000 });

  test("hostile input into create forms", async ({ page, baseURL }) => {
    test.skip(process.env.JEV_FORM_EXPLORER !== "1", "Opt-in: set JEV_FORM_EXPLORER=1. It writes QA TEST records.");
    test.info().annotations.push({ type: "run", description: `${RUN} seed=${SEED} attempts=${MAX_ATTEMPTS}` });

    await page.addInitScript(() => {
      localStorage.setItem("autoflow-locale", "en");
      for (const k of ["messenger_onboarding_seen_v1", "dealer_website_onboarding_seen_v1", "feature_spotlight_seen_v3", "global_search_onboarding_seen_v1"]) {
        localStorage.setItem(k, "1");
      }
    });
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));
    const refusal = await refusalReason(page, baseURL, sockets);
    test.skip(Boolean(refusal), refusal ?? "");
    const expected = convexDeploymentOf(process.env.NEXT_PUBLIC_CONVEX_URL);

    await page.route(
      (url) => WRITES_ON_VIEW.test(url.pathname),
      (route) => route.abort(),
    );
    const orgId = await resolveOrgId(page);

    /** Stops the run the moment any frame talks to another backend. */
    const assertBackend = () => {
      const stray = servedDeployments(sockets).find((d) => d !== expected);
      if (stray) throw new Error(`The app opened a connection to ${stray}; stopping before any write.`);
    };

    async function openForm(form: FormSpec): Promise<Locator | undefined> {
      assertBackend();
      await page.goto(`/${orgId}/${form.route}`);
      const trigger = page.getByRole("button", { name: form.trigger }).first();
      if (!(await trigger.isVisible({ timeout: 20_000 }).catch(() => false))) return undefined;
      await trigger.click();
      const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: form.title }) });
      if (!(await dialog.isVisible({ timeout: 10_000 }).catch(() => false))) return undefined;
      return dialog;
    }

    /** Typable, labelled controls of an open dialog. Pickers and selects are left alone. */
    async function discoverFields(dialog: Locator): Promise<Field[]> {
      const out: Field[] = [];
      const labels = dialog.locator("label");
      for (let i = 0; i < (await labels.count()); i++) {
        const text = (await labels.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!text) continue;
        const control = dialog.getByLabel(text, { exact: true }).first();
        const shape = await control
          .evaluate((e) => ({ tag: e.tagName, type: (e.getAttribute("type") ?? "").toLowerCase() }))
          .catch(() => undefined);
        if (!shape || !["INPUT", "TEXTAREA"].includes(shape.tag)) continue;
        const kind = kindOf(text, shape.type, shape.tag);
        if (!kind) continue;
        out.push({ label: text, kind, required: text.includes("*") });
      }
      return out;
    }

    async function fill(dialog: Locator, fields: Field[], values: Map<string, string>) {
      for (const f of fields) {
        const v = values.get(f.label);
        if (v !== undefined) await dialog.getByLabel(f.label, { exact: true }).first().fill(v);
      }
    }

    /** Presses the form's own Save and reports what the app did. Fixed code only. */
    async function submit(form: FormSpec, dialog: Locator): Promise<{ outcome: Outcome; toast?: string }> {
      // The last line of defence before a write: right page, right dialog, right backend.
      assertBackend();
      expect(new URL(page.url()).pathname).toBe(`/${orgId}/${form.route}`);
      await expect(dialog.getByRole("heading", { name: form.title })).toBeVisible();

      const toasts = page.locator("[data-sonner-toast]");
      const before = new Set(await toasts.allInnerTexts().catch(() => []));
      await dialog.getByRole("button", { name: form.submit }).click();

      const deadline = Date.now() + 10_000;
      let closedAt: number | undefined;
      while (Date.now() < deadline) {
        await page.waitForTimeout(250);
        const n = await toasts.count();
        for (let i = 0; i < n; i++) {
          const t = toasts.nth(i);
          const text = (await t.innerText().catch(() => "")).trim();
          if (!text || before.has(text)) continue;
          if (form.success.test(text)) return { outcome: "accepted", toast: text };
          if ((await t.getAttribute("data-type").catch(() => null)) === "error") {
            return { outcome: classifyErrorToast(text), toast: text };
          }
        }
        const inline = dialog.locator('[id$="-form-item-message"]');
        if ((await inline.count()) > 0 && (await inline.first().innerText().catch(() => "")).trim()) {
          return { outcome: "rejected-inline", toast: (await inline.first().innerText()).trim() };
        }
        // The dialog can close a beat before its toast renders: give the toast
        // 2s before calling the save silent.
        if (!(await dialog.isVisible().catch(() => false))) {
          closedAt ??= Date.now();
          if (Date.now() - closedAt > 2_000) return { outcome: "accepted-silent" };
        }
      }
      if (closedAt !== undefined) return { outcome: "accepted-silent" };
      // A native constraint bubble (type=email, required) is a rejection, not silence.
      if ((await dialog.locator("input:invalid, textarea:invalid").count()) > 0) return { outcome: "rejected-inline", toast: "native validation" };
      return { outcome: "ignored" };
    }

    async function closeDialog(dialog: Locator) {
      if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape");
    }

    /** Row text found by searching the form's own list for the run tag. */
    async function readBack(form: FormSpec, tag: string): Promise<string | undefined> {
      await page.goto(`/${orgId}/${form.route}`);
      const search = page.locator('main input[placeholder^="Search"]').first();
      if (!(await search.isVisible({ timeout: 15_000 }).catch(() => false))) return undefined;
      await search.fill(tag);
      await page.waitForTimeout(2_000);
      const text = await page.locator("main table").innerText().catch(() => "");
      return text.includes(tag) ? text : undefined;
    }

    // One fresh record per attempt: fill required fields with valid values,
    // the target field with the hostile one, save, judge.
    let slot = 0;
    async function attemptOnce(
      c: Candidate,
      fields: Field[],
      override?: { label: string; value: string },
    ): Promise<{ outcome: Outcome; toast?: string; warned: boolean; tag: string; value?: string; dialog?: Locator; setupFailed?: string }> {
      const tag = `${RUN}${(++slot).toString().padStart(2, "0")}`;
      // A failure of the explorer's own setup says nothing about the app:
      // it is reported as inconclusive, never as "Save did nothing".
      const dialog = await openForm(c.form);
      if (!dialog) return { outcome: "ignored", warned: false, tag, setupFailed: "form did not open" };
      if (c.form.prepare && !(await c.form.prepare(dialog, page))) {
        await closeDialog(dialog);
        return { outcome: "ignored", warned: false, tag, setupFailed: "required picker had no seeded option" };
      }
      const values = new Map<string, string>();
      for (const f of fields) if (f.required) values.set(f.label, baselineValue(f.kind, tag, Date.now() + slot));
      const value = override?.value ?? hostileValue(c.rule, tag);
      values.set(override?.label ?? c.field.label, value);
      await fill(dialog, fields, values);
      await page.waitForTimeout(1_500); // the duplicate check is debounced
      const warned = DUPLICATE_WARNING.test(await dialog.innerText().catch(() => ""));
      const res = await submit(c.form, dialog);
      return { ...res, warned, tag, value, dialog };
    }

    const random = rng(SEED);
    const records: Record_[] = [];
    const fieldsByForm = new Map<string, Field[]>();

    // Discovery: open each allowed form once, list its typable fields, close it.
    for (const form of FORMS) {
      const dialog = await openForm(form);
      if (!dialog) {
        test.info().annotations.push({ type: "unreachable-form", description: form.id });
        continue;
      }
      fieldsByForm.set(form.id, await discoverFields(dialog));
      await closeDialog(dialog);
    }

    // The lead form needs a customer: seed one for this run so the picker
    // never attaches leads to another lane's records.
    const customerForm = FORMS.find((f) => f.id === "customer");
    const customerFields = fieldsByForm.get("customer");
    if (customerForm && customerFields) {
      const dialog = await openForm(customerForm);
      if (dialog) {
        const seedTag = `${RUN}-SEED`;
        const values = new Map<string, string>();
        for (const f of customerFields) if (f.required) values.set(f.label, baselineValue(f.kind, seedTag, Date.now()));
        await fill(dialog, customerFields, values);
        const seeded = await submit(customerForm, dialog);
        await closeDialog(dialog);
        test.info().annotations.push({ type: "seed-customer", description: `${seedTag}: ${seeded.outcome}` });
      }
    }

    let pool: Candidate[] = shuffle(
      FORMS.flatMap((form) => (fieldsByForm.get(form.id) ?? []).flatMap((field) => rulesFor(field).map((rule) => ({ form, field, rule })))),
      random,
    );

    for (let n = 1; n <= MAX_ATTEMPTS && pool.length > 0; n++) {
      const picked = (await jevPick(pool)) ?? 0;
      const c = pool[Math.min(picked, pool.length - 1)];
      pool = pool.filter((p) => p !== c);
      const fields = fieldsByForm.get(c.form.id) ?? [];
      let a: Attempt;
      let last: Awaited<ReturnType<typeof attemptOnce>>;
      let setupFailed: string | undefined;

      if (c.rule === "dup-variant") {
        // Seed a record with a local-format number, retry it exactly (the
        // control: is this field policed at all?), then in +962 format.
        const pair = phonePair(Date.now() % 10_000_000);
        const seeded = await attemptOnce(c, fields, { label: c.field.label, value: pair.local });
        if (seeded.dialog) await closeDialog(seeded.dialog);
        if (seeded.setupFailed) {
          a = { rule: c.rule, field: c.field, outcome: seeded.outcome };
          last = seeded;
          setupFailed = seeded.setupFailed;
        } else if (seeded.outcome !== "accepted") {
          a = { rule: c.rule, field: c.field, outcome: seeded.outcome, toast: seeded.toast };
          last = seeded;
        } else {
          const control = await attemptOnce({ ...c, rule: "dup-exact" }, fields, { label: c.field.label, value: pair.local });
          if (control.dialog) await closeDialog(control.dialog);
          last = await attemptOnce(c, fields, { label: c.field.label, value: pair.intl });
          setupFailed = control.setupFailed ?? last.setupFailed;
          a = {
            rule: c.rule,
            field: c.field,
            outcome: last.outcome,
            toast: last.toast,
            warned: last.warned,
            control: { outcome: control.outcome, warned: control.warned },
          };
        }
      } else {
        last = await attemptOnce(c, fields);
        setupFailed = last.setupFailed;
        a = { rule: c.rule, field: c.field, outcome: last.outcome, toast: last.toast, warned: last.warned };
      }

      if (setupFailed) {
        if (last.dialog) await closeDialog(last.dialog);
        records.push({
          n,
          form: c.form.id,
          field: c.field.label,
          rule: c.rule,
          outcome: a.outcome,
          verdict: { kind: "inconclusive", check: "setup", reason: `${c.field.label} (${c.rule}): ${setupFailed}` },
        });
        continue;
      }

      let shot: string | undefined;
      if (last.dialog && (await last.dialog.isVisible().catch(() => false))) {
        shot = test.info().outputPath(`attempt-${n}-${c.form.id}-${c.rule}.png`);
        await page.screenshot({ path: shot });
      }
      if (last.dialog) await closeDialog(last.dialog);

      if ((c.rule === "unicode" || c.rule === "markup") && (a.outcome === "accepted" || a.outcome === "accepted-silent")) {
        const readBackText = await readBack(c.form, last.tag);
        // Lists show names and titles only. For any other field the row is
        // found through the tagged name, so its text cannot prove or disprove
        // the round-trip: leave it unread (inconclusive), never "mangled".
        if (c.field.kind === "name" || c.field.kind === "title") {
          a.readBack = readBackText;
          a.expected = last.value;
        }
        a.scriptRan = Boolean(await page.evaluate(() => (window as unknown as { __qaFormXss?: number }).__qaFormXss));
      }

      const verdict = judge(a);
      if (verdict.kind === "finding" && !shot) {
        shot = test.info().outputPath(`finding-${n}-${c.form.id}-${c.rule}.png`);
        await page.screenshot({ path: shot, fullPage: true });
      }
      records.push({ n, form: c.form.id, field: c.field.label, rule: c.rule, outcome: a.outcome, verdict, toast: a.toast?.slice(0, 300), screenshot: shot });
    }

    const findings = records.filter((r) => r.verdict.kind === "finding");
    for (const r of records.filter((x) => x.verdict.kind === "finding" || x.verdict.kind === "advisory")) {
      test.info().annotations.push({ type: `${r.verdict.kind}:${r.verdict.check}`, description: `#${r.n} ${r.form} — ${r.verdict.reason}` });
    }
    await test.info().attach("jev-form-explorer.json", {
      body: JSON.stringify(
        {
          run: RUN,
          seed: SEED,
          maxAttempts: MAX_ATTEMPTS,
          jev: Boolean(process.env.TYPESAFE_API_KEY),
          jevStats,
          fields: Object.fromEntries(fieldsByForm),
          untried: pool.map((p) => `${p.form.id}:${p.field.label}:${p.rule}`),
          summary: {
            attempts: records.length,
            findings: findings.length,
            advisories: records.filter((r) => r.verdict.kind === "advisory").length,
            inconclusive: records.filter((r) => r.verdict.kind === "inconclusive").length,
          },
          records,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });
});
