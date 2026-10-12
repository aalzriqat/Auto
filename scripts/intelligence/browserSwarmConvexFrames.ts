/**
 * SCRUM-826 — read-only parsing of Convex sync-protocol frames, so the
 * economic attacks can observe exactly what the real web client transmitted
 * (request id, arguments, command identity) and which response belongs to
 * which request. Nothing here forges or rewrites a frame.
 */

export interface ConvexMutationRequestFrame {
  requestId: number;
  args: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

export interface ConvexMutationResponseFrame {
  requestId: number;
  success: boolean;
  /** The server's error text and ConvexError data, only on failure. */
  errorText?: string;
}

function asText(data: string | Buffer): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

function parseObject(data: string | Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(asText(data));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The Convex client's sync socket is `<origin>/api/<version>/sync`. */
export function isConvexSyncSocketUrl(url: string | URL): boolean {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      /^\/api\/[^/]+\/sync$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function parseConvexMutationRequest(
  data: string | Buffer,
  udfPathPattern: RegExp,
): ConvexMutationRequestFrame | null {
  const frame = parseObject(data);
  if (!frame || frame.type !== "Mutation") return null;
  if (typeof frame.udfPath !== "string" || !udfPathPattern.test(frame.udfPath)) return null;
  if (typeof frame.requestId !== "number" || !Array.isArray(frame.args)) return null;
  const [args] = frame.args as unknown[];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  return {
    requestId: frame.requestId,
    args: record,
    idempotencyKey:
      typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined,
  };
}

export function parseConvexMutationResponse(
  data: string | Buffer,
): ConvexMutationResponseFrame | null {
  const frame = parseObject(data);
  if (!frame || frame.type !== "MutationResponse") return null;
  if (typeof frame.requestId !== "number" || typeof frame.success !== "boolean") return null;
  if (frame.success) return { requestId: frame.requestId, success: true };
  const parts = [frame.result, frame.errorData]
    .map((part) =>
      typeof part === "string" ? part : part === undefined ? "" : JSON.stringify(part),
    )
    .filter((part) => part.length > 0);
  return { requestId: frame.requestId, success: false, errorText: parts.join(" | ") };
}
