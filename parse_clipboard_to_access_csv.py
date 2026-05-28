#!/usr/bin/env python3
"""Parse mashed viewer text and append rows to access_import.csv.

Supports:
- Default single raw-string mode (example in RAW_INPUT)
- Interactive file picker mode for one or many files

Headers (fixed):
Category, Detail, Target, Mindset, Tags, Start, End, Duration, Status
"""

from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

HEADERS = [
    "Category",
    "Detail",
    "Target",
    "Mindset",
    "Tags",
    "Start",
    "End",
    "Duration",
    "Status",
]

HEADER_PREFIX = "CategoryDetailTargetMindsetTagsStartEndDurationStatus-"
BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "access_import.csv"

# 1) Define raw input string as a variable.
RAW_INPUT = (
    "CategoryDetailTargetMindsetTagsStartEndDurationStatus-"
    "CustomWalking on the Tredmill 4hold for 20 seconds1Test"
    "5/22/2026, 2:53:04 PM5/22/2026, 2:53:25 PM00:00:21Complete"
)

DATETIME_RE = r"\d{1,2}/\d{1,2}/\d{4},\s\d{1,2}:\d{2}:\d{2}\s(?:AM|PM)"
DURATION_RE = r"\d{2}:\d{2}:\d{2}"
STATUS_RE = r"(?:Complete|In progress)"


def strip_header_prefix(raw: str) -> str:
    """Remove the concatenated headers if they exist at the start."""
    cleaned = raw.strip().strip('"').strip("'")
    if cleaned.startswith(HEADER_PREFIX):
        return cleaned[len(HEADER_PREFIX):]

    pattern = re.compile(
        r"^\s*Category\s*Detail\s*Target\s*Mindset\s*Tags\s*Start\s*End\s*Duration\s*Status\s*-?",
        re.IGNORECASE,
    )
    return pattern.sub("", cleaned)


def split_detail_target(segment: str) -> tuple[str, str]:
    """Split detail and target from a mashed segment."""
    target_starters = [
        "hold ",
        "maintain ",
        "keep ",
        "reach ",
        "aim ",
        "goal ",
        "focus ",
        "complete ",
        "finish ",
        "hit ",
    ]

    lower = segment.lower()
    split_idx = -1
    for starter in target_starters:
        idx = lower.rfind(starter)
        if idx > 0 and (split_idx == -1 or idx > split_idx):
            split_idx = idx

    if split_idx == -1:
        raise ValueError(
            "Could not split Detail and Target. Include a recognizable target phrase (for example: hold/aim/reach/focus)."
        )

    detail = segment[:split_idx].strip()
    target = segment[split_idx:].strip()
    if not detail or not target:
        raise ValueError("Detail/Target parsing produced empty value.")
    return detail, target


def parse_raw_string(raw: str) -> dict[str, str]:
    """Parse one mashed string into the 9 required columns."""
    payload = strip_header_prefix(raw)

    tail_pattern = re.compile(
        rf"(?P<prefix>.*?)"
        rf"(?P<start>{DATETIME_RE})"
        rf"(?P<end>{DATETIME_RE})"
        rf"(?P<duration>{DURATION_RE})"
        rf"(?P<status>{STATUS_RE})$"
    )
    tail_match = tail_pattern.match(payload)
    if not tail_match:
        raise ValueError("Could not parse Start/End/Duration/Status from raw input.")

    prefix = tail_match.group("prefix")
    start = tail_match.group("start")
    end = tail_match.group("end")
    duration = tail_match.group("duration")
    status = tail_match.group("status")

    cat_match = re.match(r"^-?(Custom|Study|Sleep)", prefix)
    if not cat_match:
        raise ValueError("Category must start with Custom, Study, or Sleep.")

    category = cat_match.group(1)
    after_category = prefix[cat_match.end():]

    parsed_tail = None
    for idx in range(len(after_category) - 1, -1, -1):
        if after_category[idx] not in {"0", "1"}:
            continue

        candidate_mindset = after_category[idx]
        candidate_tags = after_category[idx + 1 :].strip()
        candidate_body = after_category[:idx].strip()

        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _\-]*", candidate_tags):
            continue

        try:
            candidate_detail, candidate_target = split_detail_target(candidate_body)
        except ValueError:
            continue

        parsed_tail = (candidate_detail, candidate_target, candidate_mindset, candidate_tags)
        break

    if parsed_tail is None:
        raise ValueError("Could not parse Mindset and Tags from raw input.")

    detail, target, mindset, tags = parsed_tail

    return {
        "Category": category,
        "Detail": detail,
        "Target": target,
        "Mindset": mindset,
        "Tags": tags,
        "Start": start,
        "End": end,
        "Duration": duration,
        "Status": status,
    }


