"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Application, Container, Graphics, Rectangle, Text, TextStyle } from "pixi.js";
import type { RendererBoardState, TurnMoveResponse, PlayerColor } from "../lib/boardAdapter";
import { palette, alpha, stroke, dim, typography, motion } from "../lib/theme";
import {
  woodGrad,
  feltGrad,
  barGrad,
  triDarkGrad,
  triLightGrad,
  drawCheckerStone,
  drawDieFace,
} from "../lib/boardArt";

type BoardAction = "roll" | "done" | "pass" | "undo" | "double" | "hint" | "menu";

type Props = {
  board: RendererBoardState | null;
  canSwapDice: boolean;
  canRoll: boolean;
  canSubmit: boolean;
  canUndo: boolean;
  canDouble: boolean;
  canAnalyze: boolean;
  submitLabel: "DONE" | "PASS";
  onPointClick: (point: number) => void;
  onBarClick: () => void;
  onBearOffClick: () => void;
  onSwapDice: () => void;
  onAction: (action: BoardAction) => void;
  bestArrows?: TurnMoveResponse | null;
  arrowsVisible?: boolean;
  replayKey?: number;
  /** Move to animate when replayKey changes. Falls back to bestArrows. */
  replayMove?: TurnMoveResponse | null;
  /** When true, render the board from BLACK's perspective (home at bottom). */
  flipBoard?: boolean;
  /** When true, the dice are the "roll for first move" pair — show one on
   *  each side of the bar (each player's rolled die). After the opening
   *  player makes their first move, isOpeningRoll goes back to false and
   *  dice render in the centre as normal. */
  isOpeningRoll?: boolean;
  /** Live score chip in the rail. */
  scoreWhite?: number;
  scoreBlack?: number;
  matchLength?: number;
  /** Online lobby join code; renders as a chip in the rail when set. */
  joinCode?: string | null;
};

type PointGeometry = {
  number: number;
  x: number;
  y: number;
  w: number;
  h: number;
  orientation: "up" | "down";
  colorAlt: boolean;
};

const WIDTH = dim.WIDTH;
const HEIGHT = dim.HEIGHT;
const FRAME = dim.FRAME;
const RAIL = dim.RAIL;
const SIDE = dim.SIDE;
const BAR = dim.BAR;
const GAP = dim.GAP;
const BOARD_X = FRAME + RAIL;
const BOARD_Y = FRAME;
const BOARD_W = WIDTH - FRAME * 2 - RAIL - SIDE - 18;
const BOARD_H = HEIGHT - FRAME * 2;
const HALF_W = (BOARD_W - BAR - GAP * 2) / 2;
const POINT_W = HALF_W / 6;
const ROW_H = (BOARD_H - 22) / 2;
const BAR_X = BOARD_X + HALF_W + GAP;
const SIDE_X = BOARD_X + BOARD_W + 18;

const ARROW_GOLD = 0xf2c94c;
const ARROW_GOLD_EDGE = 0x7c5a00;
const ARROW_GOLD_GLOW = 0xfff1b8;

const pointRowsWhite = {
  topLeft: [13, 14, 15, 16, 17, 18],
  topRight: [19, 20, 21, 22, 23, 24],
  bottomLeft: [12, 11, 10, 9, 8, 7],
  bottomRight: [6, 5, 4, 3, 2, 1],
};

// BLACK perspective: vertical flip so BLACK's home (19-24) is at bottom-right.
// Orientations stay the same per row position; only the point numbers swap.
const pointRowsBlack = {
  topLeft: [12, 11, 10, 9, 8, 7],
  topRight: [6, 5, 4, 3, 2, 1],
  bottomLeft: [13, 14, 15, 16, 17, 18],
  bottomRight: [19, 20, 21, 22, 23, 24],
};

function addText(
  parent: Container,
  text: string,
  x: number,
  y: number,
  size: number = typography.defaultSize,
  fill: number = palette.textInk,
  weight: "normal" | "bold" = typography.defaultWeight,
) {
  const label = new Text({
    text,
    style: new TextStyle({
      fill,
      fontFamily: typography.fontFamily,
      fontSize: size,
      fontWeight: weight,
    }),
  });
  label.x = x;
  label.y = y;
  parent.addChild(label);
  return label;
}

function drawRoundedRect(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: number,
  fillAlpha = 1,
  edgeColor: number = palette.frameInnerEdge,
) {
  g.roundRect(x, y, w, h, radius)
    .fill({ color: fill, alpha: fillAlpha })
    .stroke({ color: edgeColor, width: stroke.panelEdgeWidth, alpha: alpha.strokeDefault });
}

