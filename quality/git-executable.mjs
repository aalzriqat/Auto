import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

function windowsGitCandidates(environment) {
  const programFilesRoots = [
    environment.ProgramW6432,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter((root) => root && path.isAbsolute(root));
  return [...new Set(programFilesRoots)].flatMap((root) => [
    path.join(root, "Git", "cmd", "git.exe"),
    path.join(root, "Git", "bin", "git.exe"),
  ]);
}

function trustedGitCandidates(platform, environment) {
  if (platform === "win32") return windowsGitCandidates(environment);
  return [
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/opt/local/bin/git",
    "/home/linuxbrew/.linuxbrew/bin/git",
    "/run/current-system/sw/bin/git",
    "/nix/var/nix/profiles/default/bin/git",
  ];
}

export function validateGitExecutable(candidate) {
  if (!path.isAbsolute(candidate)) {
    throw new TypeError("The Git executable must be an absolute path.");
  }
  if (!/^git(?:\.exe)?$/iu.test(path.basename(candidate))) {
    throw new TypeError("The Git executable must be named git or git.exe.");
  }
  const resolved = realpathSync(candidate);
  if (!lstatSync(resolved).isFile()) {
    throw new TypeError("The resolved Git executable is not a regular file.");
  }
  return resolved;
}

export function resolveGitExecutable({
  environment = process.env,
  platform = process.platform,
} = {}) {
  const configured = environment.AUTOFLOW_GIT_EXECUTABLE;
  if (configured) return validateGitExecutable(configured);

  const candidate = trustedGitCandidates(platform, environment).find((entry) =>
    existsSync(entry),
  );
  if (!candidate) {
    throw new Error(
      "Git was not found in a standard system installation directory. " +
        "Set AUTOFLOW_GIT_EXECUTABLE to its absolute executable path.",
    );
  }
  return validateGitExecutable(candidate);
}
