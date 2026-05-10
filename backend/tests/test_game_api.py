from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from backend.app.domain import (
    BoardState,
    ComputerDifficulty,
    DiceRoll,
    GameMode,
    GameState,
    PlayerColor,
    Point,
    SingleCheckerMove,
    TurnMove,
)
from backend.app.engine import EvaluationResult, MoveAnalysisResult, MoveCandidate
from backend.app.main import (
    GAME_MOVE_HISTORY,
    IN_MEMORY_GAMES,
    ONLINE_GAME_SESSIONS,
    ONLINE_LOBBIES,
    app,
)
import backend.app.main as main_module

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_in_memory_state() -> None:
    IN_MEMORY_GAMES.clear()
    ONLINE_LOBBIES.clear()
    ONLINE_GAME_SESSIONS.clear()
    GAME_MOVE_HISTORY.clear()


def _dice_sequence(*values: int) -> Iterator[int]:
    for value in values:
        yield value


def test_create_and_get_game() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    assert create_response.status_code == 201

    created = create_response.json()
    game_id = created["game_id"]
    assert created["mode"] == "LOCAL"
    assert created["current_turn"] in ("WHITE", "BLACK")
    assert created["current_dice_roll"] is not None

    get_response = client.get(f"/games/{game_id}")
    assert get_response.status_code == 200
    fetched = get_response.json()
    assert fetched["game_id"] == game_id
    assert fetched["mode"] == "LOCAL"


def test_roll_sets_current_player_dice(monkeypatch) -> None:
    sequence = _dice_sequence(3, 6)
    monkeypatch.setattr("backend.app.main.randint", lambda _a, _b: next(sequence))

    create_response = client.post("/games", json={"mode": "VS_COMPUTER"})
    game_id = create_response.json()["game_id"]

    game_response = client.get(f"/games/{game_id}")
    assert game_response.status_code == 200
    body = game_response.json()
    assert body["current_turn"] == "BLACK"
    assert body["current_dice_roll"] == {"die_1": 6, "die_2": 3}


def test_move_applies_legal_turn_and_switches_turn(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    move_payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 1, "die_2": 2},
        "moves": [
            {"from_point": 24, "to_point": 23},
            {"from_point": 23, "to_point": 21},
        ],
    }
    move_response = client.post(f"/games/{game_id}/move", json=move_payload)
    assert move_response.status_code == 200

    body = move_response.json()
    assert body["current_turn"] == "BLACK"
    assert body["turn_number"] == 2
    assert body["current_dice_roll"] is None
    assert len(body["turn_history"]) == 1
    assert len(body["move_history"]) == 1
    assert body["move_history"][0]["player"] == "WHITE"
    assert body["move_history"][0]["board_before"]["points"][23]["checker_count"] == 2
    assert body["move_history"][0]["board_after"]["points"][20]["checker_count"] == 1
    assert body["move_history"][0]["timestamp"]


def test_move_before_roll_returns_validation_error() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_dice_roll = None

    move_payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 1, "die_2": 2},
        "moves": [{"from_point": 24, "to_point": 23}],
    }
    move_response = client.post(f"/games/{game_id}/move", json=move_payload)
    assert move_response.status_code == 400
    assert "Cannot apply move before rolling dice" in move_response.json()["detail"]


def test_illegal_turn_move_returns_legal_move_options(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    illegal_payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 1, "die_2": 2},
        "moves": [
            {"from_point": 1, "to_point": 2},
            {"from_point": 2, "to_point": 4},
        ],
    }
    move_response = client.post(f"/games/{game_id}/move", json=illegal_payload)
    assert move_response.status_code == 400

    detail = move_response.json()["detail"]
    assert detail["message"] == "Submitted turn move is not legal for the current board and dice."
    assert isinstance(detail["legal_moves"], list)
    assert detail["legal_moves"]


def test_move_accepts_alternative_legal_order_not_in_deduped_display() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]

    board = BoardState.empty()
    board.points[5] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 6
    board.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1
    game.board_state = board
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=6, die_2=1)

    payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 6, "die_2": 1},
        "moves": [
            {"from_point": 1, "to_borne_off": True},
            {"from_point": 6, "to_borne_off": True},
        ],
    }

    move_response = client.post(f"/games/{game_id}/move", json=payload)
    assert move_response.status_code == 200
    response_body = move_response.json()
    assert response_body["board_state"]["borne_off_counts"]["WHITE"] == 2


