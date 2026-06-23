import { describe, test, expect } from "vitest";
import { renderNotification } from "./render";

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
});
