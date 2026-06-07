import type { Metadata } from "next";
import { Inter, Cairo } from "next/font/google";
import "./globals.css";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { ClerkProvider } from "@clerk/nextjs";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "Bloom Cars | Dealership Management",
  description: "Modern dealership management platform.",
  icons: {
    icon: "/convex.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${cairo.variable} font-inter antialiased`}
      >
        <ClerkProvider dynamic>
          <LanguageProvider>
            <ConvexClientProvider>{children}</ConvexClientProvider>
          </LanguageProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
