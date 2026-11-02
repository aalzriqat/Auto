/**
 * SCRUM-886 round 8. Every import the vehicle import dialog can send carries an import id, and
 * `vehicles.importBulk` refuses a caller without view:cost_price for both postings (PURCHASE and
 * OPENING_STOCK with an import id): their idempotency proof compares cost with a stored fingerprint.
 * The dialog is therefore not mounted for such a caller, instead of walking them through a file the
 * server refuses at the last step. The server is the control (`vehicleCostOracles.scrum886.test.ts`);
 * this pins that the screen does not offer what the server refuses, and that a cost reader still gets
 * the wizard.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  loading: false,
  queriedNames: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args !== "skip") state.queriedNames.push(getFunctionName(reference));
      return undefined;
    },
    useMutation: () => async () => undefined,
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: true, locale: "ar" }),
}));
vi.mock("@/hooks/useCurrency", () => ({ useCurrency: () => ({ format: (n: number) => String(n) }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => state.permissions.includes(permission),
    isLoading: state.loading,
  }),
}));
vi.mock("@/components/import/ImportWizard", () => ({
  ImportWizard: ({ open }: { open: boolean }) => (open ? <div data-testid="import-wizard" /> : null),
  normalizeKey: (value: string) => value,
}));

import { VehicleImportDialog } from "./VehicleImportDialog";

afterEach(() => {
  cleanup();
  state.permissions = [];
  state.loading = false;
  state.queriedNames = [];
});

describe("SCRUM-886 round 8: the vehicle import dialog is offered only to a caller who may read cost", () => {
  test("a caller who can create vehicles but not read cost gets no import wizard", () => {
    state.permissions = ["view:vehicles", "create:vehicles"];
    render(<VehicleImportDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByTestId("import-wizard")).toBeNull();
  });

  test("while permissions are still loading nothing is offered", () => {
    state.permissions = ["view:vehicles", "create:vehicles", "view:cost_price"];
    state.loading = true;
    render(<VehicleImportDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByTestId("import-wizard")).toBeNull();
  });

  test("control: a caller who holds view:cost_price still gets the import wizard", () => {
    state.permissions = ["view:vehicles", "create:vehicles", "view:cost_price"];
    render(<VehicleImportDialog open onOpenChange={() => undefined} />);
    expect(screen.getByTestId("import-wizard")).toBeTruthy();
  });
});
