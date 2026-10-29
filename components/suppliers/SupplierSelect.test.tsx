/**
 * SCRUM-868 P2: the supplier picker that replaces free-text supplier entry in the pilot vehicle forms.
 * It hands back a supplier ID (the server writes the name snapshot), searches the master by name or alias,
 * creates inline only for MANAGE_FINANCE, and shows every state in English and Arabic.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";

const world = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: [] as string[],
  permissionsLoading: false,
  /** undefined = still loading; an array = the page of the unfiltered list. */
  listRows: undefined as undefined | Array<{ _id: string; displayName: string; status: "ACTIVE" | "INACTIVE" }>,
  searchRows: undefined as undefined | Array<{ _id: string; displayName: string; status: "ACTIVE" | "INACTIVE" }>,
  queryThrows: false,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  createCalls: [] as Array<Record<string, unknown>>,
  createImpl: undefined as undefined | ((args: Record<string, unknown>) => Promise<{ supplierId: string }>),
}));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key,
      language: world.locale,
      isRtl: world.locale === "ar",
      dir: world.locale === "ar" ? "rtl" : "ltr",
    }),
  };
});
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isLoading: world.permissionsLoading,
    hasPermission: (permission: string) => world.permissions.includes(permission),
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      world.queryCalls.push({ name, args });
      if (world.queryThrows) throw new Error("query failed");
      if (args === "skip") return undefined;
      if (name === "suppliers:list") return world.listRows === undefined ? undefined : { page: world.listRows };
      if (name === "suppliers:search") return world.searchRows;
      return undefined;
    },
    useMutation: () => async (args: Record<string, unknown>) => {
      world.createCalls.push(args);
      if (!world.createImpl) throw new Error("no create stub");
      return world.createImpl(args);
    },
  };
});

import { SupplierSelect } from "./SupplierSelect";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;
const ORG = "org_1" as never;

