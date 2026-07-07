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
    const { message } = renderNotification("en", "customer.merged", {
      actorName: "Bob",
      loserName: "Dup Customer",
      survivorName: "Main Customer",
    });
    expect(message).toBe('Bob merged "Dup Customer" into "Main Customer".');
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
