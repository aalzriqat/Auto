/**
 * SCRUM-417 UX PR 4 (O3) -- the ?stage= deep link is read from and written to
 * the address with the Next router, keeps every other parameter, and replaces
 * (never pushes) history.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  pathname: "/org1/applications/app1/deal" as string | null,
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { useStageDeepLink } from "./useStageDeepLink";

beforeEach(() => {
  nav.replace.mockClear();
  nav.push.mockClear();
  nav.pathname = "/org1/applications/app1/deal";
  nav.search = "";
});
afterEach(() => vi.clearAllMocks());

describe("useStageDeepLink", () => {
  test("reads ?stage= as the raw value, null when absent", () => {
    nav.search = "stage=HANDOVER";
    expect(renderHook(() => useStageDeepLink()).result.current.value).toBe("HANDOVER");
    nav.search = "";
    expect(renderHook(() => useStageDeepLink()).result.current.value).toBeNull();
  });

  test("an unknown value is passed through untouched (the cockpit decides the fallback)", () => {
    nav.search = "stage=NOPE";
    expect(renderHook(() => useStageDeepLink()).result.current.value).toBe("NOPE");
  });

  test("writes the key with replace, scroll off, keeping other parameters", () => {
    nav.search = "tab=notes";
    renderHook(() => useStageDeepLink()).result.current.onChange("SETTLEMENT");
    expect(nav.replace).toHaveBeenCalledWith("/org1/applications/app1/deal?tab=notes&stage=SETTLEMENT", {
      scroll: false,
    });
    expect(nav.push).not.toHaveBeenCalled();
  });

  test("null removes only the stage parameter; an empty query leaves a bare path", () => {
    nav.search = "stage=APPLICATION&tab=notes";
    renderHook(() => useStageDeepLink()).result.current.onChange(null);
    expect(nav.replace).toHaveBeenLastCalledWith("/org1/applications/app1/deal?tab=notes", { scroll: false });
    nav.search = "stage=APPLICATION";
    renderHook(() => useStageDeepLink()).result.current.onChange(null);
    expect(nav.replace).toHaveBeenLastCalledWith("/org1/applications/app1/deal", { scroll: false });
  });

  test("without a pathname there is nowhere to write", () => {
    nav.pathname = null;
    renderHook(() => useStageDeepLink()).result.current.onChange("HANDOVER");
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
