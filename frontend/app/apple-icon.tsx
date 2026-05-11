import { ImageResponse } from "next/og";

// iOS Safari "Add to Home Screen" pulls this PNG and renders it with iOS's
// own corner-rounding mask, so we deliberately draw a square (no border-
// radius) and let iOS handle the squircle. Background tone matches the
// board's walnut frame to stay visually consistent with the in-app art.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #6e4220 0%, #2e1a0c 100%)",
        }}
      >
        <div
          style={{
            width: 124,
            height: 124,
            borderRadius: 62,
            background: "linear-gradient(180deg, #fffaeb 0%, #ead9ad 100%)",
            border: "4px solid #a48656",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#7a2e23",
            fontFamily: "Georgia, serif",
            fontSize: 92,
            fontWeight: 700,
            fontStyle: "italic",
            lineHeight: 1,
            paddingBottom: 6, // optical centering for the italic T
          }}
        >
          T
        </div>
      </div>
    ),
    { ...size },
  );
}
