import { describe, test, expect, vi } from "vitest";
import { renderNotification } from "./render";

// Selectively drops just "lead.created"'s EN translation (keeping every
// other type intact) so the "missing template" fallback can be exercised
// deterministically, without depending on there actually being a gap in the
// real catalog right now.
vi.mock("../i18n/domains/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n/domains/notifications")>();
  const { Notif_LeadCreated_Title, Notif_LeadCreated_Message, ...restEn } = actual.notificationsEn as Record<string, string>;
  return { ...actual, notificationsEn: restEn };
});

describe("renderNotification", () => {
  test("fills {placeholder} tokens in English", () => {
    const { title, message } = renderNotification("en", "lead.assigned", { actorName: "Alice" });
    expect(title).toBe("Lead Assigned");
    expect(message).toBe("Alice assigned a lead to you.");
  });

  test("fills {placeholder} tokens in Arabic", () => {
    const { title, message } = renderNotification("ar", "lead.assigned", { actorName: "أحمد" });
    expect(title).toBe("تم تعيين عميل محتمل");
    expect(message).toContain("أحمد");
  });

  test("substitutes multiple distinct placeholders", () => {
    const { message } = renderNotification("en", "vehicle.deleted", {
      actorName: "Bob",
      vehicleLabel: "2021 Toyota Camry",
      vin: "JT2BF22K1X0123456",
    });
    expect(message).toBe("Bob deleted a 2021 Toyota Camry (VIN: JT2BF22K1X0123456)");
  });

  test("system.announcement renders the admin-authored title/message directly, bypassing the dictionary", () => {
    const { title, message } = renderNotification("en", "system.announcement", {
      title: "Scheduled maintenance",
      message: "AutoFlow will be briefly unavailable tonight.",
    });
    expect(title).toBe("Scheduled maintenance");
    expect(message).toBe("AutoFlow will be briefly unavailable tonight.");
  });

  test("falls back to the raw type string for an unknown type", () => {
    const { title, message } = renderNotification("en", "not.a.real.type", undefined);
    expect(title).toBe("not.a.real.type");
    expect(message).toBe("");
  });

  test("handles missing data gracefully (placeholders left unresolved rather than throwing)", () => {
    expect(() => renderNotification("en", "lead.assigned", undefined)).not.toThrow();
  });

  test("system.announcement defaults title/message to empty strings when the data doesn't provide them", () => {
    const { title, message } = renderNotification("en", "system.announcement", {});
    expect(title).toBe("");
    expect(message).toBe("");
  });

  test("falls back to the raw type string when a known type has no matching title/message template", () => {
    const { title, message } = renderNotification("en", "lead.created", { actorName: "Alice" });
    expect(title).toBe("lead.created");
    expect(message).toBe("");
  });
});

// SCRUM-901: a recipient without the statement permissions gets the supplier alert with no `amount` key. The sentence must
// read correctly without it, in both languages, and never show a raw {placeholder}.
describe("renderNotification - supplier obligation alerts with and without an amount", () => {
  const base = { kind: "PAYABLE", currency: "JOD", dueDate: "2026-06-15", daysOverdue: 0 };
  const overdue = { ...base, dueDate: "2026-06-01", daysOverdue: 7 };

  test("with the amount, the sentence names it (unchanged)", () => {
    expect(renderNotification("en", "accounting.supplierObligationDue", { ...base, amount: "7654.000" }).message).toBe(
      "A supplier obligation of 7654.000 JOD is due on 2026-06-15."
    );
    expect(renderNotification("en", "accounting.supplierObligationOverdue", { ...overdue, amount: "7654.000" }).message).toBe(
      "A supplier obligation of 7654.000 JOD was due on 2026-06-01 and is 7 days overdue."
    );
  });

  test("without the amount key, English reads correctly and keeps the date and days overdue", () => {
    expect(renderNotification("en", "accounting.supplierObligationDue", base).message).toBe("A supplier obligation is due on 2026-06-15.");
    expect(renderNotification("en", "accounting.supplierObligationOverdue", overdue).message).toBe(
      "A supplier obligation was due on 2026-06-01 and is 7 days overdue."
    );
  });

  test("without the amount key, Arabic reads correctly and keeps the date and days overdue", () => {
    expect(renderNotification("ar", "accounting.supplierObligationDue", base).message).toBe("التزام مورّد يستحق بتاريخ 2026-06-15.");
    expect(renderNotification("ar", "accounting.supplierObligationOverdue", overdue).message).toBe(
      "التزام مورّد كان مستحقاً بتاريخ 2026-06-01 وتأخر 7 يوماً."
    );
  });

  test("no rendering of the redacted alert leaves a placeholder or the currency behind", () => {
    for (const locale of ["en", "ar"] as const) {
      for (const type of ["accounting.supplierObligationDue", "accounting.supplierObligationOverdue"]) {
        const { message } = renderNotification(locale, type, overdue);
        expect(message).not.toMatch(/[{}]/);
        expect(message).not.toContain("JOD");
      }
    }
  });
});
