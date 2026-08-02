import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimiter } from "./rateLimit";
import { renderNotification } from "../lib/notifications/render";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";

/**
 * How long to wait before asking Expo for delivery receipts. Expo accepts a
 * message immediately (the ticket) and only later reports what FCM/APNs
 * actually did with it (the receipt); their guidance is to wait ~15 minutes.
 */
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** Expo caps a single getReceipts call at 1000 ids. */
const RECEIPT_BATCH_SIZE = 1000;

// Same rationale as pushSend.ts: a couple of notification types carry
// user-typed content that shouldn't appear on a lock screen. Kept in step with
// PUSH_BODY_OVERRIDE there.
const PUSH_BODY_OVERRIDE: Partial<Record<string, Record<"en" | "ar", string>>> = {
  "message.received": {
    en: "Open AutoFlow to read it.",
    ar: "افتح AutoFlow للاطلاع عليها.",
  },
};

type ExpoTicket = { status?: string; id?: string; details?: { error?: string } };
type ExpoReceipt = { status?: string; details?: { error?: string } };

type SendResult =
  | { success: true; sent: number; failed?: number }
  | { success: false; error: string; sent?: number; failed?: number };

/**
 * POSTs to Expo and hands back the parsed body, collapsing all three ways the
 * call can fail — the request threw, a non-OK status, an unparseable body —
 * into a single logged-and-returned error. Returning rather than throwing is
 * deliberate: callers run as scheduled actions, and a throw would roll back the
 * writes of the mutation that scheduled them.
 *
 * `context` is interpolated into every log line and must never contain a push
 * token or a notification body.
 */
async function postToExpo<T>(
  endpoint: string,
  payload: unknown,
  context: string
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error(`[expoPush] request to ${endpoint} failed: ${context}`, error);
    return { ok: false, error: String(error) };
  }

  if (!response.ok) {
    console.error(
      `[expoPush] ${endpoint} returned HTTP ${response.status} ${response.statusText}: ${context}`
    );
    return { ok: false, error: `expo_http_${response.status}` };
  }

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    console.error(`[expoPush] could not parse the response from ${endpoint}: ${context}`, error);
    return { ok: false, error: "expo_bad_response" };
  }
}

/**
 * Counts how often each Expo error code came back, so a failure can be logged
 * as `{ MismatchSenderId: 3 }` rather than as three separate lines — and
 * without ever putting a push token or a notification body in the log.
 */
function tallyErrorCodes(entries: Array<{ details?: { error?: string } }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const code = entry.details?.error ?? "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/**
 * Expo push delivery for the native app. Fans out to every device the user has
 * registered (mobilePushTokens). Reuses the same bilingual copy as
 * email/web-push (lib/notifications/render.ts). Reaches Android only through
 * FCM, so it no-ops on devices without Google Play Services.
 *
 * Every failure path logs. This runs from `ctx.scheduler.runAfter` with no
 * caller to return to, so an unlogged failure is an invisible one — a silent
 * `{ success: false }` here is why a push outage was undiagnosable from the
 * logs. Failures are returned, never thrown: a throw in a Convex action rolls
 * back the scheduling mutation's writes, and the in-app notification that
 * dispatch() already inserted is the source of truth regardless.
 *
 * Nothing here logs a push token or a notification body — tokens are
 * credentials and bodies can contain user-typed text. Counts and Expo error
 * codes only.
 */
export const sendMobilePush = internalAction({
  args: {
    userId: v.id("users"),
    locale: v.union(v.literal("en"), v.literal("ar")),
    type: v.string(),
    data: v.any(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SendResult> => {
    const status = await rateLimiter.limit(ctx, "notificationMobilePush", { key: args.userId });
    if (!status.ok) {
      // Deliberate drop, but it must be visible: an unkeyed version of this
      // bucket silently swallowed most sends deployment-wide and looked
      // exactly like "push is broken".
      console.warn(
        `[expoPush] mobile push dropped by rate limit: user=${args.userId} type=${args.type} retryAfterMs=${status.retryAfter}`
      );
      return { success: false, error: "rate_limited" };
    }

    const tokens = await ctx.runQuery(internal.mobilePushTokens.listForUser, { userId: args.userId });
    if (tokens.length === 0) return { success: true, sent: 0 };

    const { title, message } = renderNotification(args.locale, args.type, args.data);
    const body = PUSH_BODY_OVERRIDE[args.type]?.[args.locale] ?? (message || title);

    const messages = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      sound: "default" as const,
      data: { link: args.link ?? "/", type: args.type },
    }));

    const context = `user=${args.userId} type=${args.type} tokens=${tokens.length}`;
    const result = await postToExpo<{ data?: ExpoTicket[] }>(EXPO_PUSH_ENDPOINT, messages, context);
    if (!result.ok) return { success: false, error: result.error };
    const tickets = result.data.data ?? [];

    const accepted: Array<{ id: string; token: string }> = [];
    const rejected: ExpoTicket[] = [];
    let sent = 0;
    for (let i = 0; i < tickets.length; i += 1) {
      const ticket = tickets[i];
      if (ticket.status === "ok") {
        // Accepted by Expo, NOT yet delivered. Whether FCM/APNs actually took
        // it is only knowable from the receipt, fetched below.
        sent += 1;
        if (ticket.id && tokens[i]) accepted.push({ id: ticket.id, token: tokens[i].token });
        continue;
      }
      rejected.push(ticket);
      await pruneIfDeviceNotRegistered(ctx, ticket.details?.error, tokens[i]?.token);
    }

    const failed = rejected.length;

    if (failed > 0) {
      const codes = tallyErrorCodes(rejected);
      // An all-failed send is a different event from a partial one and must be
      // greppable as such — it means this user received nothing at all.
      const kind = sent === 0 ? "every ticket rejected" : "some tickets rejected";
      console.error(
        `[expoPush] ${kind}: user=${args.userId} type=${args.type} ` +
          `tokens=${tokens.length} accepted=${sent} rejected=${failed} codes=${JSON.stringify(codes)}`
      );
    }

    // Ask Expo later what FCM/APNs actually did with the accepted messages.
    // Scheduled rather than awaited: receipts are not ready for minutes, and
    // the ids travel in the scheduler's own arguments so this needs no table.
    if (accepted.length > 0) {
      await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.expoPush.checkPushReceipts, {
        userId: args.userId,
        type: args.type,
        receipts: accepted,
      });
    }

    if (failed > 0) return { success: false, error: "expo_tickets_rejected", sent, failed };
    return { success: true, sent, failed };
  },
});

