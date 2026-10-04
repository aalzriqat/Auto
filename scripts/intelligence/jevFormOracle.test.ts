import { describe, expect, it } from "vitest";
import {
  argKeyFor,
  baselineValue,
  classifyErrorToast,
  clip,
  findDocument,
  hostileValue,
  judge,
  kindOf,
  markupScriptRan,
  phonePair,
  readBackOf,
  rulesFor,
  submissionsToReadBack,
  summarizeReadBack,
  type Attempt,
  type Field,
} from "./jevFormOracle";

const firstName: Field = { label: "First Name *", kind: "name", required: true };
const phone: Field = { label: "Phone", kind: "phone", required: false };
const notes: Field = { label: "Notes", kind: "text", required: false };

const attempt = (a: Partial<Attempt> & Pick<Attempt, "rule" | "outcome">): Attempt => ({ field: firstName, ...a });

describe("judge — fixed verdicts, no model involved", () => {
  it("a whitespace-only required value that saves is a finding (SCRUM-610 F-02/F-04)", () => {
    expect(judge(attempt({ rule: "blank-required", outcome: "accepted" })).check).toBe("blank-required-accepted");
    expect(judge(attempt({ rule: "blank-required", outcome: "rejected-inline" })).kind).toBe("ok");
    expect(judge(attempt({ rule: "blank-required", outcome: "rejected-toast" })).kind).toBe("ok");
  });

  it("a raw server error is a finding whatever the rule (F-01)", () => {
    const toast = "[Request ID: 1a2b] Server Error Uncaught Error: Validation failed at handler (../convex/expenses.ts:486:10)";
    expect(classifyErrorToast(toast)).toBe("rejected-raw");
    for (const rule of ["too-long", "unicode", "blank-required"] as const) {
      expect(judge(attempt({ rule, outcome: "rejected-raw", toast })).check).toBe("raw-error");
    }
  });

  it("a clean ConvexError message is not a raw error", () => {
    expect(classifyErrorToast('A customer with phone "0790000001" already exists.')).toBe("rejected-toast");
    expect(classifyErrorToast("An unexpected error occurred. Please try again later.")).toBe("rejected-toast");
  });

  it("Save that does nothing at all is a finding (F-08 class)", () => {
    expect(judge(attempt({ rule: "too-long", outcome: "ignored" })).check).toBe("silent-ignore");
  });

  it("a save still in progress is inconclusive, never silent-ignore (Codex F614-04)", () => {
    expect(judge(attempt({ rule: "blank-required", outcome: "pending" })).kind).toBe("inconclusive");
  });

  it("a missed toast does not hide an invalid save (Codex F614-04)", () => {
    expect(judge(attempt({ rule: "blank-required", outcome: "accepted-silent" })).check).toBe("blank-required-accepted");
    expect(judge({ rule: "garbage-phone", field: phone, outcome: "accepted-silent" }).check).toBe("invalid-format-accepted");
    // A clean value saved without confirmation stays an advisory.
    expect(judge({ rule: "markup", field: notes, outcome: "accepted-silent", scriptRan: false }).check).toBe("silent-accept");
  });

  it("a malformed phone or email that saves is a finding (F-06 class)", () => {
    expect(judge({ rule: "garbage-phone", field: phone, outcome: "accepted" }).check).toBe("invalid-format-accepted");
    expect(judge({ rule: "garbage-phone", field: phone, outcome: "rejected-inline" }).kind).toBe("ok");
  });

  it("long text and negatives are advisories, never findings", () => {
    expect(judge({ rule: "too-long", field: notes, outcome: "accepted" }).kind).toBe("advisory");
    expect(judge({ rule: "negative", field: { label: "Qty", kind: "number", required: false }, outcome: "accepted" }).kind).toBe(
      "advisory",
    );
  });

  it("markup is a finding only when it executed", () => {
    expect(judge({ rule: "markup", field: notes, outcome: "accepted", scriptRan: false }).kind).toBe("ok");
    expect(judge({ rule: "markup", field: notes, outcome: "accepted", scriptRan: true }).check).toBe("markup-executed");
  });

  it("markup saved where it never rendered is inconclusive, not ok (CodeRabbit #437)", () => {
    expect(judge({ rule: "markup", field: notes, outcome: "accepted" }).kind).toBe("inconclusive");
  });

  it("refused markup is ok only when the detector stayed quiet (Opus #437 F2)", () => {
    expect(judge({ rule: "markup", field: notes, outcome: "rejected-inline", scriptRan: false }).kind).toBe("ok");
    expect(judge({ rule: "markup", field: notes, outcome: "rejected-toast", scriptRan: true }).check).toBe("markup-executed");
  });

  it("a silent save of unverified markup says it is unverified (Opus #437 F3)", () => {
    const v = judge({ rule: "markup", field: notes, outcome: "accepted-silent" });
    expect(v.check).toBe("silent-accept");
    expect(v.reason).toContain("never seen rendered");
  });

  describe("markupScriptRan — what the explorer saw (Opus #437 F1)", () => {
    const seen = { ranBefore: false, ranAfter: false, saved: true, rendered: true };
    it("any reading that caught the payload running means it ran", () => {
      expect(markupScriptRan({ ...seen, ranBefore: true })).toBe(true);
      expect(markupScriptRan({ ...seen, ranAfter: true })).toBe(true);
      expect(markupScriptRan({ ...seen, rendered: false, ranAfter: true })).toBe(true);
    });
    it("did-not-run needs a refusal or a rendered row", () => {
      expect(markupScriptRan(seen)).toBe(false);
      expect(markupScriptRan({ ...seen, saved: false, rendered: false })).toBe(false);
    });
    it("saved but never seen rendered is unknown", () => {
      expect(markupScriptRan({ ...seen, rendered: false })).toBeUndefined();
    });
  });

  it("unicode must be accepted and read back unchanged", () => {
    const expected = hostileValue("unicode", "T1");
    expect(judge({ rule: "unicode", field: notes, outcome: "rejected-inline" }).check).toBe("unicode-rejected");
    expect(judge({ rule: "unicode", field: notes, outcome: "accepted", expected, readBack: `Row  ${expected}  more` }).kind).toBe("ok");
    expect(judge({ rule: "unicode", field: notes, outcome: "accepted", expected, readBack: "QA TEST T1 ??????" }).check).toBe(
      "unicode-mangled",
    );
    expect(judge({ rule: "unicode", field: notes, outcome: "accepted", expected }).kind).toBe("inconclusive");
  });

  describe("dup-variant is judged against its exact-format control (F-03)", () => {
    const variant = (outcome: Attempt["outcome"], warned: boolean, control?: Attempt["control"]): Attempt => ({
      rule: "dup-variant",
      field: phone,
      outcome,
      warned,
      control,
    });

    it("exact duplicate blocked, other format saved silently → finding", () => {
      expect(judge(variant("accepted", false, { outcome: "rejected-toast", warned: false })).check).toBe("duplicate-format-bypass");
      expect(judge(variant("accepted", false, { outcome: "accepted", warned: true })).check).toBe("duplicate-format-bypass");
    });

    it("other format also caught → ok", () => {
      expect(judge(variant("rejected-toast", false, { outcome: "rejected-toast", warned: false })).kind).toBe("ok");
      expect(judge(variant("accepted", true, { outcome: "rejected-toast", warned: true })).kind).toBe("ok");
    });

    it("a field with no duplicate policy at all is not judged", () => {
      expect(judge(variant("accepted", false, { outcome: "accepted", warned: false })).kind).toBe("ok");
    });

    it("no control attempt → inconclusive, never a finding", () => {
      expect(judge(variant("accepted", false)).kind).toBe("inconclusive");
    });
  });
});

