import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { NavSections, PlanCard, SETTINGS_DISCLOSURE_KEY } from "./NavSections";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "../../convex/utils/permissions";

const state = vi.hoisted(() => ({ pathname: "/org-a/accounting" }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never) => {
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Dealer" }];
      return null;
    },
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org-a" }),
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const permissionsOf = (role: string) => [
  ...DEFAULT_ROLE_TEMPLATES.find((template) => template.name === role)!.permissions,
];

/**
 * localStorage stand-in. `throwing` makes the nav's own key throw, as a blocked
 * store does; the language key still answers because LanguageProvider (outside
 * this change) reads it unguarded.
 */
function stubStorage(initial: Record<string, string> = {}, throwing = false) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => {
      if (throwing && key === SETTINGS_DISCLOSURE_KEY) throw new Error("storage blocked");
      return store.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (throwing && key === SETTINGS_DISCLOSURE_KEY) throw new Error("storage blocked");
      store.set(key, value);
    }),
  };
  vi.stubGlobal("localStorage", storage);
  return { store, storage };
}

function mount(ui: React.ReactElement) {
  return render(
    <OrgProvider>
      <LanguageProvider>{ui}</LanguageProvider>
    </OrgProvider>
  );
}

const ownerNav = (props: Partial<React.ComponentProps<typeof NavSections>> = {}) => (
  <NavSections permissions={permissionsOf("OWNER")} isOwner density="desktop" {...props} />
);

