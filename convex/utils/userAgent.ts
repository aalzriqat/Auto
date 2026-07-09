export type DeviceType = "mobile" | "tablet" | "desktop" | "unknown";

export type ParsedUserAgent = {
  deviceType: DeviceType;
  browserName: string;
  osName: string;
};

const BOT_PATTERN =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|whatsapp|telegrambot|curl|wget|python-requests|headlesschrome|pingdom|uptimerobot|ahrefsbot|semrushbot|mj12bot/i;

export function isLikelyBot(ua: string | undefined): boolean {
  if (!ua) return false;
  return BOT_PATTERN.test(ua);
}

function detectDeviceType(ua: string): DeviceType {
  if (/ipad|tablet|kindle|playbook|silk/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) return "mobile";
  if (/android/i.test(ua)) return "tablet";
  return "desktop";
}

function detectBrowserName(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/crios\//i.test(ua)) return "Chrome";
  if (/fxios\//i.test(ua)) return "Firefox";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua) && /version\//i.test(ua)) return "Safari";
  return "Other";
}

function detectOsName(ua: string): string {
  // iOS UAs contain "like Mac OS X", so this check must precede the macOS check.
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/windows nt/i.test(ua)) return "Windows";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/linux/i.test(ua)) return "Linux";
  return "Other";
}

export function parseUserAgent(ua: string | undefined): ParsedUserAgent {
  if (!ua) {
    return { deviceType: "unknown", browserName: "Other", osName: "Other" };
  }
  return {
    deviceType: detectDeviceType(ua),
    browserName: detectBrowserName(ua),
    osName: detectOsName(ua),
  };
}
