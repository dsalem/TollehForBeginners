from backend.app.domain import BoardState, DiceRoll, PlayerColor, Point
from backend.app.engine import DummyEngine, EvaluationResult, OPENING_BOOK_WHITE


def _set_point(
    board: BoardState, point_number: int, owner: PlayerColor, checker_count: int
) -> None:
    board.points[point_number - 1] = Point(owner=owner, checker_count=checker_count)


def test_evaluate_position_prefers_better_structural_position() -> None:
    engine = DummyEngine()

    favorable = BoardState.empty()
    favorable.borne_off_counts[PlayerColor.WHITE] = 6
    favorable.borne_off_counts[PlayerColor.BLACK] = 2
    favorable.bar_counts[PlayerColor.BLACK] = 1
    _set_point(favorable, 3, PlayerColor.WHITE, 2)
    _set_point(favorable, 2, PlayerColor.WHITE, 2)
    _set_point(favorable, 22, PlayerColor.BLACK, 1)

    unfavorable = BoardState.empty()
    unfavorable.borne_off_counts[PlayerColor.WHITE] = 1
    unfavorable.borne_off_counts[PlayerColor.BLACK] = 5
    unfavorable.bar_counts[PlayerColor.WHITE] = 1
    _set_point(unfavorable, 23, PlayerColor.WHITE, 1)
    _set_point(unfavorable, 20, PlayerColor.BLACK, 2)
    _set_point(unfavorable, 19, PlayerColor.BLACK, 2)

    favorable_eval = engine.evaluate_position(favorable, PlayerColor.WHITE)
    unfavorable_eval = engine.evaluate_position(unfavorable, PlayerColor.WHITE)

    assert favorable_eval.equity > unfavorable_eval.equity
    assert favorable_eval.win_probability > unfavorable_eval.win_probability

    for evaluation in (favorable_eval, unfavorable_eval):
        assert 0.0 <= evaluation.win_probability <= 1.0
        assert 0.0 <= evaluation.lose_probability <= 1.0
        assert 0.0 <= evaluation.gammon_win_probability <= 1.0
        assert 0.0 <= evaluation.backgammon_win_probability <= 1.0
        assert 0.0 <= evaluation.gammon_lose_probability <= 1.0
        assert 0.0 <= evaluation.backgammon_lose_probability <= 1.0
        assert abs((evaluation.win_probability + evaluation.lose_probability) - 1.0) < 1e-9


def test_rank_moves_returns_candidates_sorted_by_equity_desc() -> None:
    engine = DummyEngine()
    board = BoardState.empty()
    _set_point(board, 8, PlayerColor.WHITE, 2)
    _set_point(board, 6, PlayerColor.WHITE, 2)
    _set_point(board, 5, PlayerColor.BLACK, 1)

    analysis = engine.rank_moves(board, DiceRoll(1, 2), PlayerColor.WHITE)

    assert analysis.candidates
    assert len(analysis.candidates) >= 2
    assert analysis.best_move == analysis.candidates[0]

    equities = [candidate.equity for candidate in analysis.candidates]
    assert equities == sorted(equities, reverse=True)
    assert all(
        candidate.equity == candidate.evaluation.equity
        for candidate in analysis.candidates
    )


def test_rank_moves_returns_pass_candidate_when_no_legal_moves_exist() -> None:
    engine = DummyEngine()
    board = BoardState.empty()
    board.bar_counts[PlayerColor.WHITE] = 1
    _set_point(board, 24, PlayerColor.BLACK, 2)
    _set_point(board, 23, PlayerColor.BLACK, 2)

    analysis = engine.rank_moves(board, DiceRoll(1, 2), PlayerColor.WHITE)

    assert analysis.best_move is not None
    assert len(analysis.candidates) == 1
    assert analysis.candidates[0].move.moves == []


def test_opening_book_prefers_book_entry_for_white_6_2(monkeypatch) -> None:
    engine = DummyEngine()
    board = BoardState.initial()

    legal_turns = board.generate_legal_turn_moves(
        player=PlayerColor.WHITE,
        dice_roll=DiceRoll(6, 2),
        deduplicate_final_states=False,
    )

    expected_book_edges = sorted(OPENING_BOOK_WHITE[(6, 2)])

    book_turn = next(
        turn
        for turn in legal_turns
        if sorted((m.from_point, m.to_point) for m in turn.moves)
        == expected_book_edges
    )
    non_book_turn = next(
        turn
        for turn in legal_turns
        if sorted((m.from_point, m.to_point) for m in turn.moves)
        != expected_book_edges
    )

    book_board = board.copy()
    for move in book_turn.moves:
        book_board.apply_single_checker_move(move)
    non_book_board = board.copy()
    for move in non_book_turn.moves:
        non_book_board.apply_single_checker_move(move)

    def fake_eval(state: BoardState, _player: PlayerColor) -> EvaluationResult:
        signature = state.signature()
        if signature == non_book_board.signature():
            equity = 10.0
        elif signature == book_board.signature():
            equity = -10.0
        else:
            equity = 0.0
        win = 0.5 if equity >= 0 else 0.45
        return EvaluationResult(
            equity=equity,
            win_probability=win,
            gammon_win_probability=0.05,
            backgammon_win_probability=0.01,
            lose_probability=1.0 - win,
            gammon_lose_probability=0.05,
            backgammon_lose_probability=0.01,
        )

    monkeypatch.setattr(engine, "evaluate_position", fake_eval)

    analysis = engine.rank_moves(board, DiceRoll(6, 2), PlayerColor.WHITE)
    best_edges = sorted((m.from_point, m.to_point) for m in analysis.best_move.move.moves)
    assert best_edges == expected_book_edges
