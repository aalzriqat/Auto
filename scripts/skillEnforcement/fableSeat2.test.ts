/**
 * SCRUM-1042: a Claude Fable 5.2 review is accepted as Seat 2, in place of Codex, until 2026-12-25T00:00:00Z.
 * Owner ruling 2026-11-28 ("Fable 5.2 as a second reviewer"): Codex is out of quota until 2026-12-24 and Gemini until
 * about 2026-12-03. Seat 1 stays a local Opus 5.5 review; Seat 2 is a separate local session with its own signed report.
 */
import { describe, expect, test } from "vitest";
import { check } from "./checkPrSkillEvidence.mjs";
import { localReviewUrls } from "./prSkillEvidence.mjs";
import { refresh } from "./refreshPrSkillEvidence.mjs";
import { fill } from "./skillEvidenceFixtures";

describe("SCRUM-1042 Fable 5.2 as Seat 2", () => {
  const sha = "a".repeat(40);
  const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "fixture" };
  const opus = "34ac5a8c-b7c5-4c86-b828-a441cf9d671a";
  const implementer = "ec2081f1-524c-4529-bd10-f70bf3c03694";
  const fable = "7d1c0a52-3f0e-4b8e-9a57-0c6a1e2b9f44";
  const slack = "https://autoflow-ncu1880.slack.com/archives/C0CEKAY4GL8/p1794613916827239";
  const reviewUrl = (id: number) => `https://github.com/o/r/pull/7#issuecomment-${id}`;
  const before = () => new Date("2026-12-24T23:59:59Z");
  const files = ["convex/sales.ts", "convex/sales.test.ts"].map((filename) => ({
    filename, status: "modified", sha, additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" }));

  const bodyOf = (over: Record<string, string> = {}, extra = "") => fill({
    "Seat 1 session": `local:${opus}`, "Seat 1 SHA": sha, "Seat 2 model": "claude-fable-5-2",
    "Seat 2 effort": "high", "Seat 2 SHA": sha, ...over,
  }) + `- Implementer session: ${implementer}\n- Seat 1 review: ${reviewUrl(123)}\n` +
    `- Seat 2 session: local:${fable}\n- Seat 2 review: ${reviewUrl(124)}\n${extra}`;

  const opusReport = `Local Claude session: ${opus}\nLocal Claude model: claude-opus-5-5\nLocal Claude effort: high\nLocal Claude SHA: ${sha}\nLocal Claude verdict: CERTIFY\nSigned: Claude Seat 1`;
  const fableLines: Record<string, string> = {
    session: `Local Claude session: ${fable}`, model: "Local Claude model: claude-fable-5-2", effort: "Local Claude effort: high",
    sha: `Local Claude SHA: ${sha}`, verdict: "Local Claude verdict: CERTIFY", signed: "Signed: Fable reviewer",
  };
  type Options = { body?: string; fableReport?: Partial<Record<string, string | null>>; fableBody?: string;
    association?: string; edited?: boolean; issueUrl?: string; seat1Body?: string; commitMessage?: string };

  function fetchFor(options: Options = {}) {
    const lines = { ...fableLines, ...options.fableReport };
    const fableBody = options.fableBody ?? Object.values(lines).filter((l) => l !== null).join("\n");
    const comment = (id: number, body: string, association: string, edited = false) => ({
      html_url: reviewUrl(id), issue_url: options.issueUrl ?? "https://api.github.com/repos/o/r/issues/7",
      author_association: association, created_at: "2026-12-01T00:00:00Z",
      updated_at: edited ? "2026-12-01T00:05:00Z" : "2026-12-01T00:00:00Z", body });
    const commits = [{ sha, commit: { message: options.commitMessage ?? "Implement the change" } }];
    const pr = { state: "open", body: options.body ?? bodyOf(), head: { sha }, base: { ref: "main", sha: "b".repeat(40) },
      commits: 1, changed_files: files.length };
    return (async (input: string) => {
      const path = new URL(String(input)).pathname;
      const json = path.endsWith("/comments/123") ? comment(123, options.seat1Body ?? opusReport, "OWNER")
        : path.endsWith("/comments/124") ? comment(124, fableBody, options.association ?? "COLLABORATOR", options.edited)
        : path.endsWith("/files") ? files : path.endsWith("/commits") ? commits : pr;
      return { ok: true, status: 200, json: async () => json } as Response;
    }) as typeof fetch;
  }
  const run = (options: Options = {}, now: () => Date = before) => check(env, fetchFor(options), new Map(), now);

  test("accepts claude-fable-5-2 as Seat 2 with a local Opus Seat 1 on a money PR before the expiry", async () => {
    const result = await run();
    expect(result.lines.join("\n")).toContain("section present and consistent");
    expect(result.exitCode).toBe(0);
  });

  test.each(["2026-12-25T00:00:00Z", "2026-12-25T00:00:01Z", "2027-03-01T00:00:00Z"])("refuses after the expiry (%s)", async (when) => {
    const text = (await run({}, () => new Date(when))).lines.join("\n");
    expect(text).toContain("SCRUM-1042");
    expect(text).toContain("expired");
    expect(text).toContain("FAILED");
  });

  test("an unreadable clock counts as expired", async () => {
    expect((await run({}, () => new Date("not a date"))).exitCode).toBe(1);
  });

  test("the Codex route still passes after the expiry", async () => {
    const codex = bodyOf({ "Seat 2 model": "gpt-6-luna", "Seat 2 effort": "high" });
    expect((await run({ body: codex }, () => new Date("2027-01-01T00:00:00Z"))).exitCode).toBe(0);
  });

  test("the Gemini Seat 2 route still passes", async () => {
    const claude = `Local Claude session: ${opus}\nLocal Claude model: claude-opus-5-5\nLocal Claude effort: high\nLocal Claude SHA: ${sha}\nLocal Claude verdict: CERTIFY\nSigned: Claude Seat 1`;
    const gemini = `Gemini review source: ${slack}\nGemini model: Gemini 4 Hydrogen\nGemini SHA: ${sha}\nGemini verdict: CERTIFY\nSigned: Gemini reviewer`;
    const body = bodyOf({ "Seat 2 model": "Gemini 4 Hydrogen", "Seat 2 effort": "not applicable" }).replace(`local:${fable}`, slack);
    const result = await run({ body, seat1Body: claude, fableBody: gemini });
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ["a claude.ai session link as Seat 1", { "Seat 1 session": "https://claude.ai/code/session_SEAT1abc" }],
    ["a Gemini Seat 1 (registered route)", { "Seat 1 model": "Gemini 3.8 Flash", "Seat 1 session": slack }],
    ["a Seat 1 that is not Opus 5.5", { "Seat 1 model": "claude-fable-5-2" }],
  ])("refuses Fable as Seat 2 with %s", async (_name, over) => {
    expect((await run({ body: bodyOf(over) })).exitCode).toBe(1);
  });

  test.each([
    ["Seat 2 session equals the Seat 1 session", { body: bodyOf().replace(`Seat 2 session: local:${fable}`, `Seat 2 session: local:${opus}`) }],
    ["Seat 2 session equals the implementer session", { body: bodyOf().replace(`Seat 2 session: local:${fable}`, `Seat 2 session: local:${implementer}`),
      fableReport: { session: `Local Claude session: ${implementer}` } }],
    ["Seat 2 session appears in a PR commit message", { commitMessage: `Implement with session ${fable}` }],
    ["Seat 2 session appears elsewhere in the body", { body: bodyOf({}, `- note: reviewed in ${fable}\n`) }],
    ["Seat 2 session is a claude.ai link", { body: bodyOf().replace(`local:${fable}`, "https://claude.ai/code/session_FABLE123") }],
    ["Seat 2 session is a bare UUID", { body: bodyOf().replace(`local:${fable}`, fable) }],
    ["Seat 2 session is missing", { body: bodyOf().replace(`- Seat 2 session: local:${fable}\n`, "") }],
  ] satisfies [string, Options][])("refuses when %s", async (_name, options) => {
    expect((await run(options)).exitCode).toBe(1);
  });

  test.each([
    ["medium", "medium"], ["low", "low"], ["xhigh", "xhigh"], ["max", "max"], ["high-ish", "high-ish"],
  ])("refuses Seat 2 effort %s", async (_name, effort) => {
    expect((await run({ body: bodyOf({ "Seat 2 effort": effort }) })).exitCode).toBe(1);
  });

  test.each([
    ["stale body SHA", { body: bodyOf({ "Seat 2 SHA": "b".repeat(40) }) }],
    ["abbreviated body SHA", { body: bodyOf({ "Seat 2 SHA": sha.slice(0, 7) }) }],
    ["stale report SHA", { fableReport: { sha: `Local Claude SHA: ${"b".repeat(40)}` } }],
  ] satisfies [string, Options][])("refuses %s", async (_name, options) => {
    expect((await run(options)).exitCode).toBe(1);
  });

  test.each([
    ["same report for both seats", { body: bodyOf().replace(reviewUrl(124), reviewUrl(123)) }],
    ["missing Seat 2 review link", { body: bodyOf().replace(`- Seat 2 review: ${reviewUrl(124)}\n`, "") }],
    ["comment of another PR", { issueUrl: "https://api.github.com/repos/o/r/issues/8" }],
    ["edited report comment", { edited: true }],
    ["non-collaborator author", { association: "NONE" }],
    ["contributor author", { association: "CONTRIBUTOR" }],
    ["report names Opus 5.5", { fableReport: { model: "Local Claude model: claude-opus-5-5" } }],
    ["report names another Fable version", { fableReport: { model: "Local Claude model: claude-fable-5-3" } }],
    ["report effort other than high", { fableReport: { effort: "Local Claude effort: medium" } }],
    ["report from another session", { fableReport: { session: `Local Claude session: ${opus}` } }],
    ["verdict other than CERTIFY", { fableReport: { verdict: "Local Claude verdict: CHANGES_REQUESTED" } }],
    ["missing session line", { fableReport: { session: null } }],
    ["missing model line", { fableReport: { model: null } }],
    ["missing effort line", { fableReport: { effort: null } }],
    ["missing SHA line", { fableReport: { sha: null } }],
    ["missing verdict line", { fableReport: { verdict: null } }],
    ["missing Signed line", { fableReport: { signed: null } }],
    ["short Signed line", { fableReport: { signed: "Signed: f" } }],
    ["hidden field in an HTML comment", { fableBody: `<!-- hidden -->\n${Object.values(fableLines).join("\n")}` }],
    ["Seat 1 report that names Fable", { seat1Body: opusReport.replace("claude-opus-5-5", "claude-fable-5-2") }],
    ["Seat 1 report from another session", { seat1Body: opusReport.replace(opus, implementer) }],
  ] satisfies [string, Options][])("refuses %s", async (_name, options) => {
    expect((await run(options)).exitCode).toBe(1);
  });

  test.each([
    ["Fable 5.2"], ["fable 5.2"], ["claude-fable-5-2 (high)"], ["claude-fable-5-3"], ["Claude-Fable-5-2"], ["claude-fable-5-2x"], ["claude-fable-5"],
  ])("refuses the model string %s", async (model) => {
    expect((await run({ body: bodyOf({ "Seat 2 model": model }) })).exitCode).toBe(1);
  });

  test.each([
    ["a duplicate Seat 2 review field", bodyOf({}, `- Seat 2 review: ${reviewUrl(124)}\n`)],
    ["a duplicate Seat 2 session field", bodyOf({}, `- Seat 2 session: local:${fable}\n`)],
    ["a duplicate Seat 2 effort field", bodyOf({}, "- Seat 2 effort: high\n")],
    ["an HTML comment in the section", bodyOf({}, "<!-- Seat 2 effort: medium -->\n")],
  ])("refuses %s", async (_name, body) => {
    expect((await run({ body })).exitCode).toBe(1);
  });

  test("a refusal prints the lines the Fable Seat 2 route needs", async () => {
    const text = (await run({ association: "NONE" })).lines.join("\n");
    for (const needle of ["Seat 2 model: claude-fable-5-2", "Seat 2 session: local:", "Seat 2 effort: high", "Seat 2 review:", "Seat 2 SHA:",
      "Local Claude session:", "Local Claude model: claude-fable-5-2", "Local Claude effort: high", "Local Claude SHA:",
      "Local Claude verdict: CERTIFY", "Signed:", "2026-12-25", "SCRUM-1042"]) expect(text).toContain(needle);
  });

  test("the generic Seat 2 model refusal lists Fable", async () => {
    const text = (await run({ body: bodyOf({ "Seat 2 model": "gpt-5" }) })).lines.join("\n");
    expect(text).toContain("claude-fable-5-2");
  });

  test("refresh follows the Fable Seat 2 comment as well as the Seat 1 report", () => {
    expect(localReviewUrls(bodyOf())).toEqual([reviewUrl(123), reviewUrl(124)]);
    expect(localReviewUrls(bodyOf({ "Seat 2 model": "gpt-6-luna" }))).toEqual([reviewUrl(123)]);
  });

  test("an edited Fable Seat 2 comment fails the refreshed check", async () => {
    const read = fetchFor({ edited: true });
    const fetchImpl = (async (url: string, init?: RequestInit) => init?.method
      ? ({ ok: true, json: async () => ({ id: 42 }) } as Response) : read(url)) as typeof fetch;
    expect(await refresh({ ...env, COMMENT_ID: "124" }, fetchImpl, new Map(), before)).toEqual({ refreshed: true, head: sha, conclusion: "failure" });
  });
});
