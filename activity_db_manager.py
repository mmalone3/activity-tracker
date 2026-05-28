#!/usr/bin/env python3
"""SQLite database utilities for the Activity Tracker pipeline.

This module provides a small, production-ready database manager for:
- Safe connection and transaction handling with context managers
- Schema initialization and type-constrained table definitions
- Reliable ingestion with rollback on write failures
- Simple retrieval helpers for downstream pipeline steps
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sqlite3
from typing import Any, Iterable, Iterator, Mapping

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ActivityLog:
    """Typed payload for one activity event."""

    occurred_at: datetime
    activity_type: str
    duration_seconds: int
    distance_km: float | None = None
    steps: int | None = None
    metadata: dict[str, Any] | None = None

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ActivityLog":
        """Build and validate an ActivityLog from an untyped payload mapping."""
        raw_occurred_at = payload.get("occurred_at")
        if isinstance(raw_occurred_at, datetime):
            occurred_at = raw_occurred_at
        elif isinstance(raw_occurred_at, str):
            occurred_at = datetime.fromisoformat(raw_occurred_at)
        else:
            raise ValueError("'occurred_at' must be an ISO-8601 string or datetime")

        activity_type = str(payload.get("activity_type", "")).strip()
        if not activity_type:
            raise ValueError("'activity_type' is required")

        try:
            duration_seconds = int(payload.get("duration_seconds"))
        except (TypeError, ValueError) as exc:
            raise ValueError("'duration_seconds' must be an integer") from exc

        if duration_seconds < 0:
            raise ValueError("'duration_seconds' cannot be negative")

        raw_distance = payload.get("distance_km")
        distance_km = None if raw_distance is None else float(raw_distance)
        if distance_km is not None and distance_km < 0:
            raise ValueError("'distance_km' cannot be negative")

        raw_steps = payload.get("steps")
        steps = None if raw_steps is None else int(raw_steps)
        if steps is not None and steps < 0:
            raise ValueError("'steps' cannot be negative")

        metadata_raw = payload.get("metadata")
        if metadata_raw is None:
            metadata = None
        elif isinstance(metadata_raw, dict):
            metadata = dict(metadata_raw)
        else:
            raise ValueError("'metadata' must be a dictionary when provided")

        return cls(
            occurred_at=occurred_at,
            activity_type=activity_type,
            duration_seconds=duration_seconds,
            distance_km=distance_km,
            steps=steps,
            metadata=metadata,
        )


class ActivityDatabaseManager:
    """SQLite-backed manager for ingesting and querying activity records."""

    def __init__(self, db_path: str | Path, busy_timeout_ms: int = 5000) -> None:
        self.db_path = Path(db_path)
        self.busy_timeout_ms = busy_timeout_ms

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """Open a connection configured for reliability and close it automatically."""
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(
                self.db_path,
                timeout=self.busy_timeout_ms / 1000,
                detect_types=sqlite3.PARSE_DECLTYPES,
            )
            connection.row_factory = sqlite3.Row
            connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms};")
            connection.execute("PRAGMA foreign_keys = ON;")
            connection.execute("PRAGMA journal_mode = WAL;")
            yield connection
        finally:
            if connection is not None:
                connection.close()

    def initialize_schema(self) -> None:
        """Create required tables and indexes if they do not already exist."""
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            activity_type TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 0),
            distance_km REAL CHECK(distance_km IS NULL OR distance_km >= 0),
            steps INTEGER CHECK(steps IS NULL OR steps >= 0),
            metadata_json TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        """.strip()

        create_index_sql = """
        CREATE INDEX IF NOT EXISTS idx_activities_occurred_at
        ON activities(occurred_at);
        """.strip()

        try:
            with self._connect() as connection, connection:
                connection.execute(create_table_sql)
                connection.execute(create_index_sql)
        except sqlite3.DatabaseError:
            LOGGER.exception("Failed to initialize schema for database at %s", self.db_path)
            raise

    def ingest_activity(self, payload: ActivityLog | Mapping[str, Any]) -> int:
        """Insert a single activity payload and return the inserted row id."""
        activity = payload if isinstance(payload, ActivityLog) else ActivityLog.from_payload(payload)
        insert_sql = """
        INSERT INTO activities (
            occurred_at,
            activity_type,
            duration_seconds,
            distance_km,
            steps,
            metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?);
        """.strip()

        try:
            with self._connect() as connection:
                cursor = connection.cursor()
                try:
                    with connection:
                        cursor.execute(
                            insert_sql,
                            (
                                activity.occurred_at.astimezone(timezone.utc).isoformat(),
                                activity.activity_type,
                                activity.duration_seconds,
                                activity.distance_km,
                                activity.steps,
                                json.dumps(activity.metadata) if activity.metadata is not None else None,
                            ),
                        )
                        row_id = int(cursor.lastrowid)
                except sqlite3.IntegrityError:
                    connection.rollback()
                    LOGGER.exception("Integrity error while ingesting activity: %s", activity)
                    raise
                except sqlite3.OperationalError:
                    connection.rollback()
                    LOGGER.exception("Operational error while ingesting activity: %s", activity)
                    raise
                except sqlite3.DatabaseError:
                    connection.rollback()
                    LOGGER.exception("Database error while ingesting activity: %s", activity)
                    raise
                finally:
                    cursor.close()

                return row_id
        except sqlite3.DatabaseError:
            LOGGER.exception("Failed to write activity to database %s", self.db_path)
            raise

    def batch_ingest(self, payloads: Iterable[ActivityLog | Mapping[str, Any]]) -> int:
        """Insert multiple activities in one transaction (all-or-nothing)."""
        activities = [
            payload if isinstance(payload, ActivityLog) else ActivityLog.from_payload(payload)
            for payload in payloads
        ]

        if not activities:
            return 0

        insert_sql = """
        INSERT INTO activities (
            occurred_at,
            activity_type,
            duration_seconds,
            distance_km,
            steps,
            metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?);
        """.strip()

        values = [
            (
                item.occurred_at.astimezone(timezone.utc).isoformat(),
                item.activity_type,
                item.duration_seconds,
                item.distance_km,
                item.steps,
                json.dumps(item.metadata) if item.metadata is not None else None,
            )
            for item in activities
        ]

        try:
            with self._connect() as connection:
                cursor = connection.cursor()
                try:
                    with connection:
                        cursor.executemany(insert_sql, values)
                except sqlite3.IntegrityError:
                    connection.rollback()
                    LOGGER.exception("Integrity error during batch ingest (%d records)", len(activities))
                    raise
                except sqlite3.OperationalError:
                    connection.rollback()
                    LOGGER.exception("Operational error during batch ingest (%d records)", len(activities))
                    raise
                except sqlite3.DatabaseError:
                    connection.rollback()
                    LOGGER.exception("Database error during batch ingest (%d records)", len(activities))
                    raise
                finally:
                    cursor.close()

                return len(activities)
        except sqlite3.DatabaseError:
            LOGGER.exception("Failed batch write to database %s", self.db_path)
            raise

    def ingest_batch(self, payloads: Iterable[ActivityLog | Mapping[str, Any]]) -> int:
        """Backward-compatible alias for batch_ingest."""
        return self.batch_ingest(payloads)

    def fetch_recent_activities(self, limit: int = 100) -> list[dict[str, Any]]:
        """Return the most recent activities as dictionaries."""
        if limit <= 0:
            raise ValueError("'limit' must be greater than 0")

        query_sql = """
        SELECT
            id,
            occurred_at,
            activity_type,
            duration_seconds,
            distance_km,
            steps,
            metadata_json,
            created_at
        FROM activities
        ORDER BY occurred_at DESC
        LIMIT ?;
        """.strip()

        try:
            with self._connect() as connection:
                rows = connection.execute(query_sql, (limit,)).fetchall()
        except sqlite3.DatabaseError:
            LOGGER.exception("Failed to fetch activities from database %s", self.db_path)
            raise

        output: list[dict[str, Any]] = []
        for row in rows:
            metadata_json = row["metadata_json"]
            output.append(
                {
                    "id": row["id"],
                    "occurred_at": row["occurred_at"],
                    "activity_type": row["activity_type"],
                    "duration_seconds": row["duration_seconds"],
                    "distance_km": row["distance_km"],
                    "steps": row["steps"],
                    "metadata": json.loads(metadata_json) if metadata_json else None,
                    "created_at": row["created_at"],
                }
            )
        return output


if __name__ == "__main__":
    # Example: ingest one incoming payload from your pipeline.
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")

    manager = ActivityDatabaseManager(db_path="tracker.db", busy_timeout_ms=5000)
    manager.initialize_schema()

    incoming_payload = {
        "occurred_at": "2026-05-22T19:35:00+00:00",
        "activity_type": "walking",
        "duration_seconds": 1800,
        "distance_km": 2.8,
        "steps": 3600,
        "metadata": {"source": "watch-sync", "intensity": "moderate"},
    }

    try:
        inserted_id = manager.ingest_activity(incoming_payload)
        LOGGER.info("Inserted activity row id: %d", inserted_id)
    except sqlite3.DatabaseError:
        LOGGER.exception("Activity ingest failed")
