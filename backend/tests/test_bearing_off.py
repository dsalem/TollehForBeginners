import pytest

from backend.app.domain import (
    BoardState,
    DiceRoll,
    MoveValidationError,
    PlayerColor,
    Point,
    SingleCheckerMove,
)


def test_exact_die_bear_off() -> None:
    board = BoardState.empty()
    board.points[2] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 3
    board.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(3, 1))

    assert turns
    assert any(
        any(move.to_borne_off and move.from_point == 3 for move in turn.moves)
        for turn in turns
    )


def test_oversized_die_bear_off_when_no_checkers_behind() -> None:
    board = BoardState.empty()
    board.points[1] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 2

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(6, 4))

    assert len(turns) == 1
    assert len(turns[0].moves) == 1
    assert turns[0].moves[0].to_borne_off is True
    assert turns[0].moves[0].from_point == 2


def test_illegal_bear_off_when_not_all_checkers_in_home_board() -> None:
    board = BoardState.empty()
    board.points[8] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 9
    board.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1

    with pytest.raises(MoveValidationError):
        board.apply_single_checker_move(
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=1, to_borne_off=True)
        )

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(1, 2))
    assert turns
    assert all(
        all(not single_move.to_borne_off for single_move in turn.moves) for turn in turns
    )


def test_bear_off_is_illegal_when_checker_is_on_bar() -> None:
    board = BoardState.empty()
    board.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1
    board.bar_counts[PlayerColor.WHITE] = 1

    with pytest.raises(MoveValidationError):
        board.apply_single_checker_move(
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=1, to_borne_off=True)
        )

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(1, 2))
    assert turns
    assert all(turn.moves[0].from_bar for turn in turns)
    assert all(
        all(not single_move.to_borne_off for single_move in turn.moves) for turn in turns
    )