describe("field model", () => {
  it("infers kinds from labels in both languages", () => {
    expect(kindOf("First Name *", "text", "INPUT")).toBe("name");
    expect(kindOf("الاسم الأول *", "text", "INPUT")).toBe("name");
    expect(kindOf("Phone", "text", "INPUT")).toBe("phone");
    expect(kindOf("WhatsApp", "text", "INPUT")).toBe("phone");
    expect(kindOf("Email", "email", "INPUT")).toBe("email");
    expect(kindOf("Task Title *", "text", "INPUT")).toBe("title");
    expect(kindOf("National ID / Passport", "text", "INPUT")).toBe("text");
    expect(kindOf("Description / Notes", "", "TEXTAREA")).toBe("text");
    expect(kindOf("Due", "checkbox", "INPUT")).toBeUndefined();
  });

  it("only required fields get the blank rule", () => {
    expect(rulesFor(firstName)).toContain("blank-required");
    expect(rulesFor(notes)).not.toContain("blank-required");
    expect(rulesFor(phone)).toEqual(["garbage-phone", "dup-variant"]);
  });

  it("phonePair gives the same number in local and international form", () => {
    const p = phonePair(1234);
    expect(p.local).toBe("0790001234");
    expect(p.intl).toBe("+962790001234");
    expect(p.intl.slice(-9)).toBe(p.local.slice(-9));
  });

  it("every field kind gets its own rule set", () => {
    expect(rulesFor({ label: "Phone *", kind: "phone", required: true })).toEqual(["blank-required", "garbage-phone", "dup-variant"]);
    expect(rulesFor({ label: "Email *", kind: "email", required: true })).toEqual(["blank-required", "garbage-email"]);
    expect(rulesFor({ label: "Email", kind: "email", required: false })).toEqual(["garbage-email"]);
    expect(rulesFor({ label: "Qty *", kind: "number", required: true })).toEqual(["negative"]);
    expect(kindOf("Amount", "number", "INPUT")).toBe("number");
  });

  it("dup-exact is the control and never a verdict of its own", () => {
    expect(judge({ rule: "dup-exact", field: phone, outcome: "accepted" }).kind).toBe("ok");
  });
});

