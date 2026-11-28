// @vitest-environment node
/**
 * SCRUM-1030: invariant — every colour that reaches html2canvas from a print template must be one
 * html2canvas 1.4.1 parses (hex / rgb / rgba / hsl / named). Tailwind 4 palette utilities such as
 * `text-gray-600` compute to `oklch()`, which html2canvas rejects with
 * `Attempting to parse an unsupported color function "oklch"`, so the PDF download fails.
 *
 * Precedent: components/sales/wizard/rtlArrows.test.ts (source-policy test over the captured sources).
 * `white`/`black` were verified in real Chromium/WebKit to compute to rgb (PDF renders), so they are allowed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "../..");

/** Elements lib/htmlToPdf.ts captures, and the template file that renders each one. */
const CAPTURED: ReadonlyArray<readonly [id: string, file: string]> = [
  ["receipt-voucher-pdf-content", "components/sales/ReceiptVoucherPrintTemplate.tsx"],
  ["pdf-quote-content", "components/sales/QuotePrintTemplate.tsx"],
  ["lead-quote-pdf-content", "components/leads/LeadQuotePrintTemplate.tsx"],
];

const PALETTES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITIES =
  "text|bg|border(?:-[xytblrse])?|divide|ring|ring-offset|outline|decoration|shadow|from|via|to|fill|stroke|accent|caret|placeholder";
// Optional variant prefixes (`dark:`, `print:`, `hover:`, `rtl:` ...), then utility-palette-shade[/opacity].
const PALETTE_COLOUR = new RegExp(
  `(?<![\\w-])(?:[\\w[\\]&>*:-]+:)*(?:${UTILITIES})-(?:${PALETTES})-\\d{2,3}(?:/\\d+)?(?![\\w-])`,
  "g"
);

function stripTypeOnlyImports(source: string): string {
  return source.replace(/import\s+type\s[^;]+;/g, "");
}

function resolveComponent(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2)) : resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.tsx`, join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The file plus every component it renders as a JSX tag (followed transitively). */
function renderedSources(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = stripTypeOnlyImports(readFileSync(file, "utf8"));
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    const names = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/).pop() ?? "");
    const rendered = names.some((name) => name !== "" && new RegExp(`<${name}\\b`).test(source));
    if (!rendered || !/^(@\/components\/|\.)/.test(match[2])) continue;
    const child = resolveComponent(match[2], file);
    if (child) renderedSources(child, seen);
  }
  return seen;
}

function paletteColourClasses(file: string): string[] {
  return readFileSync(file, "utf8").match(PALETTE_COLOUR) ?? [];
}

describe("SCRUM-1030: print templates only use colours html2canvas can parse", () => {
  test("the policy regex catches the Tailwind 4 palette forms that compute to oklch()", () => {
    const hits = (text: string) => text.match(PALETTE_COLOUR) ?? [];
    expect(hits('className="text-gray-600 bg-slate-50/50 print:border-red-500 hover:text-blue-600"')).toEqual([
      "text-gray-600",
      "bg-slate-50/50",
      "print:border-red-500",
      "hover:text-blue-600",
    ]);
    expect(hits('className="text-[#4b5563] bg-white border-b border-t text-black text-xs font-bold"')).toEqual([]);
  });

  test.each(CAPTURED)("%s is rendered by its listed template file", (id, file) => {
    expect(readFileSync(join(ROOT, file), "utf8")).toContain(`id="${id}"`);
  });

  const scanned = new Map<string, string[]>();
  for (const [, file] of CAPTURED) {
    for (const source of renderedSources(join(ROOT, file))) scanned.set(source, [...(scanned.get(source) ?? []), file]);
  }

  test("child components rendered inside the captured elements are discovered", () => {
    const names = [...scanned.keys()].map((file) => relative(ROOT, file).replaceAll("\\", "/"));
    expect(names).toContain("components/print/DocumentLetterhead.tsx");
  });

  // html2canvas disconnects letter-spaced Arabic; DocumentLetterhead is the one place that may track, and only Latin text.
  test.each([...scanned.keys()].map((file) => [relative(ROOT, file).replaceAll("\\", "/"), file]))(
    "%s has no unconditional letter-spacing",
    (name, file) => {
      if (name === "components/print/DocumentLetterhead.tsx") return;
      expect(readFileSync(file, "utf8").match(/\btracking-|letterSpacing|letter-spacing/g) ?? []).toEqual([]);
    }
  );

  test.each([...scanned.keys()].map((file) => [relative(ROOT, file).replaceAll("\\", "/"), file]))(
    "%s has no Tailwind palette colour utility",
    (_name, file) => {
      expect(paletteColourClasses(file)).toEqual([]);
    }
  );
});
