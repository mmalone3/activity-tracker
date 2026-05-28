# Run instructions:
# 1) Install dependencies:
#    pip install fastapi uvicorn
# 2) Start the API server from this folder:
#    uvicorn main:app --host 127.0.0.1 --port 8000 --reload

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Iterator

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from activity_db_manager import ActivityDatabaseManager

app = FastAPI(title="Activity Tracker API", version="1.0.0")

# Allow local HTML/JS files to call this API without CORS blocks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db_manager() -> Iterator[ActivityDatabaseManager]:
    """FastAPI dependency that provides a db manager instance."""
    manager = ActivityDatabaseManager(Path("tracker.db"), busy_timeout_ms=5000)
    try:
        yield manager
    finally:
        # No explicit close needed here because ActivityDatabaseManager
        # handles connection lifecycle per operation via context managers.
        pass


DbManager = Annotated[ActivityDatabaseManager, Depends(get_db_manager)]


@app.on_event("startup")
def on_startup() -> None:
    """Initialize required schema at service startup."""
    ActivityDatabaseManager(Path("tracker.db"), busy_timeout_ms=5000).initialize_schema()


@app.get("/api/activities")
def get_activities(db: DbManager, limit: int = 100) -> dict[str, Any]:
    """Return recent activity logs."""
    try:
        activities = db.fetch_recent_activities(limit=limit)
        return {"count": len(activities), "items": activities}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch activities: {exc}") from exc


@app.get("/api/summary")
def get_summary(db: DbManager) -> dict[str, Any]:
    """Return total duration grouped by activity type."""
    summary_sql = """
    SELECT
        activity_type,
        SUM(duration_seconds) AS total_duration_seconds,
        COUNT(*) AS total_entries
    FROM activities
    GROUP BY activity_type
    ORDER BY total_duration_seconds DESC;
    """.strip()

    try:
        with db._connect() as connection:
            rows = connection.execute(summary_sql).fetchall()

        items = [
            {
                "activity_type": row["activity_type"],
                "total_duration_seconds": int(row["total_duration_seconds"] or 0),
                "total_entries": int(row["total_entries"] or 0),
            }
            for row in rows
        ]
        return {"count": len(items), "items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to build summary: {exc}") from exc
