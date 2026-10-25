import { expect } from "vitest";
import path from "node:path";
import { compareNode, validatorTree } from "../../scripts/contractSkew/contractTree.mjs";
import type { ClientNode } from "../../scripts/contractSkew/contractTree.mjs";
import { openingAllocationValidator, openingAllocationResultValidator } from "../../convex/utils/openingAllocationValidators";
import historicalDraftArgs from "../../scripts/contractSkew/__fixtures__/wizardDrafts-production-saveDraft.args.json";

type ProofExtraction = Readonly<{ calls: readonly {
  identifier: string; file: string; line: number; payload: ClientNode | null;
}[] }>;

/** Consume existing compiler evidence; this helper never builds or extracts a Program. */
export async function assertRegisteredOpeningProof(
  extraction: ProofExtraction, files: readonly string[], wholeWeb: boolean,
): Promise<void> {
  if (wholeWeb) {
    const roots = files.map(file => path.resolve(file));
    for (const required of ["components/accounting/setup/OpeningBalanceCard.tsx",
      "components/sales/wizard/hooks/useFinanceComparison.ts",
      "components/sales/wizard/steps/Step1QuoteSetup.tsx", "components/ui/datetime-picker.tsx"]) {
      expect(roots).toContain(path.resolve(required));
    }
    expect(files.length).toBeGreaterThan(1);
  }
  if (!("json" in openingAllocationValidator)) throw new Error("Native validator rendering is unavailable");
  const nativeArray = validatorTree({ type: "array", value: openingAllocationValidator.json });
  if (!("json" in openingAllocationResultValidator)) throw new Error("Native result-validator rendering is unavailable");
  const wrongReadbackOracle = validatorTree({ type: "array", value: openingAllocationResultValidator.json });
  const modulePath = path.resolve("convex/accountingCutover.ts");
  const registrations: unknown = await import(modulePath);
  if (!registrations || typeof registrations !== "object") throw new Error("Native registrations unavailable");
  const results = ["postOpeningBalanceDirect", "draftOpeningBalance"].map((name) => {
    const registration: unknown = Reflect.get(registrations, name);
    if (typeof registration !== "function" || !("exportArgs" in registration) || typeof registration.exportArgs !== "function") {
      throw new Error("Native registered argument export unavailable");
    }
    const rendered: unknown = registration.exportArgs();
    if (typeof rendered !== "string") throw new Error("Native argument export is not JSON text");
    const argumentTree = validatorTree(JSON.parse(rendered));
    if (argumentTree.kind !== "object") throw new Error("Native arguments are not an object validator");
    const registeredArray = argumentTree.fields.get("allocations")?.node;
    if (!registeredArray || registeredArray.kind !== "array") throw new Error("Native allocation argument unavailable");
    expect(registeredArray).toEqual(nativeArray);
    const identifier = `accountingCutover:${name}`;
    const calls = extraction.calls.filter((call) => call.identifier === identifier);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call.payload?.kind !== "object") throw new Error("Opening payload was not measured");
    const allocations = call.payload.fields.get("allocations")?.node;
    if (!allocations) throw new Error("Actual allocation field was not measured");
    const site = { identifier, file: call.file, line: call.line };
    const compared = compareNode(allocations, registeredArray, "allocations", {
      site,
    });
    const wrongReadback = compareNode(allocations, wrongReadbackOracle, "allocations", { site });
    return { identifier, kind: allocations.kind, findings: compared.findings, wrongReadback };
  });
  expect(results.map((result) => result.findings)).toEqual([[], []]);
  expect(results.map((result) => result.kind)).toEqual(["array", "array"]);
  expect(results.every((result) => result.wrongReadback.findings.some((finding) => finding.severity === "BREAKING"))).toBe(true);
  if (wholeWeb) {
    // SCRUM-862: constructed DTO fields must expose old-production skew, not optional-type ghosts.
    const calls = extraction.calls.filter(call => call.identifier === "wizardDrafts:saveDraft");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call.payload) throw new Error("Actual draft payload was not measured");
    expect(call.file).toBe("components/sales/SalesWizard.tsx");
    const registration: unknown = (await import(path.resolve("convex/wizardDrafts.ts"))).saveDraft;
    if (typeof registration !== "function" || !("exportArgs" in registration) || typeof registration.exportArgs !== "function") {
      throw new Error("Native draft argument export unavailable");
    }
    const rendered: unknown = registration.exportArgs();
    if (typeof rendered !== "string") throw new Error("Native draft arguments are not JSON text");
    const paths = ["wizardData.leadId", "wizardData.vehicleItems"];
    const context = { site: { identifier: call.identifier, file: call.file, line: call.line } };
    const historical = compareNode(call.payload, validatorTree(historicalDraftArgs.args), "", context);
    const current = compareNode(call.payload, validatorTree(JSON.parse(rendered)), "", context);
    expect(historical.findings.filter(finding => paths.includes(finding.path))).toEqual(paths.map(field =>
      expect.objectContaining({ path: field, severity: "BREAKING", provenance: "TYPE_REQUIRED" })));
    expect(current.findings).toEqual([]);
  }
}
