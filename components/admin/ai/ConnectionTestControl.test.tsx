/**
 * "Test connection" for the stored Anthropic key against a stubbed Convex
 * client. Pins what is called and which sentence is shown for each result
 * code; it is NOT a visual check.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  testConnection: undefined as unknown as ReturnType<typeof vi.fn>,
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useAction: (reference: never) => {
      const name = getFunctionName(reference);
      if (name === "aiAdmin:testProviderConnection") return stubs.testConnection;
      throw new Error(`unexpected action ${name}`);
    },
  };
});
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));

import { ConnectionTestControl } from "./ConnectionTestControl";

const en = dictionaries.en;
const ar = dictionaries.ar;

function testButton(name: string = en.AiAdminTestConnection): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  stubs.locale = "en";
  stubs.testConnection = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("ConnectionTestControl", () => {
  test("is disabled and calls nothing when no key is set", () => {
    render(<ConnectionTestControl keySet={false} />);
    expect(testButton().disabled).toBe(true);
    fireEvent.click(testButton());
    expect(stubs.testConnection).not.toHaveBeenCalled();
  });

  test("calls the action once and shows success", async () => {
    render(<ConnectionTestControl keySet />);
    fireEvent.click(testButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(en.AiAdminConnectionOk));
    expect(stubs.testConnection).toHaveBeenCalledTimes(1);
    expect(stubs.testConnection).toHaveBeenCalledWith({ provider: "anthropic" });
    expect(testButton().disabled).toBe(false);
  });

  test.each([
    ["AUTH_FAILED", en.AiAdminConnection_AUTH_FAILED],
    ["MODEL_UNAVAILABLE", en.AiAdminConnection_MODEL_UNAVAILABLE],
    ["PROVIDER_UNREACHABLE", en.AiAdminConnection_PROVIDER_UNREACHABLE],
    ["KEY_NOT_SET", en.AiAdminConnection_KEY_NOT_SET],
    ["ENCRYPTION_NOT_CONFIGURED", en.AiAdminConnection_ENCRYPTION_NOT_CONFIGURED],
    ["EGRESS_SUNK", en.AiAdminConnection_EGRESS_SUNK],
  ])("%s shows its own sentence", async (code, sentence) => {
    stubs.testConnection = vi.fn().mockResolvedValue({ ok: false, code });
    render(<ConnectionTestControl keySet />);
    fireEvent.click(testButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(sentence));
    expect(stubs.testConnection).toHaveBeenCalledTimes(1);
  });

  test("every failure sentence exists in English and Arabic and differs per code", () => {
    const codes = ["AUTH_FAILED", "MODEL_UNAVAILABLE", "PROVIDER_UNREACHABLE", "KEY_NOT_SET", "ENCRYPTION_NOT_CONFIGURED", "EGRESS_SUNK"];
    for (const dictionary of [en, ar] as Array<Record<string, string>>) {
      const sentences = codes.map((code) => dictionary[`AiAdminConnection_${code}`]);
      expect(sentences.every((sentence) => typeof sentence === "string" && sentence.length > 0)).toBe(true);
      expect(new Set(sentences).size).toBe(codes.length);
    }
  });

  test("a failed call shows a sentence of its own, not the raw error", async () => {
    stubs.testConnection = vi.fn().mockRejectedValue(new Error("[CONVEX A(aiAdmin:testProviderConnection)] Server Error"));
    render(<ConnectionTestControl keySet />);
    fireEvent.click(testButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(en.AiAdminConnectionTestFailed));
    expect(screen.getByRole("status").textContent).not.toContain("CONVEX");
  });

  test("Arabic: the control and the result read in Arabic", async () => {
    stubs.locale = "ar";
    render(<ConnectionTestControl keySet />);
    fireEvent.click(testButton(ar.AiAdminTestConnection));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(ar.AiAdminConnectionOk));
  });
});
