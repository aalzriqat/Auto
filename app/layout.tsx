import type { Metadata } from "next";
import { Inter, Cairo } from "next/font/google";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { ClerkProviderWithLocale } from "@/components/providers/ClerkProviderWithLocale";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { isDealerWebsiteHost } from "@/lib/dealerHost";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "AutoFlow | The Modern Dealership OS",
  description: "Ditch the spreadsheets. Manage your vehicle inventory, track sales pipelines, and generate professional PDF quotes instantly. Built for modern showrooms.",
  icons: {
    // Icon-only crop of the brand mark on a solid background — logo.png (the
    // full wordmark banner used elsewhere in the UI) reads as a blurry
    // gradient blob at favicon/home-screen sizes.
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },
  // iOS/iPadOS only supports Web Push (and standalone "app" chrome) for a
  // site added to the Home Screen — this is what makes that installable.
  appleWebApp: {
    capable: true,
    title: "AutoFlow",
    statusBarStyle: "default",
  },
};

export const viewport = {
  themeColor: "#0f172a",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const showAnalytics = !isDealerWebsiteHost(requestHeaders.get("host"));

  return (
    <html lang="ar" dir="rtl">
      <body
        className={`${inter.variable} ${cairo.variable} font-cairo antialiased`}
      >
        <LanguageProvider>
          <ClerkProviderWithLocale>
            <ConvexClientProvider>{children}</ConvexClientProvider>
          </ClerkProviderWithLocale>
        </LanguageProvider>
        {showAnalytics ? <Analytics /> : null}
      </body>
    </html>
  );
}
