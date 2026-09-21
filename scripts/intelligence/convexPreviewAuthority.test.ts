import { describe, expect, it, vi } from "vitest";
import {
  assertConvexCloudOrigin,
  assertPreviewDeploymentAdminKey,
  parsePreviewDeployKey,
  resolveConvexPreviewAuthority,
  resolveConvexPreviewCredentials,
  validateConvexPreviewAuthority,
} from "./convexPreviewAuthority.mjs";

const DEPLOY_KEY = "preview:team-one:project-two|unit-test-secret";
const PREVIEW_NAME = "e2e-pr-325-abcdef1234";

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
        "preview:elegant-butterfly-952|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toBe("preview:elegant-butterfly-952|deployment-secret");
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "preview:team-one:project-two|project-wide-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped/);
    expect(() =>
      assertPreviewDeploymentAdminKey(
        "preview:another-deployment|deployment-secret",
        "elegant-butterfly-952",
      ),
    ).toThrow(/not scoped/);
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

  it("resolves the named preview from the fixed Convex control-plane endpoint", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(
        JSON.stringify({
          deploymentName: "elegant-butterfly-952",
          url: "https://elegant-butterfly-952.convex.cloud",
          adminKey: "preview:elegant-butterfly-952|must-not-persist",
          deploymentType: "preview",
          reference: null,
          isDefault: false,
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
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(requestedUrl).toBe(
      "https://api.convex.dev/api/deployment/authorize_preview",
    );
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.headers).toMatchObject({
      authorization: "Bearer " + DEPLOY_KEY,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      previewName: PREVIEW_NAME,
      projectSelection: {
        kind: "teamAndProjectSlugs",
        teamSlug: "team-one",
        projectSlug: "project-two",
      },
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
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(credentials.authority).toEqual(authority);
    expect(credentials.adminKey).toBe(
      "preview:elegant-butterfly-952|must-not-persist",
    );
  });

  it("fails closed when the control plane resolves anything except a preview", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          deploymentName: "prod-name",
          url: "https://prod-name.convex.cloud",
          deploymentType: "prod",
        }),
        { status: 200 },
      ),
    );

    await expect(
      resolveConvexPreviewAuthority({
        deployKey: DEPLOY_KEY,
        previewName: PREVIEW_NAME,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/non-preview/);
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
        { ...valid, adminKey: "secret" },
        PREVIEW_NAME,
      ),
    ).toThrow(/unexpected fields/);
  });
});
