from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from random import choice, choices, randint
from string import ascii_uppercase, digits
from time import monotonic
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .domain import (
    BoardState,
    ComputerDifficulty,
    ComputerTurnPhase,
    DiceRoll,
    GameMode,
    GameState,
    MoveValidationError,
    PlayerColor,
    SingleCheckerMove,
    TurnMove,
)
from .engine import (
    EvaluationResult,
    GnuBgEngine,
    MoveAnalysisResult,
    MoveCandidate,
    create_default_engine,
)
from . import stats_db

app = FastAPI(title="Backgammon API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Bring up the SQLite stats schema on boot (idempotent).
stats_db.init_db()

IN_MEMORY_GAMES: dict[str, GameState] = {}
ONLINE_LOBBIES: dict[str, "OnlineLobby"] = {}
ONLINE_GAME_SESSIONS: dict[str, "OnlineGameSession"] = {}
GAME_MOVE_HISTORY: dict[str, list["TurnHistoryEntry"]] = {}
COMPUTER_PLAYER = PlayerColor.BLACK
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("", "0", "false", "no", "off")


# Post-move analysis engine. Rollouts are DISABLED by default because the
# `gnubg_nn.rollout()` C function in this build returns garbage values
# (a fixed ~0.975 win probability for any opening-phase position) and
# frequently segfaults (access violation 3221225477). We rely instead on
# `gnubg_nn.best_move()`'s own ranking + evaluations, which are correctly
# perspective-flipped post-move.
#
# N-ply lookahead is also left at 0 because gnubg_nn.best_move with
# n_plies > 0 segfaults on Windows when called from FastAPI's worker threads.
#
# Override via env if you have a working gnubg_nn build:
#   TOLLEH_ANALYSIS_PLIES        (default 0; raise only if main-thread-only)
#   TOLLEH_ANALYSIS_ROLLOUTS     (default false; rollout is broken here)
#   TOLLEH_ROLLOUT_GAMES         (default 216; lower = faster, less accurate)
#   TOLLEH_ROLLOUT_TOP_K         (default 5; how many top candidates to rollout)
_ANALYSIS_PLIES = _env_int("TOLLEH_ANALYSIS_PLIES", 0)
_ANALYSIS_ROLLOUTS = _env_bool("TOLLEH_ANALYSIS_ROLLOUTS", False)
_ANALYSIS_ROLLOUT_GAMES = _env_int("TOLLEH_ROLLOUT_GAMES", 216)
_ANALYSIS_ROLLOUT_TOP_K = _env_int("TOLLEH_ROLLOUT_TOP_K", 5)

ENGINE = GnuBgEngine(
    n_plies=_ANALYSIS_PLIES,
    use_rollout_for_ranking=_ANALYSIS_ROLLOUTS,
    rollout_games=_ANALYSIS_ROLLOUT_GAMES,
    rollout_top_k=_ANALYSIS_ROLLOUT_TOP_K,
)
COMPUTER_RANKING_ENGINE = create_default_engine(n_plies=1)
COMPUTER_ROLL_DISPLAY_SECONDS = 0.75
COMPUTER_MOVED_DISPLAY_SECONDS = 0.5


@dataclass
class OnlineLobby:
    lobby_code: str
    host_player_id: str
    match_length: int = 1
    guest_player_id: str | None = None
    game_id: str | None = None


@dataclass
class OnlineGameSession:
    game_id: str
    lobby_code: str
    white_player_id: str
    black_player_id: str


class GameBroadcastManager:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[WebSocket]] = {}

    async def connect(self, game_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        sockets = self._subscribers.setdefault(game_id, set())
        sockets.add(websocket)

    def disconnect(self, game_id: str, websocket: WebSocket) -> None:
        sockets = self._subscribers.get(game_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self._subscribers.pop(game_id, None)

    async def broadcast_game_state(
        self, game: GameState, post_move_analysis: PostMoveAnalysisResponse | None = None
    ) -> None:
        sockets = list(self._subscribers.get(game.game_id, set()))
        if not sockets:
            return

        payload = {
            "type": "game_state",
            "game": _serialize_game_state(
                game, post_move_analysis=post_move_analysis
            ).model_dump(mode="json"),
        }
        dead: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:
                dead.append(socket)

        for socket in dead:
            self.disconnect(game.game_id, socket)


BROADCASTS = GameBroadcastManager()


@dataclass
class TurnHistoryEntry:
    player: PlayerColor
    dice_roll: DiceRoll
    move_played: TurnMove
    board_before: BoardState
    board_after: BoardState
    analysis_result: "PostMoveAnalysisResponse | None"
    timestamp: datetime


class DiceRollModel(BaseModel):
    die_1: int = Field(ge=1, le=6)
    die_2: int = Field(ge=1, le=6)


class SingleCheckerMoveModel(BaseModel):
    from_point: int | None = Field(default=None, ge=1, le=24)
    to_point: int | None = Field(default=None, ge=1, le=24)
    from_bar: bool = False
    to_borne_off: bool = False


class TurnMoveModel(BaseModel):
    player: PlayerColor
    dice_roll: DiceRollModel
    moves: list[SingleCheckerMoveModel]


class CreateGameRequest(BaseModel):
    mode: GameMode
    computer_difficulty: ComputerDifficulty | None = None
    match_length: int = Field(default=1)


class ScoreResponse(BaseModel):
    WHITE: int
    BLACK: int


class CubeActionRequest(BaseModel):
    player: PlayerColor
    action: str | None = None


class CreateLobbyRequest(BaseModel):
    match_length: int = Field(default=1)


class CreateLobbyResponse(BaseModel):
    lobby_code: str
    player_id: str
    player_color: PlayerColor
    game_id: str | None
    status: str


class LobbyStatusResponse(BaseModel):
    lobby_code: str
    game_id: str | None
    host_joined: bool
    guest_joined: bool
    status: str


class JoinLobbyRequest(BaseModel):
    player_id: str | None = None


class JoinLobbyResponse(BaseModel):
    lobby_code: str
    game_id: str
    player_id: str
    player_color: PlayerColor
    status: str


class PointResponse(BaseModel):
    owner: PlayerColor | None
    checker_count: int


class BoardStateResponse(BaseModel):
    points: list[PointResponse]
    bar_counts: dict[PlayerColor, int]
    borne_off_counts: dict[PlayerColor, int]


class SingleCheckerMoveResponse(BaseModel):
    player: PlayerColor
    from_point: int | None
    to_point: int | None
    from_bar: bool
    to_borne_off: bool


class TurnMoveResponse(BaseModel):
    player: PlayerColor
    dice_roll: DiceRollModel
    moves: list[SingleCheckerMoveResponse]


class GameStateResponse(BaseModel):
    game_id: str
    mode: GameMode
    computer_difficulty: ComputerDifficulty | None
    board_state: BoardStateResponse
    current_turn: PlayerColor
    computer_turn_phase: ComputerTurnPhase | None
    turn_number: int
    current_dice_roll: DiceRollModel | None
    match_length: int
    score: ScoreResponse
    cube_value: int
    cube_owner: PlayerColor | None
    cube_offered_by: PlayerColor | None
    turn_history: list[TurnMoveResponse]
    move_history: list["TurnHistoryEntryResponse"] = Field(default_factory=list)
    winner: PlayerColor | None
    last_computer_roll: DiceRollModel | None = None
    last_computer_move: TurnMoveResponse | None = None
    post_move_analysis: "PostMoveAnalysisResponse | None" = None
    post_game_review: "PostGameReviewResponse | None" = None


class RollDiceResponse(BaseModel):
    game_id: str
    player: PlayerColor
    dice_roll: DiceRollModel


class AnalyzePositionRequest(BaseModel):
    player: PlayerColor | None = None
    dice_roll: DiceRollModel | None = None


class EvaluationResultResponse(BaseModel):
    equity: float
    win_probability: float
    gammon_win_probability: float
    backgammon_win_probability: float
    lose_probability: float
    gammon_lose_probability: float
    backgammon_lose_probability: float


class MoveCandidateResponse(BaseModel):
    move: TurnMoveResponse
    resulting_board: BoardStateResponse
    evaluation: EvaluationResultResponse
    equity: float


class MoveAnalysisResponse(BaseModel):
    best_move: MoveCandidateResponse | None
    candidates: list[MoveCandidateResponse]
    ranking_method: str = ""
    rollout_used: bool = False
    rollout_candidates_scored: int = 0
    rollout_errors: list[str] | None = None
    opening_book_applied: bool = False


class LegalMovesResponse(BaseModel):
    moves: list[TurnMoveResponse]


class MoveQualityClass(str, Enum):
    GOOD = "GOOD"
    INACCURACY = "INACCURACY"
    ERROR = "ERROR"
    BLUNDER = "BLUNDER"


class MoveExplanationResponse(BaseModel):
    """Human-readable bullets describing why the best move beat the user's move.

    Generated by diffing structural features (points made, blots, prime length,
    pip count) and equity components (win/gammon/lose-gammon probabilities) of
    the two resulting positions. Empty for GOOD moves.
    """

    best_reasons: list[str] = []
    your_drawbacks: list[str] = []


class PostMoveAnalysisResponse(BaseModel):
    best_move: TurnMoveResponse
    your_move: TurnMoveResponse
    best_equity: float
    your_equity: float
    equity_loss: float
    # Single-game win probabilities (0..1) from the engine evaluation,
    # used to surface "win % lost" alongside the abstract equity loss.
    best_win_probability: float = 0.0
    your_win_probability: float = 0.0
    classification: MoveQualityClass
    ranking_method: str = ""
    rollout_used: bool = False
    rollout_candidates_scored: int = 0
    rollout_errors: list[str] | None = None
    opening_book_applied: bool = False
    explanation: MoveExplanationResponse | None = None


class TurnHistoryEntryResponse(BaseModel):
    player: PlayerColor
    dice_roll: DiceRollModel
    move_played: TurnMoveResponse
    board_before: BoardStateResponse
    board_after: BoardStateResponse
    analysis_result: PostMoveAnalysisResponse | None
    timestamp: str


class WorstMoveResponse(BaseModel):
    turn_index: int
    player: PlayerColor
    move_played: TurnMoveResponse
    equity_loss: float
    classification: MoveQualityClass
    timestamp: str


class PostGameReviewResponse(BaseModel):
    total_moves: int
    good_moves: int
    inaccuracies: int
    errors: int
    blunders: int
    total_equity_lost: float
    average_equity_loss: float
    worst_move: WorstMoveResponse | None


def _serialize_dice_roll(dice_roll: DiceRoll | None) -> DiceRollModel | None:
    if dice_roll is None:
        return None

    return DiceRollModel(die_1=dice_roll.die_1, die_2=dice_roll.die_2)


def _serialize_single_move(move: SingleCheckerMove) -> SingleCheckerMoveResponse:
    return SingleCheckerMoveResponse(
        player=move.player,
        from_point=move.from_point,
        to_point=move.to_point,
        from_bar=move.from_bar,
        to_borne_off=move.to_borne_off,
    )


def _serialize_turn_move(turn_move: TurnMove) -> TurnMoveResponse:
    return TurnMoveResponse(
        player=turn_move.player,
        dice_roll=DiceRollModel(
            die_1=turn_move.dice_roll.die_1, die_2=turn_move.dice_roll.die_2
        ),
        moves=[_serialize_single_move(move) for move in turn_move.moves],
    )


def _serialize_board_state(board_state: BoardState) -> BoardStateResponse:
    return BoardStateResponse(
        points=[
            PointResponse(owner=point.owner, checker_count=point.checker_count)
            for point in board_state.points
        ],
        bar_counts=board_state.bar_counts,
        borne_off_counts=board_state.borne_off_counts,
    )


def _serialize_evaluation_result(
    evaluation: EvaluationResult,
) -> EvaluationResultResponse:
    return EvaluationResultResponse(
        equity=evaluation.equity,
        win_probability=evaluation.win_probability,
        gammon_win_probability=evaluation.gammon_win_probability,
        backgammon_win_probability=evaluation.backgammon_win_probability,
        lose_probability=evaluation.lose_probability,
        gammon_lose_probability=evaluation.gammon_lose_probability,
        backgammon_lose_probability=evaluation.backgammon_lose_probability,
    )


def _serialize_move_candidate(candidate: MoveCandidate) -> MoveCandidateResponse:
    return MoveCandidateResponse(
        move=_serialize_turn_move(candidate.move),
        resulting_board=_serialize_board_state(candidate.resulting_board),
        evaluation=_serialize_evaluation_result(candidate.evaluation),
        equity=candidate.equity,
    )


def _serialize_move_analysis_result(
    analysis: MoveAnalysisResult,
) -> MoveAnalysisResponse:
    return MoveAnalysisResponse(
        best_move=(
            _serialize_move_candidate(analysis.best_move)
            if analysis.best_move is not None
            else None
        ),
        candidates=[_serialize_move_candidate(candidate) for candidate in analysis.candidates],
        ranking_method=analysis.ranking_method,
        rollout_used=analysis.rollout_used,
        rollout_candidates_scored=analysis.rollout_candidates_scored,
        rollout_errors=analysis.rollout_errors,
        opening_book_applied=analysis.opening_book_applied,
    )


def _serialize_turn_history_entry(
    entry: TurnHistoryEntry,
) -> TurnHistoryEntryResponse:
    return TurnHistoryEntryResponse(
        player=entry.player,
        dice_roll=_serialize_dice_roll(entry.dice_roll),
        move_played=_serialize_turn_move(entry.move_played),
        board_before=_serialize_board_state(entry.board_before),
        board_after=_serialize_board_state(entry.board_after),
        analysis_result=entry.analysis_result,
        timestamp=entry.timestamp.isoformat(),
    )


def _compute_post_game_review(game: GameState) -> PostGameReviewResponse | None:
    if game.winner is None:
        return None

    history = GAME_MOVE_HISTORY.get(game.game_id, [])
    human_analyzed_entries = [
        (index, entry)
        for index, entry in enumerate(history)
        if entry.analysis_result is not None
    ]

    if not human_analyzed_entries:
        return PostGameReviewResponse(
            total_moves=len(history),
            good_moves=0,
            inaccuracies=0,
            errors=0,
            blunders=0,
            total_equity_lost=0.0,
            average_equity_loss=0.0,
            worst_move=None,
        )

    good_moves = 0
    inaccuracies = 0
    errors = 0
    blunders = 0
    total_equity_lost = 0.0
    worst: tuple[int, TurnHistoryEntry] | None = None

    for index, entry in human_analyzed_entries:
        analysis = entry.analysis_result
        if analysis is None:
            continue
        total_equity_lost += analysis.equity_loss
        if analysis.classification == MoveQualityClass.GOOD:
            good_moves += 1
        elif analysis.classification == MoveQualityClass.INACCURACY:
            inaccuracies += 1
        elif analysis.classification == MoveQualityClass.ERROR:
            errors += 1
        elif analysis.classification == MoveQualityClass.BLUNDER:
            blunders += 1

        if worst is None or analysis.equity_loss > (worst[1].analysis_result.equity_loss):  # type: ignore[union-attr]
            worst = (index, entry)

    average_equity_loss = total_equity_lost / len(human_analyzed_entries)
    worst_move_response: WorstMoveResponse | None = None
    if worst is not None and worst[1].analysis_result is not None:
        worst_entry = worst[1]
        worst_analysis = worst_entry.analysis_result
        worst_move_response = WorstMoveResponse(
            turn_index=worst[0] + 1,
            player=worst_entry.player,
            move_played=_serialize_turn_move(worst_entry.move_played),
            equity_loss=worst_analysis.equity_loss,
            classification=worst_analysis.classification,
            timestamp=worst_entry.timestamp.isoformat(),
        )

    return PostGameReviewResponse(
        total_moves=len(history),
        good_moves=good_moves,
        inaccuracies=inaccuracies,
        errors=errors,
        blunders=blunders,
        total_equity_lost=total_equity_lost,
        average_equity_loss=average_equity_loss,
        worst_move=worst_move_response,
    )


def _serialize_game_state(
    game: GameState, post_move_analysis: PostMoveAnalysisResponse | None = None
) -> GameStateResponse:
    return GameStateResponse(
        game_id=game.game_id,
        mode=game.mode,
        computer_difficulty=game.computer_difficulty,
        board_state=_serialize_board_state(game.board_state),
        current_turn=game.current_turn,
        computer_turn_phase=game.computer_turn_phase,
        turn_number=game.turn_number,
        current_dice_roll=_serialize_dice_roll(game.current_dice_roll),
        match_length=game.match_length,
        score=ScoreResponse(WHITE=game.score_white, BLACK=game.score_black),
        cube_value=game.cube_value,
        cube_owner=game.cube_owner,
        cube_offered_by=game.cube_offered_by,
        turn_history=[_serialize_turn_move(turn) for turn in game.turn_history],
        move_history=[
            _serialize_turn_history_entry(entry)
            for entry in GAME_MOVE_HISTORY.get(game.game_id, [])
        ],
        winner=game.winner,
        last_computer_roll=_serialize_dice_roll(game.last_computer_roll),
        last_computer_move=(
            _serialize_turn_move(game.last_computer_move)
            if game.last_computer_move is not None
            else None
        ),
        post_move_analysis=post_move_analysis,
        post_game_review=_compute_post_game_review(game),
    )


def _get_game_or_404(game_id: str) -> GameState:
    game = IN_MEMORY_GAMES.get(game_id)
    if game is None:
        raise HTTPException(status_code=404, detail=f"Game '{game_id}' was not found.")
    return game


def _generate_lobby_code() -> str:
    alphabet = ascii_uppercase + digits
    for _ in range(200):
        code = "".join(choices(alphabet, k=6))
        if code not in ONLINE_LOBBIES:
            return code
    raise HTTPException(status_code=500, detail="Could not generate unique lobby code.")


def _create_online_game_from_lobby(lobby: OnlineLobby) -> OnlineGameSession:
    if lobby.guest_player_id is None:
        raise HTTPException(status_code=400, detail="Cannot create game without second player.")

    game_id = str(uuid4())
    game = GameState.new_game(
        game_id=game_id,
        mode=GameMode.ONLINE_MULTIPLAYER,
        match_length=lobby.match_length,
    )
    _initialize_opening_roll(game)
    IN_MEMORY_GAMES[game_id] = game
    GAME_MOVE_HISTORY[game_id] = []

    session = OnlineGameSession(
        game_id=game_id,
        lobby_code=lobby.lobby_code,
        white_player_id=lobby.host_player_id,
        black_player_id=lobby.guest_player_id,
    )
    ONLINE_GAME_SESSIONS[game_id] = session
    lobby.game_id = game_id
    return session


def _require_online_player(
    game: GameState, player_id: str | None, require_current_turn: bool = False
) -> PlayerColor:
    session = ONLINE_GAME_SESSIONS.get(game.game_id)
    if session is None:
        raise HTTPException(
            status_code=400,
            detail="Online multiplayer session data is missing for this game.",
        )
    if not player_id:
        raise HTTPException(
            status_code=400,
            detail="player_id is required for online multiplayer actions.",
        )

    if player_id == session.white_player_id:
        color = PlayerColor.WHITE
    elif player_id == session.black_player_id:
        color = PlayerColor.BLACK
    else:
        raise HTTPException(status_code=403, detail="player_id is not a participant in this game.")

    if require_current_turn and color != game.current_turn:
        raise HTTPException(
            status_code=403,
            detail=f"It is currently {game.current_turn.value}'s turn.",
        )
    return color


def _dice_rolls_match(left: DiceRollModel, right: DiceRoll) -> bool:
    return sorted([left.die_1, left.die_2]) == sorted([right.die_1, right.die_2])


def _classify_equity_loss(equity_loss: float) -> MoveQualityClass:
    if equity_loss <= 0.020:
        return MoveQualityClass.GOOD
    if equity_loss <= 0.050:
        return MoveQualityClass.INACCURACY
    if equity_loss <= 0.100:
        return MoveQualityClass.ERROR
    return MoveQualityClass.BLUNDER


def _score_for(game: GameState, player: PlayerColor) -> int:
    return game.score_white if player == PlayerColor.WHITE else game.score_black


def _set_score_for(game: GameState, player: PlayerColor, value: int) -> None:
    if player == PlayerColor.WHITE:
        game.score_white = value
    else:
        game.score_black = value


def _is_in_home_board_for(winner: PlayerColor, point_number: int) -> bool:
    if winner == PlayerColor.WHITE:
        return 1 <= point_number <= 6
    return 19 <= point_number <= 24


def _calculate_game_points(board: BoardState, winner: PlayerColor, cube_value: int) -> int:
    loser = BoardState.opponent(winner)
    if board.borne_off_counts[loser] > 0:
        return cube_value

    has_loser_checker_in_winner_home = any(
        point.owner == loser
        and point.checker_count > 0
        and _is_in_home_board_for(winner, index + 1)
        for index, point in enumerate(board.points)
    )
    if board.bar_counts[loser] > 0 or has_loser_checker_in_winner_home:
        return cube_value * 3
    return cube_value * 2


def _start_next_game_in_match(game: GameState, starting_player: PlayerColor) -> None:
    game.board_state = BoardState.initial()
    game.current_turn = starting_player
    game.current_dice_roll = None
    game.cube_value = 1
    game.cube_owner = None
    game.cube_offered_by = None
    game.computer_turn_phase = ComputerTurnPhase.IDLE if game.mode == GameMode.VS_COMPUTER else None
    game.computer_turn_ready_at = None
    game.pending_computer_turn = None
    game.last_computer_roll = None
    game.last_computer_move = None
    _initialize_opening_roll(game)


def _initialize_opening_roll(game: GameState) -> None:
    """Roll-off for first turn: higher die starts, and that roll is the opening turn roll."""
    while True:
        white_open = randint(1, 6)
        black_open = randint(1, 6)
        if white_open != black_open:
            break

    if white_open > black_open:
        game.current_turn = PlayerColor.WHITE
        game.current_dice_roll = DiceRoll(die_1=white_open, die_2=black_open)
    else:
        game.current_turn = PlayerColor.BLACK
        game.current_dice_roll = DiceRoll(die_1=black_open, die_2=white_open)

    if game.mode == GameMode.VS_COMPUTER:
        game.computer_turn_phase = ComputerTurnPhase.IDLE
        game.computer_turn_ready_at = None
        game.pending_computer_turn = None


def _prepare_computer_pending_turn(game: GameState) -> None:
    if game.current_dice_roll is None:
        return
    legal_turn_moves = game.board_state.generate_legal_turn_moves(
        player=game.current_turn,
        dice_roll=game.current_dice_roll,
        deduplicate_final_states=False,
    )
    if not legal_turn_moves:
        game.pending_computer_turn = TurnMove(
            player=game.current_turn,
            dice_roll=game.current_dice_roll,
            moves=[],
        )
    else:
        game.pending_computer_turn = _choose_computer_turn(
            game=game,
            legal_turn_moves=legal_turn_moves,
        )


def _match_adjusted_equity(
    evaluation: EvaluationResult,
    *,
    cube_value: int,
    points_to_win_player: int,
    points_to_win_opponent: int,
) -> float:
    base = evaluation.equity
    gammon_win = evaluation.gammon_win_probability + (
        evaluation.backgammon_win_probability * 0.5
    )
    gammon_lose = evaluation.gammon_lose_probability + (
        evaluation.backgammon_lose_probability * 0.5
    )
    win_edge = evaluation.win_probability - evaluation.lose_probability

    # Keep proxy conservative so we don't overpower the base engine evaluation.
    if points_to_win_player <= cube_value:
        # At (or very near) match-point for player: prioritize plain wins.
        return base + (0.035 * win_edge) - (0.020 * gammon_lose)
    if points_to_win_opponent <= cube_value:
        # Opponent near match-point: avoid volatile losses a bit more.
        return base + (0.020 * win_edge) - (0.030 * gammon_lose) + (0.010 * gammon_win)
    return base + (0.012 * win_edge) + (0.010 * gammon_win) - (0.010 * gammon_lose)


def _should_apply_match_proxy(
    game: GameState, *, points_to_win_player: int, points_to_win_opponent: int
) -> bool:
    # Single game or plain money-like start: no proxy.
    if game.match_length <= 1:
        return False

    # Use match-aware checker-play proxy only when one side is near match end.
    # Applying it too early (for example 0-0 to 5 with cube=2) can distort
    # rankings compared to engine checker-play evaluations.
    if (
        points_to_win_player > game.cube_value
        and points_to_win_opponent > game.cube_value
    ):
        return False

    return True


def _apply_match_context_to_analysis(
    analysis: MoveAnalysisResult, game: GameState, player: PlayerColor
) -> MoveAnalysisResult:
    player_need = max(1, game.match_length - _score_for(game, player))
    opponent_need = max(1, game.match_length - _score_for(game, BoardState.opponent(player)))
    if not _should_apply_match_proxy(
        game,
        points_to_win_player=player_need,
        points_to_win_opponent=opponent_need,
    ):
        return analysis

    adjusted: list[MoveCandidate] = []
    for candidate in analysis.candidates:
        adjusted_equity = _match_adjusted_equity(
            candidate.evaluation,
            cube_value=game.cube_value,
            points_to_win_player=player_need,
            points_to_win_opponent=opponent_need,
        )
        adjusted.append(
            MoveCandidate(
                move=candidate.move,
                resulting_board=candidate.resulting_board,
                evaluation=candidate.evaluation,
                equity=adjusted_equity,
            )
        )
    adjusted.sort(key=lambda c: c.equity, reverse=True)
    return MoveAnalysisResult(
        best_move=adjusted[0] if adjusted else None,
        candidates=adjusted,
        ranking_method=f"{analysis.ranking_method} | Match-aware proxy applied (to {game.match_length}, score {_score_for(game, player)}-{_score_for(game, BoardState.opponent(player))}, cube {game.cube_value}).",
        rollout_used=analysis.rollout_used,
        rollout_candidates_scored=analysis.rollout_candidates_scored,
        rollout_errors=analysis.rollout_errors,
        opening_book_applied=analysis.opening_book_applied,
    )


def _choose_computer_cube_action(game: GameState) -> str:
    """Return 'accept' or 'reject' for a pending cube offer to the computer."""
    responder = BoardState.opponent(game.cube_offered_by or COMPUTER_PLAYER)
    responder_eval = ENGINE.evaluate_position(game.board_state, responder)

    responder_need = max(1, game.match_length - _score_for(game, responder))
    offerer = BoardState.opponent(responder)
    offerer_need = max(1, game.match_length - _score_for(game, offerer))

    # Use conservative proxy only when context is meaningful.
    if _should_apply_match_proxy(
        game,
        points_to_win_player=responder_need,
        points_to_win_opponent=offerer_need,
    ):
        adjusted_equity = _match_adjusted_equity(
            responder_eval,
            cube_value=game.cube_value,
            points_to_win_player=responder_need,
            points_to_win_opponent=offerer_need,
        )
    else:
        adjusted_equity = responder_eval.equity

    # Approximate take-point threshold for this simplified cubeful decision.
    return "accept" if adjusted_equity >= -0.20 else "reject"


def _board_features(board: BoardState, player: PlayerColor) -> dict:
    """Compute structural features for explaining why a move helped or hurt.

    Coordinates are absolute point numbers 1..24. WHITE bears off toward 1,
    BLACK toward 24, so each player's "home board" and pip direction differ.
    """
    home_range = range(1, 7) if player == PlayerColor.WHITE else range(19, 25)
    opp_home_range = range(19, 25) if player == PlayerColor.WHITE else range(1, 7)

    blots: list[int] = []
    points_held: list[int] = []
    blots_in_opp_home = 0
    pip = 0

    for index, point in enumerate(board.points):
        pn = index + 1
        if point.owner != player or point.checker_count == 0:
            continue
        if point.checker_count == 1:
            blots.append(pn)
            if pn in opp_home_range:
                blots_in_opp_home += 1
        elif point.checker_count >= 2:
            points_held.append(pn)
        if player == PlayerColor.WHITE:
            pip += pn * point.checker_count
        else:
            pip += (25 - pn) * point.checker_count

    pip += 25 * board.bar_counts[player]

    home_points_held = [pn for pn in points_held if pn in home_range]

    held_set = set(points_held)
    longest_prime = 0
    run = 0
    for pn in range(1, 25):
        if pn in held_set:
            run += 1
            longest_prime = max(longest_prime, run)
        else:
            run = 0

    return {
        "pip": pip,
        "blots": blots,
        "blots_in_opp_home": blots_in_opp_home,
        "points_held": points_held,
        "home_points_held": home_points_held,
        "longest_prime": longest_prime,
        "bar": board.bar_counts[player],
    }


def _build_explanation(
    your_board: BoardState,
    best_board: BoardState,
    your_eval: EvaluationResult,
    best_eval: EvaluationResult,
    player: PlayerColor,
) -> MoveExplanationResponse:
    your_f = _board_features(your_board, player)
    best_f = _board_features(best_board, player)

    best_reasons: list[str] = []
    your_drawbacks: list[str] = []

    new_in_best = set(best_f["points_held"]) - set(your_f["points_held"])
    new_in_best_home = set(best_f["home_points_held"]) - set(your_f["home_points_held"])
    if new_in_best_home:
        pts = ", ".join(f"{p}-point" for p in sorted(new_in_best_home))
        best_reasons.append(
            f"Makes the {pts} in your inner board, building a stronger home board for hits."
        )
    outer_new = new_in_best - new_in_best_home
    if outer_new:
        pts = ", ".join(f"{p}-point" for p in sorted(outer_new))
        best_reasons.append(
            f"Secures the {pts}, giving you a safe landing zone the opponent can't share."
        )

    if best_f["longest_prime"] >= 4 and best_f["longest_prime"] > your_f["longest_prime"]:
        best_reasons.append(
            f"Builds a {best_f['longest_prime']}-prime, making it much harder for the opponent to escape."
        )

    gammon_delta = best_eval.gammon_win_probability - your_eval.gammon_win_probability
    if gammon_delta >= 0.03:
        best_reasons.append(
            f"Increases your gammon-win chances by about {gammon_delta * 100:.0f}%."
        )

    # Highest-signal drawback first: back anchor break (24-point for WHITE,
    # 1-point for BLACK). The back anchor is a structural foundation; losing it
    # leaves back checkers with no safe escape square.
    back_anchor = 24 if player == PlayerColor.WHITE else 1
    if (
        back_anchor in best_f["points_held"]
        and back_anchor not in your_f["points_held"]
    ):
        your_drawbacks.append(
            f"Breaks your back anchor on the {back_anchor}-point — losing it leaves your back checkers with no safe square to retreat to if they're attacked."
        )

    # Blot in YOUR own home board: pip cost of being hit is maximal
    # (a checker on the 3-point goes from 3 pips of progress to 25 on the bar).
    home_range = range(1, 7) if player == PlayerColor.WHITE else range(19, 25)
    your_blots_in_own_home = sum(1 for b in your_f["blots"] if b in home_range)
    best_blots_in_own_home = sum(1 for b in best_f["blots"] if b in home_range)
    if your_blots_in_own_home > best_blots_in_own_home:
        your_drawbacks.append(
            "Leaves a blot in your own home board — if it gets hit you lose 20+ pips of progress and have to re-enter against the opponent's structure."
        )

    blot_delta = len(your_f["blots"]) - len(best_f["blots"])
    if blot_delta >= 1:
        s = "s" if blot_delta != 1 else ""
        your_drawbacks.append(
            f"Leaves {blot_delta} more blot{s} exposed than the best play."
        )

    # Blot deep in OPPONENT's home: pip cost of a hit is small (the checker
    # is already nearly at the bar), but their nearby checkers give a lot of
    # shots at it — the issue is shot count, not pip damage.
    new_blots_in_opp_home = your_f["blots_in_opp_home"] - best_f["blots_in_opp_home"]
    if new_blots_in_opp_home >= 1:
        your_drawbacks.append(
            "Leaves a blot deep in the opponent's home board, where many of their checkers are still parked and can hit it."
        )

    win_delta = best_eval.win_probability - your_eval.win_probability
    if win_delta >= 0.03:
        your_drawbacks.append(
            f"Drops your overall winning chances by about {win_delta * 100:.0f}%."
        )

    lose_gammon_delta = your_eval.gammon_lose_probability - best_eval.gammon_lose_probability
    if lose_gammon_delta >= 0.03:
        your_drawbacks.append(
            f"Raises the chance you lose a gammon by about {lose_gammon_delta * 100:.0f}%."
        )

    pip_delta = your_f["pip"] - best_f["pip"]
    if pip_delta >= 3:
        your_drawbacks.append(
            f"Wastes about {pip_delta} pips of racing distance compared to the best play."
        )

    if your_f["bar"] > best_f["bar"]:
        your_drawbacks.append(
            "Leaves a checker on the bar that the best move was able to enter."
        )

    return MoveExplanationResponse(
        best_reasons=best_reasons[:3],
        your_drawbacks=your_drawbacks[:3],
    )


def _build_post_move_analysis(
    board_state_before_move: BoardState,
    dice_roll: DiceRoll,
    player: PlayerColor,
    your_move: TurnMove,
    game: GameState,
) -> PostMoveAnalysisResponse:
    if not your_move.moves:
        return PostMoveAnalysisResponse(
            best_move=_serialize_turn_move(your_move),
            your_move=_serialize_turn_move(your_move),
            best_equity=0.0,
            your_equity=0.0,
            equity_loss=0.0,
            classification=MoveQualityClass.GOOD,
            ranking_method="Forced pass (no legal moves available).",
            rollout_used=False,
            rollout_candidates_scored=0,
            rollout_errors=None,
            opening_book_applied=False,
        )

    ranked = ENGINE.rank_moves(
        board_state_before_move=board_state_before_move,
        dice_roll=dice_roll,
        player_color=player,
        deduplicate_final_states=False,
    )
    ranked = _apply_match_context_to_analysis(ranked, game=game, player=player)

    if not ranked.candidates or ranked.best_move is None:
        return PostMoveAnalysisResponse(
            best_move=_serialize_turn_move(your_move),
            your_move=_serialize_turn_move(your_move),
            best_equity=0.0,
            your_equity=0.0,
            equity_loss=0.0,
            classification=MoveQualityClass.GOOD,
        )

    user_resulting_board = board_state_before_move.copy()
    for move in your_move.moves:
        user_resulting_board.apply_single_checker_move(move)

    user_candidate = next(
        (
            candidate
            for candidate in ranked.candidates
            if candidate.move.moves == your_move.moves
        ),
        None,
    )
    if user_candidate is None:
        # Native GNUBG ranking collapses some move-order variants that reach the
        # same final position. Match by resulting board before falling back to a
        # fresh position eval so equity-loss stays consistent with the candidate list.
        user_signature = user_resulting_board.signature()
        user_candidate = next(
            (
                candidate
                for candidate in ranked.candidates
                if candidate.resulting_board.signature() == user_signature
            ),
            None,
        )

    if user_candidate is None:
        user_eval = ENGINE.evaluate_position(user_resulting_board, player)
        user_equity = user_eval.equity
    else:
        user_eval = user_candidate.evaluation
        user_equity = user_candidate.equity

    best_equity = ranked.best_move.equity
    equity_loss = max(0.0, best_equity - user_equity)
    classification = _classify_equity_loss(equity_loss)

    explanation: MoveExplanationResponse | None = None
    if classification != MoveQualityClass.GOOD:
        explanation = _build_explanation(
            your_board=user_resulting_board,
            best_board=ranked.best_move.resulting_board,
            your_eval=user_eval,
            best_eval=ranked.best_move.evaluation,
            player=player,
        )

    return PostMoveAnalysisResponse(
        best_move=_serialize_turn_move(ranked.best_move.move),
        your_move=_serialize_turn_move(your_move),
        best_equity=best_equity,
        your_equity=user_equity,
        equity_loss=equity_loss,
        best_win_probability=ranked.best_move.evaluation.win_probability,
        your_win_probability=user_eval.win_probability,
        classification=classification,
        ranking_method=ranked.ranking_method,
        rollout_used=ranked.rollout_used,
        rollout_candidates_scored=ranked.rollout_candidates_scored,
        rollout_errors=ranked.rollout_errors,
        opening_book_applied=ranked.opening_book_applied,
        explanation=explanation,
    )


def _apply_turn_and_advance(game: GameState, turn_move: TurnMove) -> None:
    for move in turn_move.moves:
        game.board_state.apply_single_checker_move(move)

    game.turn_history.append(turn_move)
    game.current_dice_roll = None
    if turn_move.player == COMPUTER_PLAYER:
        game.last_computer_move = turn_move

    if game.board_state.borne_off_counts[turn_move.player] >= 15:
        points_won = _calculate_game_points(game.board_state, turn_move.player, game.cube_value)
        _set_score_for(game, turn_move.player, _score_for(game, turn_move.player) + points_won)
        if _score_for(game, turn_move.player) >= game.match_length:
            game.winner = turn_move.player
            game.current_dice_roll = None
            game.cube_offered_by = None
            game.cube_owner = None
            game.cube_value = 1
            game.computer_turn_phase = (
                ComputerTurnPhase.IDLE if game.mode == GameMode.VS_COMPUTER else None
            )
            game.computer_turn_ready_at = None
            game.pending_computer_turn = None
            return
        _start_next_game_in_match(game, starting_player=turn_move.player)
        return

    game.current_turn = BoardState.opponent(game.current_turn)
    game.turn_number += 1


def _record_turn_history_entry(
    *,
    game: GameState,
    player: PlayerColor,
    dice_roll: DiceRoll,
    move_played: TurnMove,
    board_before: BoardState,
    board_after: BoardState,
    analysis_result: PostMoveAnalysisResponse | None,
) -> None:
    history = GAME_MOVE_HISTORY.setdefault(game.game_id, [])
    history.append(
        TurnHistoryEntry(
            player=player,
            dice_roll=dice_roll,
            move_played=move_played,
            board_before=board_before,
            board_after=board_after,
            analysis_result=analysis_result,
            timestamp=datetime.now(UTC),
        )
    )


def _thinking_delay_for_difficulty(difficulty: ComputerDifficulty) -> float:
    if difficulty == ComputerDifficulty.BEGINNER:
        return 0.35
    if difficulty == ComputerDifficulty.INTERMEDIATE:
        return 0.55
    if difficulty == ComputerDifficulty.ADVANCED:
        return 0.7
    return 0.5


def _progress_computer_turn(game: GameState) -> None:
    if game.mode != GameMode.VS_COMPUTER or game.winner is not None:
        return

    if game.current_turn != COMPUTER_PLAYER:
        if game.computer_turn_phase == ComputerTurnPhase.MOVED:
            ready_at = game.computer_turn_ready_at
            if ready_at is not None and monotonic() >= ready_at:
                game.computer_turn_phase = ComputerTurnPhase.IDLE
                game.computer_turn_ready_at = None
        return

    now = monotonic()
    phase = game.computer_turn_phase or ComputerTurnPhase.IDLE

    if phase == ComputerTurnPhase.IDLE:
        if game.current_dice_roll is None:
            game.computer_turn_phase = ComputerTurnPhase.ROLLING
            game.current_dice_roll = DiceRoll(die_1=randint(1, 6), die_2=randint(1, 6))
            game.last_computer_roll = game.current_dice_roll
            _prepare_computer_pending_turn(game)
            game.computer_turn_ready_at = now + COMPUTER_ROLL_DISPLAY_SECONDS
            return

        # Opening roll already present for this turn: skip extra auto-roll.
        game.last_computer_roll = game.current_dice_roll
        _prepare_computer_pending_turn(game)
        difficulty = game.computer_difficulty or ComputerDifficulty.BEGINNER
        game.computer_turn_phase = ComputerTurnPhase.THINKING
        game.computer_turn_ready_at = now + _thinking_delay_for_difficulty(difficulty)
        return

    ready_at = game.computer_turn_ready_at
    if ready_at is not None and now < ready_at:
        return

    if phase == ComputerTurnPhase.ROLLING:
        difficulty = game.computer_difficulty or ComputerDifficulty.BEGINNER
        game.computer_turn_phase = ComputerTurnPhase.THINKING
        game.computer_turn_ready_at = now + _thinking_delay_for_difficulty(difficulty)
        return

    if phase == ComputerTurnPhase.THINKING:
        if game.current_dice_roll is None:
            return

        chosen_turn = game.pending_computer_turn or TurnMove(
            player=game.current_turn,
            dice_roll=game.current_dice_roll,
            moves=[],
        )
        board_before = game.board_state.copy()
        dice_roll_before = DiceRoll(
            die_1=game.current_dice_roll.die_1,
            die_2=game.current_dice_roll.die_2,
        )
        try:
            _apply_turn_and_advance(game, chosen_turn)
        except MoveValidationError:
            legal_turn_moves = game.board_state.generate_legal_turn_moves(
                player=game.current_turn,
                dice_roll=game.current_dice_roll,
                deduplicate_final_states=False,
            )
            fallback_turn = (
                _choose_computer_turn(game=game, legal_turn_moves=legal_turn_moves)
                if legal_turn_moves
                else TurnMove(
                    player=game.current_turn,
                    dice_roll=game.current_dice_roll,
                    moves=[],
                )
            )
            _apply_turn_and_advance(game, fallback_turn)
            chosen_turn = fallback_turn
        _record_turn_history_entry(
            game=game,
            player=chosen_turn.player,
            dice_roll=dice_roll_before,
            move_played=chosen_turn,
            board_before=board_before,
            board_after=game.board_state.copy(),
            analysis_result=None,
        )
        game.pending_computer_turn = None
        game.computer_turn_phase = ComputerTurnPhase.MOVED
        game.computer_turn_ready_at = now + COMPUTER_MOVED_DISPLAY_SECONDS
        return

    if phase == ComputerTurnPhase.MOVED:
        game.computer_turn_phase = ComputerTurnPhase.IDLE
        game.computer_turn_ready_at = None


def _choose_computer_turn(
    game: GameState,
    legal_turn_moves: list[TurnMove],
) -> TurnMove:
    difficulty = game.computer_difficulty or ComputerDifficulty.BEGINNER

    if difficulty == ComputerDifficulty.BEGINNER:
        return choice(legal_turn_moves)

    if game.current_dice_roll is None:
        return choice(legal_turn_moves)

    ranked = COMPUTER_RANKING_ENGINE.rank_moves(
        board_state_before_move=game.board_state,
        dice_roll=game.current_dice_roll,
        player_color=game.current_turn,
        deduplicate_final_states=False,
    )

    if not ranked.candidates or ranked.best_move is None:
        return choice(legal_turn_moves)

    def _pick_if_legal(candidate: TurnMove | None) -> TurnMove | None:
        if candidate is None:
            return None
        for legal in legal_turn_moves:
            if legal.moves == candidate.moves:
                return legal
        return None

    if difficulty == ComputerDifficulty.INTERMEDIATE:
        picked = _pick_if_legal(ranked.best_move.move)
        return picked if picked is not None else choice(legal_turn_moves)

    if difficulty == ComputerDifficulty.ADVANCED:
        top_two = [candidate.move for candidate in ranked.candidates[:2]]
        legal_top_two = [move for move in top_two if _pick_if_legal(move) is not None]
        if legal_top_two:
            return _pick_if_legal(choice(legal_top_two)) or choice(legal_turn_moves)
        return choice(legal_turn_moves)

    picked = _pick_if_legal(ranked.best_move.move)
    return picked if picked is not None else choice(legal_turn_moves)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/lobbies", response_model=CreateLobbyResponse, status_code=201)
def create_lobby(request: CreateLobbyRequest | None = None) -> CreateLobbyResponse:
    request = request or CreateLobbyRequest()
    if request.match_length not in (1, 3, 5, 7, 9):
        raise HTTPException(status_code=400, detail="match_length must be one of 1,3,5,7,9.")
    lobby_code = _generate_lobby_code()
    host_player_id = str(uuid4())
    ONLINE_LOBBIES[lobby_code] = OnlineLobby(
        lobby_code=lobby_code,
        host_player_id=host_player_id,
        match_length=request.match_length,
    )
    return CreateLobbyResponse(
        lobby_code=lobby_code,
        player_id=host_player_id,
        player_color=PlayerColor.WHITE,
        game_id=None,
        status="WAITING_FOR_OPPONENT",
    )


@app.get("/lobbies/{lobby_code}", response_model=LobbyStatusResponse)
def get_lobby_status(lobby_code: str) -> LobbyStatusResponse:
    lobby = ONLINE_LOBBIES.get(lobby_code.upper())
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found.")

    game_ready = lobby.game_id is not None
    return LobbyStatusResponse(
        lobby_code=lobby.lobby_code,
        game_id=lobby.game_id,
        host_joined=True,
        guest_joined=lobby.guest_player_id is not None,
        status="GAME_READY" if game_ready else "WAITING_FOR_OPPONENT",
    )


@app.post("/lobbies/{lobby_code}/join", response_model=JoinLobbyResponse)
def join_lobby(lobby_code: str, request: JoinLobbyRequest | None = None) -> JoinLobbyResponse:
    lobby = ONLINE_LOBBIES.get(lobby_code.upper())
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found.")

    request = request or JoinLobbyRequest()
    existing_player_id = request.player_id

    if existing_player_id == lobby.host_player_id:
        if lobby.game_id is None:
            raise HTTPException(
                status_code=400,
                detail="Lobby is waiting for opponent. Share the code with a second player.",
            )
        return JoinLobbyResponse(
            lobby_code=lobby.lobby_code,
            game_id=lobby.game_id,
            player_id=lobby.host_player_id,
            player_color=PlayerColor.WHITE,
            status="JOINED",
        )

    if existing_player_id is not None and existing_player_id == lobby.guest_player_id:
        if lobby.game_id is None:
            raise HTTPException(status_code=400, detail="Game is still being prepared.")
        return JoinLobbyResponse(
            lobby_code=lobby.lobby_code,
            game_id=lobby.game_id,
            player_id=lobby.guest_player_id,
            player_color=PlayerColor.BLACK,
            status="JOINED",
        )

    if lobby.guest_player_id is None:
        lobby.guest_player_id = str(uuid4())
        session = _create_online_game_from_lobby(lobby)
        return JoinLobbyResponse(
            lobby_code=lobby.lobby_code,
            game_id=session.game_id,
            player_id=lobby.guest_player_id,
            player_color=PlayerColor.BLACK,
            status="JOINED",
        )

    raise HTTPException(status_code=409, detail="Lobby already has two players.")


@app.post("/games", response_model=GameStateResponse, status_code=201)
def create_game(request: CreateGameRequest) -> GameStateResponse:
    if request.mode != GameMode.VS_COMPUTER and request.computer_difficulty is not None:
        raise HTTPException(
            status_code=400,
            detail="computer_difficulty can only be provided for VS_COMPUTER mode.",
        )

    if request.match_length not in (1, 3, 5, 7, 9):
        raise HTTPException(status_code=400, detail="match_length must be one of 1,3,5,7,9.")

    game_id = str(uuid4())
    game = GameState.new_game(
        game_id=game_id,
        mode=request.mode,
        computer_difficulty=request.computer_difficulty,
        match_length=request.match_length,
    )
    _initialize_opening_roll(game)
    _progress_computer_turn(game)
    IN_MEMORY_GAMES[game_id] = game
    GAME_MOVE_HISTORY[game_id] = []
    return _serialize_game_state(game)


@app.post("/games/{game_id}/cube/offer", response_model=GameStateResponse)
async def offer_double(game_id: str, request: CubeActionRequest) -> GameStateResponse:
    game = _get_game_or_404(game_id)
    if game.winner is not None:
        raise HTTPException(status_code=400, detail="Match is already finished.")
    if request.player != game.current_turn:
        raise HTTPException(status_code=400, detail="Only current player may offer double.")
    if game.cube_offered_by is not None:
        raise HTTPException(status_code=400, detail="A cube offer is already pending.")
    if game.current_dice_roll is not None:
        raise HTTPException(status_code=400, detail="Offer double before rolling dice.")
    if game.cube_owner is not None and game.cube_owner != request.player:
        raise HTTPException(status_code=400, detail="You do not own the cube.")
    game.cube_offered_by = request.player

    # Auto-respond when the opponent is the computer.
    if game.mode == GameMode.VS_COMPUTER and BoardState.opponent(request.player) == COMPUTER_PLAYER:
        computer_action = _choose_computer_cube_action(game)
        if computer_action == "accept":
            game.cube_value *= 2
            game.cube_owner = COMPUTER_PLAYER
            game.cube_offered_by = None
        else:
            points_won = game.cube_value
            _set_score_for(game, request.player, _score_for(game, request.player) + points_won)
            game.cube_offered_by = None
            if _score_for(game, request.player) >= game.match_length:
                game.winner = request.player
            else:
                _start_next_game_in_match(game, starting_player=request.player)

    response = _serialize_game_state(game)
    await BROADCASTS.broadcast_game_state(game)
    return response


@app.post("/games/{game_id}/cube/respond", response_model=GameStateResponse)
async def respond_double(game_id: str, request: CubeActionRequest) -> GameStateResponse:
    game = _get_game_or_404(game_id)
    if game.cube_offered_by is None:
        raise HTTPException(status_code=400, detail="No pending cube offer.")
    if request.action not in ("accept", "reject"):
        raise HTTPException(status_code=400, detail="action must be 'accept' or 'reject'.")
    offering_player = game.cube_offered_by
    responding_player = BoardState.opponent(offering_player)
    if request.player != responding_player:
        raise HTTPException(status_code=400, detail="Only opponent may respond to cube offer.")

    if request.action == "accept":
        game.cube_value *= 2
        game.cube_owner = responding_player
        game.cube_offered_by = None
        response = _serialize_game_state(game)
        await BROADCASTS.broadcast_game_state(game)
        return response

    # reject
    points_won = game.cube_value
    _set_score_for(game, offering_player, _score_for(game, offering_player) + points_won)
    game.cube_offered_by = None
    if _score_for(game, offering_player) >= game.match_length:
        game.winner = offering_player
    else:
        _start_next_game_in_match(game, starting_player=offering_player)
    response = _serialize_game_state(game)
    await BROADCASTS.broadcast_game_state(game)
    return response


@app.get("/games/{game_id}", response_model=GameStateResponse)
def get_game(game_id: str) -> GameStateResponse:
    game = _get_game_or_404(game_id)
    _progress_computer_turn(game)
    return _serialize_game_state(game)


@app.post("/games/{game_id}/roll", response_model=RollDiceResponse)
async def roll_dice(game_id: str, player_id: str | None = None) -> RollDiceResponse:
    game = _get_game_or_404(game_id)

    if game.winner is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Game is over. Winner is {game.winner.value}.",
        )

    if game.mode == GameMode.VS_COMPUTER and game.current_turn == COMPUTER_PLAYER:
        raise HTTPException(
            status_code=400,
            detail="Computer rolls automatically during its turn.",
        )
    if game.mode == GameMode.ONLINE_MULTIPLAYER:
        _require_online_player(game, player_id=player_id, require_current_turn=True)
    if game.current_dice_roll is not None:
        raise HTTPException(
            status_code=400,
            detail="Dice have already been rolled for the current turn.",
        )
    if game.cube_offered_by is not None:
        raise HTTPException(status_code=400, detail="Resolve pending cube offer first.")

    game.current_dice_roll = DiceRoll(die_1=randint(1, 6), die_2=randint(1, 6))
    await BROADCASTS.broadcast_game_state(game)
    return RollDiceResponse(
        game_id=game.game_id,
        player=game.current_turn,
        dice_roll=DiceRollModel(
            die_1=game.current_dice_roll.die_1, die_2=game.current_dice_roll.die_2
        ),
    )


@app.post("/games/{game_id}/move", response_model=GameStateResponse)
async def apply_turn_move(
    game_id: str, turn_move: TurnMoveModel, player_id: str | None = None
) -> GameStateResponse:
    game = _get_game_or_404(game_id)

    if game.winner is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Game is over. Winner is {game.winner.value}.",
        )

    if game.current_dice_roll is None:
        raise HTTPException(
            status_code=400,
            detail="Cannot apply move before rolling dice for the current turn.",
        )
    if game.cube_offered_by is not None:
        raise HTTPException(status_code=400, detail="Resolve pending cube offer first.")

    if game.mode == GameMode.VS_COMPUTER and game.current_turn == COMPUTER_PLAYER:
        raise HTTPException(
            status_code=400,
            detail="It is currently the computer's turn.",
        )
    if game.mode == GameMode.ONLINE_MULTIPLAYER:
        player_color = _require_online_player(
            game, player_id=player_id, require_current_turn=True
        )
        if turn_move.player != player_color:
            raise HTTPException(
                status_code=400,
                detail=f"Turn move player does not match authenticated player ({player_color.value}).",
            )

    if turn_move.player != game.current_turn:
        raise HTTPException(
            status_code=400,
            detail=(
                "Turn move player does not match current turn. "
                f"Expected {game.current_turn.value}."
            ),
        )

    if not _dice_rolls_match(turn_move.dice_roll, game.current_dice_roll):
        raise HTTPException(
            status_code=400,
            detail=(
                "Submitted dice roll does not match current turn roll. "
                f"Expected ({game.current_dice_roll.die_1}, {game.current_dice_roll.die_2})."
            ),
        )

    board_state_before_move = game.board_state.copy()
    dice_roll_before_move = DiceRoll(
        die_1=game.current_dice_roll.die_1,
        die_2=game.current_dice_roll.die_2,
    )

    legal_turn_moves_for_display = game.board_state.generate_legal_turn_moves(
        player=game.current_turn, dice_roll=game.current_dice_roll
    )
    all_legal_turn_move_orders = game.board_state.generate_legal_turn_moves(
        player=game.current_turn,
        dice_roll=game.current_dice_roll,
        deduplicate_final_states=False,
    )
    if not all_legal_turn_move_orders:
        requested_turn = TurnMove(
            player=turn_move.player,
            dice_roll=dice_roll_before_move,
            moves=[],
        )
        if turn_move.moves:
            raise HTTPException(
                status_code=400,
                detail="No legal moves are available for the current player and dice roll.",
            )

        post_move_analysis = _build_post_move_analysis(
            board_state_before_move=board_state_before_move,
            dice_roll=dice_roll_before_move,
            player=turn_move.player,
            your_move=requested_turn,
            game=game,
        )
        _apply_turn_and_advance(game, requested_turn)
        _record_turn_history_entry(
            game=game,
            player=requested_turn.player,
            dice_roll=dice_roll_before_move,
            move_played=requested_turn,
            board_before=board_state_before_move,
            board_after=game.board_state.copy(),
            analysis_result=post_move_analysis,
        )
        response = _serialize_game_state(game, post_move_analysis=post_move_analysis)
        await BROADCASTS.broadcast_game_state(game, post_move_analysis=post_move_analysis)
        return response

    try:
        requested_moves = [
            SingleCheckerMove(
                player=turn_move.player,
                from_point=move.from_point,
                to_point=move.to_point,
                from_bar=move.from_bar,
                to_borne_off=move.to_borne_off,
            )
            for move in turn_move.moves
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid move payload: {exc}") from exc

    requested_turn = TurnMove(
        player=turn_move.player,
        dice_roll=dice_roll_before_move,
        moves=requested_moves,
    )

    is_legal = any(
        legal_turn.moves == requested_turn.moves
        for legal_turn in all_legal_turn_move_orders
    )
    if not is_legal:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Submitted turn move is not legal for the current board and dice.",
                "legal_moves": [
                    _serialize_turn_move(legal_turn).model_dump()
                    for legal_turn in legal_turn_moves_for_display
                ],
            },
        )

    post_move_analysis = _build_post_move_analysis(
        board_state_before_move=board_state_before_move,
        dice_roll=dice_roll_before_move,
        player=turn_move.player,
        your_move=requested_turn,
        game=game,
    )

    try:
        _apply_turn_and_advance(game, requested_turn)
    except MoveValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Move validation failed: {exc}") from exc

    _record_turn_history_entry(
        game=game,
        player=requested_turn.player,
        dice_roll=dice_roll_before_move,
        move_played=requested_turn,
        board_before=board_state_before_move,
        board_after=game.board_state.copy(),
        analysis_result=post_move_analysis,
    )

    response = _serialize_game_state(game, post_move_analysis=post_move_analysis)
    await BROADCASTS.broadcast_game_state(game, post_move_analysis=post_move_analysis)
    return response


