/**
 * SCRUM-887 slice A: the two explicit confirmations the server can ask for in one save (a declared
 * shared legal identity, and "this is a different supplier"), driven through the real components
 * against the real public mutations.
 *
 * ## Why a real backend
 *
 * The loop this guards (LEGAL_IDENTITY_EXISTS, then DUPLICATE_CANDIDATES, then LEGAL_IDENTITY_EXISTS
 * again) is a property of the two together: the server asks for the second confirmation only after
 * the first is sent. A stub that throws each error once cannot show a user stuck between them. So
 * `useMutation` here calls the real `suppliers.create` / `suppliers.update` through convex-test, and
 * the supplier names and tax ids below are what make the real server ask for both.
 *
 * ## What this does NOT cover
 *
 * How the panels look and read in Arabic. The strings are the real English dictionary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { convexTestWithComponents } from "../../../test-utils/convexTest";
import { seedOrgWithMember } from "../../../test-utils/seedOrg";
import schema from "../../../convex/schema";
import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PERMISSIONS } from "../../../convex/utils/permissions";

const backend = vi.hoisted(() => ({
  client: null as null | { mutation: (reference: unknown, args: unknown) => Promise<unknown> },
  queryResults: new Map<string, unknown>(),
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /** What the real server answered to each call, in order: "OK" or the refusal code. */
  answers: [] as string[],
  pushed: [] as string[],
}));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      t: (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key,
      language: "en",
      isRtl: false,
      dir: "ltr",
    }),
  };
});
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: () => true }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (url: string) => backend.pushed.push(url) }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => backend.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      backend.calls.push({ name: getFunctionName(reference), args });
      try {
        const result = await backend.client!.mutation(reference, args);
        backend.answers.push("OK");
        return result;
      } catch (error) {
        backend.answers.push((error as { data?: { code?: string } }).data?.code ?? "ERROR");
        throw error;
      }
    },
  };
});

import { SupplierCreateDialog } from "./SupplierCreateDialog";
import { SupplierDetailScreen } from "./SupplierDetailScreen";
import { useSupplierCreateFlow } from "../useSupplierCreateFlow";
import { dictionaries } from "@/lib/i18n/dictionaries";

const en = dictionaries.en as Record<string, string>;
const MODULES = import.meta.glob("../../../convex/**/*.*s");

let seq = 0;
async function seedRegistry() {
  const t = convexTestWithComponents(schema, MODULES);
  const seeded = await seedOrgWithMember(t, {
    clerkId: `confirm-${++seq}`,
    permissions: [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.MANAGE_FINANCE],
    orgName: "Confirmations Org",
    roleName: "ACCOUNTANT",
  });
  await t.mutation(internal.suppliers.initialiseRegistry, { orgId: seeded.orgId });
  backend.client = seeded.identity as unknown as typeof backend.client;
  const gulf = await seeded.identity.mutation(api.suppliers.create, {
    orgId: seeded.orgId,
    idempotencyKey: `seed-${seq}-gulf`,
    displayName: "Gulf Motors",
    taxId: "TX-1",
    taxJurisdiction: "JO",
  });
  const suppliers = () => t.run((ctx) => ctx.db.query("suppliers").collect());
  return { t, ...seeded, gulfId: gulf.supplierId, suppliers };
}

beforeEach(() => {
  backend.queryResults.clear();
  backend.calls.length = 0;
  backend.answers.length = 0;
  backend.pushed.length = 0;
});
afterEach(cleanup);

const typeInto = (container: HTMLElement, key: string, value: string) =>
  fireEvent.change(within(container).getByLabelText(en[key]), { target: { value } });

