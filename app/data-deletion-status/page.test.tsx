/**
 * SCRUM-842: the data-deletion status page is the human-readable answer Meta
 * requires behind the callback's `url`. It must look the request up by its
 * opaque code, name the platform the request came from (it said "Instagram" for
 * every request), and claim only what the callback actually removed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  code: "a1b2c3d4e5f60718293a4b5c6d7e8f90" as string | null,
  result: undefined as unknown,
  queryArgs: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useQuery: (_reference: unknown, args: unknown) => {
    stubs.queryArgs.push(args);
    return args === "skip" ? undefined : stubs.result;
  },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => (key === "id" ? stubs.code : null) }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ locale: stubs.locale, isRtl: stubs.locale === "ar", t: (key: string) => key }),
}));
vi.mock("@/components/marketing/MarketingShell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

import DataDeletionStatusPage from "./page";

const pageText = () => document.body.textContent ?? "";

describe("data-deletion status page", () => {
  beforeEach(() => {
    stubs.locale = "en";
    stubs.code = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    stubs.result = undefined;
    stubs.queryArgs = [];
  });
  afterEach(cleanup);

  test("a Facebook request is described as Facebook, never Instagram, in English and Arabic", () => {
    stubs.result = { platform: "facebook", completedAt: 1 };
    render(<DataDeletionStatusPage />);
    expect(pageText()).toContain("Facebook");
    expect(pageText()).not.toMatch(/Instagram/i);
    cleanup();

    stubs.locale = "ar";
    render(<DataDeletionStatusPage />);
    expect(pageText()).toContain("فيسبوك");
    expect(pageText()).not.toContain("إنستغرام");
  });

  test("an Instagram request is described as Instagram, never Facebook, in English and Arabic", () => {
    stubs.result = { platform: "instagram", completedAt: 1 };
    render(<DataDeletionStatusPage />);
    expect(pageText()).toContain("Instagram");
    expect(pageText()).not.toMatch(/Facebook/i);
    cleanup();

    stubs.locale = "ar";
    render(<DataDeletionStatusPage />);
    expect(pageText()).toContain("إنستغرام");
    expect(pageText()).not.toContain("فيسبوك");
  });

  test("it looks the request up by the code in the URL and never claims a complete erasure", () => {
    stubs.result = { platform: "facebook", completedAt: 1 };
    render(<DataDeletionStatusPage />);
    expect(stubs.queryArgs).toContainEqual({ code: "a1b2c3d4e5f60718293a4b5c6d7e8f90" });
    expect(pageText()).toContain("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(pageText()).not.toMatch(/fully|completely|all your data/i);
  });

  test("a recorded request whose retained-log redaction is unfinished says in progress, names the platform and claims nothing removed", () => {
    stubs.result = { platform: "facebook", completedAt: null };
    render(<DataDeletionStatusPage />);
    expect(screen.getByRole("heading").textContent).toMatch(/in progress/i);
    expect(pageText()).toContain("Facebook");
    expect(pageText()).toContain("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(pageText()).not.toMatch(/removed|deleted|no further action|instagram/i);
    cleanup();

    stubs.locale = "ar";
    render(<DataDeletionStatusPage />);
    expect(screen.getByRole("heading").textContent).toContain("قيد التنفيذ");
    expect(pageText()).toContain("فيسبوك");
    expect(pageText()).not.toContain("إنستغرام");
    expect(pageText()).not.toContain("أزلنا");
    expect(pageText()).not.toContain("لا يلزم اتخاذ أي إجراء");
  });

  test("a processed request that found no stored connection says there was nothing to remove, in English and Arabic, and does not claim credentials were removed", () => {
    stubs.result = { platform: "instagram", completedAt: 1, connectionRemoved: false };
    render(<DataDeletionStatusPage />);
    expect(pageText()).toMatch(/nothing to remove/i);
    expect(pageText()).not.toMatch(/We removed/i);
    expect(pageText()).not.toMatch(/Facebook/i);
    cleanup();

    stubs.locale = "ar";
    render(<DataDeletionStatusPage />);
    expect(pageText()).toContain("لم يكن هناك ما نزيله");
    expect(pageText()).not.toContain("أزلنا");
    expect(pageText()).toContain("إنستغرام");
  });

  test("a processed request that cleared a connection says it removed the credentials", () => {
    stubs.result = { platform: "instagram", completedAt: 1, connectionRemoved: true };
    render(<DataDeletionStatusPage />);
    expect(pageText()).toMatch(/We removed the Instagram access credentials/);
    expect(pageText()).not.toMatch(/nothing to remove/i);
  });

  test("while the lookup is loading it asserts nothing about deletion", () => {
    stubs.result = undefined;
    render(<DataDeletionStatusPage />);
    expect(pageText()).not.toMatch(/removed|deleted|processed/i);
  });

  test("an unknown code, and a link with no code, say the request was not found and echo nothing", () => {
    stubs.result = null;
    stubs.code = "<b>attacker-text</b>";
    render(<DataDeletionStatusPage />);
    expect(screen.getByRole("heading").textContent).toMatch(/could not find/i);
    expect(pageText()).not.toContain("attacker-text");
    cleanup();

    stubs.code = null;
    stubs.queryArgs = [];
    render(<DataDeletionStatusPage />);
    expect(stubs.queryArgs).toEqual(["skip"]);
    expect(screen.getByRole("heading").textContent).toMatch(/could not find/i);
  });
});
