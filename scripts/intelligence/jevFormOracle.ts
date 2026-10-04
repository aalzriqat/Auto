/**
 * The fixed rules of the Jev form explorer (SCRUM-614). Jev only chooses which
 * form, field and hostile input to try next; whether the app's answer is a
 * defect is decided here, by code that never consults a model (the SCRUM-350
 * rule: Jev may suggest, only fixed checks may declare).
 *
 * Pure on purpose: no Playwright, no I/O, so every rule has a unit test.
 */

export type FieldKind = "name" | "title" | "phone" | "email" | "text" | "number";

export type Field = { label: string; kind: FieldKind; required: boolean };

/** What the app did after Save was pressed. */
export type Outcome =
  | "accepted" // the form's own success toast appeared
  | "accepted-silent" // the dialog closed with no toast at all
  | "rejected-inline" // a field error under an input
  | "rejected-toast" // an error toast in user-facing language
  | "rejected-raw" // an error toast leaking server internals
  | "ignored" // nothing happened: no toast, no field error, dialog still open
  | "pending"; // Save was still busy when the wait ended: no evidence either way

export type Rule =
  | "blank-required" // whitespace-only into a required field
  | "too-long" // 2,000 characters
  | "markup" // an HTML payload that runs script if rendered as markup
  | "unicode" // Arabic + emoji, must round-trip exactly
  | "garbage-phone" // letters and punctuation into a phone field
  | "garbage-email" // a malformed address into an email field
  | "negative" // a negative number
  | "dup-exact" // the same phone again, in the same format
  | "dup-variant"; // the same phone again, local ↔ international format

export type Attempt = {
  rule: Rule;
  field: Field;
  outcome: Outcome;
  toast?: string;
  /** A duplicate warning was on screen before Save. */
  warned?: boolean;
  /** For dup-variant only: how the exact-format control attempt ended. */
  control?: { outcome: Outcome; warned: boolean };
  /** Row text read back from the list after an accepted save, if any. */
  readBack?: string;
  /** The value the rule expects to round-trip, for unicode/markup. */
  expected?: string;
  /** The markup payload executed in the page; undefined when it was never seen rendered. */
  scriptRan?: boolean;
};

export type Verdict = { kind: "finding" | "advisory" | "ok" | "inconclusive"; check: string; reason: string };

/**
 * Server internals that must never reach a dealer: request ids, uncaught
 * errors, stack frames, validator dumps (SCRUM-610 F-01).
 */
