import { describe, expect, it } from "vitest";
import {
  buildE2EPreviewDescriptor,
  validateE2EPreviewDescriptor,
} from "./e2ePreviewDescriptor.mjs";

const BASE_ENV = {
  CONVEX_DEPLOY_KEY: "preview:team:project|unit-test-secret",
  CONVEX_PREVIEW_NAME: "e2e-pr-325-abcdef1234",
  NEXT_PUBLIC_CONVEX_URL: "https://candidate-supplied.convex.cloud",
  HEAD_SHA: "a".repeat(40),
  PR_NUMBER: "325",
};

describe("sanitized E2E preview descriptor", () => {
  it("emits only preview identity, PR number, and exact candidate head", () => {
    expect(buildE2EPreviewDescriptor(BASE_ENV)).toEqual({
      version: 2,
      previewName: "e2e-pr-325-abcdef1234",
      headSha: "a".repeat(40),
      prNumber: 325,
    });
  });

  it("re-validates untrusted descriptor artifacts against trusted workflow identity", () => {
    const descriptor = buildE2EPreviewDescriptor(BASE_ENV);

    expect(
      validateE2EPreviewDescriptor(descriptor, {
        expectedHeadSha: BASE_ENV.HEAD_SHA,
        expectedPrNumber: 325,
        expectedPreviewName: BASE_ENV.CONVEX_PREVIEW_NAME,
      }),
    ).toEqual(descriptor);

    expect(() =>
      validateE2EPreviewDescriptor(
        { ...descriptor, headSha: "b".repeat(40) },
        {
          expectedHeadSha: BASE_ENV.HEAD_SHA,
          expectedPrNumber: 325,
          expectedPreviewName: BASE_ENV.CONVEX_PREVIEW_NAME,
        },
      ),
    ).toThrow(/head SHA/);

    expect(() =>
      validateE2EPreviewDescriptor(
        { ...descriptor, unexpected: "candidate-data" },
        {
          expectedHeadSha: BASE_ENV.HEAD_SHA,
          expectedPrNumber: 325,
          expectedPreviewName: BASE_ENV.CONVEX_PREVIEW_NAME,
        },
      ),
    ).toThrow(/unexpected fields/);
  });

  it("refuses candidate-supplied Convex authority in the handoff", () => {
    const descriptor = buildE2EPreviewDescriptor(BASE_ENV);

    expect(() =>
      validateE2EPreviewDescriptor(
        {
          ...descriptor,
          convexCloudUrl: "https://attacker-choice.convex.cloud",
        },
        {
          expectedHeadSha: BASE_ENV.HEAD_SHA,
          expectedPrNumber: 325,
          expectedPreviewName: BASE_ENV.CONVEX_PREVIEW_NAME,
        },
      ),
    ).toThrow(/unexpected fields/);

    expect(JSON.stringify(descriptor)).not.toContain("convex.cloud");
  });

  it("does not copy deploy, Clerk, or candidate URL material into the descriptor", () => {
    const descriptor = buildE2EPreviewDescriptor({
      ...BASE_ENV,
      CLERK_SECRET_KEY: "clerk-secret",
      E2E_LOGIN_PASSWORD: "password-secret",
    });

    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain("unit-test-secret");
    expect(serialized).not.toContain("clerk-secret");
    expect(serialized).not.toContain("password-secret");
    expect(serialized).not.toContain("candidate-supplied");
  });

  it("refuses a non-preview deploy key before publishing target identity", () => {
    expect(() =>
      buildE2EPreviewDescriptor({
        ...BASE_ENV,
        CONVEX_DEPLOY_KEY: "prod:team:project|unit-test-secret",
      }),
    ).toThrow(/not a PREVIEW deploy key/);
  });

  it("refuses ambiguous head and PR identities", () => {
    expect(() =>
      buildE2EPreviewDescriptor({
        ...BASE_ENV,
        HEAD_SHA: "main",
      }),
    ).toThrow(/40-character .*commit SHA/);

    expect(() =>
      buildE2EPreviewDescriptor({
        ...BASE_ENV,
        PR_NUMBER: "325;echo",
      }),
    ).toThrow(/numeric pull-request number/);
  });
});