def test_move_endpoint_accepts_pass_when_no_legal_moves_exist() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]

    board = BoardState.empty()
    board.bar_counts[PlayerColor.WHITE] = 1
    board.points[23] = Point(owner=PlayerColor.BLACK, checker_count=2)  # point 24
    board.points[22] = Point(owner=PlayerColor.BLACK, checker_count=2)  # point 23
    game.board_state = board
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    move_response = client.post(
        f"/games/{game_id}/move",
        json={
            "player": "WHITE",
            "dice_roll": {"die_1": 1, "die_2": 2},
            "moves": [],
        },
    )
    assert move_response.status_code == 200
    body = move_response.json()
    assert body["current_turn"] == "BLACK"
    assert body["turn_number"] == 2
    assert body["current_dice_roll"] is None
    assert body["turn_history"][-1]["moves"] == []
    assert body["post_move_analysis"]["equity_loss"] == 0.0


def test_vs_computer_auto_plays_after_human_turn(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "VS_COMPUTER"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    dice_sequence = _dice_sequence(3, 4)
    monkeypatch.setattr("backend.app.main.randint", lambda _a, _b: next(dice_sequence))
    monkeypatch.setattr("backend.app.main.choice", lambda options: options[0])

    player_move_payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 1, "die_2": 2},
        "moves": [
            {"from_point": 24, "to_point": 23},
            {"from_point": 23, "to_point": 21},
        ],
    }
    time_sequence = _dice_sequence(100, 101, 102, 103, 104, 105, 106)
    monkeypatch.setattr("backend.app.main.monotonic", lambda: next(time_sequence))

    move_response = client.post(f"/games/{game_id}/move", json=player_move_payload)
    assert move_response.status_code == 200
    staged = move_response.json()
    assert staged["current_turn"] == "BLACK"
    assert staged["computer_turn_phase"] in (None, "IDLE", "THINKING", "ROLLING")
    assert staged["current_dice_roll"] is None

    body = staged
    for _ in range(6):
        step_response = client.post(f"/games/{game_id}/computer/step")
        assert step_response.status_code == 200
        body = step_response.json()
        if body["current_turn"] == "WHITE":
            break
    assert body["current_turn"] == "WHITE"
    assert body["turn_number"] == 3
    assert body["current_dice_roll"] is None
    assert len(body["turn_history"]) == 2
    assert body["turn_history"][0]["player"] == "WHITE"
    assert body["turn_history"][1]["player"] == "BLACK"
    assert body["turn_history"][1]["dice_roll"] == {"die_1": 3, "die_2": 4}


