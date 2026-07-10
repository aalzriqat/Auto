import { describe, expect, test } from "vitest";
import { buildWhatsAppDeepLink } from "./whatsappDeepLink";

describe("buildWhatsAppDeepLink", () => {
  test("strips spaces and the plus sign from the phone number", () => {
    const link = buildWhatsAppDeepLink("+962 79 123 4567", "hello");
    expect(link).toBe("https://wa.me/962791234567?text=hello");
  });

  test("strips dashes from the phone number", () => {
    const link = buildWhatsAppDeepLink("+962-79-123-4567", "Hi there");
    expect(link).toBe(`https://wa.me/962791234567?text=${encodeURIComponent("Hi there")}`);
  });

  test("URL-encodes special characters in the message text", () => {
    const link = buildWhatsAppDeepLink("962791234567", "Hello & welcome, 100% free!");
    expect(link).toBe(`https://wa.me/962791234567?text=${encodeURIComponent("Hello & welcome, 100% free!")}`);
  });

  test("handles a plain local number with no plus sign", () => {
    const link = buildWhatsAppDeepLink("0791234567", "test");
    expect(link).toBe("https://wa.me/0791234567?text=test");
  });
});
