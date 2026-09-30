/// <reference types="jest" />

import { financedDealCancelTarget } from "./financedDealCancel";

describe("financedDealCancelTarget (SCRUM-447 D4)", () => {
  test("a cash sale has no target, so its Cancel stays", () => {
    expect(financedDealCancelTarget({ status: "PENDING" }, "org1", "https://app.example")).toBeNull();
  });

  test("an already cancelled financed sale has no target", () => {
    expect(financedDealCancelTarget({ applicationId: "a1", status: "CANCELLED" }, "org1", undefined)).toBeNull();
  });

  test("a financed sale links to the deal screen when the web origin is configured", () => {
    expect(
      financedDealCancelTarget({ applicationId: "a1", status: "PENDING" }, "org1", "https://app.example/")
    ).toEqual({ kind: "link", url: "https://app.example/org1/applications/a1/deal", reference: "a1" });
  });

  test("without a configured origin it names the deal instead of guessing a link", () => {
    expect(
      financedDealCancelTarget({ applicationId: "a1", status: "COMPLETED" }, "org1", undefined)
    ).toEqual({ kind: "text", reference: "a1" });
  });
});
