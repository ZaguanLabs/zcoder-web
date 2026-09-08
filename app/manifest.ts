import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "zweb · remote zcoder",
    short_name: "zweb",
    description: "A private control surface for remote zcoder servers",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1e1e1e",
    theme_color: "#1e1e1e",
    lang: "en",
    categories: ["developer", "productivity", "utilities"],
    icons: [
      { src: "/icons/zweb-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/zweb-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/zweb-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

