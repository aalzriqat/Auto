import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { newT, seedOrg, post, igDm, fbDm, snapshot, PROD_LIKE_IG, PROD_LIKE_FB } from "../test-utils/socialWebhook";

type ContactCase = {
  platform: "instagram" | "facebook";
  extra: Record<string, unknown>;
  text?: string;
  eventContext?: Record<string, unknown>;
  requiresMobile?: boolean;
  senders?: string[];
  expectedPhone?: string;
  expectedLeads?: number;
};

const sharedPost = (type: string) => ({
  attachments: [{ type, payload: { title: "Synthetic showroom caption 0790000001" } }],
});

async function assertContactProvenance(input: ContactCase) {
  const t = newT();
  const prefix = input.platform;
  const orgId = await seedOrg(t, {
    ...(prefix === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    dealershipPhone: "0790000003",
    [`${prefix}LeadFromDmsRequiresMobile`]: input.requiresMobile ?? true,
    [`${prefix}AutoReplyEnabled`]: true,
    [`${prefix}AutoReplyMessages`]: ["Please type your number."],
    [`${prefix}AutoReplyMobileReceivedMessage`]: "Number received.",
  });
  for (const sender of input.senders ?? ["synthetic_sender"]) {
    const payload = prefix === "instagram"
      ? igDm(sender, input.text, input.extra)
      : fbDm(sender, input.text, input.extra);
    Object.assign(payload.entry[0].messaging[0], input.eventContext);
    expect((await post(t, `/${prefix}-webhook`, payload)).status).toBe(200);
  }
  const state = await snapshot(t, orgId);
  const events = prefix === "instagram" ? state.igEvents : state.fbEvents;
  expect(state.customers).toHaveLength(input.senders?.length ?? 1);
  expect(state.leads).toHaveLength(input.expectedLeads ?? 0);
  expect(state.customers.map((customer) => customer.phone)).toEqual(
    (input.senders ?? ["synthetic_sender"]).map(() => input.expectedPhone),
  );
  for (const event of events) {
    expect(event.autoReplyText).toBe(input.expectedPhone ? "Number received." : "Please type your number.");
  }
  expect(events).toHaveLength(input.senders?.length ?? 1);
  if (input.extra.attachments || input.eventContext?.referral) {
    expect(events[0].text).toContain("0790000001");
    if (input.expectedLeads) expect(state.leads[0].notes).toContain("0790000001");
  }
}

async function assertUnprovenContactText(platform: "instagram" | "facebook", kind: "dm" | "comment", senderText?: string) {
  const t = newT();
  const orgId = await seedOrg(t, {
    ...(platform === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    [`${platform}LeadFromCommentsEnabled`]: true,
    [`${platform}AutoReplyEnabled`]: true,
    [`${platform}AutoReplyMessages`]: ["Please type your number."],
    [`${platform}AutoReplyMobileReceivedMessage`]: "Number received.",
  });
  const args = { orgId, kind, externalId: "synthetic_replay", text: "Stored caption 0790000001", senderText };
  const result = platform === "instagram"
    ? await t.mutation(internal.instagramEngagement.handleIncomingInstagramEvent, { ...args, senderInstagramId: "synthetic_sender" })
    : await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { ...args, senderFacebookId: "synthetic_sender" });
  const state = await snapshot(t, orgId);
  expect(state.leads).toHaveLength(kind === "comment" ? 1 : 0);
  expect(state.customers[0].phone).toBeUndefined();
  expect(result?.replyText).toBe("Please type your number.");
}

describe("SCRUM-949 sender contact provenance", () => {
  test("SCRUM-949: Instagram ig_post caption cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post") }));
  test("SCRUM-949: Instagram ig_reel caption cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_reel") }));
  test("SCRUM-949: Facebook share title cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share") }));
  test("SCRUM-949: Facebook fallback attachment title cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("unknown") }));
  test("SCRUM-949: Facebook ad referral cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: {}, eventContext: { referral: {
      source: "ADS", ad_id: "synthetic_ad", ref: "Call showroom 0790000001",
    } } }));
  test("SCRUM-949: two Instagram senders sharing one post receive no phone or lead", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), senders: ["synthetic_a", "synthetic_b"] }));
  test("SCRUM-949: two Facebook senders sharing one post receive no phone or lead", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), senders: ["synthetic_a", "synthetic_b"] }));
  test("SCRUM-949: Instagram uses the typed phone beside a shared caption", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), text: "Call me 0790000002", expectedPhone: "0790000002", expectedLeads: 1 }));
  test("SCRUM-949: Facebook uses the typed phone beside a shared caption", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), text: "Call me 0790000002", expectedPhone: "0790000002", expectedLeads: 1 }));
  test("SCRUM-949: Instagram still excludes the typed settings phone", () =>
    assertContactProvenance({ platform: "instagram", extra: {}, text: "0790000003" }));
  test("SCRUM-949: Facebook still excludes the typed settings phone", () =>
    assertContactProvenance({ platform: "facebook", extra: {}, text: "0790000003" }));
  test("SCRUM-949: Instagram share creates a phoneless lead when mobile is optional", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), requiresMobile: false, expectedLeads: 1 }));
  test("SCRUM-949: Facebook share creates a phoneless lead when mobile is optional", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), requiresMobile: false, expectedLeads: 1 }));
  test("SCRUM-949: Instagram quick reply title and payload cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: { quick_reply: { payload: "0790000001" } }, text: "0790000001" }));
  test("SCRUM-949: Facebook quick reply title and payload cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: { quick_reply: { payload: "0790000001" } }, text: "0790000001" }));
  test("SCRUM-949: Instagram story reply context cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: { reply_to: { story: { id: "synthetic_story" }, text: "0790000001" } } }));
  test("SCRUM-949: Instagram story mention cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("story_mention") }));
  test("SCRUM-949: Facebook stored combined text without provenance refuses contact extraction", () =>
    assertUnprovenContactText("facebook", "dm"));
  test("SCRUM-949: Instagram stored combined text without provenance refuses contact extraction", () =>
    assertUnprovenContactText("instagram", "dm"));
  test("SCRUM-949: Instagram empty sender text never falls back to combined text", () =>
    assertUnprovenContactText("instagram", "dm", ""));
  test("SCRUM-949: Facebook empty sender text never falls back to combined text", () =>
    assertUnprovenContactText("facebook", "dm", ""));
  test("SCRUM-949: Instagram comments never extract a phone even from sender text", () =>
    assertUnprovenContactText("instagram", "comment", "0790000001"));
  test("SCRUM-949: Facebook comments never extract a phone even from sender text", () =>
    assertUnprovenContactText("facebook", "comment", "0790000001"));
});

