import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// SCRUM-790 (M1): a caller without the matching edit permission must not be shown
// inputs the backend will refuse to save.

const perms = vi.hoisted(() => ({ granted: new Set<string>(), loading: false }));

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) =>
    args === "skip" ? undefined : [{ _id: "f1", fieldName: "Note", fieldType: "text", isActive: true, isRequired: false }],
  useMutation: () => vi.fn(),
}));
vi.mock("@/convex/_generated/api", () => ({
  api: { orgCustomFields: { list: "list", getValues: "getValues", setValues: "setValues" } },
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: perms.loading, hasPermission: (p: string) => perms.granted.has(p) }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: vi.fn() } }));

import { CustomFieldsSection } from "./CustomFieldsSection";

describe("CustomFieldsSection permission gate (SCRUM-790)", () => {
  beforeEach(() => {
    cleanup();
    perms.granted = new Set();
    perms.loading = false;
  });

  it("renders nothing for a caller without edit:vehicles", () => {
    perms.granted = new Set(["create:vehicles"]);
    render(<CustomFieldsSection orgId="org_1" entityType="vehicle" />);
    expect(screen.queryByPlaceholderText("Note")).toBeNull();
  });

  it("renders the inputs for a caller with edit:vehicles", () => {
    perms.granted = new Set(["edit:vehicles"]);
    render(<CustomFieldsSection orgId="org_1" entityType="vehicle" />);
    expect(screen.getByPlaceholderText("Note")).toBeTruthy();
  });

  it("follows the entity type: edit:vehicles does not unlock the customer section", () => {
    perms.granted = new Set(["edit:vehicles"]);
    render(<CustomFieldsSection orgId="org_1" entityType="customer" />);
    expect(screen.queryByPlaceholderText("Note")).toBeNull();
  });

  it("renders nothing while permissions are loading", () => {
    perms.loading = true;
    perms.granted = new Set(["edit:vehicles"]);
    render(<CustomFieldsSection orgId="org_1" entityType="vehicle" />);
    expect(screen.queryByPlaceholderText("Note")).toBeNull();
  });
});
