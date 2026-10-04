import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { toast } from "@/components/ui/sonner";
import { EditRoleDialog } from "./EditRoleDialog";

/**
 * SCRUM-413 (Sonnet NEW-1): the dialog pre-fills the name with the TRANSLATED
 * label, so an ordinary permission edit used to rename a stored "MANAGER" to
 * "Manager" / "المدير" — and the stored name is what the deal-authority
 * transition and template sync key on. The name is sent only when edited.
 */

const updateRole = vi.fn(async (_args: unknown) => null);

vi.mock("convex/react", () => ({ useMutation: () => updateRole }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => ({ MANAGER: "Manager", Save: "Save", ServerError_PERMISSION_RETIRED: "localized retired text" } as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/team/RolePermissionsEditor", () => ({
  RolePermissionsEditor: ({ selectedPermissions, onChange }: { selectedPermissions: string[]; onChange: (p: string[]) => void }) => (
    <button type="button" onClick={() => onChange([...selectedPermissions, "view:finance"])}>toggle-permission</button>
  ),
}));

const managerRole = { _id: "role_mgr", name: "MANAGER", permissions: ["finalize:financed_deal"] };

afterEach(() => {
  cleanup();
  updateRole.mockClear();
});

describe("EditRoleDialog", () => {
  test("a permission-only edit does not rename the stored role to its translated label", async () => {
    render(<EditRoleDialog role={managerRole} open onOpenChange={() => {}} />);

    expect(screen.getByLabelText("RoleName")).toHaveProperty("value", "Manager");
    fireEvent.click(screen.getByText("toggle-permission"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    expect(updateRole.mock.calls[0][0]).toEqual({
      orgId: "org_1",
      roleId: "role_mgr",
      name: undefined,
      permissions: ["finalize:financed_deal", "view:finance"],
    });
  });

  test("an explicit rename is still sent", async () => {
    render(<EditRoleDialog role={managerRole} open onOpenChange={() => {}} />);

    fireEvent.change(screen.getByLabelText("RoleName"), { target: { value: "Deal Desk" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(1));
    expect(updateRole.mock.calls[0][0]).toMatchObject({ name: "Deal Desk" });
  });

  // SCRUM-413 PR-B: a retired-permission refusal reaches the user as the
  // localized ServerError_PERMISSION_RETIRED entry, not the server's English.
  test("a PERMISSION_RETIRED refusal is shown through the localized dictionary entry", async () => {
    updateRole.mockRejectedValueOnce(
      new ConvexError({ code: "PERMISSION_RETIRED", message: "server english text" })
    );
    render(<EditRoleDialog role={managerRole} open onOpenChange={() => {}} />);

    fireEvent.click(screen.getByText("toggle-permission"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith("localized retired text");
  });});