function pointGeometry(flipBoard: boolean): PointGeometry[] {
  const result: PointGeometry[] = [];
  const topY = BOARD_Y + 20;
  const bottomY = BOARD_Y + ROW_H + 22;
  const leftX = BOARD_X;
  const rightX = BOARD_X + HALF_W + BAR + GAP * 2;
  const rows = flipBoard ? pointRowsBlack : pointRowsWhite;

  const addRow = (points: number[], x: number, y: number, orientation: "up" | "down") => {
    points.forEach((number, index) => {
      result.push({
        number,
        x: x + index * POINT_W,
        y,
        w: POINT_W - 6,
        h: ROW_H - 18,
        orientation,
        colorAlt: (index % 2 === 0) !== (orientation === "up"),
      });
    });
  };

  addRow(rows.topLeft, leftX, topY, "down");
  addRow(rows.topRight, rightX, topY, "down");
  addRow(rows.bottomLeft, leftX, bottomY, "up");
  addRow(rows.bottomRight, rightX, bottomY, "up");
  return result;
}

function dieRotation(value: number): number {
  return ((value % 5) - 2) * 0.045;
}

type LocCoord = { x: number; y: number };

function pointAnchor(geos: PointGeometry[], pointNumber: number): LocCoord | null {
  const g = geos.find((p) => p.number === pointNumber);
  if (!g) return null;
  const cx = g.x + g.w / 2;
  const cy = g.orientation === "down" ? g.y + 30 : g.y + g.h - 30;
  return { x: cx, y: cy };
}

function barAnchor(player: PlayerColor, flipBoard: boolean): LocCoord {
  const cx = BAR_X + BAR / 2;
  // WHITE perspective: WHITE on the lower half (their home is bottom-right),
  // BLACK on the upper half. Flip swaps which side each player occupies.
  const whiteAtLowerHalf = !flipBoard;
  const isLower = (player === "WHITE") === whiteAtLowerHalf;
  const cy = isLower ? BOARD_Y + BOARD_H * 0.62 : BOARD_Y + BOARD_H * 0.38;
  return { x: cx, y: cy };
}

function borneOffAnchor(player: PlayerColor, flipBoard: boolean): LocCoord {
  const cx = SIDE_X + (SIDE - 16) / 2;
  // WHITE perspective: WHITE bears off into the bottom tray (their home),
  // BLACK into the top tray. Flip swaps the two trays' owners.
  const whiteInBottom = !flipBoard;
  const isBottom = (player === "WHITE") === whiteInBottom;
  const cy = isBottom
    ? BOARD_Y + ROW_H + 20 + (ROW_H - 10) / 2
    : BOARD_Y + (ROW_H - 10) / 2;
  return { x: cx, y: cy };
}

function moveAnchors(
  geos: PointGeometry[],
  move: { from_point: number | null; to_point: number | null; from_bar: boolean; to_borne_off: boolean },
  player: PlayerColor,
  flipBoard: boolean,
): { from: LocCoord; to: LocCoord } | null {
  const from = move.from_bar
    ? barAnchor(player, flipBoard)
    : move.from_point !== null
      ? pointAnchor(geos, move.from_point)
      : null;
  const to = move.to_borne_off
    ? borneOffAnchor(player, flipBoard)
    : move.to_point !== null
      ? pointAnchor(geos, move.to_point)
      : null;
  if (!from || !to) return null;
  return { from, to };
}

