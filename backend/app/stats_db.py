"""SQLite-backed win/loss tracker.

Each match outcome is recorded once (by `game_id`), keyed to a `client_id`
that the frontend generates and stores in its own localStorage. Stats are
computed by aggregating recorded rows on demand — no separate denormalized
counter table to keep in sync.

The DB file lives next to the backend code by default (override with the
TOLLEH_STATS_DB env var). SQLite is stdlib, so this adds zero new
dependencies.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

# `mode` and `outcome` are validated at the API edge; the DB takes them as
# plain TEXT to keep the schema portable.
Mode = Literal["VS_COMPUTER", "ONLINE_MULTIPLAYER", "LOCAL"]
Outcome = Literal["win", "loss", "played"]

_DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "stats.db"
_DB_PATH = Path(os.environ.get("TOLLEH_STATS_DB", str(_DEFAULT_DB_PATH)))

# sqlite3 connections aren't thread-safe by default and FastAPI handlers can
# run on multiple threads, so we serialize writes through one shared lock.
# A real production app would use a connection pool / SQLAlchemy; for a
# personal stats tracker this is plenty.
_LOCK = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, isolation_level=None, check_same_thread=False)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


def init_db() -> None:
    """Create the stats schema if missing. Idempotent — safe to call on every
    server boot."""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK, _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS recorded_games (
                game_id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                outcome TEXT NOT NULL,
                recorded_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_recorded_games_client
                ON recorded_games(client_id);
            """
        )


def record_outcome(client_id: str, game_id: str, mode: Mode, outcome: Outcome) -> bool:
    """Insert a recorded-match row. Returns True if a new row was inserted,
    False if the game_id was already recorded (idempotent retry)."""
    if not client_id or not game_id:
        return False
    now = datetime.now(UTC).isoformat()
    with _LOCK, _connect() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO recorded_games
                (game_id, client_id, mode, outcome, recorded_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (game_id, client_id, mode, outcome, now),
        )
        return cursor.rowcount > 0


def get_stats(client_id: str) -> dict:
    """Aggregate recorded rows for this client into the same shape the
    frontend already uses."""
    base = {
        "vsComputer": {"wins": 0, "losses": 0},
        "online": {"wins": 0, "losses": 0},
        "local": {"games": 0},
        "totalRecorded": 0,
    }
    if not client_id:
        return base
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            """
            SELECT mode, outcome, COUNT(*) AS n
            FROM recorded_games
            WHERE client_id = ?
            GROUP BY mode, outcome
            """,
            (client_id,),
        ).fetchall()
    total = 0
    for mode, outcome, n in rows:
        total += n
        if mode == "VS_COMPUTER":
            if outcome == "win":
                base["vsComputer"]["wins"] += n
            elif outcome == "loss":
                base["vsComputer"]["losses"] += n
        elif mode == "ONLINE_MULTIPLAYER":
            if outcome == "win":
                base["online"]["wins"] += n
            elif outcome == "loss":
                base["online"]["losses"] += n
        elif mode == "LOCAL":
            base["local"]["games"] += n
    base["totalRecorded"] = total
    return base


def reset_client(client_id: str) -> int:
    """Wipe this client's recorded matches. Returns rows deleted."""
    if not client_id:
        return 0
    with _LOCK, _connect() as conn:
        cursor = conn.execute(
            "DELETE FROM recorded_games WHERE client_id = ?",
            (client_id,),
        )
        return cursor.rowcount or 0
