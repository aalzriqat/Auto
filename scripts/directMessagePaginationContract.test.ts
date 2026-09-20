import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const WEB_LIST = path.join(REPO_ROOT, "components", "messages", "ConversationList.tsx");
const MOBILE_LIST = path.join(
  REPO_ROOT,
  "apps",
  "mobile",
  "src",
  "features",
  "workspace",
  "modules",
  "messages.tsx",
);
const MOBILE_API = path.join(REPO_ROOT, "apps", "mobile", "src", "convexApi.ts");

function source(file: string) {
  return fs.readFileSync(file, "utf8");
}

const legacyListCall = /api\.directMessages\.listConversations\b/;

describe("direct-message conversation pagination contract", () => {
  test.each([
    ["web full conversation list", WEB_LIST],
    ["mobile full conversation list", MOBILE_LIST],
  ])("%s cannot silently stop at the compatibility recent-list window", (_label, file) => {
    const code = source(file);

    expect(code).toContain("api.directMessages.listConversationsPage");
    expect(code).toContain("usePaginatedQuery");
    expect(code).not.toMatch(legacyListCall);
  });

  test("web full list exposes a reachable next-page action", () => {
    const code = source(WEB_LIST);

    expect(code).toContain('conversationStatus === "CanLoadMore"');
    expect(code).toMatch(/loadMoreConversations\(\d+\)/);
  });

  test("mobile full list exposes a reachable next-page action", () => {
    const code = source(MOBILE_LIST);

    expect(code).toContain("canLoadMore(conversationStatus)");
    expect(code).toMatch(/loadMoreConversations\(\d+\)/);
  });

  test("mobile facade binds the paginated backend query", () => {
    const code = source(MOBILE_API);

    expect(code).toContain('"directMessages:listConversationsPage"');
  });
});