function drawArrow(
  parent: Container,
  from: LocCoord,
  to: LocCoord,
  index: number,
  total: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const curveSign = (index % 2 === 0 ? -1 : 1) * (total > 1 ? 1 : 0.6);
  const lift = Math.min(120, dist * 0.25) * (total > 1 ? 1 : 0.85);
  const px = -dy / dist;
  const py = dx / dist;
  const cx = (from.x + to.x) / 2 + px * lift * curveSign;
  const cy = (from.y + to.y) / 2 + py * lift * curveSign;

  const glow = new Graphics();
  glow.moveTo(from.x, from.y).quadraticCurveTo(cx, cy, to.x, to.y)
    .stroke({ color: ARROW_GOLD_GLOW, width: 12, alpha: 0.35 });
  parent.addChild(glow);

  const shaft = new Graphics();
  shaft.moveTo(from.x, from.y).quadraticCurveTo(cx, cy, to.x, to.y)
    .stroke({ color: ARROW_GOLD, width: 6, alpha: 0.95 });
  parent.addChild(shaft);

  const edge = new Graphics();
  edge.moveTo(from.x, from.y).quadraticCurveTo(cx, cy, to.x, to.y)
    .stroke({ color: ARROW_GOLD_EDGE, width: 2, alpha: 0.65 });
  parent.addChild(edge);

  const tdx = to.x - cx;
  const tdy = to.y - cy;
  const tlen = Math.hypot(tdx, tdy) || 1;
  const ux = tdx / tlen;
  const uy = tdy / tlen;
  const headLen = 18;
  const headWidth = 12;
  const baseX = to.x - ux * headLen;
  const baseY = to.y - uy * headLen;
  const leftX = baseX + (-uy) * headWidth;
  const leftY = baseY + (ux) * headWidth;
  const rightX = baseX - (-uy) * headWidth;
  const rightY = baseY - (ux) * headWidth;
  const head = new Graphics();
  head.poly([to.x, to.y, leftX, leftY, rightX, rightY])
    .fill({ color: ARROW_GOLD, alpha: 0.98 })
    .stroke({ color: ARROW_GOLD_EDGE, width: 1.5, alpha: 0.85 });
  parent.addChild(head);

  const dot = new Graphics();
  dot.circle(from.x, from.y, 5)
    .fill({ color: ARROW_GOLD, alpha: 0.95 })
    .stroke({ color: ARROW_GOLD_EDGE, width: 1.5, alpha: 0.85 });
  parent.addChild(dot);

  const label = new Text({
    text: String(index + 1),
    style: new TextStyle({
      fill: 0x2a1a08,
      fontFamily: typography.fontFamily,
      fontSize: 12,
      fontWeight: "bold",
    }),
  });
  label.x = from.x + 7;
  label.y = from.y - 7;
  parent.addChild(label);
}