export const RAW_ERROR =
  /\[Request ID:|Server Error|Uncaught|ArgumentValidationError|\bat (async )?[\w.<>]+ \(|\.(ts|js):\d+:\d+|\[CONVEX [QMA]\(/;

export function isAccepted(o: Outcome): boolean {
  return o === "accepted" || o === "accepted-silent";
}

function isRejected(o: Outcome): boolean {
  return o === "rejected-inline" || o === "rejected-toast" || o === "rejected-raw";
}

/** Error-toast text → the outcome it represents. */
export function classifyErrorToast(text: string): Outcome {
  return RAW_ERROR.test(text) ? "rejected-raw" : "rejected-toast";
}

/** Collapse whitespace the way a rendered table cell does. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The fixed verdict for one attempt. Ordered: the first rule that fires wins. */
export function judge(a: Attempt): Verdict {
  const where = `${a.field.label} (${a.rule})`;

  // Any input, any form: a raw server error is a defect on its own.
  if (a.outcome === "rejected-raw") {
    return { kind: "finding", check: "raw-error", reason: `${where}: error toast leaks server internals: ${(a.toast ?? "").slice(0, 200)}` };
  }
  // Nothing at all happened: the user cannot tell whether it saved (F-08 class).
  if (a.outcome === "ignored") {
    return { kind: "finding", check: "silent-ignore", reason: `${where}: Save did nothing — no toast, no field error.` };
  }
  // A slow save is not a silent one: without an answer there is no verdict.
  if (a.outcome === "pending") return inconclusive(where, "Save was still in progress when the wait ended");

  const verdict = judgeRule(a, where);
  // A closed dialog with no toast still saved the value: the rule's finding
  // stands, and only an otherwise clean save is downgraded to the advisory.
  if (a.outcome === "accepted-silent" && verdict.kind !== "finding") {
    // Keep an inconclusive rule's reason: the advisory must not read as verified.
    const unverified = verdict.kind === "inconclusive" ? ` Also ${verdict.reason}.` : "";
    return { kind: "advisory", check: "silent-accept", reason: `${where}: the dialog closed without any confirmation.${unverified}` };
  }
  return verdict;
}

/** Rules whose only question is "was it saved?". */
type SavedOnlyRule = "blank-required" | "garbage-phone" | "garbage-email" | "negative" | "too-long";

/**
 * The verdict for a SavedOnlyRule when the value was saved. Anything not
 * saved is ok here; a raw error or silent ignore was caught above.
 */
const WHEN_SAVED: Record<SavedOnlyRule, (a: Attempt, where: string) => Verdict> = {
  "blank-required": (a) => ({
    kind: "finding",
    check: "blank-required-accepted",
    reason: `${a.field.label} is required but a whitespace-only value was saved.`,
  }),
  "garbage-phone": (_a, where) => ({ kind: "finding", check: "invalid-format-accepted", reason: `${where}: a malformed value was saved.` }),
  "garbage-email": (_a, where) => ({ kind: "finding", check: "invalid-format-accepted", reason: `${where}: a malformed value was saved.` }),
  negative: (_a, where) => ({
    kind: "advisory",
    check: "negative-accepted",
    reason: `${where}: a negative number was saved; confirm whether that is meaningful.`,
  }),
  // Saving long text is not wrong by itself.
  "too-long": (_a, where) => ({ kind: "advisory", check: "no-length-limit", reason: `${where}: 2,000 characters were saved with no limit.` }),
};

function isSavedOnly(r: Rule): r is SavedOnlyRule {
  return Object.hasOwn(WHEN_SAVED, r);
}

function judgeRule(a: Attempt, where: string): Verdict {
  if (isSavedOnly(a.rule)) return isAccepted(a.outcome) ? WHEN_SAVED[a.rule](a, where) : ok(where);
  switch (a.rule) {
    case "markup":
      if (a.scriptRan) return { kind: "finding", check: "markup-executed", reason: `${where}: the HTML payload ran as script.` };
      // See markupScriptRan: `false` needs evidence, anything else is unknown.
      if (a.scriptRan === undefined) return inconclusive(where, "the saved payload was never seen rendered");
      return ok(where);
    case "unicode":
      return judgeUnicode(a, where);
    case "dup-variant":
      return judgeDupVariant(a, where);
    case "dup-exact":
      // The control: it says whether this field is meant to be unique at all.
      return ok(where);
    default: {
      const unhandled: never = a.rule;
      throw new Error(`No verdict for rule ${String(unhandled)}`);
    }
  }
}

/**
 * Whether a markup payload ran, from what the explorer saw. Each reading is
 * taken after a settle wait, because an <img onerror> fires only once the
 * image request has failed (Opus #437 F1). "Did not run" needs evidence:
 * either the value was refused (only the dialog and its toast ever showed
 * it), or it was saved and its row was seen rendered in the list.
 */
export function markupScriptRan(o: { ranBefore: boolean; ranAfter: boolean; saved: boolean; rendered: boolean }): boolean | undefined {
  if (o.ranBefore || o.ranAfter) return true;
  if (!o.saved || o.rendered) return false;
  return undefined;
}

function judgeUnicode(a: Attempt, where: string): Verdict {
  if (!isAccepted(a.outcome)) {
    return { kind: "finding", check: "unicode-rejected", reason: `${where}: Arabic/emoji text was refused.` };
  }
  if (a.readBack === undefined || a.expected === undefined) return inconclusive(where, "not read back");
  return squash(a.readBack).includes(squash(a.expected))
    ? ok(where)
    : { kind: "finding", check: "unicode-mangled", reason: `${where}: saved text did not read back unchanged.` };
}

/**
 * Only a defect when the app DOES police exact duplicates of this field and
 * lets the same number through in another format (SCRUM-610 F-03). A field
 * with no duplicate policy at all is not judged here.
 */
function judgeDupVariant(a: Attempt, where: string): Verdict {
  if (!a.control) return inconclusive(where, "no exact-format control attempt");
  const policed = a.control.warned || isRejected(a.control.outcome);
  if (!policed) return { kind: "ok", check: "dup-variant", reason: `${where}: field has no duplicate policy; not judged.` };
  const caught = a.warned || isRejected(a.outcome);
  return caught
    ? ok(where)
    : {
        kind: "finding",
        check: "duplicate-format-bypass",
        reason: `${a.field.label}: an exact duplicate is caught, but the same number in the other format was saved with no warning.`,
      };
}

function ok(where: string): Verdict {
  return { kind: "ok", check: "ok", reason: where };
}

function inconclusive(where: string, why: string): Verdict {
  return { kind: "inconclusive", check: "inconclusive", reason: `${where}: ${why}` };
}

/** Infers a field's kind from its label and input type. */
export function kindOf(label: string, inputType: string, tag: string): FieldKind | undefined {
  const l = label.toLowerCase();
  if (/phone|whats ?app|mobile|هاتف|واتساب|جوال/.test(l) || inputType === "tel") return "phone";
  if (inputType === "email" || /e-?mail|البريد/.test(l)) return "email";
  if (inputType === "number") return "number";
  if (/title|عنوان/.test(l)) return "title";
  if (/\bname\b|الاسم/.test(l) && !/id|passport|هوية/.test(l)) return "name";
  if (tag === "TEXTAREA" || inputType === "text" || inputType === "") return "text";
  return undefined;
}

/** The rules that apply to a field. Blank is only interesting where required. */
export function rulesFor(f: Field): Rule[] {
  const textual: Rule[] = ["too-long", "markup", "unicode"];
  switch (f.kind) {
    case "name":
    case "title":
    case "text":
      return f.required ? ["blank-required", ...textual] : textual;
    case "phone":
      return f.required ? ["blank-required", "garbage-phone", "dup-variant"] : ["garbage-phone", "dup-variant"];
    case "email":
      return f.required ? ["blank-required", "garbage-email"] : ["garbage-email"];
    case "number":
      return ["negative"];
  }
}

/**
 * A Jordanian mobile number unique to this run and slot, in both the local
 * (07…) and international (+9627…) form of the SAME number.
 */
export function phonePair(token: number): { local: string; intl: string } {
  const seven = String(Math.abs(Math.trunc(token)) % 10_000_000).padStart(7, "0");
  return { local: `079${seven}`, intl: `+96279${seven}` };
}

/** The hostile value for a rule. `tag` is a short unique marker for read-back. */
export function hostileValue(rule: Rule, tag: string): string {
  switch (rule) {
    case "blank-required":
      return "   ";
    case "too-long":
      return `QA TEST ${tag} ${"x".repeat(2_000)}`;
    case "markup":
      return `QA TEST ${tag} <img src=x onerror="window.__qaFormXss=1">`;
    case "unicode":
      return `QA TEST ${tag} اختبار سيارة 🚗`;
    case "garbage-phone":
      return "not a phone !!";
    case "garbage-email":
      return "qa@@example";
    case "negative":
      return "-100";
    case "dup-exact":
    case "dup-variant":
      return ""; // supplied by phonePair
  }
}

/** A valid value for a field the attempt is not attacking. */
export function baselineValue(kind: FieldKind, tag: string, token: number): string {
  switch (kind) {
    case "name":
      return `QA TEST ${tag}`;
    case "title":
      return `QA TEST task ${tag}`;
    case "phone":
      return phonePair(token).local;
    case "email":
      return `qa.${tag.toLowerCase()}@example.test`;
    case "number":
      return "1";
    case "text":
      return `QA TEST ${tag}`;
  }
}
