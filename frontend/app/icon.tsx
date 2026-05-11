import { ImageResponse } from "next/og";

// 32×32 browser-tab favicon. At this size a full checkers-and-die
// composition collapses into mush, so we keep just the two overlapping
// checkers — still reads as backgammon, still uses the brand palette.

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
          background: "linear-gradient(135deg, #6e4220 0%, #2e1a0c 100%)",
          position: "relative",
          borderRadius: 6,
        }}
      >
        {/* Cream checker — back-left */}
        <div
          style={{
            position: "absolute",
            left: 2,
            top: 8,
            width: 18,
            height: 18,
            borderRadius: 9,
            background: "linear-gradient(180deg, #fffaeb 0%, #ead9ad 100%)",
            border: "1px solid #a48656",
          }}
        />
        {/* Burgundy checker — front-right, overlapping */}
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 14,
            width: 18,
            height: 18,
            borderRadius: 9,
            background: "linear-gradient(180deg, #a8483a 0%, #461410 100%)",
            border: "1px solid #2a0a06",
          }}
        />
      </div>
    ),
    { ...size },
  );
}
