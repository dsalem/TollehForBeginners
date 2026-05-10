"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BackgammonPixiBoard from "./components/BackgammonPixiBoard";
import StartGameOverlay from "./components/StartGameOverlay";
import MistakeCard from "./components/MistakeCard";
import GameOverBanner from "./components/GameOverBanner";
import { perfFromMoveHistory } from "./lib/perfRating";
import MistakeHistory, { type MistakeHistoryEntry } from "./components/MistakeHistory";
import RotatePrompt from "./components/RotatePrompt";
import { adaptBoardForRenderer } from "./lib/boardAdapter";
import {
  defaultStats,
  loadStats,
  recordOutcome,
  resetStats,
  saveStats,
  type GameStats,
} from "./lib/stats";

type PlayerColor = "WHITE" | "BLACK";
type GameMode = "LOCAL" | "VS_COMPUTER" | "ONLINE_MULTIPLAYER";
type ComputerDifficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";
type ComputerTurnPhase = "IDLE" | "ROLLING" | "THINKING" | "MOVED";

type PointState = {
  owner: PlayerColor | null;
  checker_count: number;
};

type DiceRoll = {
  die_1: number;
  die_2: number;
};

type BoardState = {
  points: PointState[];
  bar_counts: Record<PlayerColor, number>;
  borne_off_counts: Record<PlayerColor, number>;
};

type SingleCheckerMovePayload = {
  from_point: number | null;
  to_point: number | null;
  from_bar: boolean;
  to_borne_off: boolean;
};

type TurnMoveResponse = {
  player: PlayerColor;
  dice_roll: DiceRoll;
  moves: Array<SingleCheckerMovePayload & { player: PlayerColor }>;
};

type EvaluationResultResponse = {
  equity: number;
  win_probability: number;
  gammon_win_probability: number;
  backgammon_win_probability: number;
  lose_probability: number;
  gammon_lose_probability: number;
  backgammon_lose_probability: number;
};

type MoveCandidateResponse = {
  move: TurnMoveResponse;
  resulting_board: BoardState;
  evaluation: EvaluationResultResponse;
  equity: number;
};

type MoveAnalysisResponse = {
  best_move: MoveCandidateResponse | null;
  candidates: MoveCandidateResponse[];
  ranking_method: string;
  rollout_used: boolean;
  rollout_candidates_scored: number;
  rollout_errors?: string[] | null;
  opening_book_applied: boolean;
};

type LegalMovesResponse = {
  moves: TurnMoveResponse[];
};

type MoveQualityClass = "GOOD" | "INACCURACY" | "ERROR" | "BLUNDER";

type MoveExplanationResponse = {
  best_reasons: string[];
  your_drawbacks: string[];
};

type PostMoveAnalysisResponse = {
  best_move: TurnMoveResponse;
  your_move: TurnMoveResponse;
  best_equity: number;
  your_equity: number;
  equity_loss: number;
  best_win_probability?: number;
  your_win_probability?: number;
  classification: MoveQualityClass;
  ranking_method: string;
  rollout_used: boolean;
  rollout_candidates_scored: number;
  rollout_errors?: string[] | null;
  opening_book_applied: boolean;
  explanation?: MoveExplanationResponse | null;
};

type GameStateResponse = {
  game_id: string;
  mode: GameMode;
  computer_difficulty: ComputerDifficulty | null;
  board_state: BoardState;
  current_turn: PlayerColor;
  computer_turn_phase: ComputerTurnPhase | null;
  turn_number: number;
  current_dice_roll: DiceRoll | null;
  match_length: number;
  score: Record<PlayerColor, number>;
  cube_value: number;
  cube_owner: PlayerColor | null;
  cube_offered_by: PlayerColor | null;
  turn_history: TurnMoveResponse[];
  move_history: TurnHistoryEntryResponse[];
  winner: PlayerColor | null;
  last_computer_roll: DiceRoll | null;
  last_computer_move: TurnMoveResponse | null;
  post_move_analysis: PostMoveAnalysisResponse | null;
  post_game_review: PostGameReviewResponse | null;
};

type TurnHistoryEntryResponse = {
  player: PlayerColor;
  dice_roll: DiceRoll;
  move_played: TurnMoveResponse;
  board_before: BoardState;
  board_after: BoardState;
  analysis_result: PostMoveAnalysisResponse | null;
  timestamp: string;
};

type WorstMoveResponse = {
  turn_index: number;
  player: PlayerColor;
  move_played: TurnMoveResponse;
  equity_loss: number;
  classification: MoveQualityClass;
  timestamp: string;
};

type PostGameReviewResponse = {
  total_moves: number;
  good_moves: number;
  inaccuracies: number;
  errors: number;
  blunders: number;
  total_equity_lost: number;
  average_equity_loss: number;
  worst_move: WorstMoveResponse | null;
};

type CreateLobbyResponse = {
  lobby_code: string;
  player_id: string;
  player_color: PlayerColor;
  game_id: string | null;
  status: string;
};

type LobbyStatusResponse = {
  lobby_code: string;
  game_id: string | null;
  host_joined: boolean;
  guest_joined: boolean;
  status: string;
};

type JoinLobbyResponse = {
  lobby_code: string;
  game_id: string;
  player_id: string;
  player_color: PlayerColor;
  status: string;
};

type SourceSelection = { kind: "point"; point: number } | { kind: "bar" };

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:8000"
).replace(/\/+$/, "");
const WS_BASE_URL = API_BASE_URL.replace(/^http/i, "ws");

function opponent(player: PlayerColor): PlayerColor {
  return player === "WHITE" ? "BLACK" : "WHITE";
}

/** A compact stringified hash of a board state — used to detect whether
 *  two different move sequences land on the same final position. */
function boardHash(board: BoardState): string {
  const points = board.points
    .map((p) => `${p.owner === "WHITE" ? "W" : p.owner === "BLACK" ? "B" : "_"}${p.checker_count}`)
    .join(",");
  return `${points}|w${board.bar_counts.WHITE}b${board.bar_counts.BLACK}|W${board.borne_off_counts.WHITE}B${board.borne_off_counts.BLACK}`;
}

function cloneBoard(board: BoardState): BoardState {
  return {
    points: board.points.map((point) => ({
      owner: point.owner,
      checker_count: point.checker_count,
    })),
    bar_counts: {
      WHITE: board.bar_counts.WHITE,
      BLACK: board.bar_counts.BLACK,
    },
    borne_off_counts: {
      WHITE: board.borne_off_counts.WHITE,
      BLACK: board.borne_off_counts.BLACK,
    },
  };
}

function applyMoveToBoard(
  board: BoardState,
  player: PlayerColor,
  move: SingleCheckerMovePayload
): boolean {
  if (move.from_bar) {
    if (board.bar_counts[player] <= 0) {
      return false;
    }
    board.bar_counts[player] -= 1;
  } else {
    if (move.from_point === null) {
      return false;
    }

    const source = board.points[move.from_point - 1];
    if (!source || source.owner !== player || source.checker_count <= 0) {
      return false;
    }

    source.checker_count -= 1;
    if (source.checker_count === 0) {
      source.owner = null;
    }
  }

  if (move.to_borne_off) {
    board.borne_off_counts[player] += 1;
    return true;
  }

  if (move.to_point === null) {
    return false;
  }

  const destination = board.points[move.to_point - 1];
  if (!destination) {
    return false;
  }

  const opposingPlayer = opponent(player);
  if (destination.owner === opposingPlayer && destination.checker_count >= 2) {
    return false;
  }

  if (destination.owner === opposingPlayer && destination.checker_count === 1) {
    board.bar_counts[opposingPlayer] += 1;
    destination.owner = player;
    destination.checker_count = 1;
    return true;
  }

  if (destination.owner === null) {
    destination.owner = player;
    destination.checker_count = 1;
    return true;
  }

  if (destination.owner !== player) {
    return false;
  }

  destination.checker_count += 1;
  return true;
}

function moveToLabel(move: SingleCheckerMovePayload): string {
  const source = move.from_bar ? "BAR" : `P${move.from_point ?? "?"}`;
  const destination = move.to_borne_off ? "OFF" : `P${move.to_point ?? "?"}`;
  return `${source} -> ${destination}`;
}

function turnMoveToLabel(turnMove: TurnMoveResponse): string {
  if (turnMove.moves.length === 0) {
    return "No legal moves (pass)";
  }

  return turnMove.moves.map((move) => moveToLabel(move)).join(", ");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function moveKey(move: SingleCheckerMovePayload): string {
  const source = move.from_bar ? "BAR" : `P${move.from_point ?? "?"}`;
  const destination = move.to_borne_off ? "OFF" : `P${move.to_point ?? "?"}`;
  return `${source}->${destination}`;
}

function sameMove(
  left: SingleCheckerMovePayload,
  right: SingleCheckerMovePayload
): boolean {
  return (
    left.from_point === right.from_point &&
    left.to_point === right.to_point &&
    left.from_bar === right.from_bar &&
    left.to_borne_off === right.to_borne_off
  );
}

function isPrefix(
  candidate: SingleCheckerMovePayload[],
  prefix: SingleCheckerMovePayload[]
): boolean {
  if (prefix.length > candidate.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i += 1) {
    if (!sameMove(candidate[i], prefix[i])) {
      return false;
    }
  }
  return true;
}

function sameTurnMove(
  left: TurnMoveResponse | null,
  right: TurnMoveResponse | null
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.moves.length !== right.moves.length) {
    return false;
  }
  return left.moves.every((move, index) => sameMove(move, right.moves[index]));
}

function sameTurnMoveIgnoringOrder(
  left: TurnMoveResponse | null,
  right: TurnMoveResponse | null
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.moves.length !== right.moves.length) {
    return false;
  }

  const leftKeys = left.moves.map((move) => moveKey(move)).sort();
  const rightKeys = right.moves.map((move) => moveKey(move)).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function buildMoveHighlightGroups(turnMove: TurnMoveResponse | null): {
  sourcePoints: Set<number>;
  destinationPoints: Set<number>;
} {
  const sourcePoints = new Set<number>();
  const destinationPoints = new Set<number>();
  if (!turnMove) {
    return { sourcePoints, destinationPoints };
  }

  for (const move of turnMove.moves) {
    if (move.from_point !== null) {
      sourcePoints.add(move.from_point);
    }
    if (move.to_point !== null) {
      destinationPoints.add(move.to_point);
    }
  }

  return { sourcePoints, destinationPoints };
}

function pipIndexesForDie(value: number): number[] {
  switch (value) {
    case 1:
      return [5];
    case 2:
      return [1, 9];
    case 3:
      return [1, 5, 9];
    case 4:
      return [1, 3, 7, 9];
    case 5:
      return [1, 3, 5, 7, 9];
    case 6:
      return [1, 3, 4, 6, 7, 9];
    default:
      return [];
  }
}

function renderDie(value: number, keyPrefix: string) {
  const activePips = new Set(pipIndexesForDie(value));
  return (
    <div className="die" aria-label={`die-${value}`}>
      {Array.from({ length: 9 }, (_, i) => i + 1).map((cell) => (
        <span
          key={`${keyPrefix}-${cell}`}
          className={`pip ${activePips.has(cell) ? "pip-on" : "pip-off"}`}
        />
      ))}
    </div>
  );
}

function computeAutoMoveFromSource(
  player: PlayerColor,
  source: SourceSelection,
  dieValue: number
): SingleCheckerMovePayload {
  if (source.kind === "bar") {
    return {
      from_point: null,
      to_point: player === "WHITE" ? 25 - dieValue : dieValue,
      from_bar: true,
      to_borne_off: false,
    };
  }

  const destination = player === "WHITE" ? source.point - dieValue : source.point + dieValue;
  if (destination >= 1 && destination <= 24) {
    return {
      from_point: source.point,
      to_point: destination,
      from_bar: false,
      to_borne_off: false,
    };
  }

  return {
    from_point: source.point,
    to_point: null,
    from_bar: false,
    to_borne_off: true,
  };
}

