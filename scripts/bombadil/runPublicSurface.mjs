// SCRUM-1005: command line entry of the Bombadil signed-out explorer
// (`pnpm bombadil:public`). Node runs this file as the entry point and nothing
// else imports it, so it runs unconditionally: there is no main-module test to
// get wrong. (Comparing import.meta.url with process.argv[1] fails when the
// script is reached through a symlink: Node resolves the real path of the main
// entry unless --preserve-symlinks-main is set, argv[1] stays as typed, and the
// run would end with exit 0 and no verdict. import.meta.main exists only from
// Node 22.18 / 24.2.) Everything else is in ./runner.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./runner.mjs";

try {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const { exitCode } = await run({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    root,
  });
  process.exitCode = exitCode;
} catch (error) {
  // A crash is never a pass: no verdict was written, so say so and fail.
  console.error(
    `bombadil verdict: CANNOT_RUN - the runner crashed: ${error?.stack ?? error}`,
  );
  process.exitCode = 1;
}
