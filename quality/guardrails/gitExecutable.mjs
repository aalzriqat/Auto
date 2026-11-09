import { existsSync } from "node:fs";

// An absolute Git path, never whatever `git` the inherited PATH resolves
// (the PATH lookup could pick up a planted binary); the same candidates as scripts/intelligence/jevImpact.mjs.
export function resolveTrustedGitExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ]
      : process.platform === "darwin"
        ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
        : ["/usr/bin/git", "/bin/git"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("A trusted absolute Git executable was not found");
  return executable;
}
