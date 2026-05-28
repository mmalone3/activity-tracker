#!/usr/bin/env python3
"""Read raw_logs.csv and insert the rows into tracker.db."""

from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

CSV_PATH = Path("raw_logs.csv")
DB_PATH = Path("tracker.db")


def create_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            activity_name TEXT,
            duration_minutes INTEGER
        )
        """
    )


def import_csv_to_sqlite(csv_path: Path = CSV_PATH, db_path: Path = DB_PATH) -> int:
    connection = None
    inserted_rows = 0

    try:
        if not csv_path.exists():
            raise FileNotFoundError(f"CSV file not found: {csv_path}")

        connection = sqlite3.connect(db_path)
        create_table(connection)

        with csv_path.open("r", encoding="utf-8-sig", newline="") as csv_file:
            reader = csv.DictReader(csv_file)
            if reader.fieldnames is None:
                raise ValueError("CSV file is missing a header row")

            required_columns = {"date", "activity_name", "duration_minutes"}
            missing_columns = required_columns.difference(
                {name.strip() for name in reader.fieldnames if name}
            )
            if missing_columns:
                raise ValueError("CSV file is missing required columns: " + ", ".join(sorted(missing_columns)))

            insert_sql = """
                INSERT INTO activities (date, activity_name, duration_minutes)
                VALUES (?, ?, ?)
            """

            for row in reader:
                date_value = str(row.get("date", "")).strip()
                activity_name = str(row.get("activity_name", "")).strip()
                duration_text = str(row.get("duration_minutes", "")).strip()

                if not date_value or not activity_name or not duration_text:
                    raise ValueError("Each row must include date, activity_name, and duration_minutes")

                connection.execute(
                    insert_sql,
                    (date_value, activity_name, int(float(duration_text))),
                )
                inserted_rows += 1

        connection.commit()
        return inserted_rows

    except Exception:
        if connection is not None:
            connection.rollback()
        raise

    finally:
        if connection is not None:
            connection.close()


def main() -> None:
    try:
        count = import_csv_to_sqlite()
        print(f"Imported {count} row(s) into {DB_PATH}.")
    except Exception as exc:
        print(f"Import failed: {exc}")


if __name__ == "__main__":
    main()
