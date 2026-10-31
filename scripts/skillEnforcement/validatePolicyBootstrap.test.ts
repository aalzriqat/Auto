import { describe, expect, it } from "vitest";
import { validatePolicyBootstrap } from "./validatePolicyBootstrap.mjs";

describe("validatePolicyBootstrap (SCRUM-760)", () => {
  const sha = "a".repeat(40);
  const baseEnv = {
    REPO: "aalzriqat/Auto",
    GH_TOKEN: "fake-token",
    INPUT_SHA: sha,
    INPUT_CONFIRM: "VALIDATE POLICY PR 734",
    GITHUB_REF: "refs/heads/gemini/scrum760-waiver-policy",
  };

  it("refuses if confirm phrase is not exact", async () => {
    await expect(validatePolicyBootstrap({ ...baseEnv, INPUT_CONFIRM: "DEPLOY TO PRODUCTION" }))
      .rejects.toThrow("Refusing policy validation: confirm input must be 'VALIDATE POLICY PR 734'");
  });

  it("refuses if input SHA is malformed", async () => {
    await expect(validatePolicyBootstrap({ ...baseEnv, INPUT_SHA: "bad-sha" }))
      .rejects.toThrow("Refusing policy validation: invalid input SHA 'bad-sha'.");
  });

  it("refuses if dispatched on the wrong branch ref", async () => {
    await expect(validatePolicyBootstrap({ ...baseEnv, GITHUB_REF: "refs/heads/main" }))
      .rejects.toThrow("Refusing policy validation: workflow must run on 'refs/heads/gemini/scrum760-waiver-policy'");
  });

  it("refuses if local checked out HEAD does not match input SHA", async () => {
    const mockGit = async () => "b".repeat(40);
    await expect(validatePolicyBootstrap(baseEnv, fetch, mockGit))
      .rejects.toThrow("Local checked out HEAD");
  });

  it("refuses if PR 734 API returns non-200", async () => {
    const mockFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const mockGit = async () => sha;
    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("Could not fetch PR 734 from GitHub API (HTTP 404).");
  });

  it("refuses if PR 734 state is closed", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: "closed", head: { sha } }),
    })) as unknown as typeof fetch;
    const mockGit = async () => sha;
    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("PR 734 is not open (state: closed).");
  });

  it("refuses if PR 734 head SHA does not match input SHA", async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: "open", head: { sha: "c".repeat(40) } }),
    })) as unknown as typeof fetch;
    const mockGit = async () => sha;
    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("PR 734 head SHA 'cccccccccccccccccccccccccccccccccccccccc' does not match input SHA");
  });

  it("writes check-run failure when computed policy check fails", async () => {
    const checksRecorded: Array<Record<string, unknown>> = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/check-runs")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        checksRecorded.push(body);
        return { ok: true, status: 201, json: async () => ({ id: 12345 }) };
      }
      if (u.includes("/files")) {
        return { ok: true, status: 200, json: async () => [{ filename: "convex/sales.ts" }, { filename: "convex/sales.test.ts" }] };
      }
      if (u.includes("/commits")) {
        return { ok: true, status: 200, json: async () => [{ sha }] };
      }
      if (u.includes("/pulls/734")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            head: { sha },
            body: "No skill evidence",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const mockGit = async () => sha;

    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("Computed policy validation failed");

    expect(checksRecorded.length).toBe(1);
    expect(checksRecorded[0].name).toBe("skill-evidence");
    expect(checksRecorded[0].conclusion).toBe("failure");
    expect(checksRecorded[0].head_sha).toBe(sha);
  });

  it("publishes check-run success when computed policy check passes", async () => {
    const checksRecorded: Array<Record<string, unknown>> = [];
    const validExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const waiverUrl = "https://github.com/aalzriqat/Auto/pull/734#issuecomment-111";
    const codexReviewUrl = "https://github.com/aalzriqat/Auto/pull/734#issuecomment-222";

    const bodyText =
      `## Skill evidence\n` +
      `- Skills run: tdd, blast-radius, two-axis-review, engineering-principles, technical-writing, unslop\n` +
      `- Red run:\n\`\`\`\nFAIL convex/sales.test.ts > refuses X\nAssertionError: expected 5 to be 0\n\`\`\`\n` +
      `- /simplify output:\n\`\`\`\nReviewed for reuse, simplification and efficiency: no changes needed\n\`\`\`\n` +
      `- Implementer session: b79c7aa3-b8f7-4025-8d9f-87ce2e6abef6\n` +
      `- Seat 1 model: WAIVED\n` +
      `- Seat 1 waiver ruling: SCRUM-760 c24127\n` +
      `- Seat 1 waiver: ${waiverUrl}\n` +
      `- Seat 2 model: Codex\n` +
      `- Seat 2 mode: chat\n` +
      `- Seat 2 effort: unasserted (chat review)\n` +
      `- Seat 2 review: ${codexReviewUrl}\n` +
      `- Seat 2 SHA: ${sha}\n`;

    const comments: Record<string, Record<string, unknown>> = {
      "111": {
        html_url: waiverUrl,
        issue_url: "https://api.github.com/repos/aalzriqat/Auto/issues/734",
        author_association: "OWNER",
        body: `Owner waiver: Seat 1\nRuling: SCRUM-760 c24127\nHead SHA: ${sha}\nExpires: ${validExpiry}\nVerdict: WAIVED\nProxy: owner-proxy\nReason: Owner ruling\n`,
      },
      "222": {
        html_url: codexReviewUrl,
        issue_url: "https://api.github.com/repos/aalzriqat/Auto/issues/734",
        author_association: "OWNER",
        body: `[Codex Review]\nReviewer: Codex Seat 2\nMode: chat\nSession: 01a18fe9-b92b-7ae0-aa13-faea3189ac57\nHead SHA: ${sha}\nVerdict: CERTIFY\nSigned: Codex Seat 2\n`,
      },
    };

    const mockFetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/issues/comments/111")) {
        return { ok: true, status: 200, json: async () => comments["111"] };
      }
      if (u.includes("/issues/comments/222")) {
        return { ok: true, status: 200, json: async () => comments["222"] };
      }
      if (u.includes("/check-runs")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        checksRecorded.push(body);
        return { ok: true, status: 201, json: async () => ({ id: 54321 }) };
      }
      if (u.includes("/files")) {
        return { ok: true, status: 200, json: async () => [{ filename: "convex/sales.ts" }, { filename: "convex/sales.test.ts" }] };
      }
      if (u.includes("/commits")) {
        return { ok: true, status: 200, json: async () => [{ sha }] };
      }
      if (u.includes("/pulls/734")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            head: { sha },
            body: bodyText,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const mockGit = async () => sha;

    const res = await validatePolicyBootstrap(baseEnv, mockFetch, mockGit);
    expect(res.success).toBe(true);
    expect(res.headSha).toBe(sha);
    expect(res.lines[0]).toBe("skill-evidence: section present and consistent. Seat 1: WAIVED (owner-proxy ruling SCRUM-760 c24127). Seat 2: CERTIFIED.");
    expect(checksRecorded.length).toBe(1);
    expect(checksRecorded[0].name).toBe("skill-evidence");
    expect(checksRecorded[0].conclusion).toBe("success");
    expect(checksRecorded[0].head_sha).toBe(sha);
  });

  it("refuses if policy check was not required for the PR (non-required bypass refusal)", async () => {
    const mockFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/files")) {
        // Files touching only docs, outside money/gate paths
        return { ok: true, status: 200, json: async () => [{ filename: "docs/readme.md" }] };
      }
      if (u.includes("/commits")) {
        return { ok: true, status: 200, json: async () => [{ sha }] };
      }
      if (u.includes("/pulls/734")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            head: { sha },
            body: "Just documentation changes",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const mockGit = async () => sha;

    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("policy check was not required for PR #734");
  });

  it("refuses if PR 734 head moved during evaluation (pre-publication race refusal)", async () => {
    let callCount = 0;
    const movedSha = "d".repeat(40);
    const mockFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/files")) {
        return { ok: true, status: 200, json: async () => [{ filename: "convex/sales.ts" }] };
      }
      if (u.includes("/commits")) {
        return { ok: true, status: 200, json: async () => [{ sha }] };
      }
      if (u.includes("/pulls/734")) {
        callCount++;
        // Initial check returns sha, pre-publication check returns movedSha
        const currentSha = callCount > 2 ? movedSha : sha;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            head: { sha: currentSha },
            body: "No skill evidence",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const mockGit = async () => sha;

    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("PR 734 head moved during evaluation");
  });

  it("refuses if pre-publication head re-verification returns non-200", async () => {
    let callCount = 0;
    const mockFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/files")) {
        return { ok: true, status: 200, json: async () => [{ filename: "convex/sales.ts" }] };
      }
      if (u.includes("/commits")) {
        return { ok: true, status: 200, json: async () => [{ sha }] };
      }
      if (u.includes("/pulls/734")) {
        callCount++;
        if (callCount > 2) {
          return { ok: false, status: 503 };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "open",
            head: { sha },
            body: "No skill evidence",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const mockGit = async () => sha;

    await expect(validatePolicyBootstrap(baseEnv, mockFetch, mockGit))
      .rejects.toThrow("Could not re-verify PR 734 head before publication (HTTP 503).");
  });
});