export default function BackgammonPixiBoard({
  board,
  canSwapDice,
  canRoll,
  canSubmit,
  canUndo,
  canDouble,
  canAnalyze,
  submitLabel,
  onPointClick,
  onBarClick,
  onBearOffClick,
  onSwapDice,
  onAction,
  bestArrows = null,
  arrowsVisible = true,
  replayKey = 0,
  replayMove = null,
  flipBoard = false,
  isOpeningRoll = false,
  scoreWhite,
  scoreBlack,
  matchLength,
  joinCode,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const rootRef = useRef<Container | null>(null);
  const overlayRef = useRef<Container | null>(null);
  const replayRef = useRef<Container | null>(null);
  const geometries = useMemo(() => pointGeometry(flipBoard), [flipBoard]);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const fullscreenTarget = useCallback((): HTMLElement | null => {
    return shellRef.current?.closest(".board-shell") as HTMLElement | null
      ?? shellRef.current;
  }, []);

  const enterFullscreen = useCallback(() => {
    const target = fullscreenTarget();
    if (!target) return;
    target.classList.add("board-shell-fullscreen");
    document.body.classList.add("body-fullscreen-board");
    setIsFullscreen(true);
    const req =
      target.requestFullscreen ??
      (target as unknown as { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;
    if (typeof req === "function") {
      try {
        const result = req.call(target);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {
            // Fall back to CSS-only fullscreen — class is already applied.
          });
        }
      } catch {
        // Browser refused (e.g. iOS Safari on iPhone); CSS fallback still works.
      }
    }
  }, [fullscreenTarget]);

  const exitFullscreen = useCallback(() => {
    const target = fullscreenTarget();
    target?.classList.remove("board-shell-fullscreen");
    document.body.classList.remove("body-fullscreen-board");
    setIsFullscreen(false);
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen ?? doc.webkitExitFullscreen;
      try {
        const result = exit?.call(document);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  }, [fullscreenTarget]);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  useEffect(() => {
    const handler = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      const native = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
      if (!native && isFullscreen) {
        // User pressed Esc out of native fullscreen — drop the CSS class too.
        const target = fullscreenTarget();
        target?.classList.remove("board-shell-fullscreen");
        document.body.classList.remove("body-fullscreen-board");
        setIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
  }, [isFullscreen, fullscreenTarget]);

  useEffect(() => {
    return () => {
      // Component unmount: make sure we don't leave the page in fullscreen mode.
      const target = fullscreenTarget();
      target?.classList.remove("board-shell-fullscreen");
      document.body.classList.remove("body-fullscreen-board");
    };
  }, [fullscreenTarget]);

  useEffect(() => {
    let destroyed = false;
    let initialized = false;
    const app = new Application();
    appRef.current = app;

    void app.init({
      width: WIDTH,
      height: HEIGHT,
      antialias: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    }).then(() => {
      initialized = true;
      if (destroyed || !hostRef.current) {
        try {
          app.destroy();
        } catch {
          // Pixi can race React dev remount cleanup while init is settling.
        }
        return;
      }
      app.canvas.className = "pixi-board-canvas";
      hostRef.current.appendChild(app.canvas);
      const root = new Container();
      const overlay = new Container();
      const replay = new Container();
      app.stage.addChild(root);
      app.stage.addChild(overlay);
      app.stage.addChild(replay);
      rootRef.current = root;
      overlayRef.current = overlay;
      replayRef.current = replay;
      draw();
    });

    return () => {
      destroyed = true;
      if (initialized && appRef.current) {
        try {
          appRef.current.destroy();
        } catch {
          // Ignore teardown races during Next.js fast refresh/remounts.
        }
      }
      appRef.current = null;
      rootRef.current = null;
      overlayRef.current = null;
      replayRef.current = null;
    };
  }, []);

  useEffect(() => {
    draw();
  }, [
    board,
    canSwapDice,
    canRoll,
    canSubmit,
    canUndo,
    canDouble,
    canAnalyze,
    submitLabel,
    bestArrows,
    arrowsVisible,
    flipBoard,
    isOpeningRoll,
    scoreWhite,
    scoreBlack,
    matchLength,
    joinCode,
  ]);

  useEffect(() => {
    if (!replayKey) return;
    const app = appRef.current;
    const layer = replayRef.current;
    const source = replayMove ?? bestArrows;
    if (!app || !layer || !source || source.moves.length === 0) return;
    const moves = source.moves;
    const player = source.player;
    const perMove = motion.arrowDrawMs;
    const easing = (t: number) => 1 - Math.pow(1 - t, 3);

    let moveIdx = 0;
    let elapsed = 0;
    let cancelled = false;

    const tick = (ticker: { deltaMS: number }) => {
      if (cancelled) return;
      elapsed += ticker.deltaMS;
      while (moveIdx < moves.length && elapsed >= perMove) {
        elapsed -= perMove;
        moveIdx += 1;
      }
      layer.removeChildren();
      if (moveIdx >= moves.length) {
        try { app.ticker.remove(tick); } catch {}
        return;
      }
      const move = moves[moveIdx];
      const anchors = moveAnchors(geometries, move, player, flipBoard);
      if (!anchors) return;
      const t01 = easing(Math.min(1, elapsed / perMove));
      const x = anchors.from.x + (anchors.to.x - anchors.from.x) * t01;
      const y = anchors.from.y + (anchors.to.y - anchors.from.y) * t01;
      const trail = new Graphics();
      trail.moveTo(anchors.from.x, anchors.from.y).lineTo(x, y)
        .stroke({ color: ARROW_GOLD, width: 4, alpha: 0.45 });
      layer.addChild(trail);
      drawCheckerStone(layer, x, y, 22, player);
      const ring = new Graphics();
      ring.circle(x, y, 26).stroke({ color: ARROW_GOLD, width: 2, alpha: 0.7 });
      layer.addChild(ring);
    };

    app.ticker.add(tick);
    return () => {
      cancelled = true;
      try { app.ticker.remove(tick); } catch {}
      if (replayRef.current) {
        replayRef.current.removeChildren();
      }
    };
  }, [replayKey, replayMove, bestArrows, geometries, flipBoard]);

  const drawAction = (
    root: Container,
    label: string,
    x: number,
    y: number,
    enabled: boolean,
    action: BoardAction,
    fill: number = palette.btnDefault,
  ) => {
    const button = new Graphics();
    button.roundRect(x, y, 72, 46, 8)
      .fill({ color: fill, alpha: enabled ? 1 : alpha.buttonDisabled })
      .stroke({ color: palette.btnDefaultEdge, width: stroke.buttonWidth, alpha: alpha.strokeButton });
    button.eventMode = enabled ? "static" : "none";
    button.cursor = enabled ? "pointer" : "default";
    button.hitArea = new Rectangle(x, y, 72, 46);
    if (enabled) {
      button.on("pointerup", () => onAction(action));
    }
    root.addChild(button);
    addText(root, label, x + 10, y + 14, 14, palette.textOnRail);
  };

  /** Big pill-shaped action button — used for the primary "what to do next"
   *  button that floats next to the dice. Only one of these is visible at a
   *  time so it always reads as the obvious next action. */
  const drawBigAction = (
    root: Container,
    label: string,
    x: number,
    y: number,
    action: BoardAction,
    fill: number,
  ) => {
    const W = 150;
    const H = 70;
    const button = new Graphics();
    button.roundRect(x, y, W, H, 35)
      .fill({ color: fill, alpha: 1 })
      .stroke({ color: palette.btnDefaultEdge, width: 3, alpha: alpha.strokeButton });
    button.eventMode = "static";
    button.cursor = "pointer";
    button.hitArea = new Rectangle(x, y, W, H);
    button.on("pointerup", () => onAction(action));
    root.addChild(button);
    // Centre the label inside the pill. We approximate text width as
    // 14 px per char at fontSize 28 — close enough for our 3-5 letter labels.
    const fontSize = 28;
    const approxWidth = label.length * (fontSize * 0.55);
    addText(root, label, x + (W - approxWidth) / 2, y + (H - fontSize) / 2 - 2, fontSize, palette.textOnRail);
  };

  const drawArrowOverlay = () => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.removeChildren();
    if (!bestArrows || !arrowsVisible) return;
    const moves = bestArrows.moves;
    const total = moves.length;
    moves.forEach((move, i) => {
      const anchors = moveAnchors(geometries, move, bestArrows.player, flipBoard);
      if (!anchors) return;
      drawArrow(overlay, anchors.from, anchors.to, i, total);
    });
  };

  const draw = () => {
    const app = appRef.current;
    const root = rootRef.current;
    if (!app || !root) {
      return;
    }

    root.removeChildren();

    const bg = new Graphics();
    bg.rect(0, 0, WIDTH, HEIGHT).fill(palette.frameOuter);
    bg.rect(FRAME, FRAME, WIDTH - FRAME * 2, HEIGHT - FRAME * 2)
      .fill(woodGrad(HEIGHT - FRAME * 2))
      .stroke({ color: palette.frameWoodEdge, width: stroke.frameWoodWidth });
    root.addChild(bg);

    const felt = new Graphics();
    felt.rect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H)
      .fill(feltGrad(BOARD_H))
      .stroke({ color: palette.frameInnerEdge, width: stroke.feltEdgeWidth });
    felt.rect(BOARD_X - 4, BOARD_Y - 4, BOARD_W + 8, BOARD_H + 8)
      .stroke({ color: palette.frameInlay, width: stroke.inlay, alpha: 0.85 });
    root.addChild(felt);

    const rail = new Graphics();
    rail.rect(FRAME, FRAME, RAIL - 12, BOARD_H)
      .fill(woodGrad(BOARD_H))
      .stroke({ color: palette.railEdge, width: stroke.railEdgeWidth });
    root.addChild(rail);
    drawAction(root, "MENU", FRAME + 10, FRAME + 18, true, "menu", palette.btnMenu);
    drawAction(root, "UNDO", FRAME + 10, FRAME + 76, canUndo, "undo", palette.btnUndoLeft);
    drawAction(root, "HINT", FRAME + 10, FRAME + 134, canAnalyze, "hint", palette.btnHint);

    // Match-score chip in the rail. Always shown when a game is active so the
    // user can see W-B / target at a glance.
    if (typeof scoreWhite === "number" && typeof scoreBlack === "number") {
      const chipX = FRAME + 6;
      const chipY = FRAME + 200;
      const chipW = RAIL - 24;
      const chipH = 80;
      const chip = new Graphics();
      chip.roundRect(chipX, chipY, chipW, chipH, 8)
        .fill({ color: 0x1c0e04, alpha: 0.55 })
        .stroke({ color: palette.frameInlay, width: 1.5, alpha: 0.85 });
      root.addChild(chip);
      addText(root, "MATCH", chipX + 14, chipY + 6, 11, palette.textOnRail);
      addText(root, `W ${scoreWhite}`, chipX + 10, chipY + 24, 14, palette.textOnRail);
      addText(root, `B ${scoreBlack}`, chipX + 10, chipY + 44, 14, palette.textOnRail);
      if (typeof matchLength === "number" && matchLength > 0) {
        addText(root, `to ${matchLength}`, chipX + 10, chipY + 62, 11, palette.textOnRail);
      }
    }

    // Online lobby join code — always-visible so the host can read off the
    // code without going back to the share screen.
    if (joinCode && joinCode.length > 0) {
      const codeX = FRAME + 6;
      const codeY = FRAME + 296;
      const codeW = RAIL - 24;
      const codeH = 60;
      const codeChip = new Graphics();
      codeChip.roundRect(codeX, codeY, codeW, codeH, 8)
        .fill({ color: palette.btnRoll, alpha: 0.95 })
        .stroke({ color: palette.frameInlay, width: 1.5, alpha: 0.95 });
      root.addChild(codeChip);
      addText(root, "CODE", codeX + 16, codeY + 6, 11, palette.textOnRail);
      addText(root, joinCode, codeX + 8, codeY + 24, 22, palette.textOnRail, "bold");
    }

    const sideX = SIDE_X;
    const trayWidth = SIDE - 16;
    const side = new Graphics();
    drawRoundedRect(side, sideX, BOARD_Y, trayWidth, ROW_H - 10, 10, palette.trayTopFill, 1, palette.trayTopEdge);
    drawRoundedRect(side, sideX, BOARD_Y + ROW_H + 20, trayWidth, ROW_H - 10, 10, palette.trayBottomFill, 1, palette.trayBottomEdge);
    side.eventMode = "static";
    side.cursor = "pointer";
    side.hitArea = new Rectangle(sideX, BOARD_Y, trayWidth, BOARD_H);
    side.on("pointerup", onBearOffClick);
    root.addChild(side);

    // Visible bear-off stacks. Borne-off checkers are drawn as flat horizontal
    // discs (lying on their side, like coins on edge) stacked from the
    // bottom of the tray upward. Matches real-life bearoff trays and the
    // Lord-of-the-Board / Backgammon NJ visual.
    const trayDiscW = trayWidth * 0.78;
    const trayDiscH = 8;
    const trayDiscStep = trayDiscH + 1;
    const trayCx = sideX + trayWidth / 2;
    const drawBearOffStack = (player: PlayerColor, count: number, trayTop: number, trayHeight: number) => {
      const labelY = trayTop + 4;
      addText(root, `${player === "WHITE" ? "W" : "B"} ${count}`, trayCx - 12, labelY, 11, palette.textOnTray);
      if (count <= 0) return;
      const isWhite = player === "WHITE";
      const fillColor = isWhite ? palette.whiteFaceMid : palette.blackFaceMid;
      const topColor = isWhite ? palette.whiteFaceTop : palette.blackFaceTop;
      const edgeColor = isWhite ? palette.whiteEdge : palette.blackEdge;
      // Maximum discs that fit between the label and the bottom of the tray.
      // Keep ~16px under the label for the count text and 4px of padding at
      // the bottom of the tray.
      const stackTopMargin = 22;
      const stackBottomMargin = 6;
      const maxFits = Math.max(
        1,
        Math.floor((trayHeight - stackTopMargin - stackBottomMargin) / trayDiscStep),
      );
      const visible = Math.min(count, maxFits);
      // Stack grows upward from the bottom of the tray.
      const baseY = trayTop + trayHeight - stackBottomMargin - trayDiscH / 2;
      for (let i = 0; i < visible; i += 1) {
        const cy = baseY - i * trayDiscStep;
        const disc = new Graphics();
        // Body of the disc — a thin ellipse with the player's mid colour.
        disc
          .ellipse(trayCx, cy, trayDiscW / 2, trayDiscH / 2)
          .fill(fillColor)
          .stroke({ color: edgeColor, width: 1, alpha: 0.95 });
        // Highlight strip across the top to imply a 3D rim, so a stack of
        // 15 reads as separate discs rather than a single solid block.
        disc
          .ellipse(trayCx, cy - trayDiscH * 0.18, trayDiscW * 0.42, trayDiscH * 0.18)
          .fill({ color: topColor, alpha: 0.7 });
        root.addChild(disc);
      }
    };
    const whiteInBottomTray = !flipBoard;
    const topTrayY = BOARD_Y;
    const bottomTrayY = BOARD_Y + ROW_H + 20;
    const trayH = ROW_H - 10;
    const whiteTrayY = whiteInBottomTray ? bottomTrayY : topTrayY;
    const blackTrayY = whiteInBottomTray ? topTrayY : bottomTrayY;
    drawBearOffStack("WHITE", board?.borneOff.WHITE ?? 0, whiteTrayY, trayH);
    drawBearOffStack("BLACK", board?.borneOff.BLACK ?? 0, blackTrayY, trayH);

    const barX = BAR_X;
    const bar = new Graphics();
    bar.roundRect(barX, BOARD_Y + 22, BAR, BOARD_H - 44, 10)
      .fill(barGrad(BOARD_H - 44))
      .stroke({
        color: board?.legalBar ? palette.barEdgeLegal : palette.barEdgeIdle,
        width: board?.legalBar ? stroke.barLegal : stroke.barIdle,
      });
    bar.eventMode = board?.legalBar || board?.selectedBar ? "static" : "none";
    bar.cursor = board?.legalBar ? "pointer" : "default";
    bar.hitArea = new Rectangle(barX, BOARD_Y + 22, BAR, BOARD_H - 44);
    bar.on("pointerup", onBarClick);
    if (board?.selectedBar) {
      bar.roundRect(barX + 4, BOARD_Y + 26, BAR - 8, BOARD_H - 52, 8)
        .stroke({ color: palette.barSelected, width: 3, alpha: 0.85 });
    }
    root.addChild(bar);
    addText(root, "BAR", barX + 17, BOARD_Y + BOARD_H / 2 - 12, 20, palette.textOnBar);

    // Visible bar checkers stacked toward each player's home: WHITE in the
    // half closer to WHITE's home (lower in default view, upper when flipped),
    // BLACK in the opposite half. Stack from the inside edge outward.
    // Match the point-checker size (28-cap), capped by the bar's interior so
    // the checker never overflows the bar walls (BAR is now 44px wide).
    const barCheckerR = Math.min(28, BAR / 2 - 2);
    const barCheckerStep = barCheckerR * 1.05;
    const barCx = barX + BAR / 2;
    const drawBarStack = (player: PlayerColor, count: number) => {
      if (count <= 0) return;
      const whiteAtLowerHalf = !flipBoard;
      const isLower = (player === "WHITE") === whiteAtLowerHalf;
      const visible = Math.min(count, 6);
      // Anchor near the inside edge of each half (closer to the bar text),
      // then stack outward toward the player's home. Offset is `radius +
      // small gap` so the first checker clears the centred BAR label.
      const startY = isLower
        ? BOARD_Y + BOARD_H / 2 + barCheckerR + 8
        : BOARD_Y + BOARD_H / 2 - barCheckerR - 8;
      const dirY = isLower ? 1 : -1;
      for (let i = 0; i < visible; i += 1) {
        const cy = startY + dirY * i * barCheckerStep;
        drawCheckerStone(root, barCx, cy, barCheckerR, player);
      }
      if (count > 6) {
        const overflowY = startY + dirY * (visible * barCheckerStep);
        addText(root, `+${count - 6}`, barCx - 8, overflowY - 8, 11, palette.textOnBar);
      }
    };
    drawBarStack("WHITE", board?.bar.WHITE ?? 0);
    drawBarStack("BLACK", board?.bar.BLACK ?? 0);

    for (const geometry of geometries) {
      const pointState = board?.points[geometry.number - 1];
      const point = new Graphics();
      point.rect(geometry.x, geometry.y, geometry.w, geometry.h)
        .fill({ color: palette.pointZoneFill, alpha: alpha.pointZoneFill })
        .stroke({ color: palette.pointZoneEdge, width: stroke.pointZoneWidth, alpha: alpha.pointZoneEdge });
      // Always interactive: lets the parent handler decide legality and
      // surface a visible error for illegal taps (otherwise silent failures
      // when legal-moves haven't loaded look like "tap does nothing").
      point.eventMode = "static";
      const isLegalPoint = Boolean(
        pointState && (
          board?.legalSources.has(geometry.number) ||
          board?.legalDestinations.has(geometry.number) ||
          board?.selectedPoint === geometry.number
        )
      );
      point.cursor = isLegalPoint ? "pointer" : "default";
      point.hitArea = new Rectangle(geometry.x, geometry.y, geometry.w, geometry.h);
      point.on("pointerup", () => onPointClick(geometry.number));
      root.addChild(point);

      const triangle = new Graphics();
      const grad = geometry.colorAlt ? triDarkGrad(geometry.h) : triLightGrad(geometry.h);
      if (geometry.orientation === "down") {
        triangle.poly([
          geometry.x + 4, geometry.y,
          geometry.x + geometry.w - 4, geometry.y,
          geometry.x + geometry.w / 2, geometry.y + geometry.h - 8,
        ]);
      } else {
        triangle.poly([
          geometry.x + geometry.w / 2, geometry.y + 8,
          geometry.x + 4, geometry.y + geometry.h,
          geometry.x + geometry.w - 4, geometry.y + geometry.h,
        ]);
      }
      triangle.fill(grad);
      root.addChild(triangle);

      const isLegal = board?.legalSources.has(geometry.number) || board?.legalDestinations.has(geometry.number);
      const isSelected = board?.selectedPoint === geometry.number;
      if (isLegal || isSelected) {
        const glow = new Graphics();
        glow.roundRect(geometry.x, geometry.y, geometry.w, geometry.h, 8)
          .stroke({
            color: isSelected ? palette.glowSelected : palette.glowLegal,
            width: isSelected ? stroke.glowSelected : stroke.glowLegal,
            alpha: alpha.glow,
          });
        root.addChild(glow);
      }

      if (board?.bestSources.has(geometry.number) || board?.bestDestinations.has(geometry.number)) {
        const mark = new Graphics();
        mark.circle(geometry.x + 14, geometry.y + 14, 7)
          .fill(palette.bestMarkFill)
          .stroke({ color: palette.bestMarkEdge, width: 1 });
        root.addChild(mark);
      }
      if (board?.yourSources.has(geometry.number) || board?.yourDestinations.has(geometry.number)) {
        const mark = new Graphics();
        mark.circle(geometry.x + geometry.w - 14, geometry.y + 14, 7)
          .fill(palette.yourMarkFill)
          .stroke({ color: palette.yourMarkEdge, width: 1 });
        root.addChild(mark);
      }

      addText(root, `P${geometry.number}`, geometry.x + 7, geometry.y + 5, 13, palette.textPointLabel);

      if (pointState?.owner && pointState.count > 0) {
        // Checker fills ~88% of the point's width (was ~72%) so they read as
        // tappable on phone and visually match Lord-of-the-Board proportions.
        // Stack overlap tightened from 1.25× to 1.05× radius so a 6+ stack
        // still fits in the point's vertical space.
        const radius = Math.min(28, geometry.w * 0.44);
        const stackStep = radius * 1.05;
        const visible = Math.min(pointState.count, 6);
        for (let i = 0; i < visible; i += 1) {
          const cx = geometry.x + geometry.w / 2;
          const cy = geometry.orientation === "down"
            ? geometry.y + radius + 4 + i * stackStep
            : geometry.y + geometry.h - radius - 4 - i * stackStep;
          drawCheckerStone(root, cx, cy, radius, pointState.owner);
        }
        if (pointState.count > 6) {
          addText(
            root,
            `+${pointState.count - 6}`,
            geometry.x + geometry.w / 2 - 10,
            geometry.y + geometry.h / 2 - 8,
            14,
            palette.textPointLabel,
          );
        }
      }
    }

    if (board?.dice) {
      const sz = 48;
      const dy = BOARD_Y + BOARD_H / 2 - sz / 2;
      const d1 = board.dice.die_1;
      const d2 = board.dice.die_2;
      if (isOpeningRoll) {
        // One die on each half of the board, centered horizontally — each
        // player can see their own roll on their side. Per-half dice center:
        // left half between rail and bar, right half between bar and tray.
        const leftCx  = BOARD_X + HALF_W / 2;
        const rightCx = BOARD_X + HALF_W + BAR + GAP * 2 + HALF_W / 2;
        drawDieFace(root, leftCx - sz / 2,  dy, sz, d1, false, dieRotation(d1), undefined);
        drawDieFace(root, rightCx - sz / 2, dy, sz, d2, false, dieRotation(d2 + 1), undefined);
      } else {
        const dx = BOARD_X + BOARD_W / 2 - 56;
        drawDieFace(root, dx,            dy, sz, d1, board.activeDie === d1, dieRotation(d1), canSwapDice ? onSwapDice : undefined);
        drawDieFace(root, dx + sz + 16,  dy, sz, d2, board.activeDie === d2, dieRotation(d2 + 1), canSwapDice ? onSwapDice : undefined);
      }
    }

    // Right-side primary button — show ONE big pill at a time for whatever
    // the next user action is (ROLL → DONE/PASS → UNDO). Matches the
    // Lord-of-the-Board / Backgammon NJ convention where the next action is
    // always obvious and always tappable. Doubling stays as a small
    // secondary button above when available.
    const bigBtnX = BOARD_X + BOARD_W - 158;
    const bigBtnY = BOARD_Y + BOARD_H / 2 - 35;
    if (canDouble) {
      drawAction(root, "DBL", bigBtnX + 36, bigBtnY - 60, true, "double", palette.btnDouble);
    }
    if (canRoll) {
      drawBigAction(root, "ROLL", bigBtnX, bigBtnY, "roll", palette.btnRoll);
    } else if (canSubmit) {
      drawBigAction(root, submitLabel, bigBtnX, bigBtnY, "done", palette.btnSubmit);
    } else if (canUndo) {
      drawBigAction(root, "UNDO", bigBtnX, bigBtnY, "undo", palette.btnUndoRight);
    }

    drawArrowOverlay();
  };

  return (
    <div ref={shellRef} className="pixi-board-shell">
      <div ref={hostRef} className="pixi-board-host" />
      <button
        type="button"
        className="pixi-fullscreen-button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
      >
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
