import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AutoFlow | The Modern Dealership OS",
    short_name: "AutoFlow",
    description:
      "Manage vehicle inventory, sales pipelines, and dealership operations from one app.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      // Dedicated icon-only crop of the brand mark on a solid background —
      // logo.png (used elsewhere as a wordmark) reads as a blurry gradient
      // blob at launcher/notification sizes since its actual mark is small
      // and centered in a large glow with illegible wordmark text.
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