const gulf = { _id: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE" as const };
const atiwi = { _id: "sup_atiwi", displayName: "Atiwi Trading", status: "ACTIVE" as const };
const dormant = { _id: "sup_dormant", displayName: "Dormant Co", status: "INACTIVE" as const };

beforeEach(() => {
  world.locale = "en";
  world.permissions = [];
  world.permissionsLoading = false;
  world.listRows = [gulf, atiwi];
  world.searchRows = [];
  world.queryThrows = false;
  world.queryCalls.length = 0;
  world.createCalls.length = 0;
  world.createImpl = undefined;
});
afterEach(cleanup);

function renderPicker(props: Partial<React.ComponentProps<typeof SupplierSelect>> = {}) {
  const onChange = vi.fn();
  render(<SupplierSelect orgId={ORG} value={undefined} onChange={onChange} dataTestId="picker" ariaLabel="Supplier" {...props} />);
  return { onChange };
}
const open = () => fireEvent.click(screen.getByTestId("picker"));
const type = (text: string) => fireEvent.change(screen.getByPlaceholderText(world.locale === "ar" ? ar.SupplierPickerSearchPlaceholder : en.SupplierPickerSearchPlaceholder), { target: { value: text } });

describe("SupplierSelect: choosing", () => {
  test("lists the active suppliers and hands back the picked supplier's id and name", () => {
    world.listRows = [gulf, atiwi, dormant];
    const { onChange } = renderPicker();
    open();
    expect(screen.queryByText("Dormant Co")).toBeNull();
    fireEvent.click(screen.getByTestId("searchable-option-sup_atiwi"));
    expect(onChange).toHaveBeenCalledWith({ id: "sup_atiwi", displayName: "Atiwi Trading" });
  });

  test("the list is asked for the ACTIVE suppliers of the organization only", () => {
    renderPicker();
    const list = world.queryCalls.find((c) => c.name === "suppliers:list" && c.args !== "skip");
    expect(list?.args).toMatchObject({ orgId: "org_1", status: "ACTIVE" });
  });

  test("typing searches the master by the typed text (a name or an alias), and shows what the server returns", () => {
    world.searchRows = [{ _id: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE" }];
    const { onChange } = renderPicker();
    open();
    type("al-khaleej");
    const search = world.queryCalls.filter((c) => c.name === "suppliers:search" && c.args !== "skip").at(-1);
    expect(search?.args).toEqual({ orgId: "org_1", query: "al-khaleej" });
    // The matched row's own name is shown, not the alias that was typed.
    fireEvent.click(screen.getByTestId("searchable-option-sup_gulf"));
    expect(onChange).toHaveBeenCalledWith({ id: "sup_gulf", displayName: "Gulf Motors" });
  });

  test("a stored supplier outside the current results still shows its stored name on the trigger", () => {
    renderPicker({ value: "sup_old", valueLabel: "Old Supplier" });
    expect(screen.getByTestId("picker").textContent).toContain("Old Supplier");
  });
});

describe("SupplierSelect: inline create is gated on MANAGE_FINANCE", () => {
  test("a finance user adds the typed supplier; the new id (not the typed text) is handed back", async () => {
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    world.createImpl = async () => ({ supplierId: "sup_new" });
    const { onChange } = renderPicker();
    open();
    type("Brand New Motors");
    fireEvent.click(screen.getByRole("button", { name: /Brand New Motors/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: "sup_new", displayName: "Brand New Motors" }));
    expect(world.createCalls).toHaveLength(1);
    expect(world.createCalls[0]).toMatchObject({ orgId: "org_1", displayName: "Brand New Motors" });
    expect(String(world.createCalls[0].idempotencyKey)).toMatch(/^supplier-create:/);
    expect(world.createCalls[0]).not.toHaveProperty("confirmDistinctFrom");
  });

  test("without MANAGE_FINANCE there is no create button and the hint says who can add it", () => {
    world.permissions = ["view:vehicles"];
    renderPicker();
    open();
    type("Brand New Motors");
    expect(screen.queryByRole("button", { name: /Brand New Motors/ })).toBeNull();
    expect(screen.getByText(en.SupplierPickerCreateNoPermission)).toBeTruthy();
    expect(world.createCalls).toHaveLength(0);
  });

  test("while permissions are still loading nothing is offered", () => {
    world.permissionsLoading = true;
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    renderPicker();
    open();
    type("Brand New Motors");
    expect(screen.queryByRole("button", { name: /Brand New Motors/ })).toBeNull();
    expect(screen.queryByText(en.SupplierPickerCreateNoPermission)).toBeNull();
  });

  test("an exact name match still offers to add: the server's duplicate confirmation decides, nothing is created silently", async () => {
    // SCRUM-868: two distinct suppliers may share a name once a finance user confirms they differ.
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    world.searchRows = [gulf];
    world.createImpl = async (args) => {
      if (!args.confirmDistinctFrom) {
        throw new ConvexError({
          code: "SUPPLIER_DUPLICATE_CANDIDATES",
          candidates: [{ supplierId: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE" }],
        });
      }
      return { supplierId: "sup_twin" };
    };
    const { onChange } = renderPicker();
    open();
    type("gulf motors");
    // The existing supplier stays pickable, and the add action is offered beside it.
    expect(screen.getByTestId("searchable-option-sup_gulf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add supplier/ }));
    expect(await screen.findByText(en.SupplierPickerSimilarTitle, { selector: "p" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(world.createCalls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: en.SupplierPickerConfirmDistinct }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: "sup_twin", displayName: "gulf motors" }));
    expect(world.createCalls[1].confirmDistinctFrom).toEqual(["sup_gulf"]);
  });

  test("similar suppliers are shown first; the user may use one, or confirm the new one is different", async () => {
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    const candidates = [
      { supplierId: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE" },
      { supplierId: "sup_dormant", displayName: "Dormant Co", status: "INACTIVE" },
    ];
    world.createImpl = async (args) => {
      if (!args.confirmDistinctFrom) throw new ConvexError({ code: "SUPPLIER_DUPLICATE_CANDIDATES", candidates });
      return { supplierId: "sup_distinct" };
    };
    const { onChange } = renderPicker();
    open();
    type("Gulf Motor");
    fireEvent.click(screen.getByRole("button", { name: /Gulf Motor/ }));
    expect(await screen.findByText(en.SupplierPickerSimilarTitle, { selector: "p" })).toBeTruthy();
    // An inactive candidate cannot be used.
    const useButtons = screen.getAllByRole("button", { name: en.SupplierPickerUseExisting }) as HTMLButtonElement[];
    expect(useButtons.map((b) => b.disabled)).toEqual([false, true]);

    fireEvent.click(screen.getByRole("button", { name: en.SupplierPickerConfirmDistinct }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: "sup_distinct", displayName: "Gulf Motor" }));
    expect(world.createCalls).toHaveLength(2);
    expect(world.createCalls[1].confirmDistinctFrom).toEqual(["sup_gulf", "sup_dormant"]);
    // The confirmed retry is a different request, so it carries a different idempotency key.
    expect(world.createCalls[1].idempotencyKey).not.toBe(world.createCalls[0].idempotencyKey);
  });

  test("using a similar existing supplier hands back that supplier and creates nothing more", async () => {
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    world.createImpl = async () => {
      throw new ConvexError({
        code: "SUPPLIER_DUPLICATE_CANDIDATES",
        candidates: [{ supplierId: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE" }],
      });
    };
    const { onChange } = renderPicker();
    open();
    type("Gulf Motor");
    fireEvent.click(screen.getByRole("button", { name: /Gulf Motor/ }));
    fireEvent.click(await screen.findByRole("button", { name: en.SupplierPickerUseExisting }));
    expect(onChange).toHaveBeenCalledWith({ id: "sup_gulf", displayName: "Gulf Motors" });
    expect(world.createCalls).toHaveLength(1);
  });

  test("a coded server refusal is shown in the user's language and nothing is picked", async () => {
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    world.locale = "ar";
    world.createImpl = async () => {
      throw new ConvexError({ code: "SUPPLIER_NOT_FOUND", message: "English server text" });
    };
    const { onChange } = renderPicker();
    open();
    type("مورد جديد");
    fireEvent.click(screen.getByRole("button", { name: /مورد جديد/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ar.ServerError_SUPPLIER_NOT_FOUND);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SupplierSelect: states", () => {
  test("loading shows a status line, not an empty list", () => {
    world.listRows = undefined;
    renderPicker();
    open();
    expect(screen.getByRole("status").textContent).toBe(en.SupplierPickerLoading);
  });

  test("an organization with no suppliers shows the empty text", () => {
    world.listRows = [];
    renderPicker();
    open();
    expect(screen.getByText(en.SupplierPickerEmpty)).toBeTruthy();
  });

  test("a search with no match shows the no-results text", () => {
    world.searchRows = [];
    renderPicker();
    open();
    type("zzz");
    expect(screen.getByText(en.SupplierPickerNoResults)).toBeTruthy();
  });

  test("a failed query shows an error in place of the picker instead of breaking the form", () => {
    world.queryThrows = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderPicker();
    expect(screen.getByRole("alert").textContent).toBe(en.SupplierPickerLoadError);
    spy.mockRestore();
  });

  test("with no organization the picker is disabled and runs no query", () => {
    renderPicker({ orgId: undefined });
    expect((screen.getByTestId("picker") as HTMLButtonElement).disabled).toBe(true);
    expect(world.queryCalls.every((c) => c.args === "skip")).toBe(true);
  });

  test("an invalid picker is marked invalid for assistive technology", () => {
    renderPicker({ invalid: true });
    expect(screen.getByTestId("picker").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("SupplierSelect: Arabic", () => {
  beforeEach(() => {
    world.locale = "ar";
  });

  test("the placeholder, search box, empty and create labels are Arabic", () => {
    world.permissions = [PERMISSIONS.MANAGE_FINANCE];
    world.listRows = [];
    renderPicker();
    expect(screen.getByTestId("picker").textContent).toContain(ar.SupplierPickerPlaceholder);
    open();
    expect(screen.getByPlaceholderText(ar.SupplierPickerSearchPlaceholder)).toBeTruthy();
    expect(screen.getByText(ar.SupplierPickerEmpty)).toBeTruthy();
    type("الخليج");
    expect(screen.getByRole("button", { name: ar.SupplierPickerCreate.replace("{name}", "الخليج") })).toBeTruthy();
  });

  test("the no-permission hint is Arabic", () => {
    world.permissions = [];
    world.searchRows = [];
    renderPicker();
    open();
    type("الخليج");
    expect(screen.getByText(ar.SupplierPickerCreateNoPermission)).toBeTruthy();
  });

  test("a supplier name is isolated with bdi so a Latin name does not reorder an Arabic line", () => {
    renderPicker({ value: "sup_gulf", valueLabel: "Gulf Motors" });
    const bdi = screen.getByTestId("picker").querySelector("bdi");
    expect(bdi?.textContent).toBe("Gulf Motors");
  });

  test("the picker text uses logical (start/end) alignment, so it mirrors in RTL", () => {
    renderPicker();
    open();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/\b(text-left|text-right|pl-\d|pr-\d|ml-\d|mr-\d)\b/);
  });
});

describe("the dictionaries carry every picker string in both languages", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("SupplierPicker") || k.startsWith("ImportSupplier"));
  test("every SupplierPicker and ImportSupplier key has an Arabic text", () => {
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], key).not.toBe(en[key]);
    }
  });

  test("each supplier identity refusal code has an English and an Arabic server-error text", () => {
    for (const code of ["IDENTITY_REQUIRED", "NOT_FOUND", "INACTIVE", "LINK_FROZEN", "ROLE_CONFLICT"]) {
      expect(en[`ServerError_SUPPLIER_${code}`], code).toBeTruthy();
      expect(ar[`ServerError_SUPPLIER_${code}`], code).toBeTruthy();
    }
  });
});
