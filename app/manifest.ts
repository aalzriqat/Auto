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
    // Matches the mobile app's dark canvas and the icon plate baked into
    // icon.png / icon-maskable.png, so the installed PWA has no colour seam
    // between its splash, its chrome, and the icon itself.
    background_color: "#0a0f1c",
    theme_color: "#0a0f1c",
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
