import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MarketplaceRequestsClient } from "@/app/(dashboard)/[orgId]/marketplace/requests/client";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const state = vi.hoisted(() => ({ canViewVehicles: false, respond: vi.fn(async () => undefined) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: "Synthetic marketplace responder", permissions: ["marketplace:respond", "view:org", ...(state.canViewVehicles ? ["view:vehicles"] : [])] };
      if (name === "marketplaceResponses:listForOrg") return [{ requestId: "request-a", buyerFirstName: "Synthetic Buyer", buyerCity: "Synthetic City", paymentType: "CASH", buyerIntent: "HOT", make: "Synthetic Make", model: "Synthetic Model", latestResponse: null }];
      if (name === "vehicles:list") {
        if (!state.canViewVehicles) throw new Error("Synthetic backend inventory visibility refusal");
        return { page: [{ _id: "vehicle-a", year: 2026, make: "Synthetic", model: "Car" }], isDone: true, continueCursor: "" };
      }
      throw new Error("Unexpected marketplace fixture query: " + name);
    },
    useMutation: (ref: never) => {
      if (getFunctionName(ref) !== "marketplaceResponses:respond") throw new Error("Unexpected marketplace mutation fixture");
      return state.respond;
    },
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/marketplace/requests",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => {
  state.respond.mockClear();
  state.canViewVehicles = false;
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

test("an inventory-authorized marketplace responder still sees available vehicle choices", () => {
  state.canViewVehicles = true;
  render(<OrgProvider><LanguageProvider><MarketplaceRequestsClient /></LanguageProvider></OrgProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.keyDown(screen.getAllByRole("combobox")[1], { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "2026 Synthetic Car" })).toBeTruthy();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("a responder without inventory access is not offered an exact-vehicle reply", () => {
  render(<OrgProvider><LanguageProvider><MarketplaceRequestsClient /></LanguageProvider></OrgProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  fireEvent.keyDown(screen.getAllByRole("combobox")[0], { key: "ArrowDown" });
  expect(screen.queryByRole("option", { name: "I have this exact car" })).toBeNull();
  expect(screen.getByRole("option", { name: "I have something similar" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Not available" })).toBeTruthy();
});

test("a marketplace responder without inventory visibility can send a non-vehicle reply", async () => {
  render(<OrgProvider><LanguageProvider><MarketplaceRequestsClient /></LanguageProvider></OrgProvider>);
  expect(() => fireEvent.click(screen.getByRole("button", { name: "Reply" }))).not.toThrow();
  fireEvent.keyDown(screen.getAllByRole("combobox")[0], { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Not available" }));
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(state.respond).toHaveBeenCalledWith({ orgId: "org-a", requestId: "request-a", kind: "NOT_AVAILABLE", vehicleId: undefined, offerPriceJod: undefined, note: undefined }));
});