def test_roll_endpoint_rejects_manual_roll_on_computer_turn() -> None:
    create_response = client.post("/games", json={"mode": "VS_COMPUTER"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]

    game.current_turn = PlayerColor.BLACK
    game.current_dice_roll = None

    roll_response = client.post(f"/games/{game_id}/roll")
    assert roll_response.status_code == 400
    assert roll_response.json()["detail"] == "Computer rolls automatically during its turn."


def test_analysis_endpoint_uses_current_turn_and_current_dice(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    analysis_response = client.post(f"/games/{game_id}/analysis", json={})
    assert analysis_response.status_code == 200

    body = analysis_response.json()
    assert "best_move" in body
    assert isinstance(body["candidates"], list)
    assert body["candidates"]
    assert body["best_move"]["equity"] == body["candidates"][0]["equity"]
    assert "ranking_method" in body
    assert "rollout_used" in body


def test_analysis_endpoint_accepts_explicit_dice_roll() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]

    analysis_response = client.post(
        f"/games/{game_id}/analysis",
        json={"player": "WHITE", "dice_roll": {"die_1": 3, "die_2": 5}},
    )
    assert analysis_response.status_code == 200
    body = analysis_response.json()
    assert isinstance(body["candidates"], list)
    assert "ranking_method" in body


def test_move_response_includes_post_move_analysis(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=2, die_2=1)

    def fake_rank_moves(
        board_state_before_move,
        dice_roll,
        player_color,
        deduplicate_final_states=True,
    ):
        _ = board_state_before_move
        _ = deduplicate_final_states
        best_move = TurnMove(
            player=player_color,
            dice_roll=dice_roll,
            moves=[
                SingleCheckerMove(player=player_color, from_point=24, to_point=23),
                SingleCheckerMove(player=player_color, from_point=23, to_point=21),
            ],
        )
        user_move = TurnMove(
            player=player_color,
            dice_roll=dice_roll,
            moves=[
                SingleCheckerMove(player=player_color, from_point=24, to_point=22),
                SingleCheckerMove(player=player_color, from_point=22, to_point=21),
            ],
        )
        best_eval = EvaluationResult(
            equity=0.2,
            win_probability=0.6,
            gammon_win_probability=0.1,
            backgammon_win_probability=0.02,
            lose_probability=0.4,
            gammon_lose_probability=0.05,
            backgammon_lose_probability=0.01,
        )
        user_eval = EvaluationResult(
            equity=0.12,
            win_probability=0.54,
            gammon_win_probability=0.08,
            backgammon_win_probability=0.015,
            lose_probability=0.46,
            gammon_lose_probability=0.06,
            backgammon_lose_probability=0.012,
        )
        best_candidate = MoveCandidate(
            move=best_move,
            resulting_board=BoardState.empty(),
            evaluation=best_eval,
            equity=best_eval.equity,
        )
        user_candidate = MoveCandidate(
            move=user_move,
            resulting_board=BoardState.empty(),
            evaluation=user_eval,
            equity=user_eval.equity,
        )
        return MoveAnalysisResult(best_move=best_candidate, candidates=[best_candidate, user_candidate])

    monkeypatch.setattr("backend.app.main.ENGINE.rank_moves", fake_rank_moves)

    move_payload = {
        "player": "WHITE",
        "dice_roll": {"die_1": 2, "die_2": 1},
        "moves": [
            {"from_point": 24, "to_point": 22},
            {"from_point": 22, "to_point": 21},
        ],
    }
    move_response = client.post(f"/games/{game_id}/move", json=move_payload)
    assert move_response.status_code == 200

    post_move_analysis = move_response.json()["post_move_analysis"]
    assert post_move_analysis is not None
    assert post_move_analysis["best_move"]["moves"] == [
        {
            "player": "WHITE",
            "from_point": 24,
            "to_point": 23,
            "from_bar": False,
            "to_borne_off": False,
        },
        {
            "player": "WHITE",
            "from_point": 23,
            "to_point": 21,
            "from_bar": False,
            "to_borne_off": False,
        },
    ]
    assert post_move_analysis["your_move"]["moves"] == [
        {
            "player": "WHITE",
            "from_point": 24,
            "to_point": 22,
            "from_bar": False,
            "to_borne_off": False,
        },
        {
            "player": "WHITE",
            "from_point": 22,
            "to_point": 21,
            "from_bar": False,
            "to_borne_off": False,
        },
    ]
    assert abs(post_move_analysis["equity_loss"] - 0.08) < 1e-9
    assert post_move_analysis["classification"] == "ERROR"
    assert "ranking_method" in post_move_analysis


def test_post_move_analysis_matches_equivalent_final_board_when_order_differs(
    monkeypatch,
) -> None:
    IN_MEMORY_GAMES.clear()

    create_response = client.post("/games", json={"mode": "LOCAL"})
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]

    board = BoardState.empty()
    board.points[7] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 8
    board.points[6] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 7
    game.board_state = board
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=4, die_2=1)

    submitted_move = TurnMove(
        player=PlayerColor.WHITE,
        dice_roll=DiceRoll(4, 1),
        moves=[
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=8, to_point=7),
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=7, to_point=3),
        ],
    )
    equivalent_ranked_move = TurnMove(
        player=PlayerColor.WHITE,
        dice_roll=DiceRoll(4, 1),
        moves=[
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=7, to_point=3),
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=8, to_point=7),
        ],
    )

    best_move = TurnMove(
        player=PlayerColor.WHITE,
        dice_roll=DiceRoll(4, 1),
        moves=[
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=8, to_point=4),
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=7, to_point=6),
        ],
    )

    submitted_board = board.copy()
    for move in submitted_move.moves:
        submitted_board.apply_single_checker_move(move)

    best_board = board.copy()
    for move in best_move.moves:
        best_board.apply_single_checker_move(move)

    best_eval = EvaluationResult(
        equity=0.25,
        win_probability=0.6,
        gammon_win_probability=0.1,
        backgammon_win_probability=0.02,
        lose_probability=0.4,
        gammon_lose_probability=0.05,
        backgammon_lose_probability=0.01,
    )
    equivalent_eval = EvaluationResult(
        equity=0.11,
        win_probability=0.53,
        gammon_win_probability=0.07,
        backgammon_win_probability=0.01,
        lose_probability=0.47,
        gammon_lose_probability=0.06,
        backgammon_lose_probability=0.01,
    )

    def fake_rank_moves(*_args, **_kwargs):
        best_candidate = MoveCandidate(
            move=best_move,
            resulting_board=best_board,
            evaluation=best_eval,
            equity=best_eval.equity,
        )
        equivalent_candidate = MoveCandidate(
            move=equivalent_ranked_move,
            resulting_board=submitted_board,
            evaluation=equivalent_eval,
            equity=equivalent_eval.equity,
        )
        return MoveAnalysisResult(
            best_move=best_candidate,
            candidates=[best_candidate, equivalent_candidate],
        )

    def fail_if_fallback_eval_called(*_args, **_kwargs):
        raise AssertionError(
            "evaluate_position fallback should not be used when equivalent final board exists"
        )

    monkeypatch.setattr("backend.app.main.ENGINE.rank_moves", fake_rank_moves)
    monkeypatch.setattr("backend.app.main.ENGINE.evaluate_position", fail_if_fallback_eval_called)

    move_response = client.post(
        f"/games/{game_id}/move",
        json={
            "player": "WHITE",
            "dice_roll": {"die_1": 4, "die_2": 1},
            "moves": [
                {"from_point": 8, "to_point": 7},
                {"from_point": 7, "to_point": 3},
            ],
        },
    )
    assert move_response.status_code == 200

    post_move_analysis = move_response.json()["post_move_analysis"]
    assert post_move_analysis is not None
    assert abs(post_move_analysis["your_equity"] - 0.11) < 1e-9
    assert abs(post_move_analysis["equity_loss"] - 0.14) < 1e-9