describe("hostile and baseline values", () => {
  it("each hostile value carries what its rule tests", () => {
    expect(hostileValue("blank-required", "T1").trim()).toBe("");
    expect(hostileValue("too-long", "T1")).toHaveLength("QA TEST T1 ".length + 2_000);
    expect(hostileValue("markup", "T1")).toMatch(/^QA TEST T1 <img [^>]*onerror=/);
    expect(hostileValue("unicode", "T1")).toMatch(/^QA TEST T1 .*[\u0600-\u06FF]/u);
    expect(hostileValue("garbage-phone", "T1")).not.toMatch(/\d/);
    expect(hostileValue("garbage-email", "T1")).toContain("@@");
    expect(Number(hostileValue("negative", "T1"))).toBeLessThan(0);
    // Duplicate attempts get their numbers from phonePair, not from here.
    expect(hostileValue("dup-exact", "T1")).toBe("");
    expect(hostileValue("dup-variant", "T1")).toBe("");
  });

  it("baseline values are valid, tagged where text, and never collide", () => {
    expect(baselineValue("name", "T1", 1)).toBe("QA TEST T1");
    expect(baselineValue("title", "T1", 1)).toBe("QA TEST task T1");
    expect(baselineValue("text", "T1", 1)).toBe("QA TEST T1");
    expect(baselineValue("phone", "T1", 7)).toBe(phonePair(7).local);
    expect(baselineValue("phone", "T1", 7)).not.toBe(baselineValue("phone", "T1", 8));
    expect(baselineValue("email", "T1", 1)).toMatch(/^qa\.t1@example\.test$/);
    expect(Number(baselineValue("number", "T1", 1))).toBeGreaterThan(0);
  });
});

