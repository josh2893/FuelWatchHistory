from __future__ import annotations

import csv
import io
import os
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import requests

BASE_URL = "https://warsydprdstafuelwatch.blob.core.windows.net/historical-reports"
DEFAULT_START_YEAR = 2001
DEFAULT_START_MONTH = 1
APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("FUELWATCH_DATA_DIR", str(APP_DIR / "data")))
RAW_DIR = DATA_DIR / "raw"
DB_DIR = DATA_DIR / "db"
DB_PATH = Path(os.getenv("FUELWATCH_DB_PATH", str(DB_DIR / "fuelwatch.sqlite3")))
REQUEST_TIMEOUT = int(os.getenv("FUELWATCH_REQUEST_TIMEOUT", "60"))
AUTO_SYNC = os.getenv("FUELWATCH_AUTO_SYNC", "true").lower() in {"1", "true", "yes", "on"}
CURRENT_MONTH_REFRESH_HOURS = int(os.getenv("FUELWATCH_CURRENT_MONTH_REFRESH_HOURS", "12"))
USER_AGENT = os.getenv(
    "FUELWATCH_USER_AGENT",
    "FuelWatchHistory/1.0 (+https://github.com/your-repo)",
)


@dataclass(frozen=True)
class MonthRef:
    year: int
    month: int

    @property
    def month_key(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"

    @property
    def filename(self) -> str:
        return f"FuelWatchRetail-{self.month:02d}-{self.year:04d}.csv"

    @property
    def url(self) -> str:
        return f"{BASE_URL}/{self.filename}"


class FuelWatchArchive:
    def __init__(self) -> None:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        DB_DIR.mkdir(parents=True, exist_ok=True)
        self._status_lock = threading.Lock()
        self._sync_thread: Optional[threading.Thread] = None
        self._status = {
            "running": False,
            "started_at": None,
            "finished_at": None,
            "current_month": None,
            "checked_months": 0,
            "total_months": 0,
            "downloaded_months": 0,
            "processed_months": 0,
            "failed_months": 0,
            "message": "Idle",
            "last_error": None,
            "last_completed_sync": None,
        }
        self._init_db()
        self._load_last_completed_sync()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def connection(self) -> Iterable[sqlite3.Connection]:
        conn = self._get_connection()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self.connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS daily_stats (
                    date TEXT NOT NULL,
                    fuel_type TEXT NOT NULL,
                    avg_price REAL NOT NULL,
                    min_price REAL NOT NULL,
                    max_price REAL NOT NULL,
                    observations INTEGER NOT NULL,
                    source_month TEXT NOT NULL,
                    PRIMARY KEY (date, fuel_type)
                );

                CREATE INDEX IF NOT EXISTS idx_daily_stats_fuel_date
                    ON daily_stats (fuel_type, date);

                CREATE TABLE IF NOT EXISTS sync_months (
                    month_key TEXT PRIMARY KEY,
                    year INTEGER NOT NULL,
                    month INTEGER NOT NULL,
                    file_name TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    downloaded_at TEXT,
                    processed_at TEXT,
                    file_path TEXT,
                    file_size INTEGER,
                    status TEXT NOT NULL,
                    error TEXT,
                    last_attempt_at TEXT
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                """
            )

    def _load_last_completed_sync(self) -> None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?",
                ("last_completed_sync",),
            ).fetchone()
        if row:
            with self._status_lock:
                self._status["last_completed_sync"] = row["value"]

    def start_background_sync(self, force: bool = False) -> bool:
        if not AUTO_SYNC and not force:
            return False
        with self._status_lock:
            if self._sync_thread and self._sync_thread.is_alive():
                return False
            self._sync_thread = threading.Thread(
                target=self._run_sync,
                kwargs={"force": force},
                name="fuelwatch-sync",
                daemon=True,
            )
            self._sync_thread.start()
            return True

    def get_status(self) -> dict:
        with self._status_lock:
            status = dict(self._status)
        if status["total_months"]:
            status["progress_pct"] = round(
                (status["checked_months"] / status["total_months"]) * 100, 1
            )
        else:
            status["progress_pct"] = 0.0
        return status

    def _set_status(self, **updates: object) -> None:
        with self._status_lock:
            self._status.update(updates)

    def _increment_status(self, field: str, amount: int = 1) -> None:
        with self._status_lock:
            self._status[field] = int(self._status.get(field, 0)) + amount

    def _run_sync(self, force: bool = False) -> None:
        today = date.today()
        months = list(self._iter_months(DEFAULT_START_YEAR, DEFAULT_START_MONTH, today.year, today.month))
        self._set_status(
            running=True,
            started_at=datetime.utcnow().isoformat() + "Z",
            finished_at=None,
            current_month=None,
            checked_months=0,
            total_months=len(months),
            downloaded_months=0,
            processed_months=0,
            failed_months=0,
            message="Preparing sync",
            last_error=None,
        )

        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT})

        try:
            for month_ref in months:
                self._set_status(
                    current_month=month_ref.month_key,
                    message=f"Syncing {month_ref.month_key}",
                )
                try:
                    self._sync_month(session, month_ref, force=force)
                except Exception as exc:  # pragma: no cover - defensive
                    self._increment_status("failed_months")
                    self._set_status(last_error=str(exc))
                    self._record_month_failure(month_ref, str(exc))
                finally:
                    self._increment_status("checked_months")

            completed_at = datetime.utcnow().isoformat() + "Z"
            with self.connection() as conn:
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    ("last_completed_sync", completed_at),
                )
            self._set_status(
                running=False,
                finished_at=completed_at,
                current_month=None,
                message="Sync complete",
                last_completed_sync=completed_at,
            )
        finally:
            session.close()

    def _sync_month(self, session: requests.Session, month_ref: MonthRef, force: bool = False) -> None:
        row = self._get_month_row(month_ref.month_key)
        is_current_month = (month_ref.year == date.today().year and month_ref.month == date.today().month)
        should_refresh_current = False
        if row and row["downloaded_at"] and is_current_month:
            downloaded_at = datetime.fromisoformat(row["downloaded_at"].replace("Z", "+00:00"))
            should_refresh_current = datetime.utcnow() - downloaded_at.replace(tzinfo=None) >= timedelta(
                hours=CURRENT_MONTH_REFRESH_HOURS
            )

        if row and row["status"] == "processed" and not force and not should_refresh_current:
            return

        file_path = self._download_month_csv(session, month_ref)
        if file_path is None:
            self._record_month_failure(month_ref, "File not found (404)", status="missing")
            self._increment_status("failed_months")
            return

        self._increment_status("downloaded_months")
        self._process_month_csv(month_ref, file_path)
        self._increment_status("processed_months")

    def _get_month_row(self, month_key: str) -> Optional[sqlite3.Row]:
        with self.connection() as conn:
            return conn.execute(
                "SELECT * FROM sync_months WHERE month_key = ?",
                (month_key,),
            ).fetchone()

    def _record_month_failure(self, month_ref: MonthRef, error: str, status: str = "failed") -> None:
        now = datetime.utcnow().isoformat() + "Z"
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO sync_months (
                    month_key, year, month, file_name, source_url,
                    downloaded_at, processed_at, file_path, file_size,
                    status, error, last_attempt_at
                ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
                ON CONFLICT(month_key) DO UPDATE SET
                    status = excluded.status,
                    error = excluded.error,
                    last_attempt_at = excluded.last_attempt_at
                """,
                (
                    month_ref.month_key,
                    month_ref.year,
                    month_ref.month,
                    month_ref.filename,
                    month_ref.url,
                    status,
                    error,
                    now,
                ),
            )

    def _download_month_csv(self, session: requests.Session, month_ref: MonthRef) -> Optional[Path]:
        year_dir = RAW_DIR / f"{month_ref.year:04d}"
        year_dir.mkdir(parents=True, exist_ok=True)
        destination = year_dir / month_ref.filename
        temp_file = destination.with_suffix(".tmp")

        response = session.get(month_ref.url, stream=True, timeout=REQUEST_TIMEOUT)
        if response.status_code == 404:
            response.close()
            return None
        response.raise_for_status()

        with temp_file.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 128):
                if chunk:
                    handle.write(chunk)
        response.close()
        temp_file.replace(destination)

        now = datetime.utcnow().isoformat() + "Z"
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO sync_months (
                    month_key, year, month, file_name, source_url,
                    downloaded_at, processed_at, file_path, file_size,
                    status, error, last_attempt_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'downloaded', NULL, ?)
                ON CONFLICT(month_key) DO UPDATE SET
                    downloaded_at = excluded.downloaded_at,
                    file_path = excluded.file_path,
                    file_size = excluded.file_size,
                    status = 'downloaded',
                    error = NULL,
                    last_attempt_at = excluded.last_attempt_at
                """,
                (
                    month_ref.month_key,
                    month_ref.year,
                    month_ref.month,
                    month_ref.filename,
                    month_ref.url,
                    now,
                    str(destination),
                    destination.stat().st_size,
                    now,
                ),
            )
        return destination

    def _process_month_csv(self, month_ref: MonthRef, file_path: Path) -> None:
        aggregates: Dict[Tuple[str, str], Dict[str, float]] = {}
        with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if not row:
                    continue
                raw_date = (row.get("PUBLISH_DATE") or "").strip()
                fuel_type = (row.get("PRODUCT_DESCRIPTION") or "").strip()
                raw_price = (row.get("PRODUCT_PRICE") or "").strip()
                if not raw_date or not fuel_type or not raw_price:
                    continue
                try:
                    parsed_date = datetime.strptime(raw_date, "%d/%m/%Y").date().isoformat()
                    price = float(raw_price)
                except ValueError:
                    continue
                key = (parsed_date, fuel_type)
                bucket = aggregates.setdefault(
                    key,
                    {"sum": 0.0, "count": 0, "min": price, "max": price},
                )
                bucket["sum"] += price
                bucket["count"] += 1
                bucket["min"] = min(bucket["min"], price)
                bucket["max"] = max(bucket["max"], price)

        processed_at = datetime.utcnow().isoformat() + "Z"
        with self.connection() as conn:
            conn.execute(
                "DELETE FROM daily_stats WHERE source_month = ?",
                (month_ref.month_key,),
            )
            rows = [
                (
                    day,
                    fuel,
                    round(values["sum"] / values["count"], 4),
                    values["min"],
                    values["max"],
                    int(values["count"]),
                    month_ref.month_key,
                )
                for (day, fuel), values in sorted(aggregates.items())
            ]
            conn.executemany(
                """
                INSERT OR REPLACE INTO daily_stats (
                    date, fuel_type, avg_price, min_price, max_price,
                    observations, source_month
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.execute(
                """
                INSERT INTO sync_months (
                    month_key, year, month, file_name, source_url,
                    downloaded_at, processed_at, file_path, file_size,
                    status, error, last_attempt_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed', NULL, ?)
                ON CONFLICT(month_key) DO UPDATE SET
                    processed_at = excluded.processed_at,
                    file_path = excluded.file_path,
                    file_size = excluded.file_size,
                    status = 'processed',
                    error = NULL,
                    last_attempt_at = excluded.last_attempt_at
                """,
                (
                    month_ref.month_key,
                    month_ref.year,
                    month_ref.month,
                    month_ref.filename,
                    month_ref.url,
                    processed_at,
                    processed_at,
                    str(file_path),
                    file_path.stat().st_size if file_path.exists() else None,
                    processed_at,
                ),
            )

    def get_metadata(self) -> dict:
        with self.connection() as conn:
            overview = conn.execute(
                """
                SELECT MIN(date) AS min_date,
                       MAX(date) AS max_date,
                       COUNT(*) AS rows
                FROM daily_stats
                """
            ).fetchone()
            fuels = conn.execute(
                """
                SELECT fuel_type,
                       MIN(date) AS first_date,
                       MAX(date) AS last_date,
                       COUNT(*) AS day_count
                FROM daily_stats
                GROUP BY fuel_type
                ORDER BY fuel_type COLLATE NOCASE
                """
            ).fetchall()

        return {
            "min_date": overview["min_date"],
            "max_date": overview["max_date"],
            "rows": overview["rows"],
            "fuel_types": [row["fuel_type"] for row in fuels],
            "fuel_type_coverage": [dict(row) for row in fuels],
        }

    def get_series(
        self,
        fuel_type: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> dict:
        query = (
            "SELECT date, avg_price, min_price, max_price, observations "
            "FROM daily_stats WHERE fuel_type = ?"
        )
        params: List[object] = [fuel_type]
        if start_date:
            query += " AND date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND date <= ?"
            params.append(end_date)
        query += " ORDER BY date"

        with self.connection() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()

        points = [dict(row) for row in rows]
        if not points:
            return {
                "fuel_type": fuel_type,
                "start_date": start_date,
                "end_date": end_date,
                "points": [],
                "summary": None,
            }

        avg_of_avg = round(sum(row["avg_price"] for row in points) / len(points), 3)
        min_low = min(row["min_price"] for row in points)
        max_high = max(row["max_price"] for row in points)
        total_observations = sum(row["observations"] for row in points)

        return {
            "fuel_type": fuel_type,
            "start_date": start_date or points[0]["date"],
            "end_date": end_date or points[-1]["date"],
            "points": points,
            "summary": {
                "range_average": avg_of_avg,
                "range_low": min_low,
                "range_high": max_high,
                "days": len(points),
                "observations": total_observations,
                "first_point": points[0]["date"],
                "last_point": points[-1]["date"],
            },
        }

    def _iter_months(
        self,
        start_year: int,
        start_month: int,
        end_year: int,
        end_month: int,
    ) -> Iterable[MonthRef]:
        year = start_year
        month = start_month
        while (year, month) <= (end_year, end_month):
            yield MonthRef(year=year, month=month)
            month += 1
            if month > 12:
                month = 1
                year += 1
