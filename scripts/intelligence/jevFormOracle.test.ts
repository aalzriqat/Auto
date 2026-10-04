import { describe, expect, it } from "vitest";
import {
  classifyErrorToast,
  hostileValue,
  judge,
  kindOf,
  phonePair,
  rulesFor,
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
});
