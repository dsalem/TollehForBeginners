/**
 * Centralized visual theme for the Pixi backgammon board.
 *
 * Phase 2: palette tokens updated to a warm walnut + cream-felt aesthetic.
 * Pixi takes 0xRRGGBB integers for colors. Where a CSS string is needed
 * elsewhere (e.g. for the floating mistake card), use `cssOf()`.
 */

// ── Color palette (Pixi-numeric, 0xRRGGBB) ──────────────────────────────────
export const palette = {
  // Outer frame & rails (walnut tones — see boardArt gradients for fills)
  frameOuter:     0x1a120a, // dark wood bezel outside the playing frame
  frameWood:      0x5c3a20, // mid walnut (solid fallback / gradient mid-stop)
  frameWoodLight: 0x8a5a32, // walnut highlight (top of grain)
  frameWoodDark:  0x2e1a0c, // walnut shadow (bottom of grain)
  frameWoodEdge:  0x1c0e04, // very dark stroke around the wood
  frameInlay:     0xc79a4a, // gold-lacquer inlay around the felt
  frameInnerEdge: 0x3a2110, // stroke around the felt panel

  rail:           0x5c3a20,
  railEdge:       0x1c0e04,

  feltSurface:    0xefe2c6, // playing surface (gradient bright top → shaded bottom)
  feltShade:      0xd6c099,
  feltEdgeShadow: 0x6b4a26,

  // Bar (centre divider — walnut, matching frame)
  barIdle:        0x4d2e16,
  barSelected:    0x7d4e26,
  barEdgeIdle:    0x1c0e04,
  barEdgeLegal:   0xffd166,
  barGrainLight:  0x6e4220,
  barGrainDark:   0x2e1a0c,

  // Side panel (borne-off trays)
  trayTopFill:    0x6e4220,
  trayTopEdge:    0x1c0e04,
  trayBottomFill: 0x3a2110,
  trayBottomEdge: 0x1c0e04,

  // Points (rectangle hit-zone behind triangles)
  pointZoneFill:  0xf2dfbf,
  pointZoneEdge:  0x8f6b48,

  // Triangles (burgundy + bone, dimensional gradient stops)
  triangleDark:        0x7a2e23,
  triangleDarkTop:     0x94392c,
  triangleDarkBottom:  0x641e15,
  triangleLight:       0xe9d8b6,
  triangleLightTop:    0xf0e2bc,
  triangleLightBottom: 0xcdb87f,
  triangleStitch:      0x9d6f2c,

  // Highlights
  glowSelected:   0x2f6bff,
  glowLegal:      0xffd166,

  // Move analysis marks
  bestMarkFill:   0xf2c94c,
  bestMarkEdge:   0x7c5a00,
  yourMarkFill:   0x69a7ff,
  yourMarkEdge:   0x123c8c,

  // Checkers — high-contrast cool/warm pair so each colour pops against the
  // cream felt and the burgundy triangles. Old ivory/ebony blended into the
  // board (especially WHITE on the cream points). Now WHITE is a warm cream
  // with strong gold ring + dark stroke; BLACK is a deep navy with a
  // saturated lift so it's distinguishable from the dark triangles.
  whiteFace:      0xfff4d4,
  whiteFaceTop:   0xffffff,
  whiteFaceMid:   0xfaecbe,
  whiteEdge:      0x6b3a14,
  whiteHighlight: 0xffffff,
  blackFace:      0x102b4e,
  blackFaceTop:   0x2a4d7a,
  blackFaceMid:   0x102b4e,
  blackEdge:      0x05101f,
  blackHighlight: 0x6f93c2,
  checkerShadow:  0x000000,

  // Dice
  dieFace:        0xf8efd8,
  dieFaceTop:     0xfcf5dd,
  dieFaceBottom:  0xdcc899,
  dieEdgeIdle:    0xa48656,
  dieEdgeActive:  0x225bd8,
  diePip:         0x7a1a14,

  // Action buttons (named by intent so re-skins are easy)
  btnDefault:     0x8a5a2f,
  btnDefaultEdge: 0x5b371f,
  btnMenu:        0x74502d,
  btnUndoLeft:    0x9a416a,
  btnUndoRight:   0xb64c7a,
  btnHint:        0x9e7433,
  btnRoll:        0x43a757,
  btnDouble:      0x0f9f55,
  btnSubmit:      0x32a857,

  // Text inks
  textInk:        0x2c1a10,
  textOnRail:     0xfff4df,
  textOnTray:     0xfff6e9,
  textOnBar:      0xfff2dc,
  textPointLabel: 0xffffff,
} as const;

// ── Alpha levels used at draw time ──────────────────────────────────────────
export const alpha = {
  checkerShadow:    0.22,
  checkerHighlight: 0.55,
  pointZoneFill:    0.18,
  pointZoneEdge:    0.45,
  glow:             0.9,
  buttonDisabled:   0.42,
  strokeDefault:    0.75,
  strokeButton:     0.85,
} as const;

// ── Stroke widths ───────────────────────────────────────────────────────────
export const stroke = {
  frameWoodWidth: 4,
  feltEdgeWidth:  3,
  railEdgeWidth:  3,
  panelEdgeWidth: 2,
  pointZoneWidth: 1,
  glowSelected:   5,
  glowLegal:      3,
  barLegal:       4,
  barIdle:        2,
  buttonWidth:    2,
  dieActive:      4,
  dieIdle:        2,
  inlay:          2,
} as const;

// ── Board geometry ──────────────────────────────────────────────────────────
// BAR slimmed from 72 → 44 to match Lord-of-the-Board / Backgammon NJ
// proportions; the playing surface widens by 28px which lets the points
// (and therefore the checkers stacked on them) be ~5% larger.
export const dim = {
  WIDTH:  1280,
  HEIGHT: 720,
  FRAME:  34,
  RAIL:   92,
  SIDE:   110,
  BAR:    44,
  GAP:    10,
} as const;

// ── Typography ──────────────────────────────────────────────────────────────
export const typography = {
  fontFamily: "Trebuchet MS, Georgia, serif",
  defaultSize: 16,
  defaultWeight: "bold" as const,
} as const;

// ── Motion tokens (used by future phases for the mistake card / replays) ───
export const motion = {
  cardEnterMs:    220,
  cardEnterEase:  "cubic-bezier(.2,.8,.2,1)",
  arrowDrawMs:    450,
  checkerTweenMs: 220,
} as const;

// ── Severity tokens for the post-move mistake card ─────────────────────────
export const severity = {
  good:    { color: 0x3c8a4a, css: "#3c8a4a", label: "Best move",   icon: "✓" },
  slight:  { color: 0xc9a23a, css: "#c9a23a", label: "Slight slip", icon: "⚠" },
  error:   { color: 0xd97a1f, css: "#d97a1f", label: "Error",       icon: "⚠" },
  blunder: { color: 0xb21d1d, css: "#b21d1d", label: "Blunder",     icon: "🛑" },
} as const;

export type SeverityKey = keyof typeof severity;

/** Convert a Pixi-numeric color (0xRRGGBB) into a `#rrggbb` string for CSS. */
export function cssOf(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}
