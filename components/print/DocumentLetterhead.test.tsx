import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { DocumentLetterhead } from "./DocumentLetterhead";

/**
 * SCRUM-1030: html2canvas 1.4.1 draws letter-spaced Arabic as disconnected isolated letters
 * ("س ن د ق ب ض" instead of "سند قبض"), although the browser joins them. Arabic text in a printed
 * document must therefore never carry a tracking-* class; Latin text keeps its spacing.
 */
const render = (props: { legalName?: string; name?: string; titleLabel?: string }) =>
  renderToStaticMarkup(
    createElement(DocumentLetterhead, { variant: "legal", titleLabel: props.titleLabel, orgBranding: props }),
  );

function classOfParagraphContaining(html: string, text: string): string {
  const match = new RegExp(`<p class="([^"]*)"[^>]*>[^<]*${text}`).exec(html);
  if (!match) throw new Error(`no <p> containing ${text}`);
  return match[1];
}

describe("DocumentLetterhead letter-spacing (SCRUM-1030)", () => {
  test("Arabic title, legal name and trade name carry no tracking class", () => {
    const html = render({ legalName: "شركة الأمل للسيارات", name: "معرض الأمل", titleLabel: "سند قبض" });
    for (const text of ["سند قبض", "شركة الأمل للسيارات", "معرض الأمل"]) {
      expect(classOfParagraphContaining(html, text)).not.toMatch(/\btracking-/);
    }
  });

  test("Latin title and names keep their letter-spacing", () => {
    const html = render({ legalName: "Al Amal Motors LLC", name: "Al Amal", titleLabel: "Receipt Voucher" });
    expect(classOfParagraphContaining(html, "Receipt Voucher")).toContain("tracking-widest");
    expect(classOfParagraphContaining(html, "Al Amal Motors LLC")).toContain("tracking-wide");
  });
});
