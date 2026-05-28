# Activity Tracker

A full-stack activity tracking application with a responsive web UI, REST API, and SQLite persistence layer for logging and analyzing daily activities.

## Problem Statement

Tracking time and activities across multiple sessions is error-prone when data lives in disparate logs or spreadsheets. This project provides a unified, structured pipeline for ingesting activity records from various sources, storing them reliably, and querying summaries and trends via a REST API.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.html (Web UI)                   │
│            Responsive dashboard with timer,              │
│         activity buttons, and result summaries           │
└────────────────────┬────────────────────────────────────┘
                     │ (HTTP/JSON)
┌────────────────────▼────────────────────────────────────┐
│             FastAPI Backend (main.py)                    │
│  • GET /api/activities — fetch recent activity logs      │
│  • GET /api/summary — time grouped by activity type      │
│  • CORS-enabled for local development                    │
└────────────────────┬────────────────────────────────────┘
                     │ (SQLite)
┌────────────────────▼────────────────────────────────────┐
│          SQLite Database (tracker.db)                    │
│  • Validated schema with type constraints                │
│  • Transaction-safe writes with automatic rollback       │
│  • Foreign key enforcement                               │
│  • WAL mode for concurrent reads                         │
└─────────────────────────────────────────────────────────┘
```

## Data Pipeline

Three utilities support data ingestion:

- **parse_clipboard_to_access_csv.py** — Parse activity strings from clipboard and export to CSV.
- **tracker_csv_to_sqlite.py** — Ingest CSV records into SQLite.
- **activity_db_manager.py** — Core database layer with schema management, validation, and transaction handling.

## Quick Start

### Prerequisites
- Python 3.9+
- pip

### Setup

1. Clone and enter the directory:
   ```bash
   git clone https://github.com/yourusername/activity-tracker.git
   cd activity-tracker
   ```

2. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. Install dependencies:
   ```bash
   pip install fastapi uvicorn
   ```

4. Start the API server:
   ```bash
   uvicorn main:app --host 127.0.0.1 --port 8000 --reload
   ```

5. Open a browser to **http://localhost:8000** and navigate to the UI.

### API Endpoints

- **GET** `/api/activities?limit=100` — Return recent activity logs.
  ```json
  {
    "count": 5,
    "items": [
      {
        "id": 1,
        "occurred_at": "2026-05-28T14:30:00Z",
        "activity_type": "Running",
        "duration_seconds": 1800,
        "distance_km": 5.2,
        "steps": null,
        "metadata_json": null,
        "created_at": "2026-05-28T14:30:15Z"
      }
    ]
  }
  ```

- **GET** `/api/summary` — Return total duration and entry count grouped by activity type.
  ```json
  {
    "count": 3,
    "items": [
      {
        "activity_type": "Running",
        "total_duration_seconds": 3600,
        "total_entries": 2
      }
    ]
  }
  ```

## Technical Highlights

- **Validated Data Ingestion** — ActivityLog dataclass enforces type constraints and business rules before write.
- **Transaction Safety** — Batch operations use `BEGIN TRANSACTION` / `ROLLBACK` for all-or-nothing writes.
- **Reliable Schema** — Automatic table creation with `CHECK` constraints and indexes on frequently queried columns.
- **Error Handling** — Comprehensive logging and HTTP exception mapping for API consumers.
- **CORS Support** — Local development-friendly middleware for cross-origin requests.

## Resume Bullets

- Built a full-stack activity tracking application with a responsive web UI, REST API, and SQLite persistence layer.
- Implemented validated ingest and transaction-safe data writes with schema management for reliable logging and reporting.
- Designed summary and retrieval endpoints for activity analytics and structured CSV import pipeline for data migration.

## Future Improvements

- Add filtering and date-range queries to `/api/activities`.
- Implement user authentication and multi-user support.
- Add weekly/monthly analytics and visualization endpoints.
- Create mobile app frontend.

## License

MIT
