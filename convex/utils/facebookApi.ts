export const FACEBOOK_GRAPH_VERSION = "v21.0";

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
): Promise<{ ok: boolean; error?: string }> {
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
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error?.message ?? res.statusText };
}
