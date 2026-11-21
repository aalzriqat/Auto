import { devices, type Browser } from "@playwright/test";
import { newContainedContext } from "../containedContext";

export function newDealLifecycleContext(
  browser: Browser,
  baseURL: string | undefined,
  storageState: string,
  display: "desktop" | "mobile",
) {
  if (!baseURL) throw new Error("Deal lifecycle tests require the configured Playwright baseURL.");

  const device = display === "mobile"
    ? devices["Pixel 5"]
    : { viewport: { width: 1280, height: 720 } };
  return newContainedContext(browser, { ...device, baseURL, storageState });
}
