import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * SCRUM-795: the legacy manual-journal draft is requested ONLY where the
 * bootstrap script and the backend are the same version and the preview is not
 * the accounting rehearsal's. Only trusted-main-e2e.yml qualifies.
 *
 * - browser-attack-swarm.yml runs TRUSTED MAIN's bootstrap script against the
 *   CANDIDATE backend; after merge that would send an argument un-rebased PR
 *   backends do not know, failing the bootstrap for every other lane.
 * - trusted-accounting-rehearsal.yml's case P1 closes the only open period, and
 *   any pending manual draft blocks that close.
 */
const ENV_NAME = "E2E_SEED_LEGACY_MANUAL_JOURNAL";
const WORKFLOWS = path.join(process.cwd(), ".github", "workflows");
const ALLOWED_WORKFLOW = "trusted-main-e2e.yml";

type Step = { name?: string; run?: string; env?: Record<string, unknown> };

function trustedMainSteps(): Step[] {
  const text = readFileSync(path.join(WORKFLOWS, ALLOWED_WORKFLOW), "utf8");
  const jobs = (parse(text) as { jobs: Record<string, { steps?: Step[] }> }).jobs;
  return Object.values(jobs).flatMap((j) => j.steps ?? []);
}

describe("SCRUM-795 legacy manual-journal seed scope", () => {
  it("(a) trusted-main-e2e sets the flag to \"1\" on BOTH the bootstrap step and the playwright step", () => {
    const steps = trustedMainSteps();
    const bootstrap = steps.filter((s) => /scripts\/e2ePreviewBootstrap\.mjs\s*$/.test(s.run?.trim() ?? ""));
    const playwright = steps.filter((s) => /^pnpm exec playwright test\s*$/.test(s.run?.trim() ?? ""));
    expect(bootstrap).toHaveLength(1);
    expect(playwright).toHaveLength(1);
    expect(bootstrap[0].env?.[ENV_NAME]).toBe("1");
    expect(playwright[0].env?.[ENV_NAME]).toBe("1");
  });

  it("(b) no other workflow mentions the flag", () => {
    const offenders = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f) && f !== ALLOWED_WORKFLOW)
      .filter((f) => readFileSync(path.join(WORKFLOWS, f), "utf8").includes(ENV_NAME));
    expect(offenders).toEqual([]);
  });

  it("(c) the bootstrap script and the spec both reference the flag", () => {
    for (const rel of ["scripts/e2ePreviewBootstrap.mjs", "playwright/tests/accounting.spec.ts"]) {
      expect(readFileSync(path.join(process.cwd(), rel), "utf8"), rel).toContain(ENV_NAME);
    }
  });
});
