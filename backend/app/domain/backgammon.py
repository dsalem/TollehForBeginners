from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class PlayerColor(str, Enum):
    WHITE = "WHITE"
    BLACK = "BLACK"


class GameMode(str, Enum):
    LOCAL = "LOCAL"
    VS_COMPUTER = "VS_COMPUTER"
    ONLINE_MULTIPLAYER = "ONLINE_MULTIPLAYER"


class ComputerDifficulty(str, Enum):
    BEGINNER = "BEGINNER"
    INTERMEDIATE = "INTERMEDIATE"
    ADVANCED = "ADVANCED"
    EXPERT = "EXPERT"


class ComputerTurnPhase(str, Enum):
    IDLE = "IDLE"
    ROLLING = "ROLLING"
    THINKING = "THINKING"
    MOVED = "MOVED"


class MoveValidationError(ValueError):
    """Raised when a checker move violates backgammon rules."""


@dataclass
class Point:
    owner: Optional[PlayerColor] = None
    checker_count: int = 0

    def __post_init__(self) -> None:
        if self.checker_count < 0:
            raise ValueError("checker_count must be non-negative")

        if self.checker_count == 0 and self.owner is not None:
            raise ValueError("owner must be None when checker_count is 0")

        if self.checker_count > 0 and self.owner is None:
            raise ValueError("owner is required when checker_count is greater than 0")


@dataclass
class SingleCheckerMove:
    player: PlayerColor
    from_point: Optional[int] = None
    to_point: Optional[int] = None
    from_bar: bool = False
    to_borne_off: bool = False

    def __post_init__(self) -> None:
        source_choices = int(self.from_bar) + int(self.from_point is not None)
        if source_choices != 1:
            raise ValueError("exactly one source must be set: from_bar or from_point")

        destination_choices = int(self.to_borne_off) + int(self.to_point is not None)
        if destination_choices != 1:
            raise ValueError("exactly one destination must be set: to_borne_off or to_point")

        if self.from_point is not None and (self.from_point < 1 or self.from_point > 24):
            raise ValueError("from_point must be in range 1..24")

        if self.to_point is not None and (self.to_point < 1 or self.to_point > 24):
            raise ValueError("to_point must be in range 1..24")


