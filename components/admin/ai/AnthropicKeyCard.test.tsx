/**
 * Key hygiene of the write-only Anthropic key card against a stubbed Convex
 * client. Pins what is sent and what is rendered; it is NOT a visual check
 * (jsdom has no layout), so RTL and spacing still need a rendered pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  saveProviderKey: undefined as unknown as ReturnType<typeof vi.fn>,
  removeProviderKey: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("convex/react", () => ({
  useAction: () => stubs.saveProviderKey,
  useMutation: () => stubs.removeProviderKey,
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AnthropicKeyCard } from "./AnthropicKeyCard";
import { toast } from "@/components/ui/sonner";

const SECRET = "sk-ant-api03-TEST-ONLY-not-a-real-key-wxyz";
const en = dictionaries.en;

function keyInput(): HTMLInputElement {
  return screen.getByLabelText(en.AiAdminKeyInputLabel) as HTMLInputElement;
}

function toastText(): string {
  return JSON.stringify([vi.mocked(toast.success).mock.calls, vi.mocked(toast.error).mock.calls]);
}

beforeEach(() => {
  stubs.saveProviderKey = vi.fn().mockResolvedValue({ last4: "wxyz", setAt: Date.UTC(2026, 10, 23) });
  stubs.removeProviderKey = vi.fn().mockResolvedValue(null);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => cleanup());

describe("AnthropicKeyCard", () => {
  test("disables saving and explains why when encryption is not configured", () => {
    render(<AnthropicKeyCard encryptionConfigured={false} status={{ isSet: false }} />);

    expect(screen.getByText(en.AiAdminEncryptionMissingTitle)).toBeTruthy();
    expect(keyInput().disabled).toBe(true);
    const save = screen.getByRole("button", { name: en.AiAdminKeySave }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(save);
    expect(stubs.saveProviderKey).not.toHaveBeenCalled();
  });

  test("is a write-only password field that starts empty", () => {
    render(
      <AnthropicKeyCard encryptionConfigured status={{ isSet: true, last4: "abcd", setAt: Date.UTC(2026, 0, 5) }} />,
    );
    const input = screen.getByLabelText(en.AiAdminKeyReplaceLabel) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByTestId("ai-key-last4").textContent).toBe("••••abcd");
  });

  test("sends the key once, then clears the input and never renders or toasts it", async () => {
    const { container } = render(<AnthropicKeyCard encryptionConfigured status={{ isSet: false }} />);

    fireEvent.change(keyInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: en.AiAdminKeySave }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.AiAdminKeySaved));
    expect(stubs.saveProviderKey).toHaveBeenCalledTimes(1);
    expect(stubs.saveProviderKey).toHaveBeenCalledWith({ provider: "anthropic", apiKey: SECRET });
    expect(keyInput().value).toBe("");
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(toastText()).not.toContain(SECRET);
  });

  test("shows the server's fixed refusal as text and never echoes the input", async () => {
    stubs.saveProviderKey = vi
      .fn()
      .mockRejectedValue(new ConvexError({ code: "VALIDATION_FAILED", message: "The API key format is not valid." }));
    render(<AnthropicKeyCard encryptionConfigured status={{ isSet: false }} />);

    fireEvent.change(keyInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: en.AiAdminKeySave }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.AiAdminKeyErrorFormat));
    // A string, not the error object: the toast wrapper sends Error objects to Sentry.
    expect(vi.mocked(toast.error).mock.calls.every(([message]) => typeof message === "string")).toBe(true);
    expect(toastText()).not.toContain(SECRET);
  });

  test("falls back to the generic message if a failure text ever contains the key", async () => {
    stubs.saveProviderKey = vi.fn().mockRejectedValue(new ConvexError({ code: "X", message: `bad ${SECRET}` }));
    render(<AnthropicKeyCard encryptionConfigured status={{ isSet: false }} />);

    fireEvent.change(keyInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: en.AiAdminKeySave }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.AiAdminKeyErrorGeneric));
    expect(toastText()).not.toContain(SECRET);
  });

  test("removes the key only after confirmation", async () => {
    render(<AnthropicKeyCard encryptionConfigured status={{ isSet: true, last4: "abcd", setAt: 1 }} />);

    fireEvent.click(screen.getByRole("button", { name: en.AiAdminKeyRemove }));
    expect(stubs.removeProviderKey).not.toHaveBeenCalled();
    expect(screen.getByText(en.AiAdminKeyRemoveTitle)).toBeTruthy();

    const confirmButtons = screen.getAllByRole("button", { name: en.AiAdminKeyRemove });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(stubs.removeProviderKey).toHaveBeenCalledWith({ provider: "anthropic" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(en.AiAdminKeyRemoved));
  });
});
