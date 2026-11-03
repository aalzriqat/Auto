import { describe, expect, it } from "vitest";
import { cspSuffix, LOCAL_CONVEX_URL, localConvexCspSources } from "./localConvexCsp";

describe("localConvexCspSources (SCRUM-892)", () => {
  it("allows the local CI backend's HTTP and websocket origins when the build targets it", () => {
    expect(localConvexCspSources(LOCAL_CONVEX_URL)).toEqual({
      connect: ["http://127.0.0.1:3210", "ws://127.0.0.1:3210"],
      img: ["http://127.0.0.1:3210"],
    });
  });

  it.each([
    "https://clever-mockingbird-719.convex.cloud",
    "https://some-preview-123.convex.cloud",
    "http://127.0.0.1:3210/",
    "http://localhost:3210",
    "http://127.0.0.1:3211",
    "https://127.0.0.1:3210",
    "",
    undefined,
  ])("adds nothing for %s, so the production policy is unchanged", (url) => {
    expect(localConvexCspSources(url)).toEqual({ connect: [], img: [] });
  });

  it("renders an empty suffix for no sources and a space-led list otherwise", () => {
    expect(cspSuffix([])).toBe("");
    expect(cspSuffix(["a", "b"])).toBe(" a b");
  });
});