@app.post("/games/{game_id}/computer/step", response_model=GameStateResponse)
async def step_computer_turn(game_id: str) -> GameStateResponse:
    game = _get_game_or_404(game_id)
    if game.mode != GameMode.VS_COMPUTER:
        raise HTTPException(
            status_code=400,
            detail="Computer stepping is available only in VS_COMPUTER mode.",
        )

    # Self-heal stalled computer turns by allowing multiple state transitions
    # in one step call when timing gates have already elapsed.
    for _ in range(4):
        before = (
            game.current_turn,
            game.computer_turn_phase,
            game.current_dice_roll.die_1 if game.current_dice_roll else None,
            game.current_dice_roll.die_2 if game.current_dice_roll else None,
            game.turn_number,
        )
        _progress_computer_turn(game)
        after = (
            game.current_turn,
            game.computer_turn_phase,
            game.current_dice_roll.die_1 if game.current_dice_roll else None,
            game.current_dice_roll.die_2 if game.current_dice_roll else None,
            game.turn_number,
        )
        if after == before:
            break
        if game.current_turn != COMPUTER_PLAYER:
            break
    response = _serialize_game_state(game)
    await BROADCASTS.broadcast_game_state(game)
    return response


@app.post("/games/{game_id}/analysis", response_model=MoveAnalysisResponse)
def analyze_game_position(
    game_id: str, request: AnalyzePositionRequest | None = None
) -> MoveAnalysisResponse:
    game = _get_game_or_404(game_id)
    request = request or AnalyzePositionRequest()

    player = request.player or game.current_turn
    dice = request.dice_roll or _serialize_dice_roll(game.current_dice_roll)

    if dice is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Dice are required for move analysis. "
                "Either roll dice first or provide dice_roll in request body."
            ),
        )

    analysis = ENGINE.rank_moves(
        board_state_before_move=game.board_state,
        dice_roll=DiceRoll(die_1=dice.die_1, die_2=dice.die_2),
        player_color=player,
    )
    analysis = _apply_match_context_to_analysis(analysis, game=game, player=player)
    return _serialize_move_analysis_result(analysis)


