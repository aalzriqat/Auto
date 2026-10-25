import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { OpeningManagementSettlementPanel } from "./OpeningManagementSettlementPanel";
import type { Id } from "@/convex/_generated/dataModel";

const fixture = vi.hoisted(() => ({ permissions: ["view:finance", "manage:finance"], actor: "preparer",
  pending: false, opening: "opening-a", version: "version-a", calls: [] as Array<{ name: string; args: unknown }>, mutation: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/accounting",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useConvexAuth: () => ({ isAuthenticated: true }),
    useMutation: (reference: never) => (args: unknown) =>
      fixture.mutation({ name: getFunctionName(reference), args }),
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      fixture.calls.push({ name, args });
      if (args === "skip") return undefined;
      if (name === "organizations:listMine") return [{ _id: "org-a" }];
      if (name === "memberships:getMyMembership") return { roleName: "Accountant", permissions: fixture.permissions };
      if (name === "openingManagementSettlement:context") return { actorId: fixture.actor, postedOpening: { id: fixture.opening, observationVersion: fixture.version, currency: "JOD", asOfDate: Date.UTC(2026, 0, 1) } };
      if (name === "openingManagementSettlement:list") return fixture.pending ? [{ _id: "plan-a", status: "PENDING_APPROVAL", createdBy: "preparer", supportingReference: "Synthetic reference", currency: "JOD", totalMinor: 100003,
        installments: Array.from({ length: 7 }, (_, i) => ({ sequence: i + 1, effectiveMonth: Date.UTC(2026, i + 1, 1), amountMinor: i === 6 ? 14287 : 14286 })) }] : [];
      throw new Error("Unexpected management SDK boundary query " + name);
    } };
});
beforeEach(() => {
  fixture.permissions = ["view:finance", "manage:finance"]; fixture.actor = "preparer"; fixture.pending = false;
  fixture.opening = "opening-a"; fixture.version = "version-a";
  fixture.calls = []; fixture.mutation.mockReset(); fixture.mutation.mockResolvedValue("plan-a");
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function page() { return <OrgProvider><LanguageProvider><OpeningManagementSettlementPanel orgId={"org-a" as Id<"organizations">} /></LanguageProvider></OrgProvider>; }

test("a replacement opening clears the entire old draft intent before it can submit", () => {
  const view = render(page());
  fireEvent.change(screen.getByLabelText("Agreed total (JOD)"), { target: { value: "100.003" } });
  fireEvent.change(screen.getByLabelText("First effective month"), { target: { value: "2026-02" } });
  fireEvent.change(screen.getByLabelText("Supporting reference"), { target: { value: "Opening A intent" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fixture.opening = "opening-b"; fixture.version = "version-b";
  view.rerender(page());
  for (const label of ["Agreed total (JOD)", "First effective month", "Supporting reference"]) {
    const input = screen.getByLabelText(label);
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected draft input");
    expect(input.value).toBe("");
  }
  const checkbox = screen.getByRole("checkbox");
  if (!(checkbox instanceof HTMLInputElement)) throw new Error("Expected draft attestation");
  expect(checkbox.checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  expect(fixture.mutation).not.toHaveBeenCalled();
});

test("real permission provider skips every management read for a non-finance actor", () => {
  fixture.permissions = [];
  render(page());
  expect(screen.queryByRole("heading", { name: "Management opening settlement" })).toBeNull();
  const reads = fixture.calls.filter((call) => call.name.startsWith("openingManagementSettlement:"));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((call) => call.args === "skip")).toBe(true);
});

test("approver sees the exact seven stored parts and a preparer cannot approve them", () => {
  fixture.pending = true;
  render(page());
  expect(screen.getAllByRole("listitem")).toHaveLength(7);
  expect(screen.getByRole("button", { name: "Approve fixed schedule" }).hasAttribute("disabled")).toBe(true);
  expect(fixture.mutation).not.toHaveBeenCalled();
});

test("a different finance approver submits only the stored plan identity", async () => {
  fixture.pending = true; fixture.actor = "approver";
  render(page());
  fireEvent.click(screen.getByRole("button", { name: "Approve fixed schedule" }));
  await waitFor(() => expect(fixture.mutation).toHaveBeenCalledWith({
    name: "openingManagementSettlement:approve", args: { orgId: "org-a", planId: "plan-a" },
  }));
  expect(fixture.mutation).toHaveBeenCalledTimes(1);
});

test("draft keeps its observation and retry key across same-version rerenders", async () => {
  fixture.mutation.mockRejectedValueOnce(new Error("SDK unavailable"));
  const view = render(page());
  fireEvent.change(screen.getByLabelText("Agreed total (JOD)"), { target: { value: "100.003" } });
  fireEvent.change(screen.getByLabelText("First effective month"), { target: { value: "2026-02" } });
  fireEvent.change(screen.getByLabelText("Supporting reference"), { target: { value: "Synthetic reference" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  await screen.findByRole("alert");
  view.rerender(page());
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  await waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(2));
  const first = fixture.mutation.mock.calls[0][0];
  expect(first.name).toBe("openingManagementSettlement:draftFromObservation");
  expect(first.args).toMatchObject({ orgId: "org-a", expectedOpeningVersion: "version-a", totalMinor: 100003, expectedCurrency: "JOD", firstEffectiveMonth: Date.UTC(2026, 1, 1), classificationAttestation: "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL" });
  expect(fixture.mutation.mock.calls[1][0]).toEqual(first);
});

test.each(["success", "failure"])("an old inflight %s cannot clear the new form retry intent", async outcome => {
  let settleOld: () => void = () => { throw new Error("Old request not started"); };
  fixture.mutation.mockImplementationOnce(() => new Promise((resolve, reject) => {
    settleOld = () => outcome === "success" ? resolve("old-plan") : reject(new Error("Late failure for A"));
  }));
  const view = render(page());
  fireEvent.change(screen.getByLabelText("Agreed total (JOD)"), { target: { value: "100.003" } });
  fireEvent.change(screen.getByLabelText("First effective month"), { target: { value: "2026-02" } });
  fireEvent.change(screen.getByLabelText("Supporting reference"), { target: { value: "Opening A" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  expect(fixture.mutation).toHaveBeenCalledTimes(1);
  fixture.opening = "opening-b"; fixture.version = "version-b";
  view.rerender(page());
  fireEvent.change(screen.getByLabelText("Agreed total (JOD)"), { target: { value: "200.003" } });
  fireEvent.change(screen.getByLabelText("First effective month"), { target: { value: "2026-03" } });
  fireEvent.change(screen.getByLabelText("Supporting reference"), { target: { value: "Opening B" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fixture.mutation.mockRejectedValueOnce(new Error("Retry B"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  await screen.findByRole("alert");
  const requestB = fixture.mutation.mock.calls[1][0];
  await act(async () => { settleOld(); });
  const input = screen.getByLabelText("Supporting reference");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected reference input");
  expect(input.value).toBe("Opening B");
  expect(screen.getByRole("button", { name: "Prepare for a different approver" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Prepare for a different approver" }));
  await waitFor(() => expect(fixture.mutation).toHaveBeenCalledTimes(3));
  expect(fixture.mutation.mock.calls[2][0]).toEqual(requestB);
  expect(requestB.args).toMatchObject({ expectedOpeningVersion: "version-b", totalMinor: 200003 });
});


test("reject sends only the stored plan identity to the reject mutation", async () => {
  fixture.pending = true;
  render(page());
  fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
  await waitFor(() => expect(fixture.mutation).toHaveBeenCalledWith({
    name: "openingManagementSettlement:reject", args: { orgId: "org-a", planId: "plan-a" },
  }));
  expect(fixture.mutation).toHaveBeenCalledTimes(1);
});
