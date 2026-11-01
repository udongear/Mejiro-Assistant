# Mejiro Assistant: US Racetrack Calendar DB

This folder holds a SQLite database of US racetracks and their 2026–2027 race dates, plus a sync script that keeps it current.

```
racing_calendar.db      ← the database (SQLite 3)
schema.sql              ← tables + views
sync_calendar.py        ← sync script (Python 3.9+, standard library only)
Sync Calendar.bat       ← Windows: double-click to sync; also refreshes ..\calendar-data.js for the website
data/                   ← curated source data (edit these, then sync)
  tracks.csv  meets.csv  meet_dates.csv  events.csv
```

## Quick start on Windows (no typing commands)

1. Install Python once from https://www.python.org/downloads/. On the installer's first screen, tick **"Add python.exe to PATH"**.
2. Unzip this folder, then double-click **`Sync Calendar.bat`**. If Windows shows "Windows protected your PC", click **More info → Run anyway**.
3. Type `1` and press Enter to sync, or `3` to see what's in the database.

To sync automatically every day, use Windows **Task Scheduler**: *Create Basic Task → Daily → Start a program*. Set **Program** to the full path of `Sync Calendar.bat` and **Add arguments** to `auto`. Output goes to `sync.log` in this folder.

## What's in it (as of Oct 29, 2026)