describe("read-back: typed → sent → persisted (SCRUM-614 acceptance 2/3)", () => {
  const typed = "QA TEST عربي 🚗 F614-X01";

  it("finds the one argument that carried the typed value, exactly or trimmed", () => {
    expect(argKeyFor({ firstName: typed, lastName: "QA TEST F614-X01" }, typed)).toBe("firstName");
    expect(argKeyFor({ firstName: "", lastName: "QA" }, "   ")).toBe("firstName");
  });

  it("never guesses: two matching arguments, or none, is no key", () => {
    expect(argKeyFor({ a: typed, b: typed }, typed)).toBeUndefined();
    expect(argKeyFor({ a: "x" }, typed)).toBeUndefined();
    expect(argKeyFor(undefined, typed)).toBeUndefined();
    // Two blanks after trimming are as ambiguous as two exact matches.
    expect(argKeyFor({ a: "", b: "" }, "  ")).toBeUndefined();
  });

  it("finds a document by _id inside a paginated query result", () => {
    const page = { page: [{ _id: "c1", firstName: "A" }, { _id: "c2", firstName: "B" }], isDone: true };
    expect(findDocument(page, "c2")).toEqual({ _id: "c2", firstName: "B" });
    expect(findDocument(page, "c3")).toBeUndefined();
    expect(findDocument(null, "c1")).toBeUndefined();
  });

  it("reports the persisted value only from the server's own document", () => {
    const args = { firstName: typed };
    expect(readBackOf({ typed, args, id: "c1", doc: { _id: "c1", firstName: typed }, expectedKey: "firstName" })).toEqual({
      source: "server-document",
      key: "firstName",
      sent: typed,
      persisted: typed,
    });
    expect(readBackOf({ typed, args, id: "c1", doc: { _id: "c1" }, expectedKey: "firstName" }).source).toBe("field-not-returned");
    expect(readBackOf({ typed, args, id: "c1", doc: undefined, expectedKey: "firstName" }).source).toBe("document-not-observed");
    expect(readBackOf({ typed, args, id: undefined, doc: undefined, expectedKey: "firstName" }).source).toBe("no-id");
    expect(readBackOf({ typed, args: { other: "x" }, id: "c1", doc: { _id: "c1", other: "x" }, expectedKey: "firstName" }).source).toBe("not-sent");
  });

  it("compares on full values and stores clipped ones", () => {
    const long = "x".repeat(2000);
    const s = summarizeReadBack(long, { source: "server-document", key: "address", sent: long, persisted: long.slice(0, 500) });
    expect(s.sentEqualsTyped).toBe(true);
    expect(s.persistedEqualsSent).toBe(false); // truncated on the server: visible, though both are clipped
    expect(s.persisted).toBe(`${"x".repeat(60)}… (500 chars)`);
    expect(clip("short")).toBe("short");
    expect(clip(42)).toBe(42);
  });

  it("a trimmed save is visible as typed ≠ sent", () => {
    const s = summarizeReadBack("   ", { source: "server-document", key: "firstName", sent: "", persisted: "" });
    expect(s.sentEqualsTyped).toBe(false);
    expect(s.persistedEqualsSent).toBe(true);
  });
});

