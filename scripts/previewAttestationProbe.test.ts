import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { probePreviewAttestation } from "./previewAttestationProbe.mjs";

const ID = "0123456789abcdef";
const env: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: "/synthetic-runner-temp" };
const invoke = async (_env: unknown, { run }: { run: (args: string[], label: string) => void }) => run(
  ["exec", "convex", "run", "e2eBootstrap:assertE2EBootstrap", "{}", "--preview-name", "e2e-synthetic"],
  "e2eBootstrap:assertE2EBootstrap",
);

describe("SCRUM-799 disposable-preview failure probe", () => {
  it("dispatches only trusted default-branch code, then pins, probes, and deletes its preview", () => {
    const workflow = parse(readFileSync(".github/workflows/preview-attestation-fault-probe.yml", "utf8")) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { if: string; steps: { run?: string; if?: string; env?: Record<string, string> }[] }>;
    };
    const job = workflow.jobs.probe!;
    expect(workflow.on).toEqual({
      repository_dispatch: { types: ["scrum799-preview-attestation-fault-probe"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    const deploys = job.steps.filter((step) => step.run?.includes("convex deploy"));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.run).toContain('--preview-create "$CONVEX_PREVIEW_NAME"');
    expect(deploys[0]!.env?.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    const pin = job.steps.findIndex((step) => step.run === "node scripts/previewDeploymentLifecycle.mjs pin --strict");
    const seed = job.steps.findIndex((step) => step.run === "node scripts/e2ePreviewBootstrap.mjs");
    const reset = job.steps.findIndex((step) => step.run === "node scripts/e2ePreviewBootstrap.mjs --set-role approver MANAGER");
    const probe = job.steps.findIndex((step) => step.run === "node scripts/previewAttestationProbe.mjs");
    const deletion = job.steps.findIndex((step) => step.run === "node scripts/previewDeploymentLifecycle.mjs delete --strict");
    expect([pin, seed, reset, probe, deletion]).toEqual([job.steps.indexOf(deploys[0]!) + 1, pin + 1, seed + 1, reset + 1, probe + 1]);
    expect(job.steps[pin]!.if).toBe("always() && env.CONVEX_PREVIEW_URL != ''");
    expect(job.steps[deletion]!.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
    expect(job.steps.every((step) => !step.run?.includes("${{"))).toBe(true);
  });

  it("reports only the request-correlated redacted category after an expected refusal", async () => {
    let written = "";
    const message = await probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: 1, stdout: "", stderr: `ConvexError: [Request ID: ${ID}] Server Error\nsensitive raw backend detail` }),
      write: (_path: string, contents: string) => { written = contents; },
      diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
    });
    expect(message).toMatch(/category=qa-approver-permissions/);
    expect(written).toContain(ID);
    expect(message + written).not.toContain("sensitive raw backend detail");
  });

  it("allows the same attestation deadline as the real form explorer", async () => {
    const explorer = readFileSync("playwright/scenarios/formExplorer/attestedPreview.ts", "utf8");
    expect(explorer).toMatch(/timeout:\s*180_000/);
    let timeout: number | undefined;
    await probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: (_command: string, _args: string[], options: { timeout?: number }) => {
        timeout = options.timeout;
        return { status: 1, stderr: `ConvexError: [Request ID: ${ID}] Server Error` };
      },
      write: () => {},
      diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
    });
    expect(timeout).toBe(180_000);
  });

  it("rejects an attestation that unexpectedly succeeds", async () => {
    await expect(probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: 0, stdout: "ok" }),
    })).rejects.toThrow(/unexpectedly accepted/);
  });

  it("does not treat a CLI launch failure as an attestation refusal", async () => {
    await expect(probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: null, error: new Error("launch failed"), stderr: `Error: [Request ID: ${ID}] Server Error` }),
      write: () => {},
      diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
    })).rejects.toThrow(/attestation refusal was not confirmed/);
  });

  it("rejects a diagnostic with a category prefix or unrelated request", async () => {
    for (const diagnostic of [
      `request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
      `Attestation backend failures: request=${ID} class=ConvexError category=qa-approver-permissions-other location=convex/e2eBootstrap.ts:1:1`,
      `Attestation backend failures: request=ffffffffffffffff class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
    ]) {
      await expect(probePreviewAttestation(env, {
        assertPreview: invoke,
        spawn: () => ({ status: 1, stderr: `ConvexError: [Request ID: ${ID}] Server Error` }),
        write: () => {},
        diagnose: () => diagnostic,
      })).rejects.toThrow(/matching redacted backend reason was unavailable/);
    }
  });

  it("returns only the matching request's redacted diagnostic", async () => {
    const message = await probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: 1, stderr: `ConvexError: [Request ID: ${ID}] Server Error` }),
      write: () => {},
      diagnose: () => `Attestation backend failures: request=ffffffffffffffff class=Error category=unclassified location=unavailable; request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
    });
    expect(message).toContain(`request=${ID}`);
    expect(message).not.toContain("request=ffffffffffffffff");
  });

  it("fails closed when the backend request ID is missing", async () => {
    await expect(probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: 1, stderr: "sensitive raw backend detail" }),
    })).rejects.toThrow(/no backend request ID/);
  });

  it("fails when the request ID is on another line or only stdout, as the real explorer would", async () => {
    for (const output of [
      { status: 1, stderr: `ConvexError: Server Error\n[Request ID: ${ID}]`, stdout: "" },
      { status: 1, stderr: "ConvexError: Server Error", stdout: `[Request ID: ${ID}]` },
    ]) {
      await expect(probePreviewAttestation(env, {
        assertPreview: invoke,
        spawn: () => output,
      })).rejects.toThrow(/no backend request ID/);
    }
  });

  it("fails closed when the request's backend reason is not the fixed category", async () => {
    await expect(probePreviewAttestation(env, {
      assertPreview: invoke,
      spawn: () => ({ status: 1, stderr: `[Request ID: ${ID}] Server Error` }),
      write: () => {},
      diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=unclassified location=unavailable`,
    })).rejects.toThrow(/matching redacted backend reason was unavailable/);
  });

  it("does not count a failure before the attestation invocation", async () => {
    await expect(probePreviewAttestation(env, {
      assertPreview: async () => { throw new Error("Clerk failed before assertion"); },
    })).rejects.toThrow(/attestation was not invoked/);
  });
});