function computePipCount(board: BoardState, player: PlayerColor): number {
  const fromPoints = board.points.reduce((total, point, index) => {
    if (point.owner !== player || point.checker_count <= 0) {
      return total;
    }
    const pointNumber = index + 1;
    const distance = player === "WHITE" ? pointNumber : 25 - pointNumber;
    return total + distance * point.checker_count;
  }, 0);

  const fromBar = board.bar_counts[player] * 25;
  return fromPoints + fromBar;
}

function extractErrorMessage(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }

  if (detail && typeof detail === "object") {
    const maybeMessage = (detail as { message?: unknown }).message;
    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }
  }

  return "Request failed. Please try again.";
}

function extractLegalMoveHints(detail: unknown): string[] {
  if (!detail || typeof detail !== "object") {
    return [];
  }

  const legalMoves = (detail as { legal_moves?: unknown }).legal_moves;
  if (!Array.isArray(legalMoves)) {
    return [];
  }

  return legalMoves
    .map((turnMove) => {
      const moves = (turnMove as { moves?: unknown }).moves;
      if (!Array.isArray(moves)) {
        return null;
      }

      const labels = moves
        .map((move) => {
          if (!move || typeof move !== "object") {
            return null;
          }
          return moveToLabel(move as SingleCheckerMovePayload);
        })
        .filter((label): label is string => Boolean(label));

      if (labels.length === 0) {
        return null;
      }

      return labels.join(", ");
    })
    .filter((hint): hint is string => Boolean(hint));
}

// Endpoints that block on the gnubg analysis engine (post-move analysis with
// rollouts, computer turn ranking) can legitimately take 15–30s on Windows
// because each rollout candidate spawns a Python subprocess. Give them a
// generous ceiling; everything else stays at the snappy 12s default.
const ANALYSIS_BLOCKING_PATTERNS: RegExp[] = [
  /\/games\/[^/]+\/move$/,
  /\/games\/[^/]+\/computer\/step$/,
  /\/games\/[^/]+\/analysis$/,
];

function timeoutForPath(path: string): number {
  return ANALYSIS_BLOCKING_PATTERNS.some((re) => re.test(path)) ? 60000 : 12000;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutForPath(path));
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        // Free ngrok serves a browser-warning HTML interstitial to clients
        // that look like browsers; this header opts out so fetch() gets JSON.
        "ngrok-skip-browser-warning": "true",
        ...(init?.headers ?? {}),
      },
    });
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") {
      const seconds = Math.round(timeoutForPath(path) / 1000);
      throw new Error(
        `Request timed out after ${seconds}s. The server may be slow or unreachable — retrying may help.`
      );
    }
    throw caught;
  } finally {
    window.clearTimeout(timeout);
  }

  const hasJson = response.headers.get("content-type")?.includes("application/json");
  const body = hasJson ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(extractErrorMessage(body?.detail ?? body)) as Error & {
      detail?: unknown;
    };
    error.detail = body?.detail ?? body;
    throw error;
  }

  return body as T;
}