def test_create_vs_computer_game_accepts_and_returns_difficulty() -> None:
    IN_MEMORY_GAMES.clear()

    create_response = client.post(
        "/games",
        json={"mode": "VS_COMPUTER", "computer_difficulty": "EXPERT"},
    )
    assert create_response.status_code == 201
    body = create_response.json()
    assert body["mode"] == "VS_COMPUTER"
    assert body["computer_difficulty"] == "EXPERT"


def test_create_vs_computer_game_defaults_to_beginner_difficulty() -> None:
    IN_MEMORY_GAMES.clear()

    create_response = client.post("/games", json={"mode": "VS_COMPUTER"})
    assert create_response.status_code == 201
    assert create_response.json()["computer_difficulty"] == "BEGINNER"


def test_create_non_vs_game_rejects_computer_difficulty() -> None:
    IN_MEMORY_GAMES.clear()

    create_response = client.post(
        "/games",
        json={"mode": "LOCAL", "computer_difficulty": "ADVANCED"},
    )
    assert create_response.status_code == 400
    assert (
        create_response.json()["detail"]
        == "computer_difficulty can only be provided for VS_COMPUTER mode."
    )


def test_cube_offer_vs_computer_auto_accepts_when_position_is_take(monkeypatch) -> None:
    create_response = client.post(
        "/games",
        json={"mode": "VS_COMPUTER", "match_length": 5, "computer_difficulty": "EXPERT"},
    )
    game_id = create_response.json()["game_id"]

    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = None
    game.cube_value = 1

    def fake_eval(_board: BoardState, _player: PlayerColor) -> EvaluationResult:
        return EvaluationResult(
            equity=0.05,
            win_probability=0.52,
            gammon_win_probability=0.08,
            backgammon_win_probability=0.01,
            lose_probability=0.48,
            gammon_lose_probability=0.07,
            backgammon_lose_probability=0.01,
        )

    monkeypatch.setattr("backend.app.main.ENGINE.evaluate_position", fake_eval)

    response = client.post(
        f"/games/{game_id}/cube/offer",
        json={"player": "WHITE"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["cube_offered_by"] is None
    assert body["cube_value"] == 2
    assert body["cube_owner"] == "BLACK"


def test_cube_offer_vs_computer_auto_rejects_when_position_is_pass(monkeypatch) -> None:
    create_response = client.post(
        "/games",
        json={"mode": "VS_COMPUTER", "match_length": 5, "computer_difficulty": "EXPERT"},
    )
    game_id = create_response.json()["game_id"]

    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = None
    game.cube_value = 1
    game.score_white = 0
    game.score_black = 0

    def fake_eval(_board: BoardState, _player: PlayerColor) -> EvaluationResult:
        return EvaluationResult(
            equity=-0.60,
            win_probability=0.22,
            gammon_win_probability=0.03,
            backgammon_win_probability=0.00,
            lose_probability=0.78,
            gammon_lose_probability=0.18,
            backgammon_lose_probability=0.03,
        )

    monkeypatch.setattr("backend.app.main.ENGINE.evaluate_position", fake_eval)

    response = client.post(
        f"/games/{game_id}/cube/offer",
        json={"player": "WHITE"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["cube_offered_by"] is None
    assert body["cube_value"] == 1
    assert body["score"]["WHITE"] == 1


def test_choose_computer_turn_beginner_uses_random_legal_move(monkeypatch) -> None:
    game = GameState.new_game(
        game_id="g-beginner",
        mode=GameMode.VS_COMPUTER,
        starting_player=PlayerColor.BLACK,
        computer_difficulty=ComputerDifficulty.BEGINNER,
    )
    game.current_turn = PlayerColor.BLACK
    game.current_dice_roll = DiceRoll(die_1=1, die_2=2)

    first = TurnMove(player=PlayerColor.BLACK, dice_roll=game.current_dice_roll, moves=[])
    second = TurnMove(player=PlayerColor.BLACK, dice_roll=game.current_dice_roll, moves=[])

    def fail_if_rank_called(*_args, **_kwargs):
        raise AssertionError("ranking engine should not be used for BEGINNER")

    monkeypatch.setattr(main_module.COMPUTER_RANKING_ENGINE, "rank_moves", fail_if_rank_called)
    monkeypatch.setattr("backend.app.main.choice", lambda options: options[-1])

    chosen = main_module._choose_computer_turn(game=game, legal_turn_moves=[first, second])
    assert chosen == second


def test_choose_computer_turn_intermediate_and_expert_use_best_ranked_move(
    monkeypatch,
) -> None:
    for difficulty in (ComputerDifficulty.INTERMEDIATE, ComputerDifficulty.EXPERT):
        game = GameState.new_game(
            game_id=f"g-{difficulty.value.lower()}",
            mode=GameMode.VS_COMPUTER,
            starting_player=PlayerColor.BLACK,
            computer_difficulty=difficulty,
        )
        game.current_turn = PlayerColor.BLACK
        game.current_dice_roll = DiceRoll(die_1=3, die_2=4)

        best = TurnMove(
            player=PlayerColor.BLACK,
            dice_roll=game.current_dice_roll,
            moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=1, to_point=4)],
        )
        other = TurnMove(
            player=PlayerColor.BLACK,
            dice_roll=game.current_dice_roll,
            moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=12, to_point=16)],
        )

        evaluation = EvaluationResult(
            equity=0.1,
            win_probability=0.55,
            gammon_win_probability=0.05,
            backgammon_win_probability=0.01,
            lose_probability=0.45,
            gammon_lose_probability=0.04,
            backgammon_lose_probability=0.005,
        )
        ranked = MoveAnalysisResult(
            best_move=MoveCandidate(
                move=best,
                resulting_board=BoardState.empty(),
                evaluation=evaluation,
                equity=evaluation.equity,
            ),
            candidates=[
                MoveCandidate(
                    move=best,
                    resulting_board=BoardState.empty(),
                    evaluation=evaluation,
                    equity=evaluation.equity,
                ),
                MoveCandidate(
                    move=other,
                    resulting_board=BoardState.empty(),
                    evaluation=evaluation,
                    equity=evaluation.equity - 0.05,
                ),
            ],
        )

        monkeypatch.setattr(
            main_module.COMPUTER_RANKING_ENGINE,
            "rank_moves",
            lambda *_args, **_kwargs: ranked,
        )
        monkeypatch.setattr("backend.app.main.choice", lambda options: options[-1])

        chosen = main_module._choose_computer_turn(
            game=game,
            legal_turn_moves=[other, best],
        )
        assert chosen == best


