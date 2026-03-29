# FuelWatch History Explorer

A Docker-friendly web app for browsing Western Australia FuelWatch historical retail prices using the direct monthly CSV archive pattern.

## What it does

- Downloads monthly FuelWatch retail CSV files from January 2001 onward.
- Aggregates the archive into statewide daily summaries by fuel type.
- Stores processed results in SQLite for fast chart loading.
- Automatically checks for updates each day and refreshes only the months that need re-checking.
- Keeps the latest processed month and the current month fresh without re-downloading the entire archive.
- Retries any previously missed or failed months during normal update runs.
- Displays a clean browser dashboard with:
  - fuel type selector
  - date range selector
  - 1Y / 5Y / 10Y / All presets
  - daily average / low / high line overlays
  - range summary cards
  - drag-to-zoom chart filtering
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
- container: `8095`

Persistent volume:

- `fuelwatch-data`

## How syncing works

### First startup

The first startup runs a full historical import from January 2001 onward.

The UI still loads immediately and shows sync progress while data is being imported.

### Daily automatic updates

After the initial load, the app automatically checks for updates every day.

The normal update flow:

- starts from the latest successfully processed month
- re-checks that month to catch any partial or missed data
- refreshes the current month so new daily records appear
- retries any older months that were previously missed or failed
- de-duplicates by replacing the stored aggregate rows for any month it reprocesses

### Manual update button

The **Check for updates** button does an incremental catch-up update. It does **not** force a full archive rebuild.

If you ever want a full archive rebuild through the API, you can call:

```text
POST /api/sync?full=true
```

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `FUELWATCH_AUTO_SYNC` | `true` | Start archive sync automatically on app startup |
| `FUELWATCH_CURRENT_MONTH_REFRESH_HOURS` | `24` | Minimum age before the current month file is refreshed again |
| `FUELWATCH_DAILY_SYNC_HOURS` | `24` | How often the background scheduler checks for updates |
| `FUELWATCH_SCHEDULER_POLL_SECONDS` | `60` | How often the scheduler wakes up to see if the next update run is due |
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
- `POST /api/sync`
- `POST /api/sync?full=true`
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
