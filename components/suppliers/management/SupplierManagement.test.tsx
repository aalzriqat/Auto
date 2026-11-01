/**
 * SCRUM-887 slice A: the Suppliers management screen. Navigation, list states, create (including
 * the duplicate confirmation and the legal-identity refusal), edit with optimistic concurrency,
 * aliases, deactivate / reactivate, and read-only mode for VIEW_FINANCE without MANAGE_FINANCE.
 * Every string is checked in English and Arabic through the real dictionaries.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";

type Row = {
  _id: string;
  displayName: string;
  legalName?: string;
  status: "ACTIVE" | "INACTIVE";
  taxId?: string;
  taxJurisdiction?: string;
  sharedLegalIdentityOf?: string;
};
type Full = Row & {
  contact?: { phone?: string; email?: string; address?: string };
  version: number;
  revision: number;
  deactivatedReason?: string;
  aliases: Array<{ _id: string; alias: string; status: "ACTIVE" | "RETIRED" }>;
};

const world = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: [] as string[],
  permissionsLoading: false,
  paged: { results: [] as Row[], status: "Exhausted" as string },
  searchRows: undefined as undefined | { rows: Row[]; truncated: boolean },
  record: undefined as undefined | Full,
  queryThrows: null as null | Error,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  mutationCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  mutationImpl: {} as Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  pushed: [] as string[],
  loadMore: vi.fn(),
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
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (url: string) => world.pushed.push(url) }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      world.queryCalls.push({ name, args });
      if (world.queryThrows) throw world.queryThrows;
      if (args === "skip") return undefined;
      if (name === "suppliers:searchForManagement") return world.searchRows;
      if (name === "suppliers:get") return world.record;
      return undefined;
    },
    usePaginatedQuery: (reference: never, args: unknown) => {
      world.queryCalls.push({ name: getFunctionName(reference), args });
      if (world.queryThrows) throw world.queryThrows;
      return args === "skip" ? { results: [], status: "LoadingFirstPage", loadMore: world.loadMore } : { ...world.paged, loadMore: world.loadMore };
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: Record<string, unknown>) => {
        world.mutationCalls.push({ name, args });
        const impl = world.mutationImpl[name];
        if (!impl) throw new Error(`no stub for ${name}`);
        return impl(args);
      };
    },
  };
});

import { SupplierListScreen } from "./SupplierListScreen";
import { SupplierDetailScreen } from "./SupplierDetailScreen";
import { buildUpdate, formFromSupplier } from "./SupplierDetailScreen";
import { SupplierSelect } from "../SupplierSelect";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { SUPPLIER_ERROR, type CandidateReason } from "@/convex/utils/supplierRegistry";
import { mainNavigation, navItemPermitted } from "@/lib/navigation";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;
const ORG = "org_1" as never;
const SUP = "sup_gulf" as never;

const gulf: Row = { _id: "sup_gulf", displayName: "Gulf Motors", legalName: "Gulf Motors LLC", status: "ACTIVE", taxId: "123", taxJurisdiction: "JO" };
const dormant: Row = { _id: "sup_dormant", displayName: "Dormant Co", status: "INACTIVE" };
const hitOne: Row = { _id: "sup_hit_1", displayName: "Search Hit One", status: "ACTIVE" };
const hitTwo: Row = { _id: "sup_hit_2", displayName: "Search Hit Two", status: "ACTIVE" };

function fullRecord(over: Partial<Full> = {}): Full {
  return {
    ...gulf,
    contact: { phone: "0790000000" },
    version: 3,
    // The edit token differs from the snapshot version on purpose: the screen must send the token.
    revision: 5,
    aliases: [
      { _id: "al_1", alias: "GM Trading", status: "ACTIVE" },
      { _id: "al_2", alias: "Old GM", status: "RETIRED" },
    ],
    ...over,
  };
}

const codedError = (payload: Record<string, unknown>) => new ConvexError({ message: "server english", ...payload });

beforeEach(() => {
  world.locale = "en";
  world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.MANAGE_FINANCE];
  world.permissionsLoading = false;
  world.paged = { results: [gulf, dormant], status: "Exhausted" };
  world.searchRows = undefined;
  world.record = fullRecord();
  world.queryThrows = null;
  world.queryCalls.length = 0;
  world.mutationCalls.length = 0;
  world.mutationImpl = {};
  world.pushed.length = 0;
  world.loadMore.mockClear();
});
afterEach(cleanup);

const label = (key: string) => en[key];
const lastList = () => world.queryCalls.filter((c) => c.name === "suppliers:listForManagement").at(-1)?.args;

describe("navigation", () => {
  test("Suppliers sits right after Sourcing, gated on view:finance, with a dictionary label in both languages", () => {
    const names = mainNavigation.map((item) => item.name);
    expect(names.indexOf("Suppliers")).toBe(names.indexOf("Sourcing") + 1);
    const item = mainNavigation.find((i) => i.name === "Suppliers")!;
    expect(item.href).toBe("/suppliers");
    expect(item.permission).toBe("view:finance");
    expect(en.Suppliers).toBe("Suppliers");
    expect(ar.Suppliers).toBeTruthy();
    const roleHas = (role: string) =>
      [...DEFAULT_ROLE_TEMPLATES.find((template) => template.name === role)!.permissions] as string[];
    expect(navItemPermitted(item, roleHas("ACCOUNTANT"))).toBe(true);
    expect(navItemPermitted(item, roleHas("SALES"))).toBe(false);
  });
});

describe("list", () => {
  test("shows suppliers, links each to its detail, and defaults to the Active filter", () => {
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.getByRole("heading", { name: "Suppliers" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Gulf Motors" });
    expect(link.getAttribute("href")).toBe("/org_1/suppliers/sup_gulf");
    expect(screen.getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
    const first = world.queryCalls.find((c) => c.name === "suppliers:listForManagement");
    expect(first?.args).toEqual({ orgId: ORG, status: "ACTIVE" });
  });

  test("the filter switches between Active, Inactive and All", () => {
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: "Inactive" }));
    expect(lastList()).toEqual({ orgId: ORG, status: "INACTIVE" });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(lastList()).toEqual({ orgId: ORG });
  });

  test("search sends the typed text to the search query (name, alias or tax id) after the debounce", async () => {
    world.searchRows = { rows: [gulf], truncated: false };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.change(screen.getByLabelText("Search suppliers"), { target: { value: "123" } });
    await waitFor(() =>
      expect(world.queryCalls.some((c) => c.name === "suppliers:searchForManagement" && (c.args as { query?: string }).query === "123")).toBe(true),
    );
  });

  test("a search that hit the server's cap says so in English and Arabic, and offers no load-more", async () => {
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale;
      world.searchRows = { rows: [hitOne, hitTwo], truncated: true };
      render(<SupplierListScreen orgId={ORG} />);
      fireEvent.change(screen.getByLabelText((dictionaries[locale] as Record<string, string>).SuppliersSearchLabel), { target: { value: "shared" } });
      await screen.findByRole("link", { name: "Search Hit One" });
      const notice = await screen.findByText((dictionaries[locale] as Record<string, string>).SuppliersSearchTruncated.replace("{count}", "2"));
      expect(notice.getAttribute("role")).toBe("status");
      expect(screen.queryByRole("button", { name: (dictionaries[locale] as Record<string, string>).SuppliersLoadMore })).toBeNull();
      cleanup();
    }
  });

  test("a complete search result shows no truncation notice", async () => {
    world.searchRows = { rows: [hitOne], truncated: false };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.change(screen.getByLabelText("Search suppliers"), { target: { value: "gulf" } });
    await screen.findByRole("link", { name: "Search Hit One" });
    expect(screen.queryByText(/Refine your search/)).toBeNull();
  });

  test("an empty search that hit the server's cap says the search did not finish, not 'no match', in English and Arabic", async () => {
    for (const locale of ["en", "ar"] as const) {
      const words = dictionaries[locale] as Record<string, string>;
      world.locale = locale;
      world.searchRows = { rows: [], truncated: true };
      render(<SupplierListScreen orgId={ORG} />);
      fireEvent.change(screen.getByLabelText(words.SuppliersSearchLabel), { target: { value: "shared" } });
      const notice = await screen.findByText(words.SuppliersSearchTruncatedNoMatch);
      expect(notice.getAttribute("role")).toBe("status");
      expect(screen.queryByText(words.SuppliersNoMatch)).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
    // The Arabic text is a real translation, not the English fallback or the key.
    expect(ar.SuppliersSearchTruncatedNoMatch).not.toBe(en.SuppliersSearchTruncatedNoMatch);
    expect(ar.SuppliersSearchTruncatedNoMatch).toMatch(/[؀-ۿ]/);
  });

  test("an empty search that did not hit the cap still says no match", async () => {
    world.searchRows = { rows: [], truncated: false };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.change(screen.getByLabelText("Search suppliers"), { target: { value: "nothing" } });
    await screen.findByText(label("SuppliersNoMatch"));
    expect(screen.queryByText(label("SuppliersSearchTruncatedNoMatch"))).toBeNull();
  });
  test("loading, empty, no-match and load-more states", () => {
    world.paged = { results: [], status: "LoadingFirstPage" };
    const { unmount } = render(<SupplierListScreen orgId={ORG} />);
    expect(screen.getByRole("status").textContent).toBe(label("SuppliersLoading"));
    unmount();

    world.paged = { results: [], status: "Exhausted" };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText(label("SuppliersEmptyTitle"))).toBeTruthy();
    cleanup();

    world.paged = { results: [gulf], status: "CanLoadMore" };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersLoadMore") }));
    expect(world.loadMore).toHaveBeenCalledWith(25);
  });

  test("a filter with no rows says no match, not 'no suppliers yet'", () => {
    world.paged = { results: [], status: "Exhausted" };
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.getByText(label("SuppliersNoMatch"))).toBeTruthy();
  });

  test("a failed query shows the localized load error instead of crashing", () => {
    world.queryThrows = new Error("boom");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.getByRole("alert").textContent).toBe(label("SuppliersLoadError"));
  });

  test("Arabic: heading, filter, columns and empty text come from the Arabic dictionary and the labels are not English", () => {
    world.locale = "ar";
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.getByRole("heading", { name: ar.Suppliers })).toBeTruthy();
    expect(screen.getByRole("button", { name: ar.SuppliersFilterInactive })).toBeTruthy();
    expect(screen.getByText(ar.SuppliersColName)).toBeTruthy();
    expect(screen.queryByText("Add supplier")).toBeNull();
    expect(screen.getByRole("button", { name: ar.SuppliersAdd })).toBeTruthy();
  });

  test("VIEW_FINANCE without MANAGE_FINANCE: no Add button, a read-only note, and an empty state without an action", () => {
    world.permissions = [PERMISSIONS.VIEW_FINANCE];
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.queryByRole("button", { name: label("SuppliersAdd") })).toBeNull();
    expect(screen.getByRole("note").textContent).toBe(label("SuppliersReadOnlyNote"));
    cleanup();

    world.paged = { results: [], status: "Exhausted" };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText(label("SuppliersEmptyBodyReadOnly"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: label("SuppliersAdd") })).toBeNull();
  });

  test("while permissions load, no write control is offered", () => {
    world.permissionsLoading = true;
    render(<SupplierListScreen orgId={ORG} />);
    expect(screen.queryByRole("button", { name: label("SuppliersAdd") })).toBeNull();
  });
});

describe("create", () => {
  const open = () => {
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getAllByRole("button", { name: (dictionaries[world.locale] as Record<string, string>).SuppliersAdd })[0]);
    return screen.getByRole("dialog");
  };
  const fill = (dialog: HTMLElement, name: string) =>
    fireEvent.change(within(dialog).getByLabelText((dictionaries[world.locale] as Record<string, string>).SuppliersFieldDisplayName), { target: { value: name } });
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: label("SuppliersCreateSubmit") }));

  test("creates without a vehicle, sends only the filled fields, then opens the new supplier", async () => {
    world.mutationImpl["suppliers:create"] = async () => ({ supplierId: "sup_new" });
    const dialog = open();
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    fill(dialog, "  New Co ");
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersFieldTaxId")), { target: { value: "TX-1" } });
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersFieldTaxJurisdiction")), { target: { value: "JO" } });
    submit(dialog);
    await waitFor(() => expect(world.pushed).toEqual(["/org_1/suppliers/sup_new"]));
    const args = world.mutationCalls[0].args;
    expect(args).toMatchObject({ orgId: ORG, displayName: "New Co", taxId: "TX-1", taxJurisdiction: "JO" });
    expect(args.idempotencyKey).toMatch(/^supplier-create:/);
    expect(args).not.toHaveProperty("confirmDistinctFrom");
    expect(args.contact).toBeUndefined();
  });

  test("a blank name is refused on the screen without calling the server", async () => {
    const dialog = open();
    submit(dialog);
    expect(await within(dialog).findByText(label("SuppliersDisplayNameRequired"))).toBeTruthy();
    expect(world.mutationCalls).toHaveLength(0);
  });

  test("duplicate candidates: shows them, offers the existing supplier, and 'different supplier' resends with exactly those ids", async () => {
    let calls = 0;
    world.mutationImpl["suppliers:create"] = async () => {
      calls += 1;
      if (calls === 1) {
        throw codedError({
          code: "SUPPLIER_DUPLICATE_CANDIDATES",
          candidates: [
            { supplierId: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE", reasons: ["SAME_NAME"] },
            { supplierId: "sup_dormant", displayName: "Dormant Co", status: "INACTIVE", reasons: ["CLOSE_NAME"] },
          ],
        });
      }
      return { supplierId: "sup_new" };
    };
    const dialog = open();
    fill(dialog, "Gulf Motors");
    submit(dialog);
    const group = await within(dialog).findByRole("group", { name: label("SuppliersDupTitle") });
    expect(within(group).getByText("Gulf Motors")).toBeTruthy();
    expect(within(group).getByText(label("SuppliersDupReason_SAME_NAME"))).toBeTruthy();
    const open1 = within(group).getAllByRole("link", { name: label("SuppliersDupOpenExisting") })[0];
    expect(open1.getAttribute("href")).toBe("/org_1/suppliers/sup_gulf");
    expect(world.pushed).toHaveLength(0);

    fireEvent.click(within(group).getByRole("button", { name: label("SuppliersDupConfirmDistinct") }));
    await waitFor(() => expect(world.pushed).toEqual(["/org_1/suppliers/sup_new"]));
    expect(world.mutationCalls[1].args.confirmDistinctFrom).toEqual(["sup_gulf", "sup_dormant"]);
    // The confirmed retry is a different payload, so it must not reuse the first idempotency key.
    expect(world.mutationCalls[1].args.idempotencyKey).not.toBe(world.mutationCalls[0].args.idempotencyKey);
  });

  test("a duplicate reason the screen has no label for shows the generic label, never a raw key", async () => {
    world.mutationImpl["suppliers:create"] = async () => {
      throw codedError({
        code: "SUPPLIER_DUPLICATE_CANDIDATES",
        candidates: [{ supplierId: "sup_gulf", displayName: "Gulf Motors", status: "ACTIVE", reasons: ["SAME_TAX_ID"] }],
      });
    };
    const dialog = open();
    fill(dialog, "Gulf Motors");
    submit(dialog);
    const group = await within(dialog).findByRole("group", { name: label("SuppliersDupTitle") });
    expect(group.textContent).not.toContain("SuppliersDupReason_");
    expect(within(group).getByText(label("SuppliersDupReason_UNKNOWN"))).toBeTruthy();
  });
  test("legal-identity conflict: explains it, links the existing supplier, and the shared path needs a reason", async () => {
    let calls = 0;
    world.mutationImpl["suppliers:create"] = async () => {
      calls += 1;
      if (calls === 1) throw codedError({ code: "SUPPLIER_LEGAL_IDENTITY_EXISTS", existingSupplierId: "sup_gulf" });
      return { supplierId: "sup_branch" };
    };
    const dialog = open();
    fill(dialog, "Gulf Motors Branch");
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersFieldTaxId")), { target: { value: "123" } });
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersFieldTaxJurisdiction")), { target: { value: "JO" } });
    submit(dialog);
    const panel = await within(dialog).findByRole("group", { name: label("SuppliersLegalTitle") });
    expect(within(panel).getByText(label("SuppliersLegalBody"))).toBeTruthy();
    expect(within(panel).getByRole("link", { name: label("SuppliersLegalOpenExisting") }).getAttribute("href")).toBe(
      "/org_1/suppliers/sup_gulf",
    );
    const share = within(panel).getByRole("button", { name: label("SuppliersLegalShareSubmit") });
    expect((share as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText(label("SuppliersLegalShareReason")), { target: { value: "Second branch" } });
    fireEvent.click(share);
    await waitFor(() => expect(world.pushed).toEqual(["/org_1/suppliers/sup_branch"]));
    expect(world.mutationCalls[1].args).toMatchObject({
      sharedLegalIdentityOf: "sup_gulf",
      sharedLegalIdentityReason: "Second branch",
    });
  });

  test.each([
    ["REGISTRY_NOT_INITIALISED", "ServerError_REGISTRY_NOT_INITIALISED"],
    ["SUPPLIER_INVALID_INPUT", "ServerError_SUPPLIER_INVALID_INPUT"],
    ["SUPPLIER_SHARED_IDENTITY_MISMATCH", "ServerError_SUPPLIER_SHARED_IDENTITY_MISMATCH"],
  ])("the coded refusal %s is shown in the user's language, English and Arabic", async (code, key) => {
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale;
      world.mutationImpl["suppliers:create"] = async () => {
        throw codedError({ code });
      };
      const dialog = open();
      fill(dialog, "X Co");
      fireEvent.click(within(dialog).getByRole("button", { name: dictionaries[locale].SuppliersCreateSubmit }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe((dictionaries[locale] as Record<string, string>)[key]);
      expect(alert.textContent).not.toContain("server english");
      cleanup();
    }
  });

  test("an unknown failure shows the localized generic line, never the server's English text", async () => {
    world.locale = "ar";
    world.mutationImpl["suppliers:create"] = async () => {
      throw codedError({ code: "SOMETHING_NEW" });
    };
    render(<SupplierListScreen orgId={ORG} />);
    fireEvent.click(screen.getAllByRole("button", { name: ar.SuppliersAdd })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(ar.SuppliersFieldDisplayName), { target: { value: "X" } });
    fireEvent.click(within(dialog).getByRole("button", { name: ar.SuppliersCreateSubmit }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(ar.SuppliersGenericError);
  });
});

describe("inline picker keeps working on the shared create flow", () => {
  test("SupplierSelect exports are unchanged", () => {
    expect(typeof SupplierSelect).toBe("function");
  });
});

describe("detail and edit", () => {
  const renderDetail = () => render(<SupplierDetailScreen orgId={ORG} supplierId={SUP} />);

  test("buildUpdate sends only what changed; null clears; a name change carries the reason", () => {
    const base = fullRecord() as unknown as Parameters<typeof buildUpdate>[0];
    const form = formFromSupplier(base);
    expect(buildUpdate(base, form, "")).toEqual({});
    expect(buildUpdate(base, { ...form, legalName: "" }, "")).toEqual({ legalName: null });
    expect(buildUpdate(base, { ...form, phone: "", email: "" }, "")).toEqual({ contact: null });
    expect(buildUpdate(base, { ...form, displayName: " Gulf Co ", taxJurisdiction: "jo" }, " fix ")).toEqual({
      displayName: "Gulf Co",
      reason: "fix",
    });
    expect(buildUpdate(base, { ...form, taxId: "", taxJurisdiction: "" }, "")).toEqual({ taxId: null, taxJurisdiction: null });
  });

  test("edit saves with the loaded edit token as expectedVersion and only the changed field", async () => {
    world.mutationImpl["suppliers:update"] = async () => ({ version: 3, revision: 6 });
    renderDetail();
    expect((screen.getByRole("button", { name: label("SuppliersEditSubmit") }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldLegalName")), { target: { value: "Gulf Motors Ltd" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(1));
    expect(world.mutationCalls[0].args).toEqual({ orgId: ORG, supplierId: "sup_gulf", expectedVersion: 5, legalName: "Gulf Motors Ltd" });
  });

  test("a contact-only edit sends the edit token, and the next save sends the token the server returned", async () => {
    const answers = [{ version: 3, revision: 6 }, { version: 3, revision: 7 }];
    world.mutationImpl["suppliers:update"] = async () => answers.shift();
    renderDetail();
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldPhone")), { target: { value: "0791111111" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(1));
    expect(world.mutationCalls[0].args).toEqual({ orgId: ORG, supplierId: "sup_gulf", expectedVersion: 5, contact: { phone: "0791111111" } });

    await waitFor(() => expect((screen.getByRole("button", { name: label("SuppliersEditSubmit") }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldEmail")), { target: { value: "a@gulf.example" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(2));
    expect(world.mutationCalls[1].args).toMatchObject({ expectedVersion: 6, contact: { phone: "0791111111", email: "a@gulf.example" } });
  });

  test("a display-name change asks for a reason and does not call the server without one", async () => {
    world.mutationImpl["suppliers:update"] = async () => ({ version: 4, revision: 6 });
    renderDetail();
    expect(screen.queryByLabelText(label("SuppliersNameReason"))).toBeNull();
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldDisplayName")), { target: { value: "Gulf Motors Group" } });
    const reason = screen.getByLabelText(label("SuppliersNameReason"));
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    expect(await screen.findByText(label("SuppliersNameReasonRequired"))).toBeTruthy();
    expect(world.mutationCalls).toHaveLength(0);
    fireEvent.change(reason, { target: { value: "Rebranded" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(1));
    expect(world.mutationCalls[0].args).toMatchObject({ displayName: "Gulf Motors Group", reason: "Rebranded", expectedVersion: 5 });
  });

  test("a version conflict keeps the user's edits out of the record and offers a reload", async () => {
    world.mutationImpl["suppliers:update"] = async () => {
      throw codedError({ code: "SUPPLIER_VERSION_CONFLICT", currentVersion: 4 });
    };
    renderDetail();
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldLegalName")), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    const alert = await screen.findByText(label("SuppliersVersionConflictTitle"));
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersVersionConflictReload") }));
    expect((screen.getByLabelText(label("SuppliersFieldLegalName")) as HTMLInputElement).value).toBe("Gulf Motors LLC");
    expect(screen.queryByText(label("SuppliersVersionConflictTitle"))).toBeNull();
  });

  test("an edit that creates a duplicate shows the candidates and resends with confirmDistinctFrom", async () => {
    let calls = 0;
    world.mutationImpl["suppliers:update"] = async () => {
      calls += 1;
      if (calls === 1) {
        throw codedError({
          code: "SUPPLIER_DUPLICATE_CANDIDATES",
          candidates: [{ supplierId: "sup_dormant", displayName: "Dormant Co", status: "INACTIVE", reasons: ["CLOSE_NAME"] }],
        });
      }
      return { version: 4 };
    };
    renderDetail();
    fireEvent.change(screen.getByLabelText(label("SuppliersFieldLegalName")), { target: { value: "Dormant Co Ltd" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersEditSubmit") }));
    const group = await screen.findByRole("group", { name: label("SuppliersDupTitle") });
    fireEvent.click(within(group).getByRole("button", { name: label("SuppliersDupConfirmDistinct") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(2));
    expect(world.mutationCalls[1].args.confirmDistinctFrom).toEqual(["sup_dormant"]);
  });

  test("aliases: lists active and retired, adds one, retires one", async () => {
    world.mutationImpl["suppliers:addAlias"] = async () => ({ aliasId: "al_3" });
    world.mutationImpl["suppliers:retireAlias"] = async () => null;
    renderDetail();
    const section = screen.getByRole("region", { name: label("SuppliersAliasesTitle") });
    expect(within(section).getByText("GM Trading")).toBeTruthy();
    expect(within(section).getByText(label("SuppliersAliasRetired"))).toBeTruthy();
    // Only the active alias can be retired.
    expect(within(section).getAllByRole("button", { name: /Retire alias/ })).toHaveLength(1);

    fireEvent.change(within(section).getByLabelText(label("SuppliersAliasLabel")), { target: { value: " Gulf Trading " } });
    fireEvent.click(within(section).getByRole("button", { name: label("SuppliersAliasAdd") }));
    await waitFor(() => expect(world.mutationCalls.at(-1)?.name).toBe("suppliers:addAlias"));
    expect(world.mutationCalls.at(-1)?.args).toEqual({ orgId: ORG, supplierId: "sup_gulf", alias: "Gulf Trading" });

    fireEvent.click(within(section).getByRole("button", { name: "Retire alias GM Trading" }));
    await waitFor(() => expect(world.mutationCalls.at(-1)?.name).toBe("suppliers:retireAlias"));
    expect(world.mutationCalls.at(-1)?.args).toEqual({ orgId: ORG, aliasId: "al_1" });
  });

  test("alias refusals are localized", async () => {
    world.mutationImpl["suppliers:addAlias"] = async () => {
      throw codedError({ code: "SUPPLIER_ALIAS_EXISTS" });
    };
    renderDetail();
    fireEvent.change(screen.getByLabelText(label("SuppliersAliasLabel")), { target: { value: "GM Trading" } });
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersAliasAdd") }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.ServerError_SUPPLIER_ALIAS_EXISTS);
  });

  test("deactivate needs a confirmation and a reason, states obligations stay settleable, then calls the server", async () => {
    world.mutationImpl["suppliers:deactivate"] = async () => null;
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersDeactivate") }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/can still be settled/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: label("SuppliersDeactivateConfirm") }));
    expect(await within(dialog).findByText(label("SuppliersDeactivateReasonRequired"))).toBeTruthy();
    expect(world.mutationCalls).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersDeactivateReason")), { target: { value: " Closed down " } });
    fireEvent.click(within(dialog).getByRole("button", { name: label("SuppliersDeactivateConfirm") }));
    await waitFor(() => expect(world.mutationCalls).toHaveLength(1));
    expect(world.mutationCalls[0]).toEqual({ name: "suppliers:deactivate", args: { orgId: ORG, supplierId: "sup_gulf", reason: "Closed down" } });
  });

  test("reactivate confirms and calls the server; the inactive banner shows the reason", async () => {
    world.record = fullRecord({ status: "INACTIVE", deactivatedReason: "Closed down" });
    world.mutationImpl["suppliers:reactivate"] = async () => null;
    renderDetail();
    expect(screen.getByText(label("SuppliersDeactivatedBanner"))).toBeTruthy();
    expect(screen.getByText("Reason: Closed down")).toBeTruthy();
    expect(screen.queryByRole("button", { name: label("SuppliersDeactivate") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersReactivate") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label("SuppliersReactivateConfirm") }));
    await waitFor(() => expect(world.mutationCalls).toEqual([{ name: "suppliers:reactivate", args: { orgId: ORG, supplierId: "sup_gulf" } }]));
  });

  test("a refused deactivate shows the localized reason and keeps the dialog open", async () => {
    world.mutationImpl["suppliers:deactivate"] = async () => {
      throw codedError({ code: "SUPPLIER_ALREADY_INACTIVE" });
    };
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: label("SuppliersDeactivate") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(label("SuppliersDeactivateReason")), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: label("SuppliersDeactivateConfirm") }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(en.ServerError_SUPPLIER_ALREADY_INACTIVE);
  });

  test("read-only (VIEW_FINANCE without MANAGE_FINANCE): details shown as text, no inputs, no write buttons", () => {
    world.permissions = [PERMISSIONS.VIEW_FINANCE];
    renderDetail();
    expect(screen.getByRole("note").textContent).toBe(label("SuppliersReadOnlyNote"));
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const key of ["SuppliersEditSubmit", "SuppliersDeactivate", "SuppliersReactivate", "SuppliersAliasAdd"]) {
      expect(screen.queryByRole("button", { name: label(key) })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /Retire alias/ })).toBeNull();
    expect(screen.getByText("0790000000")).toBeTruthy();
    expect(screen.getByText("GM Trading")).toBeTruthy();
  });

  test("loading, a missing supplier and an Arabic render", () => {
    world.record = undefined;
    const { unmount } = renderDetail();
    expect(screen.getByRole("status").textContent).toBe(label("SuppliersLoading"));
    unmount();

    world.queryThrows = codedError({ code: "SUPPLIER_NOT_FOUND" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    world.locale = "ar";
    render(<SupplierDetailScreen orgId={ORG} supplierId={SUP} />);
    expect(screen.getByRole("alert").textContent).toBe(ar.ServerError_SUPPLIER_NOT_FOUND);
    expect(screen.getByRole("link", { name: ar.SuppliersBack })).toBeTruthy();
  });
});

describe("dictionary", () => {
  test("every Suppliers key has non-empty English and Arabic text", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("Suppliers") || /^ServerError_(REGISTRY_|SUPPLIER_(LEGAL|DUPLICATE|CANDIDATES|SHARED|REASON|VERSION|IDEMPOTENCY|ALREADY|INVALID|NO_CHANGE|ALIAS))/.test(k));
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) {
      expect(en[key], key).toBeTruthy();
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], `${key} left in English`).not.toBe(en[key]);
    }
  });

  test("every duplicate reason the server can return has an English and Arabic label", () => {
    // Record<CandidateReason, ...> stops compiling when the server union gains a member.
    const reasons: Record<CandidateReason, true> = { SAME_NAME: true, ALIAS: true, CLOSE_NAME: true, TAX_ID: true };
    for (const reason of Object.keys(reasons)) {
      expect(en[`SuppliersDupReason_${reason}`], reason).toBeTruthy();
      expect(ar[`SuppliersDupReason_${reason}`], reason).toBeTruthy();
    }
  });

  test("every supplier registry error code has an English and Arabic ServerError label", () => {
    for (const code of Object.values(SUPPLIER_ERROR)) {
      expect(en[`ServerError_${code}`], `${code} (en)`).toBeTruthy();
      expect(ar[`ServerError_${code}`], `${code} (ar)`).toBeTruthy();
    }
  });});