def append_rows_to_csv(rows: list[dict[str, str]], csv_path: Path) -> int:
    """Create CSV with headers if needed, then append rows."""
    if not rows:
        return 0

    file_exists = csv_path.exists()
    with csv_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=HEADERS, quoting=csv.QUOTE_MINIMAL)
        if not file_exists:
            writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def load_rows_from_csv(path: Path) -> list[dict[str, str]]:
    """Load already-structured rows from a CSV that contains required headers."""
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return []

        normalized = {name.strip().lower(): name for name in reader.fieldnames}
        required = {name.lower() for name in HEADERS}
        if not required.issubset(set(normalized.keys())):
            raise ValueError("CSV does not contain all required headers.")

        output: list[dict[str, str]] = []
        for row in reader:
            mapped = {h: (row.get(normalized[h.lower()]) or "").strip() for h in HEADERS}
            if any(mapped.values()):
                output.append(mapped)
        return output


def load_rows_from_text(path: Path) -> list[dict[str, str]]:
    """Parse each non-empty line in a text file as mashed clipboard input."""
    rows: list[dict[str, str]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            rows.append(parse_raw_string(stripped))
    return rows


def pick_files_interactively() -> list[Path]:
    """Open file picker and return selected one-or-many paths."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("tkinter is required for file picker mode.") from exc

    root = tk.Tk()
    root.withdraw()
    selected = filedialog.askopenfilenames(
        title="Select one or more input files",
        filetypes=[
            ("CSV files", "*.csv"),
            ("Text files", "*.txt"),
            ("All files", "*.*"),
        ],
        initialdir=str(BASE_DIR),
    )
    root.destroy()
    return [Path(item) for item in selected]


def collect_rows_from_files(paths: list[Path]) -> tuple[list[dict[str, str]], list[str]]:
    """Parse one-or-many files and continue on bad inputs with warnings."""
    all_rows: list[dict[str, str]] = []
    warnings: list[str] = []

    for path in paths:
        if not path.exists() or not path.is_file():
            warnings.append(f"Skipped missing file: {path}")
            continue

        if path.suffix.lower() == ".csv":
            try:
                csv_rows = load_rows_from_csv(path)
                all_rows.extend(csv_rows)
                continue
            except ValueError:
                # Fallback: treat as text lines of mashed strings.
                pass
            except Exception as exc:
                warnings.append(f"Failed reading CSV {path.name}: {exc}")
                continue

        try:
            text_rows = load_rows_from_text(path)
            all_rows.extend(text_rows)
        except Exception as exc:
            warnings.append(f"Failed parsing text {path.name}: {exc}")

    return all_rows, warnings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Parse mashed viewer data and append to access_import.csv"
    )
    parser.add_argument(
        "--pick-files",
        action="store_true",
        help="Open a file picker to select one or many input files (.csv/.txt)",
    )
    parser.add_argument(
        "--files",
        nargs="*",
        default=[],
        help="Optional input file paths (one or many).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    warnings: list[str] = []

    if args.pick_files:
        file_paths = pick_files_interactively()
        if not file_paths:
            print("No files selected. Nothing appended.")
            return
        rows, warnings = collect_rows_from_files(file_paths)
    elif args.files:
        rows, warnings = collect_rows_from_files([Path(item) for item in args.files])
    else:
        rows = [parse_raw_string(RAW_INPUT)]

    appended = append_rows_to_csv(rows, CSV_PATH)
    print(f"Success: appended {appended} row(s) to {CSV_PATH}")
    if warnings:
        print(f"Warnings: {len(warnings)}")
        for warning in warnings:
            print(" - " + warning)


if __name__ == "__main__":
    main()
