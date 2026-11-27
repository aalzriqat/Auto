// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildConversation, flattenSocialEvents, MAX_CONTEXT_MESSAGES, MAX_MESSAGE_CHARACTERS } from "./draftContext";
import type { DraftMessage } from "./draftContext";

describe("flattenSocialEvents", () => {
  test("turns an event into the customer text, the automatic reply and the staff reply, in that order", () => {
    expect(
      flattenSocialEvents([
        { text: "Price?", autoReplyText: "Thanks, a rep will reply.", manualReplyText: "It is 25000." },
        { text: "OK" },
      ])
    ).toEqual([
      { direction: "customer", text: "Price?" },
      { direction: "dealership", text: "Thanks, a rep will reply." },
      { direction: "dealership", text: "It is 25000." },
      { direction: "customer", text: "OK" },
    ]);
  });

  test("skips empty fields", () => {
    expect(flattenSocialEvents([{ text: "", autoReplyText: undefined, manualReplyText: "" }])).toEqual([]);
  });
});

describe("buildConversation", () => {
  test("keeps the newest 12 messages in order", () => {
    const messages: DraftMessage[] = Array.from({ length: 15 }, (_, i) => ({ direction: "customer", text: `m${i}` }));
    const conversation = buildConversation(messages);
    expect(MAX_CONTEXT_MESSAGES).toBe(12);
    // guardrail-4-fixture: the context window is 12 messages
    expect(conversation).toHaveLength(12);
    expect(conversation[0]?.text).toBe("m3");
    expect(conversation[11]?.text).toBe("m14");
  });

  test("cuts each message to 1,500 characters, counting characters not UTF-16 units", () => {
    const [cut] = buildConversation([{ direction: "customer", text: "😀".repeat(1600) }]);
    expect(MAX_MESSAGE_CHARACTERS).toBe(1500);
    // guardrail-4-fixture: the per-message cap is 1,500 characters
    expect(Array.from(cut?.text ?? "")).toHaveLength(1500);
  });

  test("drops empty and blank messages", () => {
    expect(
      buildConversation([
        { direction: "customer", text: "   " },
        { direction: "customer", text: "" },
        { direction: "customer", text: "Hi" },
      ])
    ).toEqual([{ direction: "customer", text: "Hi" }]);
  });

  test("copies direction and text only, so no other field of a handed-over document survives", () => {
    const leaky = { direction: "customer", text: "Hi", customerId: "SENTINEL_CUSTOMER_ID", phone: "SENTINEL_PHONE" } as const;
    const [message] = buildConversation([leaky]);
    expect(Object.keys(message ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(["direction", "text"]);
    expect(JSON.stringify(message)).not.toContain("SENTINEL");
  });
});
