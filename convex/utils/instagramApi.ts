export const INSTAGRAM_GRAPH_VERSION = "v21.0";

/** Posts a reply to a specific Instagram comment via the Graph API. */
export async function postCommentReply(
  commentId: string,
  message: string,
  accessToken: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${commentId}/replies`);
  url.searchParams.set("message", message);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString(), { method: "POST" });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error?.message ?? res.statusText };
}

/** Sends a direct message to an Instagram-scoped recipient via the Messaging API. */
export async function postDirectMessage(
  recipientInstagramId: string,
  message: string,
  businessAccountId: string,
  accessToken: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${businessAccountId}/messages`);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientInstagramId },
      message: { text: message },
    }),
  });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => null);
  return { ok: false, error: json?.error?.message ?? res.statusText };
}