@app.get("/games/{game_id}/legal-moves", response_model=LegalMovesResponse)
def get_legal_moves(game_id: str) -> LegalMovesResponse:
    game = _get_game_or_404(game_id)
    _progress_computer_turn(game)

    if game.winner is not None:
        return LegalMovesResponse(moves=[])

    if game.current_dice_roll is None:
        return LegalMovesResponse(moves=[])

    legal_turns = game.board_state.generate_legal_turn_moves(
        player=game.current_turn,
        dice_roll=game.current_dice_roll,
        deduplicate_final_states=False,
    )
    return LegalMovesResponse(
        moves=[_serialize_turn_move(turn_move) for turn_move in legal_turns]
    )


@app.websocket("/ws/games/{game_id}")
async def game_updates_socket(websocket: WebSocket, game_id: str) -> None:
    game = IN_MEMORY_GAMES.get(game_id)
    if game is None:
        await websocket.close(code=4404)
        return

    await BROADCASTS.connect(game_id, websocket)
    try:
        await websocket.send_json(
            {
                "type": "game_state",
                "game": _serialize_game_state(game).model_dump(mode="json"),
            }
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        BROADCASTS.disconnect(game_id, websocket)
    except Exception:
        BROADCASTS.disconnect(game_id, websocket)


# ── Win/loss stats endpoints ─────────────────────────────────────────────
# Persist per-client match outcomes in SQLite. The frontend generates a
# UUID-style client_id on first visit and includes it in the URL so users
# stay anonymous while still getting a stable record across reloads.


class StatsRecordRequest(BaseModel):
    game_id: str
    mode: str = Field(..., description="VS_COMPUTER | ONLINE_MULTIPLAYER | LOCAL")
    outcome: str = Field(..., description="win | loss | played")


@app.get("/stats/{client_id}")
def get_stats(client_id: str) -> dict:
    return stats_db.get_stats(client_id)


@app.post("/stats/{client_id}/record")
def record_stats(client_id: str, body: StatsRecordRequest) -> dict:
    if body.mode not in ("VS_COMPUTER", "ONLINE_MULTIPLAYER", "LOCAL"):
        raise HTTPException(status_code=422, detail=f"Unknown mode: {body.mode}")
    if body.outcome not in ("win", "loss", "played"):
        raise HTTPException(status_code=422, detail=f"Unknown outcome: {body.outcome}")
    inserted = stats_db.record_outcome(
        client_id=client_id,
        game_id=body.game_id,
        mode=body.mode,  # type: ignore[arg-type]
        outcome=body.outcome,  # type: ignore[arg-type]
    )
    return {"recorded": inserted, "stats": stats_db.get_stats(client_id)}


@app.delete("/stats/{client_id}")
def reset_stats(client_id: str) -> dict:
    deleted = stats_db.reset_client(client_id)
    return {"deleted": deleted, "stats": stats_db.get_stats(client_id)}
