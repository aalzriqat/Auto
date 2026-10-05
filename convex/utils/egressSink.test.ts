import { afterEach, describe, expect, test, vi } from "vitest";
import { isEgressSinkActive, PRODUCTION_DEPLOYMENT_NAME, sinkEgress } from "./egressSink";

const PREVIEW_URL = "https://combative-gerbil-860.convex.cloud";
const PROD_URL = `https://${PRODUCTION_DEPLOYMENT_NAME}.convex.cloud`;

function deployment(cls: string | undefined, url: string | undefined) {
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", cls);
  vi.stubEnv("CONVEX_CLOUD_URL", url);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isEgressSinkActive (SCRUM-639)", () => {
  test("a preview-class deployment that is not production is sunk", () => {
    deployment("preview", PREVIEW_URL);
    expect(isEgressSinkActive()).toBe(true);
  });

  test("production is never sunk, even with the preview class wrongly set on it", () => {
    deployment("preview", PROD_URL);
    expect(isEgressSinkActive()).toBe(false);
    deployment(undefined, PROD_URL);
    expect(isEgressSinkActive()).toBe(false);
  });

  test("no class, or any other value, delivers as today", () => {
    for (const cls of [undefined, "", "Preview", " preview", "preview ", "production", "dev"]) {
      deployment(cls, PREVIEW_URL);
      expect(isEgressSinkActive(), String(cls)).toBe(false);
    }
  });

  test("a missing or unreadable deployment URL fails toward delivering", () => {
    for (const url of [undefined, "", "   ", "not a url"]) {
      deployment("preview", url);
      expect(isEgressSinkActive(), String(url)).toBe(false);
    }
  });

  test("the sink log names the channel and sender, nothing else", () => {
    deployment("preview", PREVIEW_URL);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(sinkEgress("email", "sendTaskAlarm")).toBe(true);
    expect(log).toHaveBeenCalledWith("[egressSink] preview: email send held by the sink: sender=sendTaskAlarm");

    deployment(undefined, PROD_URL);
    log.mockClear();
    expect(sinkEgress("email", "sendTaskAlarm")).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
