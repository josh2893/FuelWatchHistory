from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .archive import FuelWatchArchive

app = FastAPI(title="FuelWatch History")
archive = FuelWatchArchive()
STATIC_DIR = Path(__file__).resolve().parent / "static"


@app.on_event("startup")
def startup_event() -> None:
    archive.start_scheduler()
    archive.start_background_sync()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/status")
def status() -> dict:
    return archive.get_status()


@app.post("/api/sync")
def trigger_sync(force: bool = False, full: bool = False) -> dict:
    started = archive.start_background_sync(force=force, full=full)
    return {"started": started, "status": archive.get_status()}


@app.get("/api/metadata")
def metadata() -> dict:
    return archive.get_metadata()


@app.get("/api/series")
def series(
    fuel_type: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> dict:
    try:
        if start_date:
            date.fromisoformat(start_date)
        if end_date:
            date.fromisoformat(end_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Dates must be in YYYY-MM-DD format") from exc

    result = archive.get_series(
        fuel_type=fuel_type,
        start_date=start_date,
        end_date=end_date,
    )
    if not result["points"]:
        raise HTTPException(status_code=404, detail="No data found for that fuel type and date range")
    return result


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
