import { buildTheme, getFontFamily, getTypographyStyle, resolveStatusBarStyle, theme } from "./theme";

describe("mobile theme tokens", () => {
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
