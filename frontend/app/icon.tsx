import { ImageResponse } from "next/og";

// Browser-tab favicon. At 32×32 the cream-checker-with-T composition from
// apple-icon collapses into mush, so we drop the wood frame and just render
// the cream disc full-bleed with a darker italic T. Reads at one glance.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 16,
          background: "linear-gradient(180deg, #fffaeb 0%, #ead9ad 100%)",
          border: "1px solid #a48656",
          color: "#7a2e23",
          fontFamily: "Georgia, serif",
          fontSize: 24,
          fontWeight: 700,
          fontStyle: "italic",
          lineHeight: 1,
          paddingBottom: 2,
        }}
      >
        T
      </div>
    ),
    { ...size },
  );
}
