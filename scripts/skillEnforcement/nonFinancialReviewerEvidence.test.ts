/**
 * SCRUM-954 / SCRUM-994: the non-financial reviewer route (Gemini plus local Codex).
 * Split from skillEnforcement.test.ts to keep that file under the source-size limit.
 */
import { describe, expect, test, vi } from "vitest";
import { check, scopeDigest } from "./checkPrSkillEvidence.mjs";
import { refresh } from "./refreshPrSkillEvidence.mjs";
import { fill } from "./skillEvidenceFixtures";

describe("SCRUM-954 non-financial reviewer evidence", () => {
  const sha = "a".repeat(40);
  const gemini = "https://autoflow-ncu1880.slack.com/archives/C0CEKAY4GL8/p1794613916827239";
  const codex = "34ac5a8c-b7c5-4c86-b828-a441cf9d671a";
  const implementer = "ec2081f1-524c-4529-bd10-f70bf3c03694";
  const env = { REPO: "o/r", PR_NUMBER: "7", GH_TOKEN: "fixture" };
  const reviewUrl = (id: number) => `https://github.com/o/r/pull/7#issuecomment-${id}`;
  const body = fill({
    "Seat 1 session": gemini, "Seat 1 model": "Gemini 3.8 Flash", "Seat 1 SHA": sha,
    "Seat 2 model": "gpt-6.1-sol", "Seat 2 effort": "medium", "Seat 2 SHA": sha,
  }) + `- Implementer session: ${implementer}\n- Seat 1 review: ${reviewUrl(123)}\n` +
    `- Seat 2 session: local:${codex}\n- Seat 2 review: ${reviewUrl(124)}\n`;
  // The report must repeat the body's Seat 2 model and effort exactly, so a Luna case changes both.
  const lunaBody = (model: string, effort: string) =>
    body.replace("Seat 2 model: gpt-6.1-sol", `Seat 2 model: ${model}`).replace("Seat 2 effort: medium", `Seat 2 effort: ${effort}`);
  const file = (filename: string, previous_filename?: string) => ({
    filename, status: previous_filename ? "renamed" : "modified", previous_filename,
    sha, additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new",
  });
  const nonfinancial = file("scripts/intelligence/trustedBrowserJevSuggestions.mjs");
  const registeredDigest = scopeDigest([nonfinancial]);
  if (!registeredDigest) throw new Error("The registered scope fixture must have a complete patch.");
  const registry = new Map([[7, { digest: registeredDigest, implementer, Gemini: gemini, Codex: codex }]]);
  const baseSha = "b".repeat(40);
  const beforeTree = "c".repeat(40);
  const headTree = "d".repeat(40);

  function fixture(options: { paths?: ReturnType<typeof file>[]; count?: number; codexVerdict?: string;
    codexSha?: string; codexSession?: string; codexModel?: string; codexEffort?: string; geminiAssociation?: string; declaredBody?: string;
    commitCount?: number; editCodexAfterRead?: boolean; editedCodex?: boolean; missingCommitMessage?: boolean; requestedMode?: string; initiallyUnavailable?: boolean } = {}) {
    let codexReads = 0;
    let prReads = 0;
    const paths = options.paths ?? [nonfinancial];
    return (async (input: string) => {
      const url = new URL(String(input));
      const match = url.pathname.match(/\/issues\/comments\/(123|124)$/);
      const isGemini = match?.[1] === "123";
      const codexVerdict = match?.[1] === "124" && ++codexReads > 1 && options.editCodexAfterRead
        ? "BLOCK" : options.codexVerdict ?? "CERTIFY";
      const report = match ? {
        html_url: reviewUrl(Number(match[1])), issue_url: "https://api.github.com/repos/o/r/issues/7",
        author_association: isGemini ? options.geminiAssociation ?? "OWNER" : "COLLABORATOR",
        created_at: "2026-11-14T00:00:00Z",
        updated_at: !isGemini && options.editedCodex ? "2026-11-14T00:01:00Z" : "2026-11-14T00:00:00Z",
        body: isGemini
          ? `Gemini review source: ${gemini}\nGemini model: Gemini 3.8 Flash\nGemini SHA: ${sha}\nGemini verdict: CERTIFY\nSigned: Gemini reviewer`
          : `Local Codex session: ${options.codexSession ?? codex}\nLocal Codex model: ${options.codexModel ?? "gpt-6.1-sol"}\nLocal Codex effort: ${options.codexEffort ?? "medium"}\nLocal Codex SHA: ${options.codexSha ?? sha}\nLocal Codex verdict: ${codexVerdict}\nSigned: Codex reviewer`,
      } : null;
      const commits = [{ sha, commit: options.missingCommitMessage ? undefined : { message: "Implement provider recovery" } }];
      const pr = { state: "open", body: options.declaredBody ?? body, head: { sha }, base: { ref: "main", sha: baseSha },
        commits: options.commitCount ?? 1, changed_files: options.count ?? paths.length };
      const tree = (head: boolean) => ({
        sha: head ? headTree : beforeTree, truncated: false,
        tree: [{ path: nonfinancial.filename, mode: head ? options.requestedMode ?? "100644" : "100644",
          sha: head ? sha : baseSha, type: "blob" }],
      });
      if (url.pathname.endsWith("/pulls/7") && ++prReads === 1 && options.initiallyUnavailable) {
        return { ok: false, status: 503 } as Response;
      }
      const json = report ?? (url.pathname.endsWith("/files") ? paths : url.pathname.endsWith("/commits") ? commits : pr);
      const replies: Record<string, unknown> = {
        [`compare/${baseSha}...${sha}`]: { base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha }, status: "ahead", total_commits: 1, commits },
        [`git/commits/${baseSha}`]: { sha: baseSha, tree: { sha: beforeTree } },
        [`git/commits/${sha}`]: { sha, tree: { sha: headTree } },
        [`git/trees/${beforeTree}`]: tree(false),
        [`git/trees/${headTree}`]: tree(true),
      };
      const verification = replies[url.pathname.replace("/repos/o/r/", "")];
      return { ok: true, status: 200, json: async () => verification ?? json } as Response;
    }) as typeof fetch;
  }

  test.each(["high", "high (Codex)", "HIGH"])("accepts a Local Codex report on gpt-6-luna at effort %j (SCRUM-994)", async (effort) => {
    expect((await check(env, fixture({ codexModel: "gpt-6-luna", codexEffort: effort, declaredBody: lunaBody("gpt-6-luna", effort) }), registry)).exitCode).toBe(0);
  });

  test("accepts two separate exact-head Gemini and Codex reports on registered non-financial scope", async () => {
    expect((await check(env, fixture(), registry)).exitCode).toBe(0);
    expect((await check(env, fixture())).exitCode).toBe(1);
  });

  test.each([
    ["accounting figures", { paths: [nonfinancial, file("convex/accounting/rules.ts")] }],
    ["shared financial mutation wiring", { paths: [nonfinancial, file("convex/functions.ts")] }],
    ["renamed financial source", { paths: [file(nonfinancial.filename, "convex/sales.ts")] }],
    ["incomplete file list", { count: 2 }],
    ["missing sensitive path from API", { paths: [file("docs/readme.md")], count: 2 }],
    ["duplicate file list", { paths: [nonfinancial, nonfinancial] }],
    ["same filename with a different diff", { paths: [{ ...nonfinancial, patch: "@@ -1 +1 @@\n-old\n+different" }] }],
    ["same filename with a replaced blob", { paths: [{ ...nonfinancial, sha: "b".repeat(40) }] }],
    ["same filename with a truncated diff", { paths: [{ ...nonfinancial, patch: "@@ -1 +1 @@\n-old" }] }],
    ["previously edited report with valid fields", { editedCodex: true }],
    ["unknown gate scope", { paths: [file("scripts/intelligence/newProvider.mjs")] }],
    ["external Gemini source", { declaredBody: body.replace(gemini, "https://example.com/review") }],
    ["missing commit message", { missingCommitMessage: true }],
    ["different Git mode", { requestedMode: "100755" }],
    ["different declared implementer", { declaredBody: body.replace(implementer, "838778d3-49bf-4ad4-bd40-14dd12a21307") }],
    ["incomplete commit history", { commitCount: 2 }],
    ["Codex changes verdict during verification", { editCodexAfterRead: true }],
    ["duplicate evidence field", { declaredBody: body + `- Seat 2 SHA: ${"b".repeat(40)}\n` }],
    ["stale Codex SHA", { codexSha: "b".repeat(40) }],
    ["Local Codex gpt-6-luna at medium effort", { codexModel: "gpt-6-luna", codexEffort: "medium", declaredBody: lunaBody("gpt-6-luna", "medium") }],
    ["Local Codex look-alike model gpt-6-lunar", { codexModel: "gpt-6-lunar", declaredBody: lunaBody("gpt-6-lunar", "medium") }],
    ["noncertifying Codex", { codexVerdict: "CHANGES_REQUESTED" }],
    ["mismatched Codex identity", { codexSession: implementer }],
    ["untrusted Gemini report", { geminiAssociation: "NONE" }],
    ["reused reports", { declaredBody: body.replace(reviewUrl(124), reviewUrl(123)) }],
    ["same session as implementer", { declaredBody: body.replace(`local:${codex}`, `local:${implementer}`) }],
  ] satisfies [string, Parameters<typeof fixture>[0]][])("refuses %s", async (_name, options) => {
    expect((await check(env, fixture(options), registry)).exitCode).toBe(1);
  });

  test.each([
    ["gpt-6-luna at medium effort", "gpt-6-luna", "medium"],
    ["gpt-6-luna at low effort", "gpt-6-luna", "low"],
    ["gpt-6-luna at xhigh effort", "gpt-6-luna", "xhigh"],
    ["gpt-6.1-sol at high effort", "gpt-6.1-sol", "high"],
    ["gpt-6-sol at high effort", "gpt-6-sol", "high"],
    ["gpt-6-lunar at high effort", "gpt-6-lunar", "high"],
  ])("refuses a Local Codex report on %s for the model-and-effort rule", async (_name, model, effort) => {
    const result = await check(env, fixture({ codexModel: model, codexEffort: effort, declaredBody: lunaBody(model, effort) }), registry);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("gpt-6-sol or gpt-6.1-sol at low or medium effort, or gpt-6-luna at high effort");
  });

  test("does not retry a check creation when the API response may hide a successful write", async () => {
    const read = fixture();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? ({ ok: false, status: 502 } as Response)
      : read(url));
    await expect(refresh({ ...env, COMMENT_ID: "123" }, fetchImpl as typeof fetch, registry)).rejects.toThrow("502");
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  test("returns a rate limit without issuing an immediate retry", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) } as Response));
    await expect(refresh({ ...env, COMMENT_ID: "123" }, fetchImpl, registry)).rejects.toThrow("429");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([429, 403])("does not publish another request after a rate limit (%s) during revalidation", async (status) => {
    const read = fixture();
    let prReads = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return { ok: true, json: async () => ({ id: 42 }) } as Response;
      if (String(url).endsWith("/pulls/7") && ++prReads === 2) {
        const headers = new Headers(status === 429 ? { "retry-after": "30" } : {});
        return { ok: false, status, headers,
          json: async () => ({ message: "You have exceeded a secondary rate limit." }) } as Response;
      }
      return read(url);
    });
    await expect(refresh({ ...env, COMMENT_ID: "123" }, fetchImpl as typeof fetch, registry)).rejects.toThrow(String(status));
    expect(fetchImpl.mock.calls.flatMap(([, init]) => init?.method ?? [])).toEqual(["POST"]);
  });

  test.each(["123", "124"])("refresh rechecks a referenced Gemini or Codex report after an edit (%s)", async (commentId) => {
    const read = fixture({ codexVerdict: "CHANGES_REQUESTED", initiallyUnavailable: true });
    const fetchImpl = (async (url: string, init?: RequestInit) => init?.method
      ? ({ ok: true, json: async () => ({ id: 42 }) } as Response)
      : read(url)) as typeof fetch;
    expect(await refresh({ ...env, COMMENT_ID: commentId }, fetchImpl, registry)).toEqual({ refreshed: true, head: sha, conclusion: "failure" });
  });
});
