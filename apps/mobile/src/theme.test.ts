import { buildTheme, getFontFamily, getTypographyStyle, resolveStatusBarStyle, theme } from "./theme";

/** Relative luminance per WCAG 2.1 §1.4.3. */
function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.replace("#", "").substr(offset, 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Every background a foreground token can realistically land on, per mode.
const SURFACE_TOKENS = ["surface", "background", "surfaceAlt", "surfaceMuted"] as const;
// Tokens that render as TEXT. WCAG AA body text floor is 4.5:1.
const TEXT_TOKENS = ["text", "mutedText", "danger"] as const;
// Tokens that only ever render as icons/dots/dividers. WCAG 1.4.11 asks 3:1.
const NON_TEXT_TOKENS = ["subtleText"] as const;

/** Every (token, surface) pair below `floor`, named so a regression says which. */
function contrastFailures(
  mode: "light" | "dark",
  tokens: readonly string[],
  floor: number,
): string[] {
  const { colors } = buildTheme(mode) as { colors: Record<string, string> };
  const failures: string[] = [];
  for (const token of tokens) {
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrastRatio(colors[token], colors[surface]);
      if (ratio < floor) {
        failures.push(`${mode}.${token} on ${surface}: ${ratio.toFixed(2)}:1 < ${floor}:1`);
      }
    }
  }
  return failures;
}

describe("mobile theme tokens", () => {
  test.each(["light", "dark"] as const)(
    "%s text tokens clear the WCAG AA 4.5:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, TEXT_TOKENS, 4.5)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s non-text tokens clear the WCAG 1.4.11 3:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, NON_TEXT_TOKENS, 3)).toEqual([]);
    },
  );

  test("keeps subtleText visually lighter than mutedText so the hierarchy survives the contrast fix", () => {
    for (const mode of ["light", "dark"] as const) {
      const { colors } = buildTheme(mode);
      const towardCanvas = mode === "light" ? 1 : -1;
      expect(
        Math.sign(relativeLuminance(colors.subtleText) - relativeLuminance(colors.mutedText)),
      ).toBe(towardCanvas);
    }
  });


  test("keeps the brand color palette stable while expanding shape and depth tokens", () => {
    expect(theme.colors.primary).toBe("#2563eb");
    expect(theme.colors.accent).toBe("#ea580c");
    expect(theme.radius).toEqual({ sm: 10, md: 14, lg: 18, xl: 24, full: 999 });
    expect(theme.shadows.sm).toEqual(
      expect.objectContaining({
        shadowColor: "#0f172a",
        shadowOpacity: 0.05,
        elevation: 2,
      }),
    );
    expect(theme.shadows.md.elevation).toBe(4);
    expect(theme.shadows.lg.elevation).toBe(8);
  });

  test("builds both light and dark palettes, keeping brand hues, and maps the status bar", () => {
    const light = buildTheme("light");
    const dark = buildTheme("dark");

    // Default/active theme is light — the original app look.
    expect(theme.colors.background).toBe(light.colors.background);
    expect(light.colors.background).toBe("#f2f2f7");
    expect(light.colors.surface).toBe("#ffffff");
    // Dark flips the neutrals but keeps the brand blue/orange verbatim.
    expect(dark.colors.background).toBe("#0a0f1c");
    expect(dark.colors.primary).toBe("#3b82f6");
    expect(dark.colors.accent).toBe("#ea580c");
    // On-dark accent text uses a brighter same-hue glow; light keeps the base.
    expect(dark.colors.primaryGlow).toBe("#60a5fa");
    expect(light.colors.primaryGlow).toBe("#2563eb");
    // Non-color tokens are shared across themes.
    expect(dark.radius).toEqual(light.radius);

    expect(resolveStatusBarStyle("light")).toBe("dark");
    expect(resolveStatusBarStyle("dark")).toBe("light");
  });

  test("resolves typography families by locale and falls back when fonts are not ready", () => {
    expect(getFontFamily("en", "regular")).toBe("Inter_400Regular");
    expect(getFontFamily("ar", "bold")).toBe("Cairo_700Bold");
    expect(getFontFamily("en", "medium", false)).toBeUndefined();

    expect(getTypographyStyle("display", "en")).toEqual(
      expect.objectContaining({
        fontFamily: "Inter_700Bold",
        fontSize: 34,
        fontWeight: "700",
        lineHeight: 41,
      }),
    );
    expect(getTypographyStyle("heading", "ar")).toEqual(
      expect.objectContaining({
        fontFamily: "Cairo_600SemiBold",
        fontSize: 17,
        fontWeight: "600",
      }),
    );
    expect(getTypographyStyle("label", "en", false)).toEqual(
      expect.objectContaining({
        fontFamily: undefined,
        letterSpacing: 0.5,
        textTransform: "uppercase",
      }),
    );
  });
});
