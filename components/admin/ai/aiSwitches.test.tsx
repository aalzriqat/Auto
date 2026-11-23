/**
 * Flip-save-revert behaviour of the platform and per-dealership AI switches
 * against a stubbed Convex client. Not a visual check.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { Id } from "@/convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  mutation: undefined as unknown as ReturnType<typeof vi.fn>,
  orgSettings: undefined as { draftsEnabled: boolean } | undefined,
}));

vi.mock("convex/react", () => ({
  useMutation: () => stubs.mutation,
  useQuery: () => stubs.orgSettings,
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AiMasterSwitchCard } from "./AiMasterSwitchCard";
import { OrgAiDraftsSwitch } from "./OrgAiDraftsSwitch";
import { toast } from "@/components/ui/sonner";

const en = dictionaries.en;
const ORG_ID = "org1" as Id<"organizations">;

/** What the live query reports once the save has landed. */
const SERVER_VALUE_AFTER_SAVE = true;

function deferred(): { promise: Promise<null>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<null>((done) => {
    resolve = () => done(null);
  });
  return { promise, resolve };
}

function switchControl(): HTMLElement {
  return screen.getByRole("switch");
}

beforeEach(() => {
  stubs.mutation = vi.fn().mockResolvedValue(null);
  stubs.orgSettings = { draftsEnabled: false };
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => cleanup());

describe("AiMasterSwitchCard", () => {
  test("saves the new value and states the three conditions", async () => {
    render(<AiMasterSwitchCard draftsEnabled={false} />);
    expect(screen.getByText(en.AiAdminConditionPlatform)).toBeTruthy();
    expect(screen.getByText(en.AiAdminConditionDealership)).toBeTruthy();
    expect(screen.getByText(en.AiAdminConditionKey)).toBeTruthy();

    fireEvent.click(switchControl());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.AiAdminMasterTurnedOn));
    expect(stubs.mutation).toHaveBeenCalledWith({ enabled: true });
  });

  test("stays on after a successful save once the server value is on", async () => {
    const save = deferred();
    stubs.mutation = vi.fn().mockReturnValue(save.promise);
    const { rerender } = render(<AiMasterSwitchCard draftsEnabled={false} />);

    fireEvent.click(switchControl());
    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    expect((switchControl() as HTMLButtonElement).disabled).toBe(true);

    rerender(<AiMasterSwitchCard draftsEnabled={SERVER_VALUE_AFTER_SAVE} />);
    save.resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.AiAdminMasterTurnedOn));
    expect(stubs.mutation).toHaveBeenCalledWith({ enabled: true });
    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    expect((switchControl() as HTMLButtonElement).disabled).toBe(false);
  });

  test("flips back to the server value when the save fails", async () => {
    stubs.mutation = vi.fn().mockRejectedValue(new Error("boom"));
    render(<AiMasterSwitchCard draftsEnabled={false} />);

    fireEvent.click(switchControl());
    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(switchControl().getAttribute("aria-checked")).toBe("false");
  });
});

describe("OrgAiDraftsSwitch", () => {
  test("is disabled while the dealership setting loads", () => {
    stubs.orgSettings = undefined;
    render(<OrgAiDraftsSwitch orgId={ORG_ID} />);
    expect((switchControl() as HTMLButtonElement).disabled).toBe(true);
  });

  test("stays on after a successful save once the server value is on", async () => {
    const save = deferred();
    stubs.mutation = vi.fn().mockReturnValue(save.promise);
    const { rerender } = render(<OrgAiDraftsSwitch orgId={ORG_ID} />);

    fireEvent.click(switchControl());
    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    expect((switchControl() as HTMLButtonElement).disabled).toBe(true);

    stubs.orgSettings = { draftsEnabled: SERVER_VALUE_AFTER_SAVE };
    rerender(<OrgAiDraftsSwitch orgId={ORG_ID} />);
    save.resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.AiAdminOrgSwitchTurnedOn));
    expect(stubs.mutation).toHaveBeenCalledWith({ orgId: ORG_ID, enabled: true });
    expect(switchControl().getAttribute("aria-checked")).toBe("true");
    expect((switchControl() as HTMLButtonElement).disabled).toBe(false);
  });

  test("sends the dealership id and flips back when refused", async () => {
    stubs.mutation = vi.fn().mockRejectedValue(new Error("refused"));
    render(<OrgAiDraftsSwitch orgId={ORG_ID} />);

    fireEvent.click(switchControl());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(stubs.mutation).toHaveBeenCalledWith({ orgId: ORG_ID, enabled: true });
    expect(switchControl().getAttribute("aria-checked")).toBe("false");
  });
});