beforeEach(() => {
  state.pathname = "/org-a/accounting";
  stubStorage({ "autoflow-locale": "en" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("grouped sections", () => {
  test("owner sees the fixed captions, in order, and a single labelled navigation landmark", () => {
    mount(ownerNav());
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByText("Customers & sales").tagName).toBe("P");
    expect(within(nav).getByText("Inventory & sourcing")).toBeTruthy();
    expect(within(nav).getByText("Finance & reports")).toBeTruthy();
    const captions = ["Customers & sales", "Inventory & sourcing", "Finance & reports", "Settings"].map(
      (caption) => within(nav).getByText(caption)
    );
    for (let i = 1; i < captions.length; i++) {
      expect(captions[i - 1].compareDocumentPosition(captions[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test("captions never use uppercase or letter-spacing (both break Arabic joining)", () => {
    mount(ownerNav());
    const caption = screen.getByText("Customers & sales");
    expect(caption.className).not.toMatch(/uppercase|tracking-/);
    expect(caption.className).toContain("text-slate-500");
  });

  test("Notifications and Billing are not rows in the list", () => {
    mount(ownerNav());
    expect(document.querySelector('a[href="/org-a/notifications"]')).toBeNull();
    expect(document.querySelector('a[href="/org-a/settings/billing"]')).toBeNull();
  });

  test("Settings reads Commission rules, not the earned Commissions label", () => {
    mount(ownerNav());
    expect(document.querySelector('a[href="/org-a/settings/commission"]')?.textContent).toContain("Commission rules");
    expect(document.querySelector('a[href="/org-a/commissions"]')?.textContent).toContain("Commissions");
  });

  test("a member with no permissions gets an empty navigation", () => {
    mount(<NavSections permissions={[]} isOwner={false} density="desktop" />);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("active route", () => {
  test("marks only the matching link with aria-current", () => {
    state.pathname = "/org-a/sales/abc123";
    mount(ownerNav());
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("href"))).toEqual(["/org-a/sales"]);
  });

  test("matches on a path-segment boundary", () => {
    state.pathname = "/org-a/sales-reports";
    mount(ownerNav());
    expect(screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page")).toEqual([]);
  });
});

describe("Settings disclosure", () => {
  const settingsButton = () => screen.getByRole("button", { name: "Settings" });

  test("is closed by default and its links are out of the accessibility tree", () => {
    mount(ownerNav());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Branches" })).toBeNull();
    // Still in the document, so audits and tests that look for the href find it.
    expect(document.querySelector('a[href="/org-a/settings/branches"]')).not.toBeNull();
  });

  test("the button controls the list and toggling persists the choice", () => {
    const { store } = stubStorage({ "autoflow-locale": "en" });
    mount(ownerNav());
    const button = settingsButton();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-controls")!)?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("link", { name: "Branches" })).toBeTruthy();
    expect(store.get(SETTINGS_DISCLOSURE_KEY)).toBe("1");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(store.get(SETTINGS_DISCLOSURE_KEY)).toBe("0");
  });

  test("opens by itself when the current page is inside Settings", () => {
    state.pathname = "/org-a/settings/branches";
    mount(ownerNav());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Branches" }).getAttribute("aria-current")).toBe("page");
  });

  test("a remembered open choice is restored on another page", () => {
    stubStorage({ "autoflow-locale": "en", [SETTINGS_DISCLOSURE_KEY]: "1" });
    mount(ownerNav());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("a remembered closed choice still yields to landing inside Settings", () => {
    stubStorage({ "autoflow-locale": "en", [SETTINGS_DISCLOSURE_KEY]: "0" });
    state.pathname = "/org-a/team";
    mount(ownerNav());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("a stored value that is not 1 or 0 is ignored", () => {
    stubStorage({ "autoflow-locale": "en", [SETTINGS_DISCLOSURE_KEY]: "en" });
    mount(ownerNav());
    expect(settingsButton().getAttribute("aria-expanded")).toBe("false");
  });

  test("blocked storage does not break rendering or toggling", () => {
    const { storage } = stubStorage({ "autoflow-locale": "en" }, true);
    mount(ownerNav());
    const button = settingsButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(storage.getItem).toHaveBeenCalledWith(SETTINGS_DISCLOSURE_KEY);
    expect(storage.setItem).toHaveBeenCalledWith(SETTINGS_DISCLOSURE_KEY, "1");
  });

  test("a closed Settings that holds the current page shows a marker dot", () => {
    state.pathname = "/org-a/team";
    mount(ownerNav());
    const button = settingsButton();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.querySelector(".bg-primary")).not.toBeNull();
  });

  test("a manager whose only Settings item is Team gets a plain list, no toggle", () => {
    mount(<NavSections permissions={permissionsOf("MANAGER")} isOwner={false} density="desktop" />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByText("Settings").tagName).toBe("P");
    expect(screen.getByRole("link", { name: "Team" })).toBeTruthy();
  });
});

describe("Approvals badge and navigation callback", () => {
  test("renders the count the caller supplies, only on Approvals", () => {
    mount(ownerNav({ badges: { Approvals: 4 } }));
    const approvals = document.querySelector('a[href="/org-a/approvals"]')!;
    expect(approvals.textContent).toContain("4");
    expect(document.querySelector('a[href="/org-a/tasks"]')!.textContent).not.toMatch(/\d/);
  });

  test("renders no badge for zero, null or absent counts", () => {
    for (const badges of [{ Approvals: 0 }, { Approvals: null }, undefined]) {
      const { unmount } = mount(ownerNav({ badges }));
      expect(document.querySelector('a[href="/org-a/approvals"]')!.textContent).toBe("Approvals");
      unmount();
    }
  });

  test("onNavigate fires when a link is chosen (the drawer closes on it)", () => {
    const onNavigate = vi.fn();
    mount(ownerNav({ onNavigate, density: "drawer" }));
    fireEvent.click(screen.getByRole("link", { name: "Leads" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  test("drawer rows are 44px high and desktop rows 36px", () => {
    const { unmount } = mount(ownerNav({ density: "drawer" }));
    expect(screen.getByRole("link", { name: "Leads" }).className).toContain("h-11");
    unmount();
    mount(ownerNav({ density: "desktop" }));
    expect(screen.getByRole("link", { name: "Leads" }).className).toContain("h-9");
  });
});

describe("Arabic", () => {
  test("captions and the renamed Settings entry are translated", () => {
    stubStorage({ "autoflow-locale": "ar" });
    mount(ownerNav());
    expect(screen.getByText("العملاء والمبيعات")).toBeTruthy();
    expect(screen.getByText("المخزون والتوريد")).toBeTruthy();
    expect(screen.getByText("المالية والتقارير")).toBeTruthy();
    expect(screen.getByRole("button", { name: "الإعدادات" })).toBeTruthy();
    expect(document.querySelector('a[href="/org-a/settings/commission"]')?.textContent).toContain("قواعد العمولات");
    expect(screen.getByRole("navigation", { name: "التنقل الرئيسي" })).toBeTruthy();
  });
});

describe("plan card", () => {
  test("links the owner to Billing", () => {
    mount(<PlanCard permissions={permissionsOf("OWNER")} isOwner density="desktop" />);
    expect(document.querySelector('[data-nav-surface="plan-card"] a[href="/org-a/settings/billing"]')).not.toBeNull();
  });

  test("renders nothing for a non-owner", () => {
    const { container } = mount(<PlanCard permissions={permissionsOf("OWNER")} isOwner={false} density="drawer" />);
    expect(container.querySelector("a")).toBeNull();
  });

  test("marks itself current on the billing page", () => {
    state.pathname = "/org-a/settings/billing";
    mount(<PlanCard permissions={[]} isOwner density="drawer" />);
    expect(screen.getByRole("link").getAttribute("aria-current")).toBe("page");
  });
});
