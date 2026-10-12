import { describe, expect, it } from "vitest";
import {
  isConvexSyncSocketUrl,
  parseConvexMutationRequest,
  parseConvexMutationResponse,
} from "./browserSwarmConvexFrames";

const createFrame = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "Mutation",
    requestId: 7,
    udfPath: "expenses:create",
    args: [{ idempotencyKey: "create-expense:abc", orgId: "org1", title: "t", amount: 41 }],
    ...overrides,
  });

describe("SCRUM-826 Convex sync frame parsing", () => {
  it("recognises only the Convex sync websocket", () => {
    expect(isConvexSyncSocketUrl("wss://x.convex.cloud/api/1.42.1/sync")).toBe(true);
    expect(isConvexSyncSocketUrl("ws://127.0.0.1:3210/api/1.0/sync")).toBe(true);
    expect(isConvexSyncSocketUrl("wss://x.convex.cloud/api/1.42.1/other")).toBe(false);
    expect(isConvexSyncSocketUrl("not a url")).toBe(false);
  });

  it("extracts the request id, arguments and command identity of a matching mutation", () => {
    expect(parseConvexMutationRequest(createFrame(), /^expenses(\.js)?:create$/)).toEqual({
      requestId: 7,
      args: { idempotencyKey: "create-expense:abc", orgId: "org1", title: "t", amount: 41 },
      idempotencyKey: "create-expense:abc",
    });
    expect(
      parseConvexMutationRequest(
        createFrame({ udfPath: "expenses.js:create" }),
        /^expenses(\.js)?:create$/,
      )?.requestId,
    ).toBe(7);
  });

  it("ignores other functions, other message types and non-JSON frames", () => {
    const pattern = /^expenses(\.js)?:create$/;
    expect(parseConvexMutationRequest(createFrame({ udfPath: "expenses:update" }), pattern)).toBeNull();
    expect(parseConvexMutationRequest(createFrame({ type: "Action" }), pattern)).toBeNull();
    expect(parseConvexMutationRequest("{not json", pattern)).toBeNull();
    expect(parseConvexMutationRequest(Buffer.from(createFrame()), pattern)?.requestId).toBe(7);
  });

  it("keeps a missing identity visible instead of dropping the frame", () => {
    const frame = createFrame({ args: [{ orgId: "org1", title: "t", amount: 41 }] });
    expect(parseConvexMutationRequest(frame, /^expenses:create$/)).toMatchObject({
      requestId: 7,
      idempotencyKey: undefined,
    });
  });

  it("parses mutation responses by request id and success", () => {
    expect(
      parseConvexMutationResponse(
        JSON.stringify({ type: "MutationResponse", requestId: 7, success: true, result: "id1" }),
      ),
    ).toEqual({ requestId: 7, success: true });
    expect(
      parseConvexMutationResponse(
        JSON.stringify({
          type: "MutationResponse",
          requestId: 8,
          success: false,
          result: "Server Error",
          errorData: "Posted expenses are locked.",
        }),
      ),
    ).toEqual({
      requestId: 8,
      success: false,
      errorText: "Server Error | Posted expenses are locked.",
    });
    expect(parseConvexMutationResponse(JSON.stringify({ type: "Transition" }))).toBeNull();
    expect(parseConvexMutationResponse("garbage")).toBeNull();
  });
});