/**
 * Prunes a token only when Expo says the device is gone.
 *
 * `DeviceNotRegistered` means the app was uninstalled or the token rotated —
 * the row is genuinely dead and re-sending to it wastes a message forever.
 *
 * Everything else is deliberately kept. `MismatchSenderId` and
 * `InvalidCredentials` in particular describe a fault in the SENDER's FCM
 * configuration, not the device: the token is perfectly good and will start
 * working the moment the server credentials are fixed. Pruning on those would
 * delete every live token in the deployment in response to one bad config,
 * turning a reversible outage into permanent data loss.
 */
async function pruneIfDeviceNotRegistered(
  ctx: { runMutation: ActionCtx["runMutation"] },
  errorCode: string | undefined,
  token: string | undefined
): Promise<boolean> {
  if (errorCode !== "DeviceNotRegistered" || !token) return false;
  await ctx.runMutation(internal.mobilePushTokens.removeByToken, { token });
  return true;
}

/**
 * Second half of a send: Expo reports real delivery outcomes in receipts, not
 * in the tickets returned by the send call.
 *
 * This is why dead tokens accumulated. The send path checked tickets for
 * `DeviceNotRegistered` and prod evidence shows tickets come back `ok` even for
 * devices FCM has since dropped — the error only ever appeared in the receipt,
 * which nothing fetched. Two stale rows for one user survived that way. The
 * ticket-level check is still worth keeping (Expo does report some rejections
 * there, e.g. a malformed token) but it was never the whole story.
 *
 * Returns failures rather than throwing, same rationale as sendMobilePush.
 */
export const checkPushReceipts = internalAction({
  args: {
    userId: v.id("users"),
    type: v.string(),
    receipts: v.array(v.object({ id: v.string(), token: v.string() })),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string; pruned?: number }> => {
    const byId = new Map(args.receipts.map((r) => [r.id, r.token]));
    const ids = [...byId.keys()];
    let pruned = 0;
    let missing = 0;
    const problems: ExpoReceipt[] = [];

    for (let offset = 0; offset < ids.length; offset += RECEIPT_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + RECEIPT_BATCH_SIZE);

      const context = `user=${args.userId} type=${args.type} ids=${batch.length}`;
      const result = await postToExpo<{ data?: Record<string, ExpoReceipt> }>(
        EXPO_RECEIPTS_ENDPOINT,
        { ids: batch },
        context
      );
      if (!result.ok) return { success: false, error: result.error };
      const data = result.data.data ?? {};

      for (const id of batch) {
        const receipt = data[id];
        // Expo omits ids whose receipt isn't ready yet. Not an error, but worth
        // counting: if this is consistently non-zero, RECEIPT_DELAY_MS is short.
        if (!receipt) {
          missing += 1;
          continue;
        }
        if (receipt.status === "ok") continue;
        problems.push(receipt);
        if (await pruneIfDeviceNotRegistered(ctx, receipt.details?.error, byId.get(id))) pruned += 1;
      }
    }

    if (problems.length > 0) {
      console.error(
        `[expoPush] undelivered on receipt: user=${args.userId} type=${args.type} ` +
          `checked=${ids.length} undelivered=${problems.length} pruned=${pruned} ` +
          `codes=${JSON.stringify(tallyErrorCodes(problems))}`
      );
    }
    if (missing > 0) {
      console.warn(
        `[expoPush] ${missing}/${ids.length} receipts not ready yet: user=${args.userId} type=${args.type}`
      );
    }

    return { success: problems.length === 0, pruned };
  },
});
