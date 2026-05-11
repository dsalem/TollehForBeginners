import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tolleh — Backgammon for Beginners",
  description: "Backgammon with engine analysis, mistake review, and performance ratings.",
  applicationName: "Tolleh",
  appleWebApp: {
    capable: true,
    title: "Tolleh",
    // "black-translucent" lets the canvas extend behind the iOS status bar
    // (the board renders edge-to-edge in landscape after add-to-home-screen).
    statusBarStyle: "black-translucent",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#2e1a0c",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
