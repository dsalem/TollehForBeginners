import { ImageResponse } from "next/og";

// iOS Safari "Add to Home Screen" PNG. Dark walnut background, two
// overlapping checkers (cream + burgundy) and a rotated white die — the
// three pieces of backgammon iconography that read instantly at home-
// screen size (~60–80px on iPhone).
//
// All shapes are positioned divs with linear-gradients and box-shadows;
// Satori (the rasterizer behind ImageResponse) supports this CSS subset
// reliably, no SVG required.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const PIP = (top: number, left: number) => (
  <div
    style={{
      position: "absolute",
      top,
      left,
      width: 10,
      height: 10,
      borderRadius: 5,
      background: "#7a1a14",
    }}
  />
);

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "linear-gradient(135deg, #6e4220 0%, #2e1a0c 100%)",
          position: "relative",
        }}
      >
        {/* Cream checker — back-left of the pair */}
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 56,
            width: 92,
            height: 92,
            borderRadius: 46,
            background:
              "linear-gradient(180deg, #fffaeb 0%, #ead9ad 60%, #c8af7c 100%)",
            border: "4px solid #a48656",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 8px rgba(0,0,0,0.35)",
          }}
        >
          {/* Inner tournament ring — gives the disc some depth at small sizes */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              border: "2px solid #a48656",
              opacity: 0.55,
            }}
          />
        </div>

        {/* Burgundy checker — front-right, partially overlapping the cream one */}
        <div
          style={{
            position: "absolute",
            left: 68,
            top: 84,
            width: 92,
            height: 92,
            borderRadius: 46,
            background:
              "linear-gradient(180deg, #a8483a 0%, #7a2e23 55%, #461410 100%)",
            border: "4px solid #2a0a06",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 5px 10px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              border: "2px solid #2a0a06",
              opacity: 0.55,
            }}
          />
        </div>

        {/* Die — upper-right corner, slightly tilted. Face shows 5. */}
        <div
          style={{
            position: "absolute",
            right: 16,
            top: 12,
            width: 64,
            height: 64,
            borderRadius: 12,
            background:
              "linear-gradient(180deg, #ffffff 0%, #e8dfc4 100%)",
            border: "3px solid #a48656",
            transform: "rotate(-10deg)",
            boxShadow: "0 4px 10px rgba(0,0,0,0.5)",
            display: "flex",
          }}
        >
          {/* "5" face: four corner pips + a centre pip */}
          {PIP(8, 8)}
          {PIP(8, 40)}
          {PIP(27, 27)}
          {PIP(46, 8)}
          {PIP(46, 40)}
        </div>
      </div>
    ),
    { ...size },
  );
}
