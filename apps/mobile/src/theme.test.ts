import { getFontFamily, getTypographyStyle, theme } from "./theme";

describe("mobile theme tokens", () => {
  test("keeps the brand color palette stable while expanding shape and depth tokens", () => {
    expect(theme.colors.primary).toBe("#0f766e");
    expect(theme.colors.accent).toBe("#ea580c");
    expect(theme.radius).toEqual({ sm: 8, md: 12, lg: 16, xl: 20, full: 999 });
    expect(theme.shadows.sm).toEqual(
      expect.objectContaining({
        shadowColor: "#0f172a",
        shadowOpacity: 0.06,
        elevation: 2,
      }),
    );
    expect(theme.shadows.md.elevation).toBe(4);
    expect(theme.shadows.lg.elevation).toBe(8);
  });

  test("resolves typography families by locale and falls back when fonts are not ready", () => {
    expect(getFontFamily("en", "regular")).toBe("Inter_400Regular");
    expect(getFontFamily("ar", "bold")).toBe("Cairo_700Bold");
    expect(getFontFamily("en", "medium", false)).toBeUndefined();

    expect(getTypographyStyle("display", "en")).toEqual(
      expect.objectContaining({
        fontFamily: "Inter_700Bold",
        fontSize: 28,
        fontWeight: "700",
        lineHeight: 34,
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
        letterSpacing: 0,
        textTransform: "uppercase",
      }),
    );
  });
});
