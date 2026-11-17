// @vitest-environment node
import { expect, it } from "vitest";
import { createGitHubReceiptTransport, loadPublishedBrowserReceipt } from "./trustedBrowserSource.mjs";

const candidate = {
  repositoryId: 12, prNumber: 825, baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};

it("refuses duplicate current publications even when both advertise a successful producer", () => {
  const check = {
    name: "authenticated-pr-e2e", app: { slug: "github-actions" }, head_sha: candidate.headSha,
    status: "completed", conclusion: "success", external_id: `g5:${candidate.prNumber}:123:1`,
  };
  expect(loadPublishedBrowserReceipt({
    candidate,
    api: (route: string) => {
      if (!route.includes("/check-runs?")) throw new Error("An ambiguous publication must refuse before reading its producer.");
      return { total_count: 2, check_runs: [check, check] };
    },
    downloadZip: () => { throw new Error("An ambiguous publication must refuse before reading its archive."); },
  })).toBeNull();
});

it("refuses a partial check inventory that omits other possible publications", () => {
  expect(loadPublishedBrowserReceipt({
    candidate, api: () => ({ total_count: 101, check_runs: [] }),
    downloadZip: () => { throw new Error("A partial inventory cannot authorize an archive download."); },
  })).toBeNull();
});

it("refuses arbitrary authenticated GitHub routes", () => {
  const transport = createGitHubReceiptTransport({ repository: "aalzriqat/Auto", token: "fixture" });
  expect(() => transport.api("/actions/artifacts/12/../../releases")).toThrow("GitHub receipt route is unavailable.");
  expect(() => transport.downloadZip("12/../../secret")).toThrow("GitHub receipt route is unavailable.");
});
