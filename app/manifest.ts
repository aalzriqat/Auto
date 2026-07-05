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
      {
        src: "/logo.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
