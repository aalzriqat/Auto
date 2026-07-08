export const FACEBOOK_GRAPH_VERSION = "v25.0";

/**
 * Text-bearing fields to request when fetching a post/reel's content to
 * match against vehicle inventory. Reels resolve to a Video node (not a
 * Page Post) and don't support message/story/caption/name/call_to_action/
 * properties/attachments — the Graph API 400s the *entire* request if any
 * requested field is invalid for the resolved node type, so these two
 * lists must stay disjoint by node type rather than merged into one.
 */
export const FACEBOOK_REEL_VIDEO_FIELDS = ["description", "title"].join(",");

export const FACEBOOK_PAGE_POST_FIELDS = [
  "message",
  "story",
  "name",
  "caption",
  "description",
  "call_to_action",
  "properties",
  "attachments{title,description,name,caption,url,unshimmed_url,subattachments{title,description,name,caption,url,unshimmed_url}}",
  "child_attachments{title,description,name,caption,url,call_to_action}",
].join(",");

/** Fields to read back off the parsed JSON response for either node type above. */
export const FACEBOOK_POST_TEXT_FIELDS = ["message", "story", "name", "caption", "description", "title"] as const;

/** Posts a reply to a specific Facebook Page comment via the Graph API. */
export async function postCommentReply(
  commentId: string,
  message: string,
  pageAccessToken: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${commentId}/comments`);
  url.searchParams.set("message", message);
  url.searchParams.set("access_token", pageAccessToken);
  const res = await fetch(url.toString(), { method: "POST" });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error?.message ?? res.statusText };
}

/** Sends a Messenger message to a Page-scoped recipient via the Graph API. */
export async function postDirectMessage(
  recipientFacebookId: string,
  message: string,
  pageId: string,
  pageAccessToken: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/messages`);
  url.searchParams.set("access_token", pageAccessToken);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientFacebookId },
      message: { text: message },
      messaging_type: "RESPONSE",
    }),
  });
  if (res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: true, messageId: json?.message_id };
  }
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error?.message ?? res.statusText };
}

/**
 * Fetches the complete Messenger conversation history for a given PSID.
 * Finds the conversation via /{pageId}/conversations?user_id={psid}, then
 * paginates through all messages. Returns newest-first (Graph API default).
 */
export async function fetchFbConversationMessages(
  psid: string,
  pageId: string,
  pageAccessToken: string
): Promise<{
  conversationId: string | null;
  messages: Array<{
    id: string;
    message: string;
    from: { id: string; name: string };
    created_time: string;
  }>;
}> {
  const convUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/conversations`);
  convUrl.searchParams.set("platform", "messenger");
  convUrl.searchParams.set("user_id", psid);
  convUrl.searchParams.set("fields", "id");
  convUrl.searchParams.set("access_token", pageAccessToken);

  const convRes = await fetch(convUrl.toString());
  if (!convRes.ok) return { conversationId: null, messages: [] };
  const convJson = await convRes.json();
  const conversationId: string | null = convJson.data?.[0]?.id ?? null;
  if (!conversationId) return { conversationId: null, messages: [] };

  const messages: Array<{ id: string; message: string; from: { id: string; name: string }; created_time: string }> = [];
  let nextUrl: string | null =
    `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${conversationId}/messages` +
    `?fields=id,message,from,created_time&limit=100&access_token=${pageAccessToken}`;

  while (nextUrl !== null) {
    const pageUrl: string = nextUrl;
    const pageRes = await fetch(pageUrl);
    if (!pageRes.ok) break;
    const pageJson: { data?: typeof messages; paging?: { next?: string } } = await pageRes.json();
    messages.push(...(pageJson.data ?? []));
    nextUrl = pageJson.paging?.next ?? null;
  }

  return { conversationId, messages };
}
