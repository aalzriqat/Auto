/**
 * Turns anything thrown by a Convex call into a string that is safe to hand to
 * `toast.error()`.
 *
 * Why this exists: 109 call sites did `toast.error(error)`, passing a raw
 * `Error`/`ConvexError` object into sonner v2, whose `toast.error()` expects a
 * `ReactNode`. A non-node argument renders nothing, so a failed mutation showed
 * the user *no* toast at all — the documented reason a swallowed
 * profit-approval failure stayed invisible for weeks.
 *
 * What the client actually receives: `convex/browser` never rethrows the
 * server's error verbatim. `createHybridErrorStacktrace` wraps it, so
 * `error.message` looks like
 *
 *     [CONVEX M(sales:create)] [Request ID: abc123] Server Error
 *     Uncaught Error: Vehicle already sold
 *         at handler (../convex/sales.ts:120:5)
 *       Called by client
 *
 * Only `Vehicle already sold` is meant for a human. The rest is transport noise
 * and — per the house rule of logging raw server-side and showing clean generic
 * text in the UI — the request id, the stack frames and the source paths must
 * never reach the screen.
 *
 * When the server threw a `ConvexError`, the client also copies the original
 * payload onto `error.data` (see `forwardData`), which is already clean. That
 * is the preferred source and is why `ConvexError` is checked first: it extends
 * `Error`, so an `instanceof Error` branch placed above would swallow it and
 * throw the good payload away.
 */

export const GENERIC_ERROR_MESSAGE = "An unexpected error occurred. Please try again later.";

/**
 * Convex stamps this on every `ConvexError`. Preferred over `instanceof`
 * because more than one copy of the `convex` package can be resolved at once
 * (pnpm keeps one per peer set), and `instanceof` fails across those copies.
 */
const CONVEX_ERROR_MARKER = Symbol.for("ConvexError");

/** The developer-thrown message sitting inside Convex's transport wrapper. */
const CONVEX_INNER_MESSAGE = /Uncaught\s+(?:ConvexError|Error)\s*:\s*([\s\S]*)$/;

/**
 * Lines Convex appends after the real message: V8 stack frames, plus the
 * `Called by client` marker added on the browser side.
 */
const NOISE_LINE = /^\s*(?:at\s|Called by client\s*$)/;

/**
 * A last-ditch tripwire. If a candidate still carries a source location, a
 * request id or the transport prefix, we failed to strip it cleanly — show the
 * generic message rather than leak internals.
 */
const LEAKS_INTERNALS = /\.[jt]sx?:\d+|\/convex\/|Request ID|\[CONVEX/i;

/** Returns a trimmed, non-empty, leak-free string, or null if there isn't one. */
function usableMessage(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (LEAKS_INTERNALS.test(trimmed)) return null;
  return trimmed;
}

function isConvexError(error: unknown): error is { data: unknown } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[CONVEX_ERROR_MARKER] === true || candidate.name === "ConvexError";
}

function hasStringMessage(error: unknown): error is { message: string } {
  if (typeof error !== "object" || error === null) return false;
  return typeof (error as { message?: unknown }).message === "string";
}

/** `ConvexError.data` is whatever the server threw: a string or a structured payload. */
function fromConvexData(data: unknown): string | null {
  if (typeof data === "string") return usableMessage(data);
  if (typeof data === "object" && data !== null) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") return usableMessage(message);
  }
  return null;
}

/** Peels Convex's transport wrapper off an `Error.message`. */
function fromWrappedMessage(message: string): string | null {
  const match = CONVEX_INNER_MESSAGE.exec(message);

  if (match === null) {
    // Carries the transport prefix but has no recognisable inner message —
    // e.g. an ArgumentValidationError, whose text names schema fields. There is
    // nothing safe to show, so fall back to the generic string.
    if (message.includes("[CONVEX")) return null;
    // Not a Convex error at all: an ordinary client-side Error. Its message is
    // the application's own and is shown as-is.
    return usableMessage(message);
  }

  const kept: string[] = [];
  for (const line of match[1].split("\n")) {
    if (NOISE_LINE.test(line)) break;
    kept.push(line);
  }
  return usableMessage(kept.join("\n"));
}

/**
 * Always returns a non-empty, user-facing string. Never throws.
 */
export function getErrorMessage(error: unknown): string {
  try {
    // Checked before Error: ConvexError extends Error, and its `.data` is the
    // clean payload the server actually meant to send.
    if (isConvexError(error)) {
      const fromData = fromConvexData(error.data);
      if (fromData !== null) return fromData;
      // Unusable `.data` (undefined, a number, an object with no message) can
      // still have a readable message inside the wrapper — fall through.
    }

    if (error instanceof Error || hasStringMessage(error)) {
      return fromWrappedMessage((error as { message: string }).message) ?? GENERIC_ERROR_MESSAGE;
    }

    if (typeof error === "string") {
      return usableMessage(error) ?? GENERIC_ERROR_MESSAGE;
    }

    return GENERIC_ERROR_MESSAGE;
  } catch {
    // A getter or Proxy on the thrown value must not turn error reporting into
    // a second error.
    return GENERIC_ERROR_MESSAGE;
  }
}