describe("create: a name match and a shared legal identity together", () => {
  async function reachLegalIdentityPanel(orgId: Id<"organizations">) {
    render(<SupplierCreateDialog orgId={orgId} open onOpenChange={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    typeInto(dialog, "SuppliersFieldDisplayName", "Gulf Motors");
    typeInto(dialog, "SuppliersFieldTaxId", "TX-1");
    typeInto(dialog, "SuppliersFieldTaxJurisdiction", "JO");
    fireEvent.click(within(dialog).getByRole("button", { name: en.SuppliersCreateSubmit }));
    const legal = await within(dialog).findByRole("group", { name: en.SuppliersLegalTitle });
    return { dialog, legal };
  }

  test("same name and same legal identity create the supplier after the two explicit confirmations", async () => {
    const { orgId, gulfId, suppliers } = await seedRegistry();
    const { dialog, legal } = await reachLegalIdentityPanel(orgId);

    // First confirmation: declare the shared legal identity, with a reason.
    fireEvent.change(within(legal).getByLabelText(en.SuppliersLegalShareReason), { target: { value: "Second branch" } });
    fireEvent.click(within(legal).getByRole("button", { name: en.SuppliersLegalShareSubmit }));
    const duplicates = await within(dialog).findByRole("group", { name: en.SuppliersDupTitle });
    // Nothing is created yet: the second confirmation is still outstanding.
    expect(await suppliers()).toHaveLength(1);
    expect(backend.pushed).toEqual([]);

    // Second confirmation: "this is a different supplier".
    fireEvent.click(within(duplicates).getByRole("button", { name: en.SuppliersDupConfirmDistinct }));
    await waitFor(() => expect(backend.answers).toHaveLength(3));
    // The server asks for the legal identity, then the duplicate check, then accepts. It must not
    // ask for the legal identity a second time.
    expect(backend.answers).toEqual(["SUPPLIER_LEGAL_IDENTITY_EXISTS", "SUPPLIER_DUPLICATE_CANDIDATES", "OK"]);
    await waitFor(() => expect(backend.pushed).toHaveLength(1));

    const rows = await suppliers();
    expect(rows).toHaveLength(2);
    const created = rows.find((row) => row._id !== gulfId)!;
    expect(created).toMatchObject({
      displayName: "Gulf Motors",
      sharedLegalIdentityOf: gulfId,
      sharedLegalIdentityReason: "Second branch",
    });
    // The final request carried both answers; the screen never invented either of them.
    const last = backend.calls.at(-1)!.args;
    expect(last).toMatchObject({ sharedLegalIdentityOf: gulfId, sharedLegalIdentityReason: "Second branch", confirmDistinctFrom: [gulfId] });
  });

  test("editing the name or the tax identity after a confirmation drops it: the server is asked fresh", async () => {
    const { orgId, gulfId, suppliers } = await seedRegistry();
    const { dialog, legal } = await reachLegalIdentityPanel(orgId);
    fireEvent.change(within(legal).getByLabelText(en.SuppliersLegalShareReason), { target: { value: "Second branch" } });
    fireEvent.click(within(legal).getByRole("button", { name: en.SuppliersLegalShareSubmit }));
    await within(dialog).findByRole("group", { name: en.SuppliersDupTitle });

    // The user changes their mind about the identity. The earlier share must not follow the new payload.
    typeInto(dialog, "SuppliersFieldTaxId", "TX-1");
    typeInto(dialog, "SuppliersFieldDisplayName", "Gulf Motors Branch");
    expect(within(dialog).queryByRole("group", { name: en.SuppliersDupTitle })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: en.SuppliersCreateSubmit }));

    // The edited payload shares the tax id again, so the server again asks about the legal identity
    // first. Nothing was created on the strength of the old answer.
    await within(dialog).findByRole("group", { name: en.SuppliersLegalTitle });
    expect(await suppliers()).toHaveLength(1);
    expect(backend.calls.at(-1)!.args).not.toHaveProperty("sharedLegalIdentityOf");
    expect(backend.calls.at(-1)!.args).not.toHaveProperty("confirmDistinctFrom");
    expect(gulfId).toBeTruthy();
  });

  test("the create hook drops earlier confirmations when the payload it is given changes, whoever calls it", async () => {
    const { orgId, gulfId } = await seedRegistry();
    const { result } = renderHook(() => useSupplierCreateFlow(orgId));
    const sameIdentity = { displayName: "Gulf Motors", taxId: "TX-1", taxJurisdiction: "JO" };

    await act(async () => {
      await result.current.submit(sameIdentity, { sharedLegalIdentityOf: gulfId, sharedLegalIdentityReason: "Second branch" });
    });
    await waitFor(() => expect(result.current.candidates).not.toBeNull());

    // A different name with the same identity, and no share chosen for it.
    await act(async () => {
      await result.current.submit({ ...sameIdentity, displayName: "Gulf Motors Branch" }, { confirmDistinctFrom: [gulfId] });
    });
    const sent = backend.calls.at(-1)!.args;
    expect(sent).not.toHaveProperty("sharedLegalIdentityOf");
    expect(result.current.legalConflict).toEqual({ existingSupplierId: gulfId });
  });
});

describe("edit: a name match and a shared legal identity together", () => {
  test("renaming onto a taken name and identity saves after the two explicit confirmations", async () => {
    const { t, orgId, identity, gulfId, suppliers } = await seedRegistry();
    const branch = await identity.mutation(api.suppliers.create, {
      orgId,
      idempotencyKey: "seed-branch",
      displayName: "Riyadh Branch",
      taxId: "TX-2",
      taxJurisdiction: "JO",
    });
    backend.queryResults.set("suppliers:get", await identity.query(api.suppliers.get, { orgId, supplierId: branch.supplierId }));
    render(<SupplierDetailScreen orgId={orgId} supplierId={branch.supplierId} />);

    typeInto(document.body, "SuppliersFieldDisplayName", "Gulf Motors");
    typeInto(document.body, "SuppliersNameReason", "Rebranded");
    typeInto(document.body, "SuppliersFieldTaxId", "TX-1");
    fireEvent.click(screen.getByRole("button", { name: en.SuppliersEditSubmit }));

    const legal = await screen.findByRole("group", { name: en.SuppliersLegalTitle });
    fireEvent.change(within(legal).getByLabelText(en.SuppliersLegalShareReason), { target: { value: "Same legal entity" } });
    fireEvent.click(within(legal).getByRole("button", { name: en.SuppliersLegalShareSubmit }));

    const duplicates = await screen.findByRole("group", { name: en.SuppliersDupTitle });
    fireEvent.click(within(duplicates).getByRole("button", { name: en.SuppliersDupConfirmDistinct }));

    await waitFor(() => expect(backend.answers).toHaveLength(3));
    expect(backend.answers).toEqual(["SUPPLIER_LEGAL_IDENTITY_EXISTS", "SUPPLIER_DUPLICATE_CANDIDATES", "OK"]);
    await waitFor(async () => {
      const row = (await suppliers()).find((s) => s._id === branch.supplierId)!;
      expect(row.displayName).toBe("Gulf Motors");
    });
    const row = (await suppliers()).find((s) => s._id === branch.supplierId)!;
    expect(row).toMatchObject({ taxId: "TX-1", sharedLegalIdentityOf: gulfId, sharedLegalIdentityReason: "Same legal entity" });
    expect(backend.calls.at(-1)!.args).toMatchObject({ sharedLegalIdentityOf: gulfId, confirmDistinctFrom: [gulfId] });
    expect(t).toBeTruthy();
  });
});