@dataclass
class BoardState:
    points: list[Point]
    bar_counts: dict[PlayerColor, int] = field(default_factory=dict)
    borne_off_counts: dict[PlayerColor, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if len(self.points) != 24:
            raise ValueError("BoardState must have exactly 24 points")

        self.bar_counts = self._normalize_counts(self.bar_counts, "bar_counts")
        self.borne_off_counts = self._normalize_counts(
            self.borne_off_counts, "borne_off_counts"
        )

    @staticmethod
    def _normalize_counts(
        counts: dict[PlayerColor, int], field_name: str
    ) -> dict[PlayerColor, int]:
        normalized = {
            PlayerColor.WHITE: counts.get(PlayerColor.WHITE, 0),
            PlayerColor.BLACK: counts.get(PlayerColor.BLACK, 0),
        }

        invalid_keys = set(counts.keys()) - {PlayerColor.WHITE, PlayerColor.BLACK}
        if invalid_keys:
            raise ValueError(f"{field_name} contains invalid player colors")

        for color, count in normalized.items():
            if count < 0:
                raise ValueError(f"{field_name}[{color}] must be non-negative")

        return normalized

    @classmethod
    def empty(cls) -> "BoardState":
        return cls(
            points=[Point() for _ in range(24)],
            bar_counts={PlayerColor.WHITE: 0, PlayerColor.BLACK: 0},
            borne_off_counts={PlayerColor.WHITE: 0, PlayerColor.BLACK: 0},
        )

    @classmethod
    def initial(cls) -> "BoardState":
        board = cls.empty()

        placements = {
            PlayerColor.WHITE: {24: 2, 13: 5, 8: 3, 6: 5},
            PlayerColor.BLACK: {1: 2, 12: 5, 17: 3, 19: 5},
        }

        for color, by_point in placements.items():
            for point_number, checker_count in by_point.items():
                board.points[point_number - 1] = Point(
                    owner=color, checker_count=checker_count
                )

        return board

    def get_point(self, point_number: int) -> Point:
        if point_number < 1 or point_number > 24:
            raise ValueError("point_number must be in range 1..24")
        return self.points[point_number - 1]

    @staticmethod
    def opponent(player: PlayerColor) -> PlayerColor:
        return PlayerColor.BLACK if player == PlayerColor.WHITE else PlayerColor.WHITE

    @staticmethod
    def _is_direction_legal(
        player: PlayerColor, from_point: int, to_point: int
    ) -> bool:
        if player == PlayerColor.WHITE:
            return to_point < from_point
        return to_point > from_point

    @staticmethod
    def _is_valid_bar_entry(player: PlayerColor, to_point: int) -> bool:
        if player == PlayerColor.WHITE:
            return 19 <= to_point <= 24
        return 1 <= to_point <= 6

    @staticmethod
    def _entry_point_for_die(player: PlayerColor, die_value: int) -> int:
        if player == PlayerColor.WHITE:
            return 25 - die_value
        return die_value

    @staticmethod
    def _is_home_board_point(player: PlayerColor, point_number: int) -> bool:
        if player == PlayerColor.WHITE:
            return 1 <= point_number <= 6
        return 19 <= point_number <= 24

    def copy(self) -> "BoardState":
        return BoardState(
            points=[
                Point(owner=point.owner, checker_count=point.checker_count)
                for point in self.points
            ],
            bar_counts=dict(self.bar_counts),
            borne_off_counts=dict(self.borne_off_counts),
        )

    def signature(self) -> tuple:
        point_signature = tuple(
            (
                point.owner.value if point.owner is not None else None,
                point.checker_count,
            )
            for point in self.points
        )
        return (
            point_signature,
            self.bar_counts[PlayerColor.WHITE],
            self.bar_counts[PlayerColor.BLACK],
            self.borne_off_counts[PlayerColor.WHITE],
            self.borne_off_counts[PlayerColor.BLACK],
        )

    def _all_checkers_in_home_board(self, player: PlayerColor) -> bool:
        if self.bar_counts[player] > 0:
            return False

        for point_number, point in enumerate(self.points, start=1):
            if point.owner != player or point.checker_count == 0:
                continue

            if not self._is_home_board_point(player, point_number):
                return False

        return True

    def _can_bear_off_with_die(
        self, player: PlayerColor, from_point: int, die_value: int
    ) -> bool:
        if not self._all_checkers_in_home_board(player):
            return False

        if not self._is_home_board_point(player, from_point):
            return False

        distance_to_bear_off = from_point if player == PlayerColor.WHITE else 25 - from_point
        if die_value == distance_to_bear_off:
            return True

        if die_value < distance_to_bear_off:
            return False

        if player == PlayerColor.WHITE:
            for higher_point in range(from_point + 1, 7):
                point = self.get_point(higher_point)
                if point.owner == player and point.checker_count > 0:
                    return False
            return True

        for lower_point in range(19, from_point):
            point = self.get_point(lower_point)
            if point.owner == player and point.checker_count > 0:
                return False
        return True

    def validate_single_checker_move(self, move: "SingleCheckerMove") -> None:
        player = move.player
        opponent = self.opponent(player)

        if self.bar_counts[player] > 0 and not move.from_bar:
            raise MoveValidationError(
                "player must enter checkers from the bar before other moves"
            )

        if move.from_bar:
            if self.bar_counts[player] <= 0:
                raise MoveValidationError("player has no checkers on the bar")
        else:
            if move.from_point is None:
                raise MoveValidationError("from_point is required for non-bar moves")

            source = self.get_point(move.from_point)
            if source.checker_count == 0:
                raise MoveValidationError("cannot move checker from an empty point")

            if source.owner != player:
                raise MoveValidationError(
                    "cannot move checker from a point owned by opponent"
                )

        if move.to_borne_off:
            if move.from_bar:
                raise MoveValidationError("cannot bear off directly from the bar")

            if move.from_point is None:
                raise MoveValidationError("from_point is required for bearing off")

            if not self._is_home_board_point(player, move.from_point):
                raise MoveValidationError(
                    "cannot bear off from outside the player's home board"
                )

            if not self._all_checkers_in_home_board(player):
                raise MoveValidationError(
                    "cannot bear off until all checkers are in the home board"
                )

            return

        if move.to_point is None:
            raise MoveValidationError("to_point is required")

        if move.from_bar and not self._is_valid_bar_entry(player, move.to_point):
            raise MoveValidationError("invalid bar entry point for player direction")

        if (
            not move.from_bar
            and move.from_point is not None
            and not self._is_direction_legal(player, move.from_point, move.to_point)
        ):
            raise MoveValidationError("move direction is invalid for player")

        destination = self.get_point(move.to_point)
        if destination.owner == opponent and destination.checker_count >= 2:
            raise MoveValidationError(
                "cannot land on a point with two or more opponent checkers"
            )

    def apply_single_checker_move(self, move: "SingleCheckerMove") -> None:
        self.validate_single_checker_move(move)

        player = move.player
        opponent = self.opponent(player)

        if move.from_bar:
            self.bar_counts[player] -= 1
        else:
            if move.from_point is None:
                raise MoveValidationError("from_point is required")

            source = self.get_point(move.from_point)
            source.checker_count -= 1
            if source.checker_count == 0:
                source.owner = None

        if move.to_borne_off:
            self.borne_off_counts[player] += 1
            return

        destination_point_number = move.to_point
        if destination_point_number is None:
            raise MoveValidationError("to_point is required")

        destination = self.get_point(destination_point_number)
        if destination.owner == opponent and destination.checker_count == 1:
            self.bar_counts[opponent] += 1
            destination.owner = player
            destination.checker_count = 1
            return

        if destination.owner is None:
            destination.owner = player
            destination.checker_count = 1
            return

        destination.checker_count += 1

    def _generate_legal_single_checker_moves_for_die(
        self, player: PlayerColor, die_value: int
    ) -> list[SingleCheckerMove]:
        if die_value < 1 or die_value > 6:
            raise ValueError("die_value must be in range 1..6")

        legal_moves: list[SingleCheckerMove] = []
        opponent = self.opponent(player)

        if self.bar_counts[player] > 0:
            entry_point = self._entry_point_for_die(player, die_value)
            destination = self.get_point(entry_point)
            if destination.owner == opponent and destination.checker_count >= 2:
                return []

            legal_moves.append(
                SingleCheckerMove(player=player, from_bar=True, to_point=entry_point)
            )
            return legal_moves

        for point_number, point in enumerate(self.points, start=1):
            if point.owner != player or point.checker_count == 0:
                continue

            if player == PlayerColor.WHITE:
                target = point_number - die_value
            else:
                target = point_number + die_value

            if 1 <= target <= 24:
                candidate = SingleCheckerMove(
                    player=player, from_point=point_number, to_point=target
                )
                try:
                    self.validate_single_checker_move(candidate)
                except MoveValidationError:
                    continue
                legal_moves.append(candidate)
                continue

            if self._can_bear_off_with_die(player, point_number, die_value):
                legal_moves.append(
                    SingleCheckerMove(
                        player=player, from_point=point_number, to_borne_off=True
                    )
                )

        return legal_moves

    def _enumerate_sequences_for_dice_values(
        self, player: PlayerColor, dice_values: list[int]
    ) -> list[tuple[list[SingleCheckerMove], list[int], "BoardState"]]:
        results: list[tuple[list[SingleCheckerMove], list[int], BoardState]] = []

        def recurse(
            board: BoardState,
            die_index: int,
            current_moves: list[SingleCheckerMove],
            used_dice: list[int],
        ) -> None:
            if die_index == len(dice_values):
                results.append((current_moves, used_dice, board))
                return

            die_value = dice_values[die_index]
            legal_moves = board._generate_legal_single_checker_moves_for_die(
                player, die_value
            )
            if not legal_moves:
                results.append((current_moves, used_dice, board))
                return

            for move in legal_moves:
                next_board = board.copy()
                next_board.apply_single_checker_move(move)
                recurse(
                    board=next_board,
                    die_index=die_index + 1,
                    current_moves=current_moves + [move],
                    used_dice=used_dice + [die_value],
                )

        recurse(self.copy(), 0, [], [])
        return results

    def generate_legal_turn_moves(
        self,
        player: PlayerColor,
        dice_roll: "DiceRoll",
        deduplicate_final_states: bool = True,
    ) -> list["TurnMove"]:
        if dice_roll.is_double:
            dice_orders = [dice_roll.values]
        else:
            dice_orders = [[dice_roll.die_1, dice_roll.die_2]]
            if dice_roll.die_1 != dice_roll.die_2:
                dice_orders.append([dice_roll.die_2, dice_roll.die_1])

        all_sequences: list[tuple[list[SingleCheckerMove], list[int], BoardState]] = []
        for dice_order in dice_orders:
            all_sequences.extend(
                self._enumerate_sequences_for_dice_values(player, dice_order)
            )

        if not all_sequences:
            return []

        max_moves_played = max(len(sequence[0]) for sequence in all_sequences)
        candidate_sequences = [
            sequence
            for sequence in all_sequences
            if len(sequence[0]) == max_moves_played
        ]

        if not dice_roll.is_double and max_moves_played == 1:
            higher_die = max(dice_roll.die_1, dice_roll.die_2)
            higher_die_sequences = [
                sequence
                for sequence in candidate_sequences
                if sequence[1] and sequence[1][0] == higher_die
            ]
            if higher_die_sequences:
                candidate_sequences = higher_die_sequences

        legal_turn_moves: list[TurnMove] = []

        if not deduplicate_final_states:
            for moves, _used_dice, _final_board in candidate_sequences:
                legal_turn_moves.append(
                    TurnMove(player=player, dice_roll=dice_roll, moves=moves)
                )
            return legal_turn_moves

        seen_final_signatures: set[tuple] = set()
        for moves, _used_dice, final_board in candidate_sequences:
            signature = final_board.signature()
            if signature in seen_final_signatures:
                continue
            seen_final_signatures.add(signature)
            legal_turn_moves.append(
                TurnMove(player=player, dice_roll=dice_roll, moves=moves)
            )

        return legal_turn_moves


@dataclass
class DiceRoll:
    die_1: int
    die_2: int

    def __post_init__(self) -> None:
        for value in (self.die_1, self.die_2):
            if value < 1 or value > 6:
                raise ValueError("each die value must be in range 1..6")

    @property
    def is_double(self) -> bool:
        return self.die_1 == self.die_2

    @property
    def values(self) -> list[int]:
        if self.is_double:
            return [self.die_1, self.die_1, self.die_1, self.die_1]
        return [self.die_1, self.die_2]


@dataclass
class TurnMove:
    player: PlayerColor
    dice_roll: DiceRoll
    moves: list[SingleCheckerMove] = field(default_factory=list)


@dataclass
class GameState:
    game_id: str
    mode: GameMode
    board_state: BoardState
    current_turn: PlayerColor
    computer_difficulty: Optional[ComputerDifficulty] = None
    computer_turn_phase: Optional[ComputerTurnPhase] = None
    turn_number: int = 1
    current_dice_roll: Optional[DiceRoll] = None
    match_length: int = 1
    score_white: int = 0
    score_black: int = 0
    cube_value: int = 1
    cube_owner: Optional[PlayerColor] = None
    cube_offered_by: Optional[PlayerColor] = None
    computer_turn_ready_at: Optional[float] = None
    pending_computer_turn: Optional["TurnMove"] = None
    last_computer_roll: Optional[DiceRoll] = None
    last_computer_move: Optional["TurnMove"] = None
    turn_history: list[TurnMove] = field(default_factory=list)
    winner: Optional[PlayerColor] = None

    def __post_init__(self) -> None:
        if self.turn_number < 1:
            raise ValueError("turn_number must be 1 or greater")
        if self.match_length not in (1, 3, 5, 7, 9):
            raise ValueError("match_length must be one of 1, 3, 5, 7, 9")
        if self.mode != GameMode.VS_COMPUTER and self.computer_difficulty is not None:
            raise ValueError(
                "computer_difficulty can only be set for VS_COMPUTER games"
            )
        if self.mode != GameMode.VS_COMPUTER and self.computer_turn_phase is not None:
            raise ValueError(
                "computer_turn_phase can only be set for VS_COMPUTER games"
            )

    @classmethod
    def new_game(
        cls,
        game_id: str,
        mode: GameMode,
        starting_player: PlayerColor = PlayerColor.WHITE,
        computer_difficulty: Optional[ComputerDifficulty] = None,
        match_length: int = 1,
    ) -> "GameState":
        if mode == GameMode.VS_COMPUTER and computer_difficulty is None:
            computer_difficulty = ComputerDifficulty.BEGINNER

        return cls(
            game_id=game_id,
            mode=mode,
            board_state=BoardState.initial(),
            current_turn=starting_player,
            computer_difficulty=computer_difficulty,
            match_length=match_length,
        )
