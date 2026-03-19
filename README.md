# FuelWatch History Explorer

A Docker-friendly web app for browsing Western Australia FuelWatch historical retail prices using the direct monthly CSV archive pattern.

## What it does

- Downloads monthly FuelWatch retail CSV files from January 2001 onward.
- Aggregates the archive into statewide daily summaries by fuel type.
- Stores processed results in SQLite for fast chart loading.
- Displays a clean browser dashboard with:
  - fuel type selector
  - date range selector
  - 1Y / 5Y / 10Y / All presets
  - daily average / low / high line overlays
  - range summary cards
  - sync progress banner while the archive is updating

## Stack

- FastAPI backend
- Vanilla HTML / CSS / JavaScript frontend
- SQLite for aggregated storage
- Single-container Docker deployment

## Run locally

```bash
docker compose up --build
```

Then browse to:

```text
http://localhost:8095
```

## Portainer / GitHub deployment

This repo is designed to work as a Portainer stack from GitHub.

Use the included `docker-compose.yml`.

Default port mapping:

- host: `8095`
- container: `8000`

Persistent volume:

- `fuelwatch-data`

## Notes on first sync

The first startup can take a while because it needs to fetch and process the archive from January 2001 onward.

The UI still loads immediately and shows sync progress while data is being imported.

Past months are cached after processing. The current month is refreshed on a schedule so the chart stays current.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `FUELWATCH_AUTO_SYNC` | `true` | Start archive sync automatically on app startup |
| `FUELWATCH_CURRENT_MONTH_REFRESH_HOURS` | `12` | Refresh cadence for the current month |
| `FUELWATCH_REQUEST_TIMEOUT` | `60` | HTTP timeout in seconds for monthly CSV downloads |
| `FUELWATCH_DATA_DIR` | `/app/data` | Root path for raw files and database |

## Data model

The app stores aggregated daily results with:

- `date`
- `fuel_type`
- `avg_price`
- `min_price`
- `max_price`
- `observations`
- `source_month`

This keeps the app fast and avoids reprocessing the full raw archive for every chart request.

## API endpoints

- `GET /api/health`
- `GET /api/status`
- `POST /api/sync?force=true`
- `GET /api/metadata`
- `GET /api/series?fuel_type=ULP&start_date=2016-01-01&end_date=2026-03-01`

## Repo structure

```text
app/
  archive.py
  main.py
  static/
    index.html
    styles.css
    app.js
data/
  raw/
  db/
Dockerfile
docker-compose.yml
requirements.txt
README.md
```
