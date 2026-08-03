import { useMemo } from "react";

import { useAppFontState } from "../../providers/AppFontContext";
import { useLocale } from "../../providers/LocaleProvider";
import { getTypographyStyle } from "../../theme";

/**
 * The dashboard's type ramp, resolved for the active locale (Inter for English,
 * Cairo for Arabic) and for whether the fonts have finished loading.
 */
export function useDashboardTypography() {
  const { locale } = useLocale();
  const { fontsLoaded } = useAppFontState();

  return useMemo(
    () => ({
      body: getTypographyStyle("body", locale, fontsLoaded),
      caption: getTypographyStyle("caption", locale, fontsLoaded),
      display: getTypographyStyle("display", locale, fontsLoaded),
      heading: getTypographyStyle("heading", locale, fontsLoaded),
      label: getTypographyStyle("label", locale, fontsLoaded),
      title: getTypographyStyle("title", locale, fontsLoaded),
    }),
    [fontsLoaded, locale],
  );
}
