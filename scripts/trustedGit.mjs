import { existsSync } from "node:fs";

/**
 * Absolute path of a Git executable, never a bare "git" resolved through PATH
 * (Sonar javascript:S4036). Throws when no trusted install is found so callers
 * fail closed. `exists`/`platform` are injectable for tests. Shared by jevImpact and mergeContentIdentity.
 */
export function resolveTrustedGitExecutable(exists = existsSync, platform = process.platform) {
  const candidates =
    platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ]
      : platform === "darwin"
        ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
        : ["/usr/bin/git", "/bin/git"];
  const executable = candidates.find((candidate) => exists(candidate));
  if (!executable) {
    throw new Error("A trusted absolute Git executable was not found");
  }
  return executable;
}