def test_choose_computer_turn_advanced_delays_and_randomizes_top_two(monkeypatch) -> None:
    game = GameState.new_game(
        game_id="g-advanced",
        mode=GameMode.VS_COMPUTER,
        starting_player=PlayerColor.BLACK,
        computer_difficulty=ComputerDifficulty.ADVANCED,
    )
    game.current_turn = PlayerColor.BLACK
    game.current_dice_roll = DiceRoll(die_1=5, die_2=6)

    best = TurnMove(
        player=PlayerColor.BLACK,
        dice_roll=game.current_dice_roll,
        moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=1, to_point=6)],
    )
    second = TurnMove(
        player=PlayerColor.BLACK,
        dice_roll=game.current_dice_roll,
        moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=12, to_point=18)],
    )
    third = TurnMove(
        player=PlayerColor.BLACK,
        dice_roll=game.current_dice_roll,
        moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=17, to_point=23)],
    )

    evaluation = EvaluationResult(
        equity=0.2,
        win_probability=0.6,
        gammon_win_probability=0.07,
        backgammon_win_probability=0.01,
        lose_probability=0.4,
        gammon_lose_probability=0.03,
        backgammon_lose_probability=0.003,
    )
    ranked = MoveAnalysisResult(
        best_move=MoveCandidate(
            move=best,
            resulting_board=BoardState.empty(),
            evaluation=evaluation,
            equity=evaluation.equity,
        ),
        candidates=[
            MoveCandidate(
                move=best,
                resulting_board=BoardState.empty(),
                evaluation=evaluation,
                equity=0.2,
            ),
            MoveCandidate(
                move=second,
                resulting_board=BoardState.empty(),
                evaluation=evaluation,
                equity=0.19,
            ),
            MoveCandidate(
                move=third,
                resulting_board=BoardState.empty(),
                evaluation=evaluation,
                equity=0.1,
            ),
        ],
    )

    monkeypatch.setattr(
        main_module.COMPUTER_RANKING_ENGINE,
        "rank_moves",
        lambda *_args, **_kwargs: ranked,
    )
    monkeypatch.setattr("backend.app.main.choice", lambda options: options[-1])

    chosen = main_module._choose_computer_turn(
        game=game,
        legal_turn_moves=[third, second, best],
    )
    assert chosen == second


