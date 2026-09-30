/**
 * SCRUM-494: the shared trusted-git resolver returns an absolute path or throws
 * (never a bare "git" resolved through PATH; Sonar javascript:S4036).
 */
import { describe, expect, test, vi } from "vitest";
import { resolveTrustedGitExecutable } from "./trustedGit.mjs";

describe("resolveTrustedGitExecutable", () => {
  test.each([
    ["win32", ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]],
    ["darwin", ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]],
    ["linux", ["/usr/bin/git", "/bin/git"]],
  ])("%s returns the first existing absolute candidate", (platform, candidates) => {
    const last = candidates[candidates.length - 1];
    const exists = vi.fn((p: unknown) => p === last);
    expect(resolveTrustedGitExecutable(exists, platform as NodeJS.Platform)).toBe(last);
    expect(exists.mock.calls.map(([p]) => p)).toEqual(candidates);
  });

  test("throws when no trusted git exists (callers fail closed)", () => {
    expect(() => resolveTrustedGitExecutable(() => false, "linux")).toThrow(
      /trusted absolute Git executable was not found/,
    );
  });

  test("defaults use the real filesystem and platform", () => {
    expect(resolveTrustedGitExecutable()).toMatch(/git(\.exe)?$/);
  });
});