export default function Home() {
  const [mobileTab, setMobileTab] = useState<"play" | "match" | "review" | "settings">("play");
  const [game, setGame] = useState<GameStateResponse | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceSelection | null>(null);
  const [pendingMoves, setPendingMoves] = useState<SingleCheckerMovePayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [legalMoveHints, setLegalMoveHints] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<MoveAnalysisResponse | null>(null);
  const [legalTurns, setLegalTurns] = useState<TurnMoveResponse[]>([]);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [postMoveFeedback, setPostMoveFeedback] =
    useState<PostMoveAnalysisResponse | null>(null);
  const [awaitingReviewAck, setAwaitingReviewAck] = useState(false);
  const [mistakeCardDismissed, setMistakeCardDismissed] = useState(false);
  const [arrowsVisible, setArrowsVisible] = useState(true);
  const [replayKey, setReplayKey] = useState(0);
  const [replayMove, setReplayMove] = useState<TurnMoveResponse | null>(null);
  // While a replay is animating, render the pre-move board underneath so the
  // ghosted-checker animation starts from the position the user faced before
  // the move. We advance through post-move-N states as each sub-move plays so
  // the stacks visibly shrink/grow (the user wants to see "I had 4 here, now
  // I have 3 plus a blot here").
  const [replayBoardOverride, setReplayBoardOverride] = useState<BoardState | null>(null);
  const replayTimeoutsRef = useRef<number[]>([]);
  const cancelReplayTimers = () => {
    for (const id of replayTimeoutsRef.current) {
      window.clearTimeout(id);
    }
    replayTimeoutsRef.current = [];
  };
  useEffect(() => {
    setMistakeCardDismissed(false);
    setArrowsVisible(true);
    setReplayMove(null);
    setReplayBoardOverride(null);
    cancelReplayTimers();
  }, [postMoveFeedback]);
  useEffect(() => {
    return cancelReplayTimers;
  }, []);
  const [computerDifficulty, setComputerDifficulty] =
    useState<ComputerDifficulty>("ADVANCED");
  const [matchLength, setMatchLength] = useState<1 | 3 | 5 | 7 | 9>(1);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [onlineLobbyCode, setOnlineLobbyCode] = useState<string | null>(null);
  const [onlinePlayerId, setOnlinePlayerId] = useState<string | null>(null);
  const [onlinePlayerColor, setOnlinePlayerColor] = useState<PlayerColor | null>(null);
  const [isWaitingForOnlineOpponent, setIsWaitingForOnlineOpponent] = useState(false);
  // Local win/loss tracker. Hydrated from localStorage after mount so we
  // don't bleed window-only access into SSR (Next.js would crash on
  // `localStorage` during the initial render otherwise).
  const [gameStats, setGameStats] = useState<GameStats>(defaultStats);
  useEffect(() => {
    setGameStats(loadStats());
  }, []);
  // Record each match exactly once when the backend reports a winner.
  useEffect(() => {
    if (!game?.winner || !game.game_id) return;
    setGameStats((prev) => {
      const next = recordOutcome({
        stats: prev,
        gameId: game.game_id,
        mode: game.mode,
        winner: game.winner as "WHITE" | "BLACK",
        localPlayerColor: onlinePlayerColor,
      });
      if (next !== prev) saveStats(next);
      return next;
    });
  }, [game?.game_id, game?.winner, game?.mode, onlinePlayerColor]);
  const handleResetStats = () => {
    if (typeof window !== "undefined" && !window.confirm("Reset your win/loss record?")) {
      return;
    }
    setGameStats(resetStats());
  };
  const [diceOrder, setDiceOrder] = useState<[number, number] | null>(null);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isDiceRollingVisual, setIsDiceRollingVisual] = useState(false);
  const [recentlyMovedPoints, setRecentlyMovedPoints] = useState<Set<number>>(new Set());
  const previousGameRef = useRef<GameStateResponse | null>(null);
  const initializedRollKeyRef = useRef<string | null>(null);

  const topLeftPoints = useMemo(() => [13, 14, 15, 16, 17, 18], []);
  const topRightPoints = useMemo(() => [19, 20, 21, 22, 23, 24], []);
  const bottomLeftPoints = useMemo(() => [12, 11, 10, 9, 8, 7], []);
  const bottomRightPoints = useMemo(() => [6, 5, 4, 3, 2, 1], []);

  const interactionBoard = useMemo(() => {
    if (replayBoardOverride) {
      return replayBoardOverride;
    }
    if (!game) {
      return null;
    }

    const draftBoard = cloneBoard(game.board_state);
    for (const draftMove of pendingMoves) {
      const applied = applyMoveToBoard(draftBoard, game.current_turn, draftMove);
      if (!applied) {
        return game.board_state;
      }
    }
    return draftBoard;
  }, [game, pendingMoves, replayBoardOverride]);
  const pipCounts = useMemo(() => {
    if (!interactionBoard) {
      return null;
    }
    const white = computePipCount(interactionBoard, "WHITE");
    const black = computePipCount(interactionBoard, "BLACK");
    return { white, black };
  }, [interactionBoard]);

  const currentDice = game?.current_dice_roll ?? null;
  const isDouble = Boolean(currentDice && currentDice.die_1 === currentDice.die_2);
  const defaultDiceOrder = useMemo<[number, number] | null>(() => {
    if (!currentDice) {
      return null;
    }
    if (currentDice.die_1 === currentDice.die_2) {
      return [currentDice.die_1, currentDice.die_2];
    }
    return currentDice.die_1 >= currentDice.die_2
      ? [currentDice.die_1, currentDice.die_2]
      : [currentDice.die_2, currentDice.die_1];
  }, [currentDice]);
  const effectiveDiceOrder = diceOrder ?? defaultDiceOrder;
  const activeDieValue = useMemo(() => {
    if (!currentDice) {
      return null;
    }
    if (currentDice.die_1 === currentDice.die_2) {
      return currentDice.die_1;
    }

    const order = effectiveDiceOrder ?? [currentDice.die_1, currentDice.die_2];
    if (pendingMoves.length >= 2) {
      return null;
    }
    return pendingMoves.length === 0 ? order[0] : order[1];
  }, [currentDice, effectiveDiceOrder, pendingMoves.length]);
  const shouldHideNextRollDuringReview =
    awaitingReviewAck && game?.mode === "VS_COMPUTER" && game.current_turn === "BLACK";
  const displayedDice = shouldHideNextRollDuringReview
    ? null
    : currentDice
      ? {
          die_1: (effectiveDiceOrder ?? [currentDice.die_1, currentDice.die_2])[0],
          die_2: (effectiveDiceOrder ?? [currentDice.die_1, currentDice.die_2])[1],
        }
      : null;
  const isOnlineGame = game?.mode === "ONLINE_MULTIPLAYER";
  const isOnlineMyTurn =
    !isOnlineGame || (onlinePlayerColor !== null && game.current_turn === onlinePlayerColor);
  const isComputerTurnActive =
    game?.mode === "VS_COMPUTER" &&
    game.current_turn === "BLACK" &&
    game.winner === null;
  const isTurnLocked = isComputerTurnActive || (isOnlineGame && !isOnlineMyTurn);
  const canOfferDouble = Boolean(
    game &&
      !isTurnLocked &&
      !game.current_dice_roll &&
      !game.cube_offered_by &&
      (game.cube_owner === null || game.cube_owner === game.current_turn)
  );
  const cubeOfferedToMe = Boolean(
    game &&
      game.cube_offered_by &&
      game.cube_offered_by !== game.current_turn &&
      (!isOnlineGame || isOnlineMyTurn)
  );
  const canSwapDiceOrder = Boolean(
    currentDice &&
      !isDouble &&
      pendingMoves.length === 0 &&
      !isTurnLocked &&
      !awaitingReviewAck &&
      !isBusy
  );
  const latestTurn = game ? game.turn_history[game.turn_history.length - 1] ?? null : null;
  const latestPlayerTurn =
    game?.post_move_analysis?.your_move ??
    (latestTurn && latestTurn.player === "WHITE" ? latestTurn : null);
  const latestComputerTurn = game?.last_computer_move ?? null;
  const highlightedPlayerMove = useMemo(
    () => buildMoveHighlightGroups(latestPlayerTurn),
    [latestPlayerTurn]
  );
  const highlightedComputerMove = useMemo(
    () => buildMoveHighlightGroups(latestComputerTurn),
    [latestComputerTurn]
  );
  const highlightedBestMove = useMemo(
    () => buildMoveHighlightGroups(postMoveFeedback?.best_move ?? null),
    [postMoveFeedback]
  );
  const highlightedYourMove = useMemo(
    () => buildMoveHighlightGroups(postMoveFeedback?.your_move ?? null),
    [postMoveFeedback]
  );
  const hasBetterPostMove = useMemo(
    () =>
      Boolean(
        postMoveFeedback &&
          postMoveFeedback.equity_loss > 0 &&
          !sameTurnMoveIgnoringOrder(postMoveFeedback.best_move, postMoveFeedback.your_move)
    ),
    [postMoveFeedback]
  );
  const recentTurnFeed = useMemo(() => {
    if (!game) {
      return [];
    }

    return [...game.turn_history]
      .slice(-8)
      .reverse()
      .map((turn) => ({
        player: turn.player,
        dice: `${turn.dice_roll.die_1}-${turn.dice_roll.die_2}`,
        move: turnMoveToLabel(turn),
      }));
  }, [game]);
  const selectedHistoryEntry = useMemo(() => {
    if (!game?.move_history || game.move_history.length === 0) {
      return null;
    }
    if (selectedHistoryIndex === null) {
      return game.move_history[game.move_history.length - 1];
    }
    return game.move_history[selectedHistoryIndex] ?? null;
  }, [game?.move_history, selectedHistoryIndex]);

  const mistakeHistoryEntries = useMemo<MistakeHistoryEntry[]>(() => {
    if (!game?.move_history) return [];
    const entries: MistakeHistoryEntry[] = [];
    game.move_history.forEach((entry, index) => {
      const analysis = entry.analysis_result;
      if (!analysis || analysis.classification === "GOOD") return;
      entries.push({
        index,
        player: entry.player,
        moveLabel: turnMoveToLabel(entry.move_played),
        classification: analysis.classification,
        equityLoss: analysis.equity_loss,
        timestamp: entry.timestamp,
      });
    });
    return entries.reverse();
  }, [game?.move_history]);

  const handleSelectMistake = (index: number) => {
    if (!game?.move_history) return;
    const entry = game.move_history[index];
    if (!entry?.analysis_result) return;
    setSelectedHistoryIndex(index);
    setPostMoveFeedback(entry.analysis_result);
    setMistakeCardDismissed(false);
    setArrowsVisible(true);
    setReplayKey((k) => k + 1);
  };

  // Start a replay animation: rewind to the pre-move position, then advance
  // the visible board state through each sub-move of the sequence so the user
  // sees the stacks change as the ghost checker arrives at each destination.
  const startReplay = (move: TurnMoveResponse) => {
    cancelReplayTimers();
    if (!game?.move_history || game.move_history.length === 0) {
      return;
    }
    const entry =
      selectedHistoryIndex !== null
        ? game.move_history[selectedHistoryIndex]
        : game.move_history[game.move_history.length - 1];
    if (!entry?.board_before) return;

    // Build the chain of board states: states[0] = pre-move, states[i+1] is
    // the position after applying sub-move i of `move`. If a sub-move fails
    // to apply (shouldn't happen for a real move, but guard anyway) we stop
    // and reuse the last good state for the rest.
    const states: BoardState[] = [cloneBoard(entry.board_before)];
    for (const subMove of move.moves) {
      const next = cloneBoard(states[states.length - 1]);
      const ok = applyMoveToBoard(next, move.player, subMove);
      states.push(ok ? next : states[states.length - 1]);
    }

    setReplayBoardOverride(states[0]);
    setReplayMove(move);
    setReplayKey((k) => k + 1);

    // Pixi animation runs ~450ms per sub-move (`motion.arrowDrawMs`); update
    // the underlying board state as each sub-move's animation completes so
    // the destination stack grows just as the ghost checker arrives.
    const ARROW_DRAW_MS = 450;
    for (let i = 0; i < move.moves.length; i += 1) {
      const target = states[i + 1];
      const id = window.setTimeout(() => {
        setReplayBoardOverride(target);
      }, (i + 1) * ARROW_DRAW_MS);
      replayTimeoutsRef.current.push(id);
    }
    // Tail timeout: clear the override so the board goes back to "real"
    // post-move state (unblocks any opponent-turn or game-flow rendering).
    const tail = window.setTimeout(() => {
      setReplayBoardOverride(null);
    }, move.moves.length * ARROW_DRAW_MS + 500);
    replayTimeoutsRef.current.push(tail);
  };

  const legalTurnMoveLists = useMemo(
    () =>
      legalTurns.map((turn) =>
        turn.moves.map((move) => ({
          from_point: move.from_point,
          to_point: move.to_point,
          from_bar: move.from_bar,
          to_borne_off: move.to_borne_off,
        }))
      ),
    [legalTurns]
  );

  const compatibleLegalTurns = useMemo(
    () =>
      legalTurnMoveLists.filter((candidate) => isPrefix(candidate, pendingMoves)),
    [legalTurnMoveLists, pendingMoves]
  );

  // The /legal-moves endpoint returns every PERMUTATION of half-moves as a
  // distinct turn — playing die-A then die-B and die-B then die-A are
  // separate entries even when they reach the same final position. For
  // forced-move detection we care about distinct OUTCOMES, not sequences,
  // so we collapse turns by the board state they produce. If there's only
  // one unique outcome, the move is forced regardless of how many ways
  // there are to reach it.
  const uniqueLegalOutcomes = useMemo(() => {
    if (!game || !game.board_state || legalTurns.length === 0) {
      return { count: 0, representative: null as TurnMoveResponse | null };
    }
    const seen = new Map<string, TurnMoveResponse>();
    for (const turn of legalTurns) {
      const board = cloneBoard(game.board_state);
      let ok = true;
      for (const move of turn.moves) {
        if (!applyMoveToBoard(board, turn.player, move)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const key = boardHash(board);
      if (!seen.has(key)) seen.set(key, turn);
    }
    const list = Array.from(seen.values());
    return { count: list.length, representative: list[0] ?? null };
  }, [legalTurns, game]);

  const allowedNextMoves = useMemo(() => {
    const nextMoves = new Map<string, SingleCheckerMovePayload>();
    const stepIndex = pendingMoves.length;
    for (const candidate of compatibleLegalTurns) {
      const next = candidate[stepIndex];
      if (!next) {
        continue;
      }
      nextMoves.set(moveKey(next), next);
    }
    return Array.from(nextMoves.values());
  }, [compatibleLegalTurns, pendingMoves.length]);
  const isDraftComplete = useMemo(
    () =>
      pendingMoves.length > 0 &&
      compatibleLegalTurns.some((candidate) => candidate.length === pendingMoves.length),
    [compatibleLegalTurns, pendingMoves.length]
  );
  const isForcedPassTurn = Boolean(
    game?.current_dice_roll &&
      !isTurnLocked &&
      (legalTurns.length === 0 || (pendingMoves.length === 0 && allowedNextMoves.length === 0))
  );

  const allowedSourcePoints = useMemo(() => {
    const points = new Set<number>();
    for (const move of allowedNextMoves) {
      if (!move.from_bar && move.from_point !== null) {
        points.add(move.from_point);
      }
    }
    return points;
  }, [allowedNextMoves]);

  const barAllowedAsSource = useMemo(
    () => allowedNextMoves.some((move) => move.from_bar),
    [allowedNextMoves]
  );
  const canBearOffFromSelectedSource = useMemo(() => {
    if (!selectedSource || selectedSource.kind !== "point") {
      return false;
    }
    return allowedNextMoves.some(
      (move) =>
        move.from_point === selectedSource.point &&
        !move.from_bar &&
        move.to_borne_off
    );
  }, [allowedNextMoves, selectedSource]);
  const canSelectBarAsSource =
    !!game &&
    !isTurnLocked &&
    (barAllowedAsSource || selectedSource?.kind === "bar");
  const rendererBoard = useMemo(
    () =>
      adaptBoardForRenderer({
        board: interactionBoard,
        dice: displayedDice,
        activeDie: activeDieValue,
        allowedSourcePoints,
        allowedNextMoves,
        selectedSource,
        bestMove: hasBetterPostMove ? postMoveFeedback?.best_move ?? null : null,
        yourMove: hasBetterPostMove ? postMoveFeedback?.your_move ?? null : null,
      }),
    [
      interactionBoard,
      displayedDice,
      activeDieValue,
      allowedSourcePoints,
      allowedNextMoves,
      selectedSource,
      hasBetterPostMove,
      postMoveFeedback,
    ]
  );

  useEffect(() => {
    if (!game || !currentDice) {
      initializedRollKeyRef.current = null;
      return;
    }

    const rollKey = `${game.game_id}:${game.turn_number}:${game.current_turn}:${currentDice.die_1}-${currentDice.die_2}`;
    if (initializedRollKeyRef.current === rollKey) {
      return;
    }

    initializedRollKeyRef.current = rollKey;
    if (currentDice.die_1 === currentDice.die_2) {
      setDiceOrder([currentDice.die_1, currentDice.die_2]);
      return;
    }
    const high = Math.max(currentDice.die_1, currentDice.die_2);
    const low = Math.min(currentDice.die_1, currentDice.die_2);
    setDiceOrder([high, low]);
  }, [
    game?.game_id,
    game?.turn_number,
    game?.current_turn,
    currentDice?.die_1,
    currentDice?.die_2,
  ]);

  const resetMoveBuilder = () => {
    setSelectedSource(null);
    setPendingMoves([]);
  };

  const resetOnlineSession = () => {
    setOnlineLobbyCode(null);
    setOnlinePlayerId(null);
    setOnlinePlayerColor(null);
    setIsWaitingForOnlineOpponent(false);
    setJoinCodeInput("");
  };

  const handleSwapDiceOrder = () => {
    if (!currentDice || currentDice.die_1 === currentDice.die_2) {
      return;
    }
    if (pendingMoves.length > 0) {
      setError("Swap dice order before making the first move of the turn.");
      return;
    }
    setDiceOrder((previous) => {
      const current = previous ?? defaultDiceOrder ?? [currentDice.die_1, currentDice.die_2];
      return [current[1], current[0]];
    });
    setSelectedSource(null);
    setError(null);
    setLegalMoveHints([]);
  };

  const refreshLegalMoves = async (gameToInspect: GameStateResponse | null) => {
    const onlineNotMyTurn =
      gameToInspect?.mode === "ONLINE_MULTIPLAYER" &&
      onlinePlayerColor !== null &&
      gameToInspect.current_turn !== onlinePlayerColor;
    if (
      !gameToInspect ||
      !gameToInspect.current_dice_roll ||
      gameToInspect.winner ||
      (gameToInspect.mode === "VS_COMPUTER" && gameToInspect.current_turn === "BLACK") ||
      onlineNotMyTurn
    ) {
      setLegalTurns([]);
      return;
    }

    try {
      const legal = await apiRequest<LegalMovesResponse>(
        `/games/${gameToInspect.game_id}/legal-moves`
      );
      setLegalTurns(legal.moves);
    } catch {
      setLegalTurns([]);
    }
  };

  const handleCreateGame = async (
    mode: GameMode,
    requestedDifficulty?: ComputerDifficulty
  ) => {
    setIsBusy(true);
    setError(null);
    setLegalMoveHints([]);
    setAnalysis(null);
    setAnalysisError(null);
    setPostMoveFeedback(null);
    setAwaitingReviewAck(false);
    resetMoveBuilder();
    resetOnlineSession();

    try {
      const payload: {
        mode: GameMode;
        computer_difficulty?: ComputerDifficulty;
        match_length: number;
      } = {
        mode,
        match_length: matchLength,
      };
      if (mode === "VS_COMPUTER") {
        payload.computer_difficulty = requestedDifficulty ?? computerDifficulty;
      }

      const created = await apiRequest<GameStateResponse>("/games", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setGame(created);
      await refreshLegalMoves(created);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not create game.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleNewLocalGame = async () => {
    await handleCreateGame("LOCAL");
  };

  const handleNewVsComputerGame = async () => {
    await handleCreateGame("VS_COMPUTER", computerDifficulty);
  };

  const handleCreateOnlineLobby = async () => {
    setIsBusy(true);
    setError(null);
    setLegalMoveHints([]);
    setAnalysis(null);
    setAnalysisError(null);
    setPostMoveFeedback(null);
    setAwaitingReviewAck(false);
    resetMoveBuilder();
    resetOnlineSession();
    setGame(null);

    try {
      const created = await apiRequest<CreateLobbyResponse>("/lobbies", {
        method: "POST",
        body: JSON.stringify({ match_length: matchLength }),
      });
      setOnlineLobbyCode(created.lobby_code);
      setOnlinePlayerId(created.player_id);
      setOnlinePlayerColor(created.player_color);
      setIsWaitingForOnlineOpponent(true);
      setJoinCodeInput(created.lobby_code);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not create online lobby.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleJoinOnlineLobby = async () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) {
      setError("Enter a game code to join.");
      return;
    }

    setIsBusy(true);
    setError(null);
    setLegalMoveHints([]);
    setAnalysis(null);
    setAnalysisError(null);
    setPostMoveFeedback(null);
    setAwaitingReviewAck(false);
    resetMoveBuilder();

    try {
      const joined = await apiRequest<JoinLobbyResponse>(`/lobbies/${code}/join`, {
        method: "POST",
        body: JSON.stringify(
          onlinePlayerId && onlineLobbyCode === code ? { player_id: onlinePlayerId } : {}
        ),
      });
      const joinedGame = await apiRequest<GameStateResponse>(`/games/${joined.game_id}`);
      setGame(joinedGame);
      setOnlineLobbyCode(joined.lobby_code);
      setOnlinePlayerId(joined.player_id);
      setOnlinePlayerColor(joined.player_color);
      setIsWaitingForOnlineOpponent(false);
      setJoinCodeInput(joined.lobby_code);
      await refreshLegalMoves(joinedGame);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not join online game.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRollDice = async () => {
    if (!game) {
      setError("Create a game first.");
      return;
    }
    if (isTurnLocked) {
      setError(
        isOnlineGame
          ? "Wait for your turn in online game."
          : "Wait for the computer turn to finish."
      );
      return;
    }
    if (awaitingReviewAck) {
      setError("Review the post-move analysis and click Continue before the next roll.");
      return;
    }

    setIsBusy(true);
    setError(null);
    setLegalMoveHints([]);
    setAnalysis(null);
    setAnalysisError(null);
    setPostMoveFeedback(null);
    setAwaitingReviewAck(false);
    resetMoveBuilder();

    try {
      const rollPath =
        game.mode === "ONLINE_MULTIPLAYER"
          ? `/games/${game.game_id}/roll?player_id=${encodeURIComponent(onlinePlayerId ?? "")}`
          : `/games/${game.game_id}/roll`;
      try {
        await apiRequest(rollPath, { method: "POST" });
      } catch (rollErr) {
        // If the backend already has dice for this turn (race on game create),
        // fall through and just refresh state so the UI catches up.
        const msg = rollErr instanceof Error ? rollErr.message : "";
        if (!/already.*rolled/i.test(msg)) {
          throw rollErr;
        }
      }
      const nextGame = await apiRequest<GameStateResponse>(`/games/${game.game_id}`);
      setGame(nextGame);
      if (nextGame.current_dice_roll) {
        setDiceOrder([nextGame.current_dice_roll.die_1, nextGame.current_dice_roll.die_2]);
      } else {
        setDiceOrder(null);
      }
      await refreshLegalMoves(nextGame);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not roll dice.";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleOfferDouble = async () => {
    if (!game) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const path = `/games/${game.game_id}/cube/offer`;
      const updated = await apiRequest<GameStateResponse>(path, {
        method: "POST",
        body: JSON.stringify({ player: game.current_turn }),
      });
      setGame(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not offer double.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleRespondDouble = async (action: "accept" | "reject") => {
    if (!game) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const updated = await apiRequest<GameStateResponse>(`/games/${game.game_id}/cube/respond`, {
        method: "POST",
        body: JSON.stringify({ player: game.current_turn, action }),
      });
      setGame(updated);
      await refreshLegalMoves(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not respond to cube.");
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!currentDice) {
      setDiceOrder(null);
      return;
    }
    if (currentDice.die_1 === currentDice.die_2) {
      setDiceOrder([currentDice.die_1, currentDice.die_2]);
      return;
    }
    setDiceOrder([
      Math.max(currentDice.die_1, currentDice.die_2),
      Math.min(currentDice.die_1, currentDice.die_2),
    ]);
  }, [currentDice?.die_1, currentDice?.die_2, game?.game_id]);

  useEffect(() => {
    if (!game?.move_history || game.move_history.length === 0) {
      setSelectedHistoryIndex(null);
      return;
    }
    setSelectedHistoryIndex(game.move_history.length - 1);
  }, [game?.game_id, game?.move_history?.length]);

  const queueNextMove = (nextMove: SingleCheckerMovePayload) => {
    if (!game || !interactionBoard) {
      return false;
    }
    const isLegalNext = allowedNextMoves.some((move) => sameMove(move, nextMove));
    if (!isLegalNext) {
      return false;
    }

    const previewBoard = cloneBoard(interactionBoard);
    if (!applyMoveToBoard(previewBoard, game.current_turn, nextMove)) {
      return false;
    }

    setError(null);
    setLegalMoveHints([]);
    setPendingMoves((previous) => [...previous, nextMove]);
    setSelectedSource(null);
    return true;
  };

  const tryAutoMoveFromSource = (
    source: SourceSelection
  ): { applied: boolean; errorMessage: string | null } => {
    if (!game || !interactionBoard) {
      return { applied: false, errorMessage: null };
    }
    if (activeDieValue === null) {
      return { applied: false, errorMessage: null };
    }

    // Try the first/active die's move from this source.
    const autoMove = computeAutoMoveFromSource(game.current_turn, source, activeDieValue);
    const applied = queueNextMove(autoMove);
    if (applied) {
      return { applied: true, errorMessage: null };
    }

    // First die didn't produce a legal move from here — fall back to the
    // other die and swap dice order so the indicator stays in sync.
    if (!isDouble && pendingMoves.length === 0) {
      const currentOrder = effectiveDiceOrder ?? [currentDice?.die_1 ?? 0, currentDice?.die_2 ?? 0];
      const fallbackDieValue = currentOrder[1];
      if (fallbackDieValue >= 1 && fallbackDieValue <= 6) {
        const fallbackMove = computeAutoMoveFromSource(game.current_turn, source, fallbackDieValue);
        const fallbackApplied = queueNextMove(fallbackMove);
        if (fallbackApplied) {
          setDiceOrder([currentOrder[1], currentOrder[0]]);
          return { applied: true, errorMessage: null };
        }
      }
      return {
        applied: false,
        errorMessage: `No legal move from this checker with die ${activeDieValue} or the alternate die. Pick another checker.`,
      };
    }
    return { applied: false, errorMessage: null };
  };

  const selectPointAsSource = (pointNumber: number) => {
    if (!game) {
      setError(`Tapped point ${pointNumber} but no active game.`);
      return;
    }
    if (!interactionBoard) {
      setError(`Tapped point ${pointNumber} but board state hasn't loaded yet.`);
      return;
    }
    if (isTurnLocked) {
      setError(
        isOnlineGame
          ? "Wait for your turn in online game."
          : "Wait for the computer turn to finish."
      );
      return;
    }
    if (!allowedSourcePoints.has(pointNumber)) {
      setError("That point is not a legal source for the current dice and draft.");
      return;
    }

    const point = interactionBoard.points[pointNumber - 1];
    if (!point || point.owner !== game.current_turn || point.checker_count <= 0) {
      setError("Select a source point that has one of your checkers.");
      return;
    }

    const source: SourceSelection = { kind: "point", point: pointNumber };
    const autoResult = tryAutoMoveFromSource(source);
    if (autoResult.applied) {
      return;
    }

    setError(autoResult.errorMessage);
    setLegalMoveHints([]);
    setSelectedSource(source);
  };

  const selectBarAsSource = () => {
    if (!game || !interactionBoard) {
      return;
    }
    if (isTurnLocked) {
      setError(
        isOnlineGame
          ? "Wait for your turn in online game."
          : "Wait for the computer turn to finish."
      );
      return;
    }
    if (!barAllowedAsSource) {
      setError("Bar is not a legal source for the current dice and draft.");
      return;
    }

    if (interactionBoard.bar_counts[game.current_turn] <= 0) {
      setError(`No ${game.current_turn} checkers are on the bar.`);
      return;
    }

    const source: SourceSelection = { kind: "bar" };
    const autoResult = tryAutoMoveFromSource(source);
    if (autoResult.applied) {
      return;
    }

    setError(autoResult.errorMessage);
    setLegalMoveHints([]);
    setSelectedSource(source);
  };

  const addDestinationPoint = (toPoint: number) => {
    if (!selectedSource || !game || !interactionBoard) {
      setError("Select a source first.");
      return;
    }

    if (selectedSource.kind === "point" && selectedSource.point === toPoint) {
      setSelectedSource(null);
      return;
    }

    const nextMove: SingleCheckerMovePayload = {
      from_point: selectedSource.kind === "point" ? selectedSource.point : null,
      to_point: toPoint,
      from_bar: selectedSource.kind === "bar",
      to_borne_off: false,
    };
    const queued = queueNextMove(nextMove);
    if (!queued) {
      setError("That destination is not legal for the selected source.");
      return;
    }
  };

  const addDestinationBorneOff = () => {
    if (!selectedSource || !game || !interactionBoard) {
      setError("Select a source first.");
      return;
    }

    if (selectedSource.kind === "bar") {
      setError("You cannot bear off directly from the bar.");
      return;
    }

    const nextMove: SingleCheckerMovePayload = {
      from_point: selectedSource.point,
      to_point: null,
      from_bar: false,
      to_borne_off: true,
    };
    const queued = queueNextMove(nextMove);
    if (!queued) {
      setError("That bear-off move is not legal for the selected source.");
      return;
    }
  };

  const handleSubmitMove = async () => {
    if (!game) {
      setError("Create a game first.");
      return;
    }
    if (isTurnLocked) {
      setError(
        isOnlineGame
          ? "Wait for your turn in online game."
          : "Wait for the computer turn to finish."
      );
      return;
    }

    if (!game.current_dice_roll) {
      setError("Roll dice before submitting a move.");
      return;
    }

    if (pendingMoves.length === 0 && !isForcedPassTurn) {
      setError("Build at least one move before submitting.");
      return;
    }

    setIsBusy(true);
    setError(null);
    setLegalMoveHints([]);
    setAnalysisError(null);

    try {
      const payload = {
        player: game.current_turn,
        dice_roll: game.current_dice_roll,
        moves: isForcedPassTurn ? [] : pendingMoves,
      };

      const movePath =
        game.mode === "ONLINE_MULTIPLAYER"
          ? `/games/${game.game_id}/move?player_id=${encodeURIComponent(onlinePlayerId ?? "")}`
          : `/games/${game.game_id}/move`;
      const updated = await apiRequest<GameStateResponse>(movePath, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setGame(updated);
      await refreshLegalMoves(updated);
      setAnalysis(null);
      const analysis = updated.post_move_analysis ?? null;
      setPostMoveFeedback(analysis);
      const isCorrectMove = Boolean(
        analysis &&
          (sameTurnMoveIgnoringOrder(analysis.best_move, analysis.your_move) ||
            analysis.equity_loss <= 1e-9)
      );
      setAwaitingReviewAck(Boolean(analysis) && !isCorrectMove);
      resetMoveBuilder();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not submit move.";
      setError(message);

      const detail =
        caught instanceof Error && "detail" in caught
          ? (caught as Error & { detail?: unknown }).detail
          : null;
      setLegalMoveHints(extractLegalMoveHints(detail));
    } finally {
      setIsBusy(false);
    }
  };

  // Auto-pass when no legal moves are available, and auto-play when there's
  // exactly one legal turn (genuinely forced). Both fire after a short delay
  // so the player sees the dice/board first instead of an instant skip.
  const autoActionRef = useRef<number | null>(null);
  // True only when this turn's pendingMoves were filled by auto-play (the
  // single-forced-turn branch below). The auto-submit effect uses this to
  // make sure it only fires for genuinely-forced moves, never on a draft
  // the user assembled themselves — they manually tap DONE for those.
  const wasAutoPlayedRef = useRef(false);
  // Reset the auto-played flag whenever a new turn / dice roll arrives.
  useEffect(() => {
    wasAutoPlayedRef.current = false;
  }, [game?.game_id, game?.current_turn, game?.current_dice_roll]);

  useEffect(() => {
    if (autoActionRef.current !== null) {
      window.clearTimeout(autoActionRef.current);
      autoActionRef.current = null;
    }
    if (!game || isBusy || isTurnLocked || awaitingReviewAck) return;
    if (!game.current_dice_roll) return;
    if (pendingMoves.length > 0) return;
    if (game.winner) return;

    // The backend can return either:
    //   (a) `legalTurns: []`            → no legal turn at all
    //   (b) `legalTurns: [{moves: []}]` → single "pass" turn with zero
    //       sub-moves (this is what comes back when you're stuck on the
    //       bar with both entry points blocked, like dancing on doubles)
    // Both mean "must pass". The old code only handled (a); (b) fell into
    // the auto-play branch which set pendingMoves to []. That left the
    // submit effect waiting forever on `pendingMoves.length > 0`, so the
    // user had to tap PASS manually. Detect both and submit empty.
    const onlyHasEmptyPass =
      uniqueLegalOutcomes.count === 1 &&
      (uniqueLegalOutcomes.representative?.moves.length ?? 0) === 0;
    if (legalTurns.length === 0 || onlyHasEmptyPass) {
      // Auto-pass: no legal moves at all. Mark as auto-played so the submit
      // effect picks it up.
      wasAutoPlayedRef.current = true;
      autoActionRef.current = window.setTimeout(() => {
        autoActionRef.current = null;
        void handleSubmitMove();
      }, 350);
      return;
    }
    if (uniqueLegalOutcomes.count === 1 && uniqueLegalOutcomes.representative) {
      // Auto-play: every legal turn results in the same final board (often
      // multiple permutations of the same plays, common with bar-entries
      // and bear-offs). Pick any representative sequence and fill it.
      const onlyTurn = uniqueLegalOutcomes.representative;
      wasAutoPlayedRef.current = true;
      autoActionRef.current = window.setTimeout(() => {
        autoActionRef.current = null;
        setPendingMoves(
          onlyTurn.moves.map((m) => ({
            from_point: m.from_point,
            to_point: m.to_point,
            from_bar: m.from_bar,
            to_borne_off: m.to_borne_off,
          }))
        );
      }, 350);
    }
  }, [
    legalTurns,
    uniqueLegalOutcomes,
    game,
    isBusy,
    isTurnLocked,
    awaitingReviewAck,
    pendingMoves.length,
  ]);

  // Once auto-play has filled pendingMoves to match the unique legal turn,
  // submit it. Gated on `wasAutoPlayedRef` so a draft the user built
  // themselves never auto-submits — they tap DONE manually.
  useEffect(() => {
    if (isBusy || isTurnLocked || awaitingReviewAck) return;
    if (pendingMoves.length === 0) return;
    if (!isDraftComplete) return;
    if (!wasAutoPlayedRef.current) return;
    if (uniqueLegalOutcomes.count !== 1) return;
    void handleSubmitMove();
  }, [
    pendingMoves,
    isDraftComplete,
    uniqueLegalOutcomes.count,
    isBusy,
    isTurnLocked,
    awaitingReviewAck,
  ]);
  useEffect(() => {
    return () => {
      if (autoActionRef.current !== null) {
        window.clearTimeout(autoActionRef.current);
      }
    };
  }, []);

  const handleAnalyzePosition = async () => {
    if (!game) {
      setAnalysisError("Create a game first.");
      return;
    }
    if (isTurnLocked) {
      setAnalysisError(
        isOnlineGame
          ? "Wait for your turn in online game."
          : "Wait for the computer turn to finish."
      );
      return;
    }

    if (!game.current_dice_roll) {
      setAnalysisError("Roll dice first to analyze move options.");
      return;
    }

    setIsBusy(true);
    setAnalysisError(null);

    try {
      const result = await apiRequest<MoveAnalysisResponse>(`/games/${game.game_id}/analysis`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setAnalysis(result);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not analyze this position.";
      setAnalysisError(message);
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!onlineLobbyCode || !isWaitingForOnlineOpponent || game) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const status = await apiRequest<LobbyStatusResponse>(`/lobbies/${onlineLobbyCode}`);
        if (cancelled || !status.game_id) {
          return;
        }

        const joinResult = await apiRequest<JoinLobbyResponse>(
          `/lobbies/${onlineLobbyCode}/join`,
          {
            method: "POST",
            body: JSON.stringify({ player_id: onlinePlayerId }),
          }
        );
        const joinedGame = await apiRequest<GameStateResponse>(`/games/${joinResult.game_id}`);
        if (cancelled) {
          return;
        }
        setGame(joinedGame);
        setOnlinePlayerId(joinResult.player_id);
        setOnlinePlayerColor(joinResult.player_color);
        setIsWaitingForOnlineOpponent(false);
        await refreshLegalMoves(joinedGame);
      } catch {
        // Lobby polling is best-effort; explicit user actions surface errors.
      }
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [game, isWaitingForOnlineOpponent, onlineLobbyCode, onlinePlayerId]);

  useEffect(() => {
    if (!game || game.mode !== "ONLINE_MULTIPLAYER") {
      return;
    }

    const socket = new WebSocket(`${WS_BASE_URL}/ws/games/${game.game_id}`);
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; game?: GameStateResponse };
        if (payload.type === "game_state" && payload.game) {
          const updated = payload.game;
          setGame(updated);
          // Keep legalTurns in sync with WS-delivered state so the
          // auto-pass / auto-forced-move effect has correct data when it's
          // our turn online (without this, legalTurns stays stale from the
          // last refresh and auto-pass never fires after the opponent moves).
          void refreshLegalMoves(updated);
          // Only show the post-move analysis to the player who actually made
          // the move. The opponent shouldn't see the popup or be blocked by
          // an awaitingReviewAck that was meant for someone else.
          const analysis = updated.post_move_analysis ?? null;
          const analysisIsForLocalPlayer = Boolean(
            analysis &&
              onlinePlayerColor !== null &&
              analysis.your_move?.player === onlinePlayerColor
          );
          if (analysisIsForLocalPlayer) {
            setPostMoveFeedback(analysis);
          } else {
            setPostMoveFeedback(null);
            setAwaitingReviewAck(false);
          }
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    return () => {
      socket.close();
    };
  }, [game?.game_id, game?.mode, onlinePlayerColor]);

  // Set to true when the computer-step polling has bailed out after too
  // many consecutive failures. The polling effect refuses to run while this
  // is true; the user has to tap the Retry button (or change games) to
  // reset it. Avoids the "519 retries" spinner-of-death case.
  const [computerStepFailed, setComputerStepFailed] = useState(false);
  const computerStepRetry = () => {
    setComputerStepFailed(false);
    setError(null);
  };
  // Reset on new game so a fresh game doesn't inherit a stuck-failed state.
  useEffect(() => {
    setComputerStepFailed(false);
  }, [game?.game_id]);

  useEffect(() => {
    if (!game || !isComputerTurnActive || awaitingReviewAck) {
      return;
    }
    if (computerStepFailed) {
      // We've given up; await user retry.
      return;
    }

    let cancelled = false;
    let consecutiveFailures = 0;
    // The polling loop retries naturally every 450ms. Tolerate transient
    // blips quietly, surface a "still retrying" toast for sustained
    // failures, and finally GIVE UP after ~13s so the user isn't stuck
    // in an infinite-spin loop when ngrok / the backend is gone.
    const FAILURE_TOLERANCE = 3;
    const FAILURE_GIVE_UP = 30; // ~13.5 s @ 450 ms tick

    const tick = async () => {
      try {
        const updated = await apiRequest<GameStateResponse>(
          `/games/${game.game_id}/computer/step`,
          { method: "POST" }
        );
        if (!cancelled) {
          consecutiveFailures = 0;
          setGame(updated);
          if (updated.current_turn !== "BLACK") {
            await refreshLegalMoves(updated);
          }
          setError(null);
        }
      } catch (caught) {
        if (cancelled) return;
        consecutiveFailures += 1;
        const baseMessage =
          caught instanceof Error
            ? caught.message
            : "Computer turn failed to progress.";
        if (consecutiveFailures >= FAILURE_GIVE_UP) {
          // Give up — stop the loop and let the user retry on demand.
          cancelled = true;
          window.clearInterval(interval);
          setComputerStepFailed(true);
          setError(
            `Computer is unreachable. ${baseMessage} Tap Retry once your connection / backend is back.`
          );
        } else if (consecutiveFailures >= FAILURE_TOLERANCE) {
          setError(
            `Computer move stalled (${consecutiveFailures} retries). ${baseMessage} Still retrying…`
          );
        }
      }
    };
    void tick();
    const interval = window.setInterval(() => {
      void tick();
    }, 450);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [game?.game_id, isComputerTurnActive, awaitingReviewAck, computerStepFailed]);

  useEffect(() => {
    if (!game || game.mode !== "VS_COMPUTER" || awaitingReviewAck || game.winner) {
      return;
    }
    // Self-heal: if computer should be active but appears idle, force a step tick.
    if (game.current_turn === "BLACK" && game.computer_turn_phase === "IDLE") {
      let cancelled = false;
      const kick = async () => {
        try {
          const updated = await apiRequest<GameStateResponse>(
            `/games/${game.game_id}/computer/step`,
            { method: "POST" }
          );
          if (!cancelled) {
            setGame(updated);
          }
        } catch {
          // Best-effort recovery only.
        }
      };
      void kick();
      return () => {
        cancelled = true;
      };
    }
  }, [
    game?.game_id,
    game?.mode,
    game?.current_turn,
    game?.computer_turn_phase,
    game?.winner,
    awaitingReviewAck,
  ]);

  useEffect(() => {
    void refreshLegalMoves(game);
  }, [
    game?.game_id,
    game?.current_dice_roll?.die_1,
    game?.current_dice_roll?.die_2,
    game?.current_turn,
    onlinePlayerColor,
  ]);

  useEffect(() => {
    resetMoveBuilder();
    setDiceOrder(null);
    setError(null);
    setLegalMoveHints([]);
  }, [game?.game_id, game?.turn_number, game?.current_turn]);

  useEffect(() => {
    const previous = previousGameRef.current;
    if (!game) {
      previousGameRef.current = null;
      setRecentlyMovedPoints(new Set());
      setIsDiceRollingVisual(false);
      return;
    }

    if (previous && previous.game_id === game.game_id) {
      const prevDice = previous.current_dice_roll;
      const nextDice = game.current_dice_roll;
      const diceChanged =
        (prevDice?.die_1 ?? null) !== (nextDice?.die_1 ?? null) ||
        (prevDice?.die_2 ?? null) !== (nextDice?.die_2 ?? null);
      if (diceChanged && nextDice) {
        setIsDiceRollingVisual(true);
        window.setTimeout(() => setIsDiceRollingVisual(false), 520);
      }

      const changed = new Set<number>();
      for (let i = 0; i < 24; i += 1) {
        const before = previous.board_state.points[i];
        const after = game.board_state.points[i];
        if (before.owner !== after.owner || before.checker_count !== after.checker_count) {
          changed.add(i + 1);
        }
      }
      if (changed.size > 0) {
        setRecentlyMovedPoints(changed);
        window.setTimeout(() => setRecentlyMovedPoints(new Set()), 680);
      }
    }

    previousGameRef.current = game;
  }, [game]);

  const handleUndoDraftMove = () => {
    if (isBusy || isTurnLocked) {
      return;
    }
    if (pendingMoves.length > 0) {
      setPendingMoves((previous) => previous.slice(0, -1));
      setError(null);
      setLegalMoveHints([]);
      // Once the user touches the draft, this turn is no longer
      // "auto-played" — they have to tap DONE themselves.
      wasAutoPlayedRef.current = false;
      return;
    }
    if (selectedSource) {
      setSelectedSource(null);
      setError(null);
    }
  };

  const renderPoint = (pointNumber: number, orientation: "up" | "down", indexInRow: number) => {
    const point = interactionBoard?.points[pointNumber - 1] ?? {
      owner: null,
      checker_count: 0,
    };

    const isSelected =
      selectedSource?.kind === "point" && selectedSource.point === pointNumber;
    const visibleCheckerCount = Math.min(point.checker_count, 5);
    const checkerOverflow = point.checker_count > 5 ? point.checker_count - 5 : 0;
    const canSelectAsSource =
      !selectedSource &&
      !!game &&
      !isTurnLocked &&
      allowedSourcePoints.has(pointNumber);
    const disablePointClick =
      !game || isTurnLocked || (!selectedSource && !canSelectAsSource);

    const isBestSource =
      hasBetterPostMove && highlightedBestMove.sourcePoints.has(pointNumber);
    const isBestDestination =
      hasBetterPostMove && highlightedBestMove.destinationPoints.has(pointNumber);
    const isYourSource =
      hasBetterPostMove && highlightedYourMove.sourcePoints.has(pointNumber);
    const isYourDestination =
      hasBetterPostMove && highlightedYourMove.destinationPoints.has(pointNumber);

    const pointClassNames = [
      "point",
      `point-orientation-${orientation}`,
      (indexInRow % 2 === 0) !== (orientation === "up") ? "point-alt-a" : "point-alt-b",
      point.owner ? `point-owner-${point.owner.toLowerCase()}` : "",
      isSelected ? "point-selected" : "",
      canSelectAsSource ? "point-source-allowed" : "point-source-blocked",
      highlightedPlayerMove.sourcePoints.has(pointNumber) ||
      highlightedPlayerMove.destinationPoints.has(pointNumber)
        ? "point-player-last-move"
        : "",
      highlightedComputerMove.sourcePoints.has(pointNumber) ||
      highlightedComputerMove.destinationPoints.has(pointNumber)
        ? "point-computer-last-move"
        : "",
      recentlyMovedPoints.has(pointNumber) ? "point-recently-moved" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        key={pointNumber}
        type="button"
        className={pointClassNames}
        disabled={disablePointClick}
        onClick={() => {
          if (!game) {
            return;
          }

          if (selectedSource) {
            addDestinationPoint(pointNumber);
            return;
          }

          selectPointAsSource(pointNumber);
        }}
      >
        <span className="point-number">P{pointNumber}</span>
        <div className="point-triangle" />
        {isBestSource ? (
          <span
            className="point-review-marker point-review-marker-best-source"
            title="Best move: source"
          />
        ) : null}
        {isBestDestination ? (
          <span
            className="point-review-marker point-review-marker-best-destination"
            title="Best move: destination"
          />
        ) : null}
        {isYourSource ? (
          <span
            className="point-review-marker point-review-marker-your-source"
            title="Your move: source"
          />
        ) : null}
        {isYourDestination ? (
          <span
            className="point-review-marker point-review-marker-your-destination"
            title="Your move: destination"
          />
        ) : null}
        <div className="checker-stack">
          {Array.from({ length: visibleCheckerCount }, (_, index) => (
            <span
              key={`${pointNumber}-${index}`}
              className={`checker ${point.owner ? `checker-${point.owner.toLowerCase()}` : ""}`}
            />
          ))}
          {checkerOverflow > 0 ? (
            <span className="checker-overflow">+{checkerOverflow}</span>
          ) : null}
        </div>
      </button>
    );
  };

  return (
    <main className={`page mobile-tab-${mobileTab}`}>
      <RotatePrompt />
      <header className="header section-play section-settings">
        <h1>Backgammon</h1>
        <div className="button-row">
          <button type="button" onClick={handleNewLocalGame} disabled={isBusy}>
            New Local Game
          </button>
          <label className="control-inline">
            <span>Match Length</span>
            <select
              value={matchLength}
              onChange={(event) => setMatchLength(Number(event.target.value) as 1 | 3 | 5 | 7 | 9)}
              disabled={isBusy}
            >
              <option value={1}>1</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={7}>7</option>
              <option value={9}>9</option>
            </select>
          </label>
          <label className="control-inline">
            <span>Computer Difficulty</span>
            <select
              value={computerDifficulty}
              onChange={(event) =>
                setComputerDifficulty(event.target.value as ComputerDifficulty)
              }
              disabled={isBusy}
            >
              <option value="BEGINNER">Beginner</option>
              <option value="INTERMEDIATE">Intermediate</option>
              <option value="ADVANCED">Advanced</option>
              <option value="EXPERT">Expert</option>
            </select>
          </label>
          <button type="button" onClick={handleNewVsComputerGame} disabled={isBusy}>
            New VS Computer Game
          </button>
          <button type="button" onClick={handleCreateOnlineLobby} disabled={isBusy}>
            Create Online Game
          </button>
          <label className="control-inline">
            <span>Join Game Code</span>
            <input
              value={joinCodeInput}
              onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              disabled={isBusy}
            />
          </label>
          <button type="button" onClick={handleJoinOnlineLobby} disabled={isBusy}>
            Join by Code
          </button>
          <button
            type="button"
            onClick={handleAnalyzePosition}
            disabled={
              isBusy ||
              !game ||
              !game.current_dice_roll ||
              isTurnLocked ||
              game.mode !== "VS_COMPUTER"
            }
            title={
              game && game.mode !== "VS_COMPUTER"
                ? "Hint is disabled in multiplayer to keep play fair"
                : undefined
            }
          >
            Analyze Position
          </button>
        </div>
      </header>

      <section className="status-grid hud-strip section-play section-match">
        <div className="status-card">
          <strong>Game</strong>
          <span>{game ? game.game_id : "No game started"}</span>
          {onlineLobbyCode ? <span>Code: {onlineLobbyCode}</span> : null}
        </div>
        <div className="status-card">
          <strong>Current Player</strong>
          <span>{game ? game.current_turn : "-"}</span>
          <span>
            You:{" "}
            {onlinePlayerColor
              ? onlinePlayerColor
              : game?.mode === "ONLINE_MULTIPLAYER"
                ? "SPECTATOR"
                : "N/A"}
          </span>
        </div>
        <div className="status-card">
          <strong>Turn</strong>
          <span>{game ? game.turn_number : "-"}</span>
        </div>
        <div className="status-card">
          <strong>Match</strong>
          <span>To: {game ? game.match_length : matchLength}</span>
          <span>WHITE: {game ? game.score.WHITE : 0}</span>
          <span>BLACK: {game ? game.score.BLACK : 0}</span>
        </div>
        <div className="status-card">
          <strong>Cube</strong>
          <span>Value: {game ? game.cube_value : 1}</span>
          <span>Owner: {game?.cube_owner ?? "CENTER"}</span>
          <span>
            Pending:{" "}
            {game?.cube_offered_by ? `${game.cube_offered_by} offered` : "None"}
          </span>
        </div>
        <div className="status-card">
          <strong>Computer Difficulty</strong>
          <span>
            {game
              ? game.mode === "VS_COMPUTER"
                ? game.computer_difficulty ?? "-"
                : "N/A"
              : "-"}
          </span>
        </div>
        <div className="status-card">
          <strong>Dice</strong>
          <span>
            {displayedDice ? `${displayedDice.die_1} / ${displayedDice.die_2}` : "Not rolled"}
          </span>
          {displayedDice && effectiveDiceOrder ? (
            <span className="dice-order-label">
              Order: {effectiveDiceOrder[0]} then {effectiveDiceOrder[1]}
            </span>
          ) : null}
          {displayedDice ? (
            <div className="dice-row">
              <button
                type="button"
                className={`die-swap-button ${
                  activeDieValue !== null && displayedDice.die_1 === activeDieValue
                    ? "die-swap-button-active"
                    : ""
                }`}
                onClick={handleSwapDiceOrder}
                disabled={!canSwapDiceOrder}
                aria-label="Swap dice order"
                title={
                  canSwapDiceOrder
                    ? "Click to swap order"
                    : "Swap is available before the first move only"
                }
              >
                {renderDie(displayedDice.die_1, "current-die-1")}
              </button>
              <button
                type="button"
                className={`die-swap-button ${
                  activeDieValue !== null && displayedDice.die_2 === activeDieValue
                    ? "die-swap-button-active"
                    : ""
                }`}
                onClick={handleSwapDiceOrder}
                disabled={!canSwapDiceOrder}
                aria-label="Swap dice order"
                title={
                  canSwapDiceOrder
                    ? "Click to swap order"
                    : "Swap is available before the first move only"
                }
              >
                {renderDie(displayedDice.die_2, "current-die-2")}
              </button>
            </div>
          ) : null}
        </div>
        <div className="status-card">
          <strong>Pip Count</strong>
          <span>WHITE: {pipCounts ? pipCounts.white : "-"}</span>
          <span>BLACK: {pipCounts ? pipCounts.black : "-"}</span>
          <span>
            Lead:{" "}
            {pipCounts
              ? pipCounts.white === pipCounts.black
                ? "Even"
                : pipCounts.white < pipCounts.black
                  ? `WHITE by ${pipCounts.black - pipCounts.white}`
                  : `BLACK by ${pipCounts.white - pipCounts.black}`
              : "-"}
          </span>
        </div>
      </section>

      {isWaitingForOnlineOpponent && onlineLobbyCode ? (
        <section className="computer-panel section-play">
          <strong>Online Lobby</strong>
          <p>Share code <strong>{onlineLobbyCode}</strong> with opponent.</p>
          <p>Waiting for second player to join...</p>
        </section>
      ) : null}

      {game?.mode === "VS_COMPUTER" ? (
        <section className="computer-panel computer-panel-compact section-play">
          <strong>Computer Turn</strong>
          <p>Phase: {game.computer_turn_phase ?? "IDLE"}</p>
          {awaitingReviewAck ? (
            <p>Review pending: click Continue in Post-Move Analysis to start the computer turn.</p>
          ) : null}
          {isComputerTurnActive && !awaitingReviewAck ? (
            <p>Computer is taking its turn...</p>
          ) : null}
          {game.last_computer_roll ? (
            <p>
              Last roll: {game.last_computer_roll.die_1} / {game.last_computer_roll.die_2}{" "}
            </p>
          ) : (
            <p>No computer roll yet.</p>
          )}
          {game.last_computer_roll ? (
            <div className="dice-row">
              {renderDie(game.last_computer_roll.die_1, "computer-die-1")}
              {renderDie(game.last_computer_roll.die_2, "computer-die-2")}
            </div>
          ) : null}
          <p>
            Last move:{" "}
            {game.last_computer_move ? turnMoveToLabel(game.last_computer_move) : "No move yet."}
          </p>
        </section>
      ) : null}

      {game?.cube_offered_by && cubeOfferedToMe ? (
        <section className="analysis-panel section-match">
          <strong>Doubling Cube</strong>
          <p>
            {game.cube_offered_by} offered to double to {game.cube_value * 2}.
          </p>
          <div className="button-row">
            <button type="button" onClick={() => void handleRespondDouble("accept")} disabled={isBusy}>
              Accept
            </button>
            <button type="button" onClick={() => void handleRespondDouble("reject")} disabled={isBusy}>
              Reject
            </button>
          </div>
        </section>
      ) : null}

      <section className="board-layout section-play section-match section-review section-settings">
        <div className="board-shell">
          {!game ? (
            <StartGameOverlay
              isBusy={isBusy}
              matchLength={matchLength}
              setMatchLength={setMatchLength}
              computerDifficulty={computerDifficulty}
              setComputerDifficulty={setComputerDifficulty}
              joinCodeInput={joinCodeInput}
              setJoinCodeInput={setJoinCodeInput}
              onPlayComputer={handleNewVsComputerGame}
              onPlayLocal={handleNewLocalGame}
              onCreateOnline={handleCreateOnlineLobby}
              onJoinOnline={handleJoinOnlineLobby}
              stats={gameStats}
              onResetStats={handleResetStats}
            />
          ) : null}
          <BackgammonPixiBoard
            board={rendererBoard}
            canSwapDice={canSwapDiceOrder}
            canRoll={Boolean(!isBusy && game && !game.current_dice_roll && !isTurnLocked && !awaitingReviewAck)}
            canSubmit={Boolean(
              !isBusy &&
                game &&
                !isTurnLocked &&
                game.current_dice_roll &&
                (isDraftComplete || isForcedPassTurn)
            )}
            canUndo={Boolean(!isBusy && !isTurnLocked && (pendingMoves.length > 0 || selectedSource))}
            canDouble={canOfferDouble}
            canAnalyze={Boolean(
              !isBusy &&
                game &&
                game.current_dice_roll &&
                !isTurnLocked &&
                // HINT gives best-move analysis. In a 2-player human game the
                // engine's recommendation is an unfair information advantage,
                // so it's only available against the computer.
                game.mode === "VS_COMPUTER"
            )}
            submitLabel={isForcedPassTurn ? "PASS" : "DONE"}
            bestArrows={
              hasBetterPostMove && !mistakeCardDismissed
                ? postMoveFeedback?.best_move ?? null
                : analysis?.best_move?.move ?? null
            }
            arrowsVisible={arrowsVisible}
            replayKey={replayKey}
            replayMove={replayMove}
            flipBoard={isOnlineGame && onlinePlayerColor === "BLACK"}
            isOpeningRoll={Boolean(
              game &&
                game.current_dice_roll &&
                game.turn_number === 1 &&
                (game.move_history?.length ?? 0) === 0 &&
                pendingMoves.length === 0 &&
                game.current_dice_roll.die_1 !== game.current_dice_roll.die_2
            )}
            scoreWhite={game?.score?.WHITE}
            scoreBlack={game?.score?.BLACK}
            matchLength={game?.match_length}
            joinCode={
              game?.mode === "ONLINE_MULTIPLAYER" && onlineLobbyCode
                ? onlineLobbyCode
                : null
            }
            onPointClick={(pointNumber) => {
              if (selectedSource) {
                addDestinationPoint(pointNumber);
                return;
              }
              selectPointAsSource(pointNumber);
            }}
            onBarClick={() => {
              if (selectedSource?.kind === "bar") {
                setSelectedSource(null);
                return;
              }
              selectBarAsSource();
            }}
            onBearOffClick={addDestinationBorneOff}
            onSwapDice={handleSwapDiceOrder}
            onAction={(action) => {
              if (action === "roll") {
                void handleRollDice();
                return;
              }
              if (action === "done" || action === "pass") {
                void handleSubmitMove();
                return;
              }
              if (action === "undo") {
                handleUndoDraftMove();
                return;
              }
              if (action === "double") {
                void handleOfferDouble();
                return;
              }
              if (action === "menu") {
                setMobileTab("settings");
                if (game && game.winner === null) {
                  if (!window.confirm("Abandon this game and return to the start screen?")) {
                    return;
                  }
                }
                setGame(null);
                setPostMoveFeedback(null);
                setAnalysis(null);
                setAwaitingReviewAck(false);
                resetMoveBuilder();
                resetOnlineSession();
                return;
              }
              if (action === "hint") {
                if (game && game.mode !== "VS_COMPUTER") {
                  setError("Hint is disabled in multiplayer to keep play fair.");
                  return;
                }
                void handleAnalyzePosition();
              }
            }}
          />
          {postMoveFeedback && !mistakeCardDismissed ? (
            <MistakeCard
              feedback={postMoveFeedback}
              formatMove={(m) => turnMoveToLabel(m as TurnMoveResponse)}
              onDismiss={() => setMistakeCardDismissed(true)}
              onReplayBest={
                hasBetterPostMove && postMoveFeedback?.best_move
                  ? () => startReplay(postMoveFeedback.best_move as TurnMoveResponse)
                  : undefined
              }
              onReplayYour={
                postMoveFeedback?.your_move
                  ? () => startReplay(postMoveFeedback.your_move as TurnMoveResponse)
                  : undefined
              }
              onContinue={
                awaitingReviewAck
                  ? () => {
                      setAwaitingReviewAck(false);
                      setError(null);
                      setMistakeCardDismissed(true);
                    }
                  : undefined
              }
              arrowsVisible={arrowsVisible}
              onToggleArrows={
                hasBetterPostMove ? () => setArrowsVisible((v) => !v) : undefined
              }
            />
          ) : null}
          {game?.winner ? (
            (() => {
              const perf = perfFromMoveHistory(game.move_history ?? []);
              return (
                <GameOverBanner
                  winner={game.winner}
                  localPlayerColor={
                    game.mode === "ONLINE_MULTIPLAYER"
                      ? onlinePlayerColor
                      : game.mode === "VS_COMPUTER"
                        ? "WHITE"
                        : null
                  }
                  scoreWhite={game.score?.WHITE ?? 0}
                  scoreBlack={game.score?.BLACK ?? 0}
                  matchLength={game.match_length ?? 1}
                  pipWhite={pipCounts?.white ?? 0}
                  pipBlack={pipCounts?.black ?? 0}
                  perfWhite={perf.white}
                  perfBlack={perf.black}
                  // Computer's PR isn't meaningful (it IS the engine), so
                  // hide its column in vs-computer mode.
                  hideOpponentPerf={game.mode === "VS_COMPUTER"}
                  onContinue={() => {
                    setGame(null);
                    setPostMoveFeedback(null);
                    setAnalysis(null);
                    setAwaitingReviewAck(false);
                    resetMoveBuilder();
                    resetOnlineSession();
                  }}
                />
              );
            })()
          ) : null}
          <div className="board-main legacy-board-renderer">
            <div className="board-mobile-hud">
              <span>
                Score {game?.score.WHITE ?? 0}-{game?.score.BLACK ?? 0} / {game?.match_length ?? 1}
              </span>
              <span>Cube {game?.cube_value ?? 1}</span>
              <span>
                Pip {pipCounts ? `${pipCounts.white}:${pipCounts.black}` : "-"}
              </span>
            </div>
            {displayedDice ? (
              <div className={`board-dice-overlay ${isDiceRollingVisual ? "dice-rolling" : ""}`}>
                <button
                  type="button"
                  className={`die-swap-button ${
                    activeDieValue !== null && displayedDice.die_1 === activeDieValue
                      ? "die-swap-button-active"
                      : ""
                  }`}
                  onClick={handleSwapDiceOrder}
                  disabled={!canSwapDiceOrder}
                  aria-label="Swap dice order"
                  title={
                    canSwapDiceOrder
                      ? "Click to swap order"
                      : "Swap is available before the first move only"
                  }
                >
                  {renderDie(displayedDice.die_1, "board-die-1")}
                </button>
                <button
                  type="button"
                  className={`die-swap-button ${
                    activeDieValue !== null && displayedDice.die_2 === activeDieValue
                      ? "die-swap-button-active"
                      : ""
                  }`}
                  onClick={handleSwapDiceOrder}
                  disabled={!canSwapDiceOrder}
                  aria-label="Swap dice order"
                  title={
                    canSwapDiceOrder
                      ? "Click to swap order"
                      : "Swap is available before the first move only"
                  }
                >
                  {renderDie(displayedDice.die_2, "board-die-2")}
                </button>
              </div>
            ) : null}
            <div className="points-row points-row-split">
              <div className="points-half">
                {topLeftPoints.map((point, index) => renderPoint(point, "down", index))}
              </div>
              <button
                type="button"
                className={`bar-column ${selectedSource?.kind === "bar" ? "zone-selected" : ""}`}
                onClick={() => {
                  if (selectedSource?.kind === "bar") {
                    setSelectedSource(null);
                    return;
                  }
                  selectBarAsSource();
                }}
                disabled={!canSelectBarAsSource}
              >
                <strong>Bar</strong>
                <div className="tray-checker-group">
                  <span className="tray-label">WHITE: {interactionBoard?.bar_counts.WHITE ?? 0}</span>
                  <div className="tray-checkers">
                    {Array.from(
                      { length: Math.min(interactionBoard?.bar_counts.WHITE ?? 0, 5) },
                      (_, index) => (
                        <span key={`bar-white-${index}`} className="checker checker-white checker-mini" />
                      )
                    )}
                    {(interactionBoard?.bar_counts.WHITE ?? 0) > 5 ? (
                      <span className="tray-overflow">+{(interactionBoard?.bar_counts.WHITE ?? 0) - 5}</span>
                    ) : null}
                  </div>
                </div>
                <div className="tray-checker-group">
                  <span className="tray-label">BLACK: {interactionBoard?.bar_counts.BLACK ?? 0}</span>
                  <div className="tray-checkers">
                    {Array.from(
                      { length: Math.min(interactionBoard?.bar_counts.BLACK ?? 0, 5) },
                      (_, index) => (
                        <span key={`bar-black-${index}`} className="checker checker-black checker-mini" />
                      )
                    )}
                    {(interactionBoard?.bar_counts.BLACK ?? 0) > 5 ? (
                      <span className="tray-overflow">+{(interactionBoard?.bar_counts.BLACK ?? 0) - 5}</span>
                    ) : null}
                  </div>
                </div>
              </button>
              <div className="points-half">
                {topRightPoints.map((point, index) => renderPoint(point, "down", index + 6))}
              </div>
            </div>

            <div className="points-row points-row-split">
              <div className="points-half">
                {bottomLeftPoints.map((point, index) => renderPoint(point, "up", index))}
              </div>
              <div className="bar-column bar-column-spacer" aria-hidden="true">
                <strong>BAR</strong>
              </div>
              <div className="points-half">
                {bottomRightPoints.map((point, index) => renderPoint(point, "up", index + 6))}
              </div>
            </div>
          </div>

          <aside className="borne-off-trays legacy-board-renderer">
            <button
              type="button"
              className="zone-button borne-off-button"
              onClick={addDestinationBorneOff}
              disabled={!game || !selectedSource || !canBearOffFromSelectedSource || isTurnLocked}
            >
              <strong>Borne Off</strong>
              <div className="tray-checker-group">
                <span className="tray-label">
                  WHITE: {interactionBoard?.borne_off_counts.WHITE ?? 0}
                </span>
                <div className="tray-checkers">
                  {Array.from(
                    { length: Math.min(interactionBoard?.borne_off_counts.WHITE ?? 0, 5) },
                    (_, index) => (
                      <span key={`off-white-${index}`} className="checker checker-white checker-mini" />
                    )
                  )}
                  {(interactionBoard?.borne_off_counts.WHITE ?? 0) > 5 ? (
                    <span className="tray-overflow">
                      +{(interactionBoard?.borne_off_counts.WHITE ?? 0) - 5}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="tray-checker-group">
                <span className="tray-label">
                  BLACK: {interactionBoard?.borne_off_counts.BLACK ?? 0}
                </span>
                <div className="tray-checkers">
                  {Array.from(
                    { length: Math.min(interactionBoard?.borne_off_counts.BLACK ?? 0, 5) },
                    (_, index) => (
                      <span key={`off-black-${index}`} className="checker checker-black checker-mini" />
                    )
                  )}
                  {(interactionBoard?.borne_off_counts.BLACK ?? 0) > 5 ? (
                    <span className="tray-overflow">
                      +{(interactionBoard?.borne_off_counts.BLACK ?? 0) - 5}
                    </span>
                  ) : null}
                </div>
              </div>
            </button>
            <div className="zone-button borne-off-display">
              <strong>Off Trays</strong>
              <span>White Home: Right Side</span>
              <span>Black Home: Right Side</span>
            </div>
          </aside>

          <div className="board-float-actions legacy-board-renderer">
            <button
              type="button"
              className="board-float-button board-float-button-menu mobile-only-action"
              onClick={() => setMobileTab("settings")}
              disabled={isBusy}
            >
              MENU
            </button>
            <button
              type="button"
              className="board-float-button board-float-button-hint mobile-only-action"
              onClick={handleAnalyzePosition}
              disabled={
                isBusy ||
                !game ||
                !game.current_dice_roll ||
                isTurnLocked ||
                game.mode !== "VS_COMPUTER"
              }
            >
              HINT
            </button>
            {canOfferDouble ? (
              <button
                type="button"
                className="board-float-button"
                onClick={() => void handleOfferDouble()}
                disabled={isBusy}
              >
                DOUBLE
              </button>
            ) : null}
            {!game?.current_dice_roll ? (
              <button
                type="button"
                className="board-float-button"
                onClick={handleRollDice}
                disabled={isBusy || !game || isTurnLocked || awaitingReviewAck}
              >
                ROLL
              </button>
            ) : (
              <button
                type="button"
                className="board-float-button"
                onClick={handleSubmitMove}
                disabled={
                  isBusy ||
                  !game ||
                  isTurnLocked ||
                  (!isDraftComplete && !isForcedPassTurn)
                }
              >
                {isForcedPassTurn ? "PASS" : "DONE"}
              </button>
            )}
            <button
              type="button"
              className="board-float-button board-float-button-undo"
              onClick={handleUndoDraftMove}
              disabled={isBusy || isTurnLocked || (pendingMoves.length === 0 && !selectedSource)}
            >
              UNDO
            </button>
          </div>
        </div>
      </section>

      <section className="draft-panel section-play">
        <strong>Draft Moves</strong>
        <p>Click a checker to auto-move by the active die. Click a die to swap order.</p>
        {activeDieValue !== null ? <p>Active die: {activeDieValue}</p> : null}
        <p>Legal full-turn sequences: {legalTurns.length}</p>
        {isForcedPassTurn ? (
          <p>No legal moves are available for this roll. Click PASS to advance the turn.</p>
        ) : null}
        {selectedSource ? (
          <p className="selected-source">
            Selected source: {selectedSource.kind === "bar" ? "BAR" : `P${selectedSource.point}`}
          </p>
        ) : null}

        {pendingMoves.length === 0 ? (
          <p>No moves drafted yet.</p>
        ) : (
          <ol>
            {pendingMoves.map((move, index) => (
              <li key={`${moveToLabel(move)}-${index}`}>{moveToLabel(move)}</li>
            ))}
          </ol>
        )}
      </section>

      {awaitingReviewAck && (!postMoveFeedback || mistakeCardDismissed || postMoveFeedback.classification === "GOOD") ? (
        <section className="review-continue-panel section-play section-review">
          <button
            type="button"
            className="review-continue-btn"
            onClick={() => {
              setAwaitingReviewAck(false);
              setError(null);
            }}
            disabled={isBusy}
          >
            Continue to opponent turn
          </button>
        </section>
      ) : null}

      <MistakeHistory
        entries={mistakeHistoryEntries}
        selectedIndex={selectedHistoryIndex}
        onSelect={handleSelectMistake}
      />

      <section className="turn-feed-panel section-review">
        <strong>Move History</strong>
        {game?.move_history?.length ? (
          <p>Click a move to review details.</p>
        ) : null}
        {!game?.move_history || game.move_history.length === 0 ? (
          <p>No turns yet.</p>
        ) : (
          <div className="history-list">
            {game.move_history.map((entry, index) => {
              const isSelected = selectedHistoryIndex === index;
              return (
                <button
                  type="button"
                  key={`${entry.timestamp}-${index}`}
                  className={`history-item ${isSelected ? "history-item-selected" : ""}`}
                  onClick={() => setSelectedHistoryIndex(index)}
                >
                  <span className={`feed-player feed-player-${entry.player.toLowerCase()}`}>
                    {entry.player}
                  </span>
                  <span>
                    {entry.dice_roll.die_1}-{entry.dice_roll.die_2}
                  </span>
                  <span>{turnMoveToLabel(entry.move_played)}</span>
                  <span>{formatHistoryTimestamp(entry.timestamp)}</span>
                  <span className="history-classification">
                    {entry.analysis_result?.classification ?? "NO_ANALYSIS"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selectedHistoryEntry ? (
          <div className="history-review">
            <strong>Selected Move Review</strong>
            <p>
              Move: {turnMoveToLabel(selectedHistoryEntry.move_played)} | Dice:{" "}
              {selectedHistoryEntry.dice_roll.die_1}-{selectedHistoryEntry.dice_roll.die_2}
            </p>
            <p>Played: {formatHistoryTimestamp(selectedHistoryEntry.timestamp)}</p>
            <p>
              Board Before Pip Count: WHITE {computePipCount(selectedHistoryEntry.board_before, "WHITE")} | BLACK{" "}
              {computePipCount(selectedHistoryEntry.board_before, "BLACK")}
            </p>
            <p>
              Board After Pip Count: WHITE {computePipCount(selectedHistoryEntry.board_after, "WHITE")} | BLACK{" "}
              {computePipCount(selectedHistoryEntry.board_after, "BLACK")}
            </p>
            <p>
              Mistake Classification:{" "}
              <strong>{selectedHistoryEntry.analysis_result?.classification ?? "NO_ANALYSIS"}</strong>
            </p>
          </div>
        ) : null}
      </section>

      {game?.winner && game.post_game_review ? (
        <section className="analysis-panel section-match">
          <strong>Post-Game Review</strong>
          <p>
            Winner: <strong>{game.winner}</strong>
          </p>
          <p>
            Total Moves: {game.post_game_review.total_moves} | Good:{" "}
            {game.post_game_review.good_moves} | Inaccuracies:{" "}
            {game.post_game_review.inaccuracies} | Errors: {game.post_game_review.errors} |
            Blunders: {game.post_game_review.blunders}
          </p>
          <p>
            Total Equity Lost: {game.post_game_review.total_equity_lost.toFixed(3)} | Average
            Equity Loss: {game.post_game_review.average_equity_loss.toFixed(3)}
          </p>
          {game.post_game_review.worst_move ? (
            <p>
              Worst Move (Turn {game.post_game_review.worst_move.turn_index}):{" "}
              {turnMoveToLabel(game.post_game_review.worst_move.move_played)} | Loss{" "}
              {game.post_game_review.worst_move.equity_loss.toFixed(3)} (
              {game.post_game_review.worst_move.classification}) at{" "}
              {formatHistoryTimestamp(game.post_game_review.worst_move.timestamp)}
            </p>
          ) : (
            <p>No analyzed human moves available for worst-move detection.</p>
          )}
        </section>
      ) : null}

      {error ? (
        <section className="error-panel section-play section-review section-match">
          <strong>{computerStepFailed ? "Backend unreachable" : "Validation Error"}</strong>
          <p>{error}</p>
          {legalMoveHints.length > 0 ? (
            <>
              <strong>Legal move options:</strong>
              <ul>
                {legalMoveHints.map((hint, index) => (
                  <li key={`${hint}-${index}`}>{hint}</li>
                ))}
              </ul>
            </>
          ) : null}
          {computerStepFailed ? (
            <button
              type="button"
              className="error-panel-retry"
              onClick={computerStepRetry}
            >
              Retry
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="analysis-panel section-review">
        <strong>Move Analysis (Engine)</strong>
        {analysisError ? <p>{analysisError}</p> : null}
        {!analysis ? (
          <p>Click Analyze Position after rolling dice to view best move suggestions.</p>
        ) : (
          <>
            <p>
              <strong>Best Move:</strong>{" "}
              {analysis.best_move ? turnMoveToLabel(analysis.best_move.move) : "No legal move"}
            </p>
            {analysis.best_move ? (
              <p>
                Equity: {analysis.best_move.equity.toFixed(3)} | Win:{" "}
                {formatPercent(analysis.best_move.evaluation.win_probability)} | Gammon Win:{" "}
                {formatPercent(analysis.best_move.evaluation.gammon_win_probability)} | Backgammon
                Win: {formatPercent(analysis.best_move.evaluation.backgammon_win_probability)}
              </p>
            ) : null}
            <p>
              <strong>Calculation:</strong> {analysis.ranking_method} | Rollout used:{" "}
              {analysis.rollout_used ? "Yes" : "No"} (candidates:{" "}
              {analysis.rollout_candidates_scored}) | Opening book applied:{" "}
              {analysis.opening_book_applied ? "Yes" : "No"}
            </p>
            {analysis.rollout_errors && analysis.rollout_errors.length > 0 ? (
              <p>
                <strong>Rollout Errors:</strong> {analysis.rollout_errors.join(" | ")}
              </p>
            ) : null}

            <div className="analysis-candidates">
              {analysis.candidates.map((candidate, index) => (
                <article key={`${index}-${candidate.equity}`} className="analysis-candidate">
                  <strong>
                    #{index + 1} {turnMoveToLabel(candidate.move)}
                  </strong>
                  <span>
                    Equity {candidate.equity.toFixed(3)} | Win{" "}
                    {formatPercent(candidate.evaluation.win_probability)} | Lose{" "}
                    {formatPercent(candidate.evaluation.lose_probability)}
                  </span>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <nav className="mobile-bottom-nav">
        <button
          type="button"
          className={mobileTab === "play" ? "mobile-tab-active" : ""}
          onClick={() => setMobileTab("play")}
        >
          Play
        </button>
        <button
          type="button"
          className={mobileTab === "match" ? "mobile-tab-active" : ""}
          onClick={() => setMobileTab("match")}
        >
          Match
        </button>
        <button
          type="button"
          className={mobileTab === "review" ? "mobile-tab-active" : ""}
          onClick={() => setMobileTab("review")}
        >
          Review
        </button>
        <button
          type="button"
          className={mobileTab === "settings" ? "mobile-tab-active" : ""}
          onClick={() => setMobileTab("settings")}
        >
          Settings
        </button>
      </nav>
    </main>
  );
}