def test_choose_computer_turn_falls_back_when_engine_move_not_legal(monkeypatch) -> None:
    game = GameState.new_game(
        game_id="g-fallback",
        mode=GameMode.VS_COMPUTER,
        starting_player=PlayerColor.BLACK,
        computer_difficulty=ComputerDifficulty.EXPERT,
    )
    game.current_turn = PlayerColor.BLACK
    game.current_dice_roll = DiceRoll(die_1=6, die_2=2)

    legal = TurnMove(
        player=PlayerColor.BLACK,
        dice_roll=game.current_dice_roll,
        moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_bar=True, to_point=6)],
    )
    illegal = TurnMove(
        player=PlayerColor.BLACK,
        dice_roll=game.current_dice_roll,
        moves=[SingleCheckerMove(player=PlayerColor.BLACK, from_point=1, to_point=7)],
    )

    evaluation = EvaluationResult(
        equity=0.1,
        win_probability=0.5,
        gammon_win_probability=0.05,
        backgammon_win_probability=0.005,
        lose_probability=0.5,
        gammon_lose_probability=0.04,
        backgammon_lose_probability=0.004,
    )
    ranked = MoveAnalysisResult(
        best_move=MoveCandidate(
            move=illegal,
            resulting_board=BoardState.empty(),
            evaluation=evaluation,
            equity=evaluation.equity,
        ),
        candidates=[
            MoveCandidate(
                move=illegal,
                resulting_board=BoardState.empty(),
                evaluation=evaluation,
                equity=evaluation.equity,
            )
        ],
    )
    monkeypatch.setattr(
        main_module.COMPUTER_RANKING_ENGINE,
        "rank_moves",
        lambda *_args, **_kwargs: ranked,
    )
    monkeypatch.setattr("backend.app.main.choice", lambda options: options[0])

    chosen = main_module._choose_computer_turn(game=game, legal_turn_moves=[legal])
    assert chosen.moves == legal.moves


