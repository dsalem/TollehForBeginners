export type PlayerColor = "WHITE" | "BLACK";

export type PointState = {
  owner: PlayerColor | null;
  checker_count: number;
};

export type DiceRoll = {
  die_1: number;
  die_2: number;
};

export type BoardState = {
  points: PointState[];
  bar_counts: Record<PlayerColor, number>;
  borne_off_counts: Record<PlayerColor, number>;
};

export type SingleCheckerMovePayload = {
  from_point: number | null;
  to_point: number | null;
  from_bar: boolean;
  to_borne_off: boolean;
};

export type TurnMoveResponse = {
  player: PlayerColor;
  dice_roll: DiceRoll;
  moves: Array<SingleCheckerMovePayload & { player: PlayerColor }>;
};

export type RendererPoint = {
  number: number;
  owner: PlayerColor | null;
  count: number;
  signedCount: number;
};

export type RendererBoardState = {
  points: RendererPoint[];
  bar: Record<PlayerColor, number>;
  borneOff: Record<PlayerColor, number>;
  dice: DiceRoll | null;
  activeDie: number | null;
  legalSources: Set<number>;
  legalDestinations: Set<number>;
  legalBar: boolean;
  selectedPoint: number | null;
  selectedBar: boolean;
  bestSources: Set<number>;
  bestDestinations: Set<number>;
  yourSources: Set<number>;
  yourDestinations: Set<number>;
};

export function buildMovePointSets(turnMove: TurnMoveResponse | null): {
  sources: Set<number>;
  destinations: Set<number>;
} {
  const sources = new Set<number>();
  const destinations = new Set<number>();
  if (!turnMove) {
    return { sources, destinations };
  }

  for (const move of turnMove.moves) {
    if (!move.from_bar && move.from_point !== null) {
      sources.add(move.from_point);
    }
    if (!move.to_borne_off && move.to_point !== null) {
      destinations.add(move.to_point);
    }
  }
  return { sources, destinations };
}

export function adaptBoardForRenderer(args: {
  board: BoardState | null;
  dice: DiceRoll | null;
  activeDie: number | null;
  allowedSourcePoints: Set<number>;
  allowedNextMoves: SingleCheckerMovePayload[];
  selectedSource: { kind: "point"; point: number } | { kind: "bar" } | null;
  bestMove: TurnMoveResponse | null;
  yourMove: TurnMoveResponse | null;
}): RendererBoardState | null {
  if (!args.board) {
    return null;
  }

  const legalDestinations = new Set<number>();
  let legalBar = false;
  for (const move of args.allowedNextMoves) {
    if (move.from_bar) {
      legalBar = true;
    }
    if (!move.to_borne_off && move.to_point !== null) {
      legalDestinations.add(move.to_point);
    }
  }

  const best = buildMovePointSets(args.bestMove);
  const yours = buildMovePointSets(args.yourMove);

  return {
    points: args.board.points.map((point, index) => ({
      number: index + 1,
      owner: point.owner,
      count: point.checker_count,
      signedCount:
        point.owner === "WHITE"
          ? point.checker_count
          : point.owner === "BLACK"
            ? -point.checker_count
            : 0,
    })),
    bar: args.board.bar_counts,
    borneOff: args.board.borne_off_counts,
    dice: args.dice,
    activeDie: args.activeDie,
    legalSources: args.allowedSourcePoints,
    legalDestinations,
    legalBar,
    selectedPoint: args.selectedSource?.kind === "point" ? args.selectedSource.point : null,
    selectedBar: args.selectedSource?.kind === "bar",
    bestSources: best.sources,
    bestDestinations: best.destinations,
    yourSources: yours.sources,
    yourDestinations: yours.destinations,
  };
}