| | |
|---|---|
| Tracks | 101 (36 Thoroughbred, 32 Harness, 30 Mixed TB/QH, 3 Quarter Horse) |
| Meets | 153 (133 for 2026, 20 for 2027) |
| Race days | ~4,200 (Jan 1, 2026 – Dec 31, 2027) |
| Marquee events | 35 (Derby, Preakness, Belmont, Breeders' Cup, Pegasus, etc.) |

Each track has: **name**, **type** (`Thoroughbred` / `Harness` / `Quarter Horse` / `Mixed`), the breeds it races, city/state, time zone, status, and website.

### How sure each date is

Every race day has a `status`. Show them differently in the UI:

| status | meaning |
|---|---|
| `scheduled` | Date is published in an official list (e.g., NM Racing Commission, Kentucky Downs) or is a marquee race day |
| `estimated` | Generated from the meet's published dates and its weekly racing pattern; individual days may be off |
| `confirmed` | Seen on a real race card from The Racing API (only after you run that sync) |
| `cancelled` | Flagged as not run |

Some meets are `range_only`: the season dates are known but the race nights aren't published. They appear in `meets` and `v_meets` but add no rows to `race_days`. Most harness meets are like this; their season dates come from the USTA.

### 2027 coverage

Only what has been officially published as of late Oct 2026:

- **Full 2027 meets:** Kentucky (Churchill, Keeneland, Ellis, Kentucky Downs, Turfway), New Mexico (all 5 tracks, exact dates), Fairmount Park, Sam Houston (TB + QH)
- **Winter 2026-27 meets that run into 2027:** Gulfstream, Tampa Bay, Fair Grounds, Oaklawn, Delta Downs, Turf Paradise, Dover (harness), Fresno (harness)
- **NYRA:** only Belmont Stakes Day (Jun 5) and the Breeders' Cup (Oct 29–30) at Belmont. NYRA's full 2027 calendar comes out in December.
- **Not out yet:** California (CHRB 2027 allocations), Maryland, NY harness, Ohio, Indiana, Pennsylvania, and most other states. These usually publish between November and January. Add them when they appear (see *Updating*).

### Known gaps

- No 2026 dates for: Presque Isle Downs, Arizona Downs, Rillito, Sun Downs, Grants Pass, Gillespie County Fair, the Meadowlands' 9-day turf meet, Delta Downs Jan–Mar 2026, and Dover Jan–Apr 2026.
- Hawthorne closed in July 2026 (bankrupt). Pimlico is closed for rebuilding. Freehold isn't on the USTA's 2026 list.
- For meets that span two years, `planned_days` is the full-meet total, while the calendar only holds days from 2026 on.

---

## Reading it from your site

The three views are all most pages need:

```sql
-- Month calendar
SELECT race_date, track_code, track_name, state, track_type, breed, status, featured_event
FROM v_calendar
WHERE race_date BETWEEN '2027-01-01' AND '2027-01-31'
ORDER BY race_date, track_name;

-- Who's racing on a given day
SELECT track_name, track_type, status FROM v_calendar WHERE race_date = '2026-11-28';

-- Track list with next race day and current meet
SELECT code, name, state, track_type, next_race_date, current_meet FROM v_tracks ORDER BY name;

-- Meets (season bars), including range-only harness meets
SELECT track_name, meet_name, start_date, end_date, phase, date_precision FROM v_meets
WHERE end_date >= date('now') ORDER BY start_date;

-- Marquee days
SELECT * FROM events WHERE event_date >= date('now') ORDER BY event_date;
```

**Node:** `const db = require('better-sqlite3')('racing_calendar.db', { readonly: true }); db.prepare('SELECT * FROM v_calendar WHERE race_date = ?').all('2026-11-28');`
**Python:** `sqlite3.connect('racing_calendar.db').execute('SELECT * FROM v_calendar WHERE race_date = ?', ('2026-11-28',))`
**PHP:** `new PDO('sqlite:racing_calendar.db')`

If the site has no backend, `python3 sync_calendar.py export --out calendar.json` writes everything (tracks, meets, race_days, events) to one JSON file.

Linking to your bets: store `tracks.code` (e.g. `CD`, `SAR`) on each bet/trade row so the bet history can join to the calendar.

---

## Syncing (the script)

```bash
python3 sync_calendar.py status                     # what's in the DB + last syncs
python3 sync_calendar.py sync --source seed         # reload data/*.csv
python3 sync_calendar.py sync --source usta         # refresh harness meet dates from the USTA
python3 sync_calendar.py sync --source racingapi    # confirm actual race cards (paid API)
python3 sync_calendar.py sync --source all          # seed → usta → racingapi (if a key is set)
python3 sync_calendar.py sync --source all --dry-run   # preview, write nothing
python3 sync_calendar.py init --force               # rebuild from scratch
```

### Sources

1. **`seed`** reads the curated CSVs in `data/` (every meet row cites its source URL). To make a remote copy the "master database", host the four CSVs anywhere that serves plain files (a GitHub repo's raw URL, S3, your own server) and run:
   `python3 sync_calendar.py sync --source seed --seed-url https://raw.githubusercontent.com/<you>/<repo>/main/data/`
   or set `MEJIRO_SEED_URL` once. Edit the sheet, and every sync picks up the change.
2. **`usta`** is the [US Trotting Association track list](https://www.ustrotting.com/track-information/). It covers every active US harness track and its meet dates, and it's free. It updates meet ranges and adds new meets. The parser was checked against the live page's markup on Oct 29, 2026. If the page layout changes, it aborts without changing anything.
3. **`racingapi`** is [The Racing API](https://www.theracingapi.com) North America add-on (needs the Standard plan; the add-on was £49.99/month when checked). Set `RACINGAPI_USERNAME` and `RACINGAPI_PASSWORD`. By default it checks 3 days back to 7 days ahead and marks the cards it finds `confirmed`. With `--mark-missing`, it marks past expected days that the API never listed as `cancelled`. The API's response format wasn't publicly documented, so the parser is tolerant. Run it with `--dry-run` first, and add any unmatched track names it reports to `aliases` in `tracks.csv`.

Equibase was **not** used: its terms prohibit automated scraping.

### Scheduling

- **cron (Linux/macOS):** `15 6 * * * cd /path/to/calendar && /usr/bin/python3 sync_calendar.py sync --source all >> sync.log 2>&1`
- **Windows Task Scheduler:** Action = `python`, Arguments = `sync_calendar.py sync --source all`, Start in = this folder.

Weekly is plenty for `seed`/`usta`. Run daily if you use `racingapi`.

### Safety rules the sync follows

- Each source runs in its own transaction. A failure rolls back and is logged in `sync_runs`.
- Rows with `locked = 1` are never modified. Use this for manual fixes: `UPDATE race_days SET locked=1, status='cancelled', notes='weather' WHERE ...`
- `confirmed`/`cancelled` rows from the API are never overwritten by seed or USTA data.
- Meets whose dates were updated by the USTA keep those dates on later seed syncs (`--force` overrides).
- Christmas Day is never generated from a weekly pattern.

## Updating the calendar by hand

1. Add or edit a row in `data/meets.csv`:
   - `race_weekdays`: `Thu,Fri,Sat,Sun`, or segments for mid-meet changes: `2027-01-01..2027-02-14=Fri,Sat|2027-02-15..2027-04-03=Thu,Fri,Sat`
   - `extra_dates` / `dark_dates`: `;`-separated dates added to or removed from the pattern
   - `date_precision`: `exact` (list every date in `meet_dates.csv`), `pattern`, or `range_only`
   - `status`: `approved`, `announced`, `tentative`, `ended_early`, or `cancelled`
2. Run `python3 sync_calendar.py sync --source seed`. It validates the CSVs and refuses to load bad rows.

New track: add it to `tracks.csv` (give harness tracks their USTA code in `usta_code`), then add its meets.
