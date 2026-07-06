const PLATFORM_HOSTS = new Set(["autoflowdealer.com", "www.autoflowdealer.com"]);

export function normalizedHost(host: string | null): string {
  return (host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function configuredAppHost(): string | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return null;

  try {
    return normalizedHost(new URL(appUrl).host);
  } catch {
    return null;
  }
}

export function isDealerWebsiteHost(host: string | null): boolean {
  const normalized = normalizedHost(host);
  if (!normalized || normalized === "localhost" || normalized === "127.0.0.1") {
    return false;
  }

  if (normalized === configuredAppHost()) return false;
  if (PLATFORM_HOSTS.has(normalized)) return false;
  if (normalized.endsWith(".autoflowdealer.com")) return true;

  return !normalized.endsWith(".vercel.app");
}
