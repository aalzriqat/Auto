import { describe, expect, it, vi } from "vitest";
import {
  assertConvexCloudOrigin,
  assertPreviewDeploymentAdminKey,
  parsePreviewDeployKey,
  resolveConvexPreviewAuthority,
  resolveConvexPreviewCredentials,
  validateConvexPreviewAuthority,
  writeConvexPreviewAuthority,
} from "./convexPreviewAuthority.mjs";

const DEPLOY_KEY = "preview:team-one:project-two|unit-test-secret";
const PREVIEW_NAME = "e2e-pr-325-abcdef1234";
const CREATED_URL = "https://elegant-butterfly-952.convex.cloud";

describe("trusted Convex preview authority", () => {
  it("parses only a concrete preview deploy-key authority", () => {
    expect(parsePreviewDeployKey(DEPLOY_KEY)).toEqual({
      teamSlug: "team-one",
      projectSlug: "project-two",
    });
    expect(() =>
      parsePreviewDeployKey("prod:team-one:project-two|unit-test-secret"),
    ).toThrow(/preview:team:project/);
    expect(() =>
      parsePreviewDeployKey("preview:team-one|unit-test-secret"),
    ).toThrow(/preview:team:project/);
  });

  it("accepts only a deployment-scoped preview admin key", () => {
    expect(
      assertPreviewDeploymentAdminKey(
        "elegant-butterfly-952|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toBe("elegant-butterfly-952|deployment-secret");
    for (const type of ["prod", "dev", "preview"]) {
      expect(
        assertPreviewDeploymentAdminKey(
          type + ":elegant-butterfly-952|deployment-secret",
          "elegant-butterfly-952",
        ),
      ).toBe(type + ":elegant-butterfly-952|deployment-secret");
    }
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "project:elegant-butterfly-952|project-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped.*type 'project'/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "preview:another-deployment|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped.*differs/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "preview:x:elegant-butterfly-952|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped.*3 prefix segments/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "preview:team-one:project-two|project-wide-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "another-deployment|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "elegant-butterfly-952|line-one\nline-two",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "elegant-butterfly-952|",
        "elegant-butterfly-952",
      ),
    ).toThrow(/malformed/);
  });

  it("never echoes unrecognized admin-key prefix bytes into the refusal", () => {
    // The refusal reaches public CI logs before any ::add-mask:: runs, so only
    // fixed, known type literals may be named.
    let message = "";
    try {
      assertPreviewDeploymentAdminKey(
        "sk_sensitive_example:elegant-butterfly-952|opaque-secret",
        "elegant-butterfly-952",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not scoped.*unrecognized type/);
    expect(message).not.toContain("sk_sensitive_example");
    expect(message).not.toContain("opaque-secret");
  });

  it("accepts only bare Convex cloud origins", () => {
    expect(
      assertConvexCloudOrigin("https://elegant-butterfly-952.convex.cloud"),
    ).toBe("https://elegant-butterfly-952.convex.cloud");
    expect(() =>
      assertConvexCloudOrigin("https://example.com"),
    ).toThrow(/convex\.cloud/);
    expect(() =>
      assertConvexCloudOrigin(
        "https://elegant-butterfly-952.convex.cloud/extra?x=1",
      ),
    ).toThrow(/canonical/);
  });

  it("claims the existing named preview from the fixed Convex control-plane endpoint", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(
        JSON.stringify({
          deploymentName: "elegant-butterfly-952",
          instanceUrl: "https://elegant-butterfly-952.convex.cloud",
          adminKey: "preview:elegant-butterfly-952|must-not-persist",
          isNewDeployment: false,
          reference: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const authority = await resolveConvexPreviewAuthority({
      deployKey: DEPLOY_KEY,
      previewName: PREVIEW_NAME,
      expectedConvexCloudUrl: CREATED_URL,
      fetchImpl: fetchImpl as typeof fetch,
    });

    // The Convex CLI deploys to a preview through claim_preview_deployment;
    // authorize_preview answers with a project-scoped key (SCRUM-350 KEY-2).
    expect(requestedUrl).toBe(
      "https://api.convex.dev/api/claim_preview_deployment",
    );
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.headers).toMatchObject({
      authorization: "Bearer " + DEPLOY_KEY,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      projectSelection: {
        kind: "teamAndProjectSlugs",
        teamSlug: "team-one",
        projectSlug: "project-two",
      },
      identifier: PREVIEW_NAME,
      reuse: true,
    });
    expect(authority).toEqual({
      version: 1,
      authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
      previewName: PREVIEW_NAME,
      convexCloudUrl: "https://elegant-butterfly-952.convex.cloud",
      deploymentName: "elegant-butterfly-952",
    });
    expect(JSON.stringify(authority)).not.toContain("must-not-persist");

    const credentials = await resolveConvexPreviewCredentials({
      deployKey: DEPLOY_KEY,
      previewName: PREVIEW_NAME,
      expectedConvexCloudUrl: CREATED_URL,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(credentials.authority).toEqual(authority);
    expect(credentials.adminKey).toBe(
      "preview:elegant-butterfly-952|must-not-persist",
    );
  });

  function claimResponse(body: Record<string, unknown>) {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          deploymentName: "elegant-butterfly-952",
          instanceUrl: "https://elegant-butterfly-952.convex.cloud",
          adminKey: "preview:elegant-butterfly-952|deployment-secret",
          isNewDeployment: false,
          ...body,
        }),
        { status: 200 },
      ),
    );
  }

  it("refuses a claim that created a new preview instead of reusing the bootstrapped one", async () => {
    for (const isNewDeployment of [true, undefined, "false"]) {
      await expect(
        resolveConvexPreviewCredentials({
          deployKey: DEPLOY_KEY,
          previewName: PREVIEW_NAME,
          expectedConvexCloudUrl: CREATED_URL,
          fetchImpl: claimResponse({ isNewDeployment }) as typeof fetch,
        }),
      ).rejects.toThrow(/did not reuse the existing preview/);
    }
  });

  it("fails closed when the control plane resolves anything except a preview", async () => {
    await expect(
      resolveConvexPreviewAuthority({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: CREATED_URL,
        fetchImpl: claimResponse({ deploymentType: "prod" }) as typeof fetch,
      }),
    ).rejects.toThrow(/non-preview/);
  });

  it("still refuses a project-scoped key returned by the claim", async () => {
    await expect(
      resolveConvexPreviewCredentials({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: CREATED_URL,
        fetchImpl: claimResponse({
          adminKey: "preview:team-one:project-two|project-wide-secret",
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/not scoped.*3 prefix segments/);
  });

  // SCRUM-377: the claim is keyed by name and can return a newer run's
  // replacement; a run that knows what it created refuses anything else.
  it("refuses a claim that resolved a deployment other than the one this run created", async () => {
    await expect(
      resolveConvexPreviewCredentials({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: "https://newer-replacement-777.convex.cloud",
        fetchImpl: claimResponse({}) as typeof fetch,
      }),
    ).rejects.toThrow(/other than the one this run created/);
    await expect(
      resolveConvexPreviewAuthority({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: "https://newer-replacement-777.convex.cloud",
        fetchImpl: claimResponse({}) as typeof fetch,
      }),
    ).rejects.toThrow(/other than the one this run created/);
  });

  it("accepts the deployment this run created, compared as a canonical origin", async () => {
    for (const expected of [
      "https://elegant-butterfly-952.convex.cloud",
      "https://elegant-butterfly-952.convex.cloud/",
    ]) {
      const resolved = await resolveConvexPreviewCredentials({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: expected,
        fetchImpl: claimResponse({}) as typeof fetch,
      });
      expect(resolved.authority.deploymentName).toBe("elegant-butterfly-952");
    }
  });

  it("the swarm authority step requires the URL its run created", async () => {
    const fetchImpl = claimResponse({});
    await expect(
      writeConvexPreviewAuthority({
        repoRoot: "unused-because-it-refuses-first",
        env: { PR_NUMBER: "377", CONVEX_PREVIEW_DEPLOY_KEY: DEPLOY_KEY } as unknown as NodeJS.ProcessEnv,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/CONVEX_PREVIEW_URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Sol R3-1 / Sonnet F4: a workflow guard over script text can be fooled by
  // a commented-out argument or a later `undefined` duplicate key, so the
  // resolver itself refuses a lookup that does not name the created deployment.
  it("refuses a lookup that does not name the deployment this run created, before any request", async () => {
    const fetchImpl = claimResponse({});
    for (const expectedConvexCloudUrl of [undefined, null, ""]) {
      await expect(
        resolveConvexPreviewCredentials({
          deployKey: DEPLOY_KEY,
          previewName: PREVIEW_NAME,
          expectedConvexCloudUrl: expectedConvexCloudUrl as unknown as string,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow(/this run created is required/);
      await expect(
        resolveConvexPreviewAuthority({
          deployKey: DEPLOY_KEY,
          previewName: PREVIEW_NAME,
          expectedConvexCloudUrl: expectedConvexCloudUrl as unknown as string,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow(/this run created is required/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a malformed expected URL before any request", async () => {
    const fetchImpl = claimResponse({});
    await expect(
      resolveConvexPreviewCredentials({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: "",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a claim whose instance URL is not the claimed deployment", async () => {
    await expect(
      resolveConvexPreviewCredentials({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        expectedConvexCloudUrl: CREATED_URL,
        fetchImpl: claimResponse({
          instanceUrl: "https://different-deployment-123.convex.cloud",
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/does not match its deployment URL/);
  });

  it("rejects forged or decorated authority artifacts", () => {
    const valid = {
      version: 1,
      authority: "CONVEX_CONTROL_PLANE_AUTHORIZE_PREVIEW",
      previewName: PREVIEW_NAME,
      convexCloudUrl: "https://elegant-butterfly-952.convex.cloud",
      deploymentName: "elegant-butterfly-952",
    };

    expect(validateConvexPreviewAuthority(valid, PREVIEW_NAME)).toEqual(valid);
    expect(() =>
      validateConvexPreviewAuthority(
        { ...valid, authority: "CANDIDATE_DESCRIPTOR" },
        PREVIEW_NAME,
      ),
    ).toThrow(/metadata/);
    expect(() =>
      validateConvexPreviewAuthority(
        { ...valid, previewName: "e2e-pr-999-deadbeef00" },
        PREVIEW_NAME,
      ),
    ).toThrow(/trusted preview name/);
    expect(() =>
      validateConvexPreviewAuthority(
        {
          ...valid,
          convexCloudUrl: "https://different-deployment-123.convex.cloud",
        },
        PREVIEW_NAME,
      ),
    ).toThrow(/does not match its deployment URL/);
    expect(() =>
      validateConvexPreviewAuthority(
        { ...valid, convexCloudUrl: undefined },
        PREVIEW_NAME,
      ),
    ).toThrow(/invalid deployment URL/);
    expect(() =>
      validateConvexPreviewAuthority(
        { ...valid, adminKey: "secret" },
        PREVIEW_NAME,
      ),
    ).toThrow(/unexpected fields/);
  });
});