def test_create_join_lobby_creates_online_game_and_assigns_colors() -> None:
    create_lobby_response = client.post("/lobbies")
    assert create_lobby_response.status_code == 201
    created = create_lobby_response.json()
    lobby_code = created["lobby_code"]
    white_player_id = created["player_id"]
    assert created["player_color"] == "WHITE"
    assert created["status"] == "WAITING_FOR_OPPONENT"

    status_response = client.get(f"/lobbies/{lobby_code}")
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "WAITING_FOR_OPPONENT"

    join_response = client.post(f"/lobbies/{lobby_code}/join", json={})
    assert join_response.status_code == 200
    joined = join_response.json()
    assert joined["player_color"] == "BLACK"
    assert joined["status"] == "JOINED"
    game_id = joined["game_id"]

    host_join_response = client.post(
        f"/lobbies/{lobby_code}/join", json={"player_id": white_player_id}
    )
    assert host_join_response.status_code == 200
    host_joined = host_join_response.json()
    assert host_joined["game_id"] == game_id
    assert host_joined["player_color"] == "WHITE"

    assert game_id in IN_MEMORY_GAMES
    assert game_id in ONLINE_GAME_SESSIONS
    assert IN_MEMORY_GAMES[game_id].mode == GameMode.ONLINE_MULTIPLAYER


def test_online_roll_enforces_player_identity_and_turn(monkeypatch) -> None:
    create_lobby_response = client.post("/lobbies")
    lobby_code = create_lobby_response.json()["lobby_code"]
    white_player_id = create_lobby_response.json()["player_id"]

    join_response = client.post(f"/lobbies/{lobby_code}/join", json={})
    assert join_response.status_code == 200
    black_player_id = join_response.json()["player_id"]
    game_id = join_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = None

    missing_player_id_roll = client.post(f"/games/{game_id}/roll")
    assert missing_player_id_roll.status_code == 400
    assert "player_id is required" in missing_player_id_roll.json()["detail"]

    wrong_turn_roll = client.post(f"/games/{game_id}/roll", params={"player_id": black_player_id})
    assert wrong_turn_roll.status_code == 403
    assert "currently WHITE's turn" in wrong_turn_roll.json()["detail"]

    dice_sequence = _dice_sequence(2, 5)
    monkeypatch.setattr("backend.app.main.randint", lambda _a, _b: next(dice_sequence))

    valid_roll = client.post(f"/games/{game_id}/roll", params={"player_id": white_player_id})
    assert valid_roll.status_code == 200
    assert valid_roll.json()["dice_roll"] == {"die_1": 2, "die_2": 5}


def test_websocket_endpoint_pushes_game_state_updates(monkeypatch) -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    assert create_response.status_code == 201
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]
    game.current_dice_roll = None

    with client.websocket_connect(f"/ws/games/{game_id}") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "game_state"
        assert initial["game"]["game_id"] == game_id

        dice_sequence = _dice_sequence(4, 6)
        monkeypatch.setattr("backend.app.main.randint", lambda _a, _b: next(dice_sequence))
        roll_response = client.post(f"/games/{game_id}/roll")
        assert roll_response.status_code == 200

        pushed = websocket.receive_json()
        assert pushed["type"] == "game_state"
        assert pushed["game"]["current_dice_roll"] == {"die_1": 4, "die_2": 6}


def test_post_game_review_is_returned_when_game_ends() -> None:
    create_response = client.post("/games", json={"mode": "LOCAL"})
    assert create_response.status_code == 201
    game_id = create_response.json()["game_id"]
    game = IN_MEMORY_GAMES[game_id]

    game.board_state = BoardState.empty()
    game.board_state.borne_off_counts[PlayerColor.WHITE] = 14
    game.board_state.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1
    game.current_turn = PlayerColor.WHITE
    game.current_dice_roll = DiceRoll(die_1=1, die_2=1)

    move_response = client.post(
        f"/games/{game_id}/move",
        json={
            "player": "WHITE",
            "dice_roll": {"die_1": 1, "die_2": 1},
            "moves": [{"from_point": 1, "to_borne_off": True}],
        },
    )
    assert move_response.status_code == 200
    body = move_response.json()
    assert body["winner"] == "WHITE"
    assert body["post_game_review"] is not None
    review = body["post_game_review"]
    assert review["total_moves"] >= 1
    assert "good_moves" in review
    assert "inaccuracies" in review
    assert "errors" in review
    assert "blunders" in review
    assert "total_equity_lost" in review
    assert "average_equity_loss" in review
