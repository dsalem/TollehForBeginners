/**
 * Board art primitives — gradient factories + dimensional draw helpers.
 *
 * Everything here is a thin wrapper over Pixi v8's Graphics / FillGradient
 * APIs. The board renderer (BackgammonPixiBoard.tsx) calls these so it can
 * stay focused on layout & state rather than pixel-level styling.
 *
 * FillGradient instances are stateful in Pixi, so we build a fresh one per
 * call. They're cheap to construct.
 */

import { Container, FillGradient, Graphics, Rectangle } from "pixi.js";
import { palette, alpha, stroke } from "./theme";

// ── Gradient factories ──────────────────────────────────────────────────────
// All gradients run vertically (y0=0 → y1=h) unless noted.

export function woodGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0,    palette.frameWoodLight);
  g.addColorStop(0.5,  palette.frameWood);
  g.addColorStop(1,    palette.frameWoodDark);
  return g;
}

export function feltGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0, palette.feltSurface);
  g.addColorStop(1, palette.feltShade);
  return g;
}

export function barGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0,   palette.barGrainLight);
  g.addColorStop(0.5, palette.barIdle);
  g.addColorStop(1,   palette.barGrainDark);
  return g;
}

export function triDarkGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0, palette.triangleDarkTop);
  g.addColorStop(1, palette.triangleDarkBottom);
  return g;
}

export function triLightGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0, palette.triangleLightTop);
  g.addColorStop(1, palette.triangleLightBottom);
  return g;
}

export function dieFaceGrad(h: number): FillGradient {
  const g = new FillGradient(0, 0, 0, h);
  g.addColorStop(0, palette.dieFaceTop);
  g.addColorStop(1, palette.dieFaceBottom);
  return g;
}

// ── Checker stone (dimensional, layered to fake a radial gradient) ─────────
// Draws (in order, all at /around centre x,y):
//   1. drop-shadow ellipse beneath
//   2. dark outer disc (full radius)
//   3. mid-tone disc (~93% radius) — gives the bevel effect
//   4. bright highlight disc (~63% radius) — offset up-left, very low alpha
//   5. tournament inner ring (stroked, ~63% radius)
//   6. tiny bright specular dot
export function drawCheckerStone(
  parent: Container,
  x: number,
  y: number,
  radius: number,
  owner: "WHITE" | "BLACK",
): void {
  const isWhite = owner === "WHITE";
  const dark    = isWhite ? palette.whiteEdge      : palette.blackEdge;
  const mid     = isWhite ? palette.whiteFaceMid   : palette.blackFaceMid;
  const highlit = isWhite ? palette.whiteFaceTop   : palette.blackFaceTop;
  const spec    = isWhite ? palette.whiteHighlight : palette.blackHighlight;

  // 1. shadow
  const shadow = new Graphics();
  shadow
    .ellipse(x + 2, y + 4, radius * 0.98, radius * 0.46)
    .fill({ color: palette.checkerShadow, alpha: alpha.checkerShadow });
  parent.addChild(shadow);

  // 2-5. layered disc. The outer ring is wider (radius * 0.88 vs 0.93) and
  // gets an extra dark stroke so the checker reads as a discrete object even
  // when its face colour is in the same family as the felt.
  const disc = new Graphics();
  // outer dark ring
  disc.circle(x, y, radius).fill(dark);
  // mid face (slightly smaller so the dark ring is visually thicker)
  disc.circle(x, y, radius * 0.88).fill(mid);
  // crisp outline so checkers separate from cream/burgundy points
  disc.circle(x, y, radius).stroke({ color: dark, width: 1.2, alpha: 0.95 });
  // highlight wash, offset up-left
  disc
    .circle(x - radius * 0.18, y - radius * 0.20, radius * 0.78)
    .fill({ color: highlit, alpha: 0.55 });
  // tournament inner ring
  disc
    .circle(x, y, radius * 0.62)
    .stroke({ color: dark, width: 1, alpha: 0.7 });
  parent.addChild(disc);

  // 6. specular dot
  const spot = new Graphics();
  spot
    .circle(x - radius * 0.36, y - radius * 0.38, radius * 0.18)
    .fill({ color: spec, alpha: isWhite ? 0.85 : 0.45 });
  parent.addChild(spot);
}

// ── Dice face (rounded ivory cube with deep-red pips, slight rotation) ─────
// Pixi's Graphics has no rotation per-call, so we use a short-lived Container
// at the dice's centre and rotate that.
export function drawDieFace(
  parent: Container,
  x: number,
  y: number,
  size: number,
  value: number,
  active: boolean,
  rotationRad: number,
  onClick?: () => void,
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const wrap = new Container();
  wrap.x = cx;
  wrap.y = cy;
  wrap.rotation = rotationRad;
  parent.addChild(wrap);

  // soft cast shadow under the cube
  const shadow = new Graphics();
  shadow
    .ellipse(2, size * 0.5 + 4, size * 0.55, size * 0.18)
    .fill({ color: palette.checkerShadow, alpha: 0.22 });
  wrap.addChild(shadow);

  const die = new Graphics();
  die
    .roundRect(-size / 2, -size / 2, size, size, size * 0.18)
    .fill(dieFaceGrad(size))
    .stroke({
      color: active ? palette.dieEdgeActive : palette.dieEdgeIdle,
      width: active ? stroke.dieActive : stroke.dieIdle,
      alpha: 0.9,
    });
  die.eventMode = onClick ? "static" : "none";
  die.cursor = onClick ? "pointer" : "default";
  die.hitArea = new Rectangle(-size / 2, -size / 2, size, size);
  if (onClick) {
    die.on("pointerup", onClick);
  }
  wrap.addChild(die);

  // Pip layout — coordinates are relative to the cube centre (range ±size/2).
  const o = size * 0.27;       // pip offset from centre
  const layouts: Record<number, Array<[number, number]>> = {
    1: [[0, 0]],
    2: [[-o, -o], [o, o]],
    3: [[-o, -o], [0, 0], [o, o]],
    4: [[-o, -o], [o, -o], [-o, o], [o, o]],
    5: [[-o, -o], [o, -o], [0, 0], [-o, o], [o, o]],
    6: [[-o, -o], [o, -o], [-o, 0], [o, 0], [-o, o], [o, o]],
  };
  const pipR = size * 0.085;
  const pip = new Graphics();
  for (const [px, py] of layouts[value] ?? []) {
    pip.circle(px, py, pipR).fill(palette.diePip);
  }
  wrap.addChild(pip);
}
