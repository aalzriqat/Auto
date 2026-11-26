/**
 * SCRUM-1002: Gemini is accepted as Seat 2, in place of Codex, until 2026-12-25T00:00:00Z.
 * Owner ruling 2026-11-26 ("Accept Gemini instead"): Codex free plan is out of quota until 2026-12-24.
 * Seat 1 stays an independent Claude session with its own signed report.
 */
import { describe, expect, test } from "vitest";
import { check } from "./checkPrSkillEvidence.mjs";
import { localReviewUrls } from "./prSkillEvidence.mjs";
import { refresh } from "./refreshPrSkillEvidence.mjs";
import { fill } from "./skillEvidenceFixtures";

describe("SCRUM-1002 Gemini as Seat 2", () => {
  const sha = "a".repeat(40);
  const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "fixture" };
  const claude = "34ac5a8c-b7c5-4c86-b828-a441cf9d671a";
  const implementer = "ec2081f1-524c-4529-bd10-f70bf3c03694";
  const slack = "https://autoflow-ncu1880.slack.com/archives/C0CEKAY4GL8/p1794613916827239";
  const reviewUrl = (id: number) => `https://github.com/o/r/pull/7#issuecomment-${id}`;
  const before = () => new Date("2026-12-24T23:59:59Z");
  const files = ["convex/sales.ts", "convex/sales.test.ts"].map((filename) => ({
    filename, status: "modified", sha, additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" }));

  const bodyOf = (over: Record<string, string> = {}, extra = "") => fill({
    "Seat 1 session": `local:${claude}`, "Seat 1 SHA": sha, "Seat 2 model": "Gemini 4 Hydrogen",
    "Seat 2 effort": "not applicable", "Seat 2 SHA": sha, ...over,
  }) + `- Implementer session: ${implementer}\n- Seat 1 review: ${reviewUrl(123)}\n` +
    `- Seat 2 session: ${slack}\n- Seat 2 review: ${reviewUrl(124)}\n${extra}`;

  const claudeReport = `Local Claude session: ${claude}\nLocal Claude model: claude-opus-5-5\nLocal Claude effort: high\nLocal Claude SHA: ${sha}\nLocal Claude verdict: CERTIFY\nSigned: Claude Seat 1`;
  const geminiLines: Record<string, string> = {
    source: `Gemini review source: ${slack}`, model: "Gemini model: Gemini 4 Hydrogen", sha: `Gemini SHA: ${sha}`,
    verdict: "Gemini verdict: CERTIFY", signed: "Signed: Gemini reviewer",
  };
  type Options = { body?: string; gemini?: Partial<Record<string, string | null>>; geminiBody?: string;
    association?: string; edited?: boolean; issueUrl?: string; seat1Body?: string };

  function fetchFor(options: Options = {}) {
    const lines = { ...geminiLines, ...options.gemini };
    const geminiBody = options.geminiBody ?? Object.values(lines).filter((l) => l !== null).join("\n");
    const comment = (id: number, body: string, association: string, edited = false) => ({
      html_url: reviewUrl(id), issue_url: options.issueUrl ?? "https://api.github.com/repos/o/r/issues/7",
      author_association: association, created_at: "2026-12-01T00:00:00Z",
      updated_at: edited ? "2026-12-01T00:05:00Z" : "2026-12-01T00:00:00Z", body });
    const commits = [{ sha, commit: { message: "Implement the change" } }];
    const pr = { state: "open", body: options.body ?? bodyOf(), head: { sha }, base: { ref: "main", sha: "b".repeat(40) },
      commits: 1, changed_files: files.length };
    return (async (input: string) => {
      const path = new URL(String(input)).pathname;
      const json = path.endsWith("/comments/123") ? comment(123, options.seat1Body ?? claudeReport, "OWNER")
        : path.endsWith("/comments/124") ? comment(124, geminiBody, options.association ?? "COLLABORATOR", options.edited)
        : path.endsWith("/files") ? files : path.endsWith("/commits") ? commits : pr;
      return { ok: true, status: 200, json: async () => json } as Response;
    }) as typeof fetch;
  }
  const run = (options: Options = {}, now: () => Date = before) => check(env, fetchFor(options), new Map(), now);

  test("accepts Gemini 4 Hydrogen as Seat 2 with an independent Claude Seat 1 on a money PR before the expiry", async () => {
    const result = await run();
    expect(result.lines.join("\n")).toContain("section present and consistent");
    expect(result.exitCode).toBe(0);
  });

  test.each(["2026-12-25T00:00:00Z", "2026-12-25T00:00:01Z", "2027-03-01T00:00:00Z"])("refuses after the expiry (%s)", async (when) => {
    const result = await run({}, () => new Date(when));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("SCRUM-1002");
  });

  test("an unreadable clock counts as expired", async () => {
    expect((await run({}, () => new Date("not a date"))).exitCode).toBe(1);
  });

  test("the Codex route still passes after the expiry", async () => {
    const codex = bodyOf({ "Seat 2 model": "gpt-6-luna", "Seat 2 effort": "high" }, "");
    expect((await run({ body: codex }, () => new Date("2027-01-01T00:00:00Z"))).exitCode).toBe(0);
  });

  test.each([
    ["verdict other than CERTIFY", { gemini: { verdict: "Gemini verdict: CHANGES_REQUESTED" } }],
    ["stale report SHA", { gemini: { sha: `Gemini SHA: ${"b".repeat(40)}` } }],
    ["stale body SHA", { body: bodyOf({ "Seat 2 SHA": "b".repeat(40) }) }],
    ["abbreviated body SHA", { body: bodyOf({ "Seat 2 SHA": sha.slice(0, 7) }) }],
    ["edited report comment", { edited: true }],
    ["non-collaborator author", { association: "NONE" }],
    ["contributor author", { association: "CONTRIBUTOR" }],
    ["comment of another PR", { issueUrl: "https://api.github.com/repos/o/r/issues/8" }],
    ["permalink outside the workspace", { body: bodyOf({}, "").replace(slack, "https://example.com/archives/C0CEKAY4GL8/p1794613916827239") }],
    ["permalink in another channel", { body: bodyOf({}, "").replaceAll(slack, slack.replace("C0CEKAY4GL8", "C0OTHER0000")),
      gemini: { source: `Gemini review source: ${slack.replace("C0CEKAY4GL8", "C0OTHER0000")}` } }],
    ["report source differs from the body permalink", { gemini: { source: "Gemini review source: https://autoflow-ncu1880.slack.com/archives/C0CEKAY4GL8/p1794613916827240" } }],
    ["missing source line", { gemini: { source: null } }],
    ["missing model line", { gemini: { model: null } }],
    ["missing SHA line", { gemini: { sha: null } }],
    ["missing verdict line", { gemini: { verdict: null } }],
    ["missing Signed line", { gemini: { signed: null } }],
    ["short Signed line", { gemini: { signed: "Signed: g" } }],
    ["report model differs from the body model", { gemini: { model: "Gemini model: Gemini 3.8 Flash" } }],
    ["hidden field in an HTML comment", { geminiBody: `<!-- hidden -->\n${Object.values(geminiLines).join("\n")}` }],
    ["unlisted Gemini model", { body: bodyOf({ "Seat 2 model": "Gemini 3.8 Flash" }), gemini: { model: "Gemini model: Gemini 3.8 Flash" } }],
    ["look-alike Gemini model", { body: bodyOf({ "Seat 2 model": "Gemini 4 Hydrogen Pro" }), gemini: { model: "Gemini model: Gemini 4 Hydrogen Pro" } }],
    ["lower-case Gemini model", { body: bodyOf({ "Seat 2 model": "gemini 4 hydrogen" }), gemini: { model: "Gemini model: gemini 4 hydrogen" } }],
    ["same report for both seats", { body: bodyOf({}, "").replace(reviewUrl(124), reviewUrl(123)) }],
    ["missing Seat 2 review link", { body: bodyOf().replace(`- Seat 2 review: ${reviewUrl(124)}\n`, "") }],
    ["missing Seat 2 session permalink", { body: bodyOf().replace(`- Seat 2 session: ${slack}\n`, "") }],
    ["duplicate Seat 2 review field", { body: bodyOf({}, `- Seat 2 review: ${reviewUrl(124)}\n`) }],
    ["Seat 1 report from another session", { seat1Body: claudeReport.replace(claude, implementer) }],
    ["Seat 1 is the implementer", { body: bodyOf({ "Seat 1 session": `local:${implementer}` }) }],
    ["Seat 1 report on a different model", { seat1Body: claudeReport.replace("claude-opus-5-5", "gemini") }],
  ] satisfies [string, Options][])("refuses %s", async (_name, options) => {
    expect((await run(options)).exitCode).toBe(1);
  });

  test.each([
    ["Gemini 4 Hydrogen as Seat 1 as well", { "Seat 1 model": "Gemini 4 Hydrogen" }],
    ["Gemini 3.8 Flash Seat 1 with Gemini Seat 2", { "Seat 1 model": "Gemini 3.8 Flash", "Seat 1 session": slack }],
    ["Seat 1 without a signed local report", { "Seat 1 session": "https://claude.ai/code/session_SEAT1abc" }],
  ])("refuses Gemini on both seats: %s", async (_name, over) => {
    expect((await run({ body: bodyOf(over) })).exitCode).toBe(1);
  });

  test("a refusal prints the lines the Gemini Seat 2 route needs", async () => {
    const text = (await run({ association: "NONE" })).lines.join("\n");
    for (const needle of ["Seat 2 model: Gemini 4 Hydrogen", "Seat 2 session:", "Seat 2 review:", "Gemini review source:",
      "Gemini model:", "Gemini SHA:", "Gemini verdict: CERTIFY", "2026-12-25"]) expect(text).toContain(needle);
  });

  test("refresh follows the Seat 2 Gemini comment as well as the Seat 1 report", () => {
    expect(localReviewUrls(bodyOf())).toEqual([reviewUrl(123), reviewUrl(124)]);
    expect(localReviewUrls(bodyOf({ "Seat 2 model": "gpt-6-luna", "Seat 2 effort": "high" }))).toEqual([reviewUrl(123)]);
  });

  test("an edited Gemini Seat 2 comment fails the refreshed check", async () => {
    const read = fetchFor({ edited: true });
    const fetchImpl = (async (url: string, init?: RequestInit) => init?.method
      ? ({ ok: true, json: async () => ({ id: 42 }) } as Response) : read(url)) as typeof fetch;
    expect(await refresh({ ...env, COMMENT_ID: "124" }, fetchImpl, new Map(), before)).toEqual({ refreshed: true, head: sha, conclusion: "failure" });
  });
});
