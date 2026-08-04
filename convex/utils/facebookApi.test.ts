import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchFacebookUserProfileName } from "./facebookApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchFacebookUserProfileName", () => {
  test("production regression: resolves a real DM name from conversation participants", async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => jsonResponse({
      data: [{
        id: "conversation_id",
        participants: {
          data: [
            { id: "page_id", name: "Bloom Cars" },
            { id: "page_scoped_id", name: "  Noor   Al Masri  " },
          ],
        },
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFacebookUserProfileName("page_scoped_id", "page_id", "page_token"))
      .resolves.toEqual({ ok: true, name: "Noor Al Masri" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const requestedUrl = new URL(String(input));
    expect(requestedUrl.pathname).toContain("/page_id/conversations");
    expect(requestedUrl.searchParams.get("platform")).toBe("messenger");
    expect(requestedUrl.searchParams.get("user_id")).toBe("page_scoped_id");
    expect(requestedUrl.searchParams.get("fields")).toBe("id,participants");
    expect(requestedUrl.searchParams.has("access_token")).toBe(false);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer page_token");
  });

  test("falls back to the direct PSID profile when no conversation is available", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ first_name: "Noor", last_name: "Al Masri" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFacebookUserProfileName("page_scoped_id", "page_id", "page_token"))
      .resolves.toEqual({ ok: true, name: "Noor Al Masri" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain("/page_scoped_id");
  });

  test("returns a controlled error when Meta does not provide a usable name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: { message: "Permission denied" } }, 403)
    ));

    await expect(fetchFacebookUserProfileName("page_scoped_id", "page_id", "page_token"))
      .resolves.toEqual({ ok: false, error: "Permission denied" });
  });
});
