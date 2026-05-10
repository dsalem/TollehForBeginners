import pytest

from backend.app.domain import BoardState, MoveValidationError, PlayerColor, Point, SingleCheckerMove


def test_normal_legal_move() -> None:
    board = BoardState.initial()

    board.apply_single_checker_move(
        SingleCheckerMove(player=PlayerColor.WHITE, from_point=24, to_point=23)
    )

    from_point = board.get_point(24)
    to_point = board.get_point(23)
    assert from_point.owner == PlayerColor.WHITE
    assert from_point.checker_count == 1
    assert to_point.owner == PlayerColor.WHITE
    assert to_point.checker_count == 1


def test_blocked_point_is_illegal() -> None:
    board = BoardState.empty()
    board.points[9] = Point(owner=PlayerColor.WHITE, checker_count=2)   # point 10
    board.points[7] = Point(owner=PlayerColor.BLACK, checker_count=2)   # point 8

    with pytest.raises(MoveValidationError):
        board.apply_single_checker_move(
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=10, to_point=8)
        )


def test_landing_on_blot_hits_opponent_checker_to_bar() -> None:
    board = BoardState.empty()
    board.points[9] = Point(owner=PlayerColor.WHITE, checker_count=1)   # point 10
    board.points[7] = Point(owner=PlayerColor.BLACK, checker_count=1)   # point 8

    board.apply_single_checker_move(
        SingleCheckerMove(player=PlayerColor.WHITE, from_point=10, to_point=8)
    )

    assert board.get_point(10).owner is None
    assert board.get_point(10).checker_count == 0
    assert board.get_point(8).owner == PlayerColor.WHITE
    assert board.get_point(8).checker_count == 1
    assert board.bar_counts[PlayerColor.BLACK] == 1


def test_illegal_move_while_checker_is_on_bar() -> None:
    board = BoardState.initial()
    board.bar_counts[PlayerColor.WHITE] = 1

    with pytest.raises(MoveValidationError):
        board.apply_single_checker_move(
            SingleCheckerMove(player=PlayerColor.WHITE, from_point=24, to_point=23)
        )
