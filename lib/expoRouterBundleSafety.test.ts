import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repo invariant, not a unit test.
 *
 * Expo Router turns every file under `apps/mobile/app/` into a route and
 * bundles it, so a test file placed there drags its dev-only dependencies into
 * the production bundle. Putting the sign-in tests in `app/(auth)/` did exactly
 * that: Metro followed @testing-library/react-native into a `require("console")`
 * and the OTA publish failed with "Unable to resolve module console" — after
 * every unit test, typecheck, lint and web build had already passed.
 *
 * Route tests belong in `apps/mobile/src/`, importing the route by path.
 *
 * Lives here rather than in the mobile package because that package's tsconfig
 * deliberately excludes Node types, and because the root vitest suite is what
 * CI runs on every push.
 */
const APP_DIR = join(__dirname, "..", "apps", "mobile", "app");

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? collectFiles(full) : [full];
  });
}

describe("expo-router bundle safety", () => {
  it("keeps test files out of apps/mobile/app, which is bundled as routes", () => {
    const offenders = collectFiles(APP_DIR)
      .filter((file) => /\.(test|spec)\.[jt]sx?$/.test(file))
      // Normalise Windows separators so the failure message reads the same on
      // every platform.
      .map((file) => file.slice(APP_DIR.length + 1).split(sep).join("/"));

    expect(offenders).toEqual([]);
  });
});
