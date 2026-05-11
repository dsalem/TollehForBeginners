import type { MetadataRoute } from "next";

// Web App Manifest — drives Android Chrome's "Install app" / "Add to Home
// screen" flow. iOS Safari mostly ignores this and pulls apple-icon + the
// `appleWebApp` metadata from layout.tsx instead, but we ship both so the
// app installs identically on either platform.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tolleh — Backgammon for Beginners",
    short_name: "Tolleh",
    description:
      "Backgammon trainer with engine analysis, mistake review, and performance ratings.",
    start_url: "/",
    display: "standalone",
    orientation: "landscape",
    background_color: "#2e1a0c",
    theme_color: "#2e1a0c",
    icons: [
      {
        // Next.js auto-routes app/icon.tsx → /icon
        src: "/icon",
        sizes: "32x32",
        type: "image/png",
      },
      {
        // app/apple-icon.tsx → /apple-icon
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
      {
        // Same image; Chrome wants a "maskable" variant flagged so it
        // applies its own safe-area mask when generating the launcher icon.
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