describe("Codex review of ac09a2914 (F614-1..3)", () => {
  const typed = "QA TEST عربي 🚗 F614-X02";
  const notes = { label: "Notes", kind: "text", required: false } as const;

  it("F614-1: a value sent under another field is wrong-field, never server-document", () => {
    const args = { firstName: "QA TEST F614-X02", lastName: typed };
    const doc = { _id: "c1", firstName: "QA TEST F614-X02", lastName: typed };
    expect(readBackOf({ typed, args, id: "c1", doc, expectedKey: "firstName" })).toEqual({
      source: "wrong-field",
      key: "firstName",
      observedKey: "lastName",
      sent: "QA TEST F614-X02",
    });
  });

  it("F614-1: a field with no mapped argument is unmapped, not traced by its value", () => {
    const rb = readBackOf({ typed, args: { notes: typed }, id: "l1", doc: { _id: "l1", notes: typed }, expectedKey: undefined });
    expect(rb).toEqual({ source: "unmapped", observedKey: "notes" });
  });

  it("F614-1: the mapped key is read even when another argument holds the same value", () => {
    // The phone is copied into WhatsApp: value matching alone is ambiguous, the map is not.
    const args = { firstName: "QA", lastName: "QA", phone: "0791234567", whatsapp: "0791234567" };
    const rb = readBackOf({ typed: "0791234567", args, id: "c1", doc: { _id: "c1", ...args }, expectedKey: "phone" });
    expect(rb).toMatchObject({ source: "server-document", key: "phone", persisted: "0791234567" });
  });

  it("F614-1: a client-transformed value is still traced at its key, and the change shows", () => {
    const rb = readBackOf({ typed: "  x  ", args: { address: "x" }, id: "c1", doc: { _id: "c1", address: "x" }, expectedKey: "address" });
    expect(rb).toMatchObject({ source: "server-document", key: "address", sent: "x" });
    expect(summarizeReadBack("  x  ", rb).sentEqualsTyped).toBe(false);
  });

  it("F614-2: every saved submission is read back, not only the last", () => {
    const subs = [
      { role: "seed", outcome: "accepted", value: "0791234567" },
      { role: "control", outcome: "accepted", value: "0791234567" },
      { role: "variant", outcome: "rejected-inline", value: "+962791234567" },
      { role: "attempt", outcome: "accepted-silent", value: undefined },
    ] as const;
    expect(submissionsToReadBack(subs).map((s) => s.role)).toEqual(["seed", "control"]);
  });

  it("F614-4: a create the server confirmed is read back whatever the UI reported", () => {
    const subs = [
      // An error toast after a confirmed create (e.g. a failed custom-field save first).
      { role: "attempt", outcome: "rejected-toast", value: "QA", created: { args: {}, id: "c9" } },
      // Control: the same UI outcome with no confirmed create stays out.
      { role: "seed", outcome: "rejected-toast", value: "QA", created: { args: {}, id: undefined } },
      { role: "control", outcome: "rejected-inline", value: "QA" },
      // UI-accepted without a confirmed id stays in, so it shows as unverified (no-id).
      { role: "variant", outcome: "accepted", value: "QA", created: undefined },
    ] as const;
    expect(submissionsToReadBack(subs).map((s) => s.role)).toEqual(["attempt", "variant"]);
  });

  it("F614-3: the server's own field must equal the typed value exactly", () => {
    const expected = hostileValue("unicode", "T2");
    const server = (readBack: string) => judge({ rule: "unicode", field: notes, outcome: "accepted", expected, readBack, readBackFrom: "server-document" });
    expect(server(expected).kind).toBe("ok");
    expect(server(`${expected} extra`).check).toBe("unicode-mangled");
    expect(server(`prefix ${expected}`).check).toBe("unicode-mangled");
    expect(server(expected.replace(" ", "  ")).check).toBe("unicode-mangled");
    // The list row is a whole cell of text: containment stays its rule.
    expect(judge({ rule: "unicode", field: notes, outcome: "accepted", expected, readBack: `Row ${expected} more`, readBackFrom: "list" }).kind).toBe("ok");
  });
});

describe("calibration run 5, #14: markup saved into a field the list never shows", () => {
  it("is inconclusive, not ok", () => {
    const description = { label: "Description / Notes", kind: "text", required: false } as const;
    const scriptRan = markupScriptRan({ ranBefore: false, ranAfter: false, saved: true, rendered: false });
    expect(judge({ rule: "markup", field: description, outcome: "accepted", scriptRan }).kind).toBe("inconclusive");
  });
});
