import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "zweb · remote zcoder",
  description: "A private web interface for remote zcoder servers",
  applicationName: "zweb",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/zweb-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/zweb-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/zweb-apple-180.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "zweb", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false, email: false, address: false },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#1e1e1e",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await headers();
  return (
    <html lang="en">
      <body>{children}<PwaRegister /></body>
    </html>
  );
}
