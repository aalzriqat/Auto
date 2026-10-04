import { describe, expect, test } from "vitest";
import { gitCandidates, resolveGit } from "./gitExecutable.mjs";

describe("gitCandidates", () => {
  test("posix: fixed absolute locations only, none relative", () => {
    const list = gitCandidates("linux", {});
    expect(list[0]).toBe("/usr/bin/git");
    expect(list.every((p) => p.startsWith("/"))).toBe(true);
  });

  test("win32: Git for Windows under each configured root, skipping unset ones", () => {
    const list = gitCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    });
    expect(list).toEqual(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"]);
    expect(gitCandidates("win32", {})).toEqual([]);
  });
});

describe("resolveGit", () => {
  test("returns the first candidate that exists", () => {
    const exists = (p: string) => p === "/usr/local/bin/git" || p === "/bin/git";
    expect(resolveGit({ platform: "linux", env: {}, exists })).toBe("/usr/local/bin/git");
  });

  test("returns undefined, never a bare 'git', when nothing is installed in a fixed location", () => {
    expect(resolveGit({ platform: "linux", env: {}, exists: () => false })).toBeUndefined();
    expect(resolveGit({ platform: "win32", env: {}, exists: () => true })).toBeUndefined();
  });

  test("an absolute CONTRACT_SKEW_GIT wins when it exists", () => {
    expect(resolveGit({ platform: "linux", env: { CONTRACT_SKEW_GIT: "/opt/git/bin/git" }, exists: () => true })).toBe("/opt/git/bin/git");
    expect(resolveGit({ platform: "win32", env: { CONTRACT_SKEW_GIT: "D:\\tools\\git.exe" }, exists: () => true })).toBe("D:\\tools\\git.exe");
  });

  test("an absolute override that does not exist is not silently replaced by a default", () => {
    expect(resolveGit({ platform: "linux", env: { CONTRACT_SKEW_GIT: "/nope/git" }, exists: (p) => p === "/usr/bin/git" })).toBeUndefined();
  });

  test("a relative override is ignored, so it cannot make the lookup depend on the working directory", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "/usr/bin/git";
    };
    expect(resolveGit({ platform: "linux", env: { CONTRACT_SKEW_GIT: "./git" }, exists })).toBe("/usr/bin/git");
    expect(seen).not.toContain("./git");
  });

  test("with default dependencies on this machine it returns an absolute path or undefined", () => {
    const found = resolveGit();
    if (found !== undefined) expect(found).toMatch(/^([A-Za-z]:\\|\/)/);
  });
});
