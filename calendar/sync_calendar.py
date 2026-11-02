#!/usr/bin/env python3
"""
Mejiro Assistant - US racetrack calendar sync
=============================================

Builds and refreshes ``racing_calendar.db`` (SQLite). It uses only the Python
standard library (Python 3.9+); there is nothing to pip install.

Commands
--------
  python sync_calendar.py init                         # create the DB and load the seed data
  python sync_calendar.py sync --source seed           # reload data/*.csv (or --seed-url)
  python sync_calendar.py sync --source usta           # refresh harness meet dates from USTA
  python sync_calendar.py sync --source racingapi      # confirm real race cards (needs API key)
  python sync_calendar.py sync --source all            # seed -> usta -> racingapi (if configured)
  python sync_calendar.py status                       # counts + last sync runs
  python sync_calendar.py export --out calendar.json   # JSON copy for static front ends

Add --dry-run to any sync to see what would change without writing.

Data sources
------------
seed       The curated CSVs in ./data (tracks, meets, meet_dates, events). Point
           --seed-url (or MEJIRO_SEED_URL) at a folder URL that serves the same
           four CSV files, such as a GitHub raw folder or your own server, and the
           script pulls from there instead.
usta       https://www.ustrotting.com/track-information/ - the US Trotting
           Association's list of active harness tracks and their meet dates.
racingapi  The Racing API, North America add-on
           (GET https://api.theracingapi.com/v1/north-america/meets). Set
           RACINGAPI_USERNAME and RACINGAPI_PASSWORD. It marks days as
           'confirmed' and can flag cancelled cards (--mark-missing).

Race-day statuses
-----------------
scheduled  date published in an official list (exact)
estimated  generated from the meet's weekday pattern (show it differently in the UI)
confirmed  seen on a real race card from the API
cancelled  flagged as not run

Rows with locked = 1 are never modified by any sync, so use that for manual fixes.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import html
import html.parser
import io
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Iterable

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE / "racing_calendar.db"
DEFAULT_SCHEMA = HERE / "schema.sql"
DEFAULT_SEED_DIR = HERE / "data"
SCHEMA_VERSION = "1"

# Race days are only materialised inside this window (keeps the DB focused).
CALENDAR_START = dt.date(2026, 1, 1)
CALENDAR_END = dt.date(2027, 12, 31)

WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
# Pattern-generated days never fall on these (MM-DD). Explicit/extra dates still can.
GLOBAL_DARK_MMDD = {"12-25"}

USER_AGENT = "MejiroAssistant-CalendarSync/1.0 (personal betting-tracker calendar)"
SEED_FILES = ("tracks.csv", "meets.csv", "meet_dates.csv", "events.csv")


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def parse_date(value: str) -> dt.date:
    return dt.date.fromisoformat(value.strip()[:10])


def date_list(value: str | None) -> list[dt.date]:
    if not value:
        return []
    return [parse_date(v) for v in re.split(r"[;,\s]+", value.strip()) if v]


def daterange(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    day = start
    while day <= end:
        yield day
        day += dt.timedelta(days=1)


def parse_weekday_set(spec: str) -> set[int]:
    days = set()
    for token in spec.split(","):
        token = token.strip().lower()[:3]
        if not token:
            continue
        if token not in WEEKDAYS:
            raise ValueError(f"Unknown weekday '{token}' in '{spec}'")
        days.add(WEEKDAYS[token])
    return days


def weekday_matcher(spec: str | None) -> Callable[[dt.date], bool] | None:
    """Return f(date)->bool for a race_weekdays spec, or None when unknown.

    Accepted forms:
      "Thu,Fri,Sat,Sun"
      "2026-01-01..2026-02-15=Thu,Fri,Sat,Sun|2026-02-16..2026-03-29=Fri,Sat,Sun"
    With segments, a date outside every segment is not a race day.
    """
    if not spec or not spec.strip():
        return None
    spec = spec.strip()
    if "=" not in spec:
        days = parse_weekday_set(spec)
        return lambda d: d.weekday() in days
    segments = []
    for part in spec.split("|"):
        rng, days = part.split("=", 1)
        a, b = rng.split("..")
        segments.append((parse_date(a), parse_date(b), parse_weekday_set(days)))

    def match(d: dt.date) -> bool:
        return any(a <= d <= b and d.weekday() in days for a, b, days in segments)

    return match


def norm_name(value: str) -> str:
    value = value.lower().replace("&", " and ").replace("'", "")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def http_get(url: str, headers: dict | None = None, timeout: int = 30, retries: int = 2) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (401, 403, 404):
                raise
            last_err = err
        except (urllib.error.URLError, TimeoutError) as err:
            last_err = err
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last_err}")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_schema(conn: sqlite3.Connection, schema_path: Path = DEFAULT_SCHEMA) -> None:
    # Columns added after the first release. Add them before schema.sql rebuilds the views that use them.
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tracks'").fetchone():
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
        if "youtube" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN youtube TEXT")
        if "livestream" not in cols:
            conn.execute("ALTER TABLE tracks ADD COLUMN livestream INTEGER NOT NULL DEFAULT 0")
    conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('calendar_window', ?)",
                 (f"{CALENDAR_START}..{CALENDAR_END}",))


def track_ids_by_code(conn: sqlite3.Connection) -> dict[str, int]:
    return {r["code"]: r["track_id"] for r in conn.execute("SELECT track_id, code FROM tracks")}


def default_breed(track_type: str) -> str:
    return {"Harness": "Standardbred", "Quarter Horse": "Quarter Horse",
            "Mixed": "Mixed"}.get(track_type, "Thoroughbred")


class Stats(dict):
    def bump(self, key: str, n: int = 1) -> None:
        if n:
            self[key] = self.get(key, 0) + n

    def text(self) -> str:
        return ", ".join(f"{k}={v}" for k, v in sorted(self.items())) or "no changes"


# --------------------------------------------------------------------------
# Meet -> race days
# --------------------------------------------------------------------------
def expand_meet(meet: sqlite3.Row, explicit: list[dt.date],
                window: tuple[dt.date, dt.date] = (CALENDAR_START, CALENDAR_END)) -> tuple[list[dt.date], str]:
    """Return (dates, status) for a meet. status is 'scheduled' or 'estimated'."""
    lo, hi = window
    if meet["date_precision"] == "exact":
        return sorted(d for d in explicit if lo <= d <= hi), "scheduled"
    if meet["date_precision"] == "range_only":
        return [], "estimated"
    matcher = weekday_matcher(meet["race_weekdays"])
    if matcher is None:
        return [], "estimated"
    start, end = parse_date(meet["start_date"]), parse_date(meet["end_date"])
    dark = set(date_list(meet["dark_dates"]))
    days = {d for d in daterange(max(start, lo), min(end, hi))
            if matcher(d) and d not in dark and d.strftime("%m-%d") not in GLOBAL_DARK_MMDD}
    days |= {d for d in date_list(meet["extra_dates"]) if lo <= d <= hi}
    return sorted(days), "estimated"


def rebuild_race_days(conn: sqlite3.Connection, stats: Stats, meet_ids: list[int] | None = None,
                      sources_owned: tuple[str, ...] = ("seed", "usta")) -> None:
    """Make race_days match the meets' calendars, without touching confirmed,
    cancelled, locked, or API-sourced rows."""
    sql = "SELECT * FROM meets"
    params: tuple = ()
    if meet_ids is not None:
        if not meet_ids:
            return
        sql += f" WHERE meet_id IN ({','.join('?' * len(meet_ids))})"
        params = tuple(meet_ids)
    # Published marquee race days (events table) count as scheduled even inside pattern meets.
    event_days: set[tuple[int, str]] = set()
    for e in conn.execute("SELECT track_id, event_date, COALESCE(end_date, event_date) AS last FROM events"):
        for d in daterange(parse_date(e["event_date"]), parse_date(e["last"])):
            event_days.add((e["track_id"], d.isoformat()))
    for meet in conn.execute(sql, params).fetchall():
        explicit = [parse_date(r["race_date"]) for r in
                    conn.execute("SELECT race_date FROM meet_dates WHERE meet_id = ?", (meet["meet_id"],))]
        desired_dates, base_status = expand_meet(meet, explicit)
        desired = {d.isoformat() for d in desired_dates}
        status_of = lambda day: "scheduled" if (meet["track_id"], day) in event_days else base_status  # noqa: E731
        if meet["status"] == "cancelled":
            desired = set()
        source = meet["origin"] if meet["origin"] in sources_owned else "seed"

        existing = {r["race_date"]: r for r in conn.execute(
            "SELECT * FROM race_days WHERE meet_id = ?", (meet["meet_id"],))}

        for day in sorted(desired):
            row = existing.get(day)
            if row is None:
                other = conn.execute(
                    "SELECT * FROM race_days WHERE track_id = ? AND race_date = ? AND breed = ?",
                    (meet["track_id"], day, meet["breed"])).fetchone()
                if other is not None:
                    # Day already known (e.g. from the API or another meet): just link it.
                    if other["meet_id"] is None:
                        conn.execute("UPDATE race_days SET meet_id = ?, updated_at = datetime('now') "
                                     "WHERE race_day_id = ?", (meet["meet_id"], other["race_day_id"]))
                        stats.bump("race_days_linked")
                    continue
                conn.execute(
                    "INSERT INTO race_days(track_id, meet_id, race_date, breed, status, source) "
                    "VALUES (?,?,?,?,?,?)",
                    (meet["track_id"], meet["meet_id"], day, meet["breed"], status_of(day), source))
                stats.bump("race_days_added")
            elif (not row["locked"] and row["source"] in sources_owned
                  and row["status"] in ("scheduled", "estimated") and row["status"] != status_of(day)):
                conn.execute("UPDATE race_days SET status = ?, updated_at = datetime('now') "
                             "WHERE race_day_id = ?", (status_of(day), row["race_day_id"]))
                stats.bump("race_days_restatused")

        for day, row in existing.items():
            if day in desired or row["locked"]:
                continue
            if row["source"] in sources_owned and row["status"] in ("scheduled", "estimated"):
                conn.execute("DELETE FROM race_days WHERE race_day_id = ?", (row["race_day_id"],))
                stats.bump("race_days_removed")


# --------------------------------------------------------------------------
# Source: seed CSVs (local folder or remote URL)
# --------------------------------------------------------------------------
class SeedSource:
    name = "seed"

    def __init__(self, seed_dir: Path = DEFAULT_SEED_DIR, seed_url: str | None = None,
                 prune: bool = False, force: bool = False):
        self.seed_dir = seed_dir
        self.seed_url = seed_url.rstrip("/") + "/" if seed_url else None
        self.prune = prune
        self.force = force

    def read(self, filename: str) -> list[dict]:
        if self.seed_url:
            text = http_get(urllib.parse.urljoin(self.seed_url, filename)).decode("utf-8-sig")
        else:
            text = (self.seed_dir / filename).read_text(encoding="utf-8-sig")
        return [{k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
                for row in csv.DictReader(io.StringIO(text))]

    def run(self, conn: sqlite3.Connection, stats: Stats) -> None:
        tracks, meets, meet_dates, events = (self.read(f) for f in SEED_FILES)
        self._validate(tracks, meets, meet_dates, events)

        for t in tracks:
            cur = conn.execute(
                """INSERT INTO tracks(code, name, city, state, track_type, breeds, timezone, status,
                                      usta_code, website, youtube, livestream, aliases, notes)
                   VALUES (:code,:name,:city,:state,:track_type,:breeds,:timezone,:status,
                           :usta_code,:website,:youtube,:livestream,:aliases,:notes)
                   ON CONFLICT(code) DO UPDATE SET
                     name=excluded.name, city=excluded.city, state=excluded.state,
                     track_type=excluded.track_type, breeds=excluded.breeds, timezone=excluded.timezone,
                     status=excluded.status, usta_code=excluded.usta_code, website=excluded.website,
                     youtube=excluded.youtube, livestream=excluded.livestream,
                     aliases=excluded.aliases, notes=excluded.notes, updated_at=datetime('now')
                   WHERE tracks.name IS NOT excluded.name OR tracks.status IS NOT excluded.status
                      OR tracks.notes IS NOT excluded.notes OR tracks.aliases IS NOT excluded.aliases
                      OR tracks.track_type IS NOT excluded.track_type OR tracks.breeds IS NOT excluded.breeds
                      OR tracks.website IS NOT excluded.website OR tracks.usta_code IS NOT excluded.usta_code
                      OR tracks.youtube IS NOT excluded.youtube OR tracks.livestream IS NOT excluded.livestream
                      OR tracks.city IS NOT excluded.city OR tracks.timezone IS NOT excluded.timezone""",
                {k: (t.get(k) or None) for k in ("code", "name", "city", "state", "track_type", "breeds",
                                                  "timezone", "status", "usta_code", "website", "youtube",
                                                  "aliases", "notes")}
                | {"status": t.get("status") or "active",
                   "livestream": 1 if (t.get("livestream") or "").lower() in ("yes", "1", "true") else 0})
            stats.bump("tracks_upserted", cur.rowcount)

        ids = track_ids_by_code(conn)
        touched: list[int] = []
        for m in meets:
            params = {
                "meet_key": m["meet_key"], "track_id": ids[m["track_code"]], "name": m["name"],
                "breed": m["breed"], "season_year": int(m["season_year"]),
                "start_date": m["start_date"], "end_date": m["end_date"],
                "race_weekdays": m.get("race_weekdays") or None,
                "planned_days": int(m["planned_days"]) if m.get("planned_days") else None,
                "status": m["status"], "date_precision": m["date_precision"],
                "extra_dates": m.get("extra_dates") or None, "dark_dates": m.get("dark_dates") or None,
                "source_name": m.get("source_name") or None, "source_url": m.get("source_url") or None,
                "notes": m.get("notes") or None,
            }
            existing = conn.execute("SELECT meet_id, origin FROM meets WHERE meet_key = ?",
                                    (m["meet_key"],)).fetchone()
            if existing is None:
                cur = conn.execute(
                    """INSERT INTO meets(meet_key, track_id, name, breed, season_year, start_date, end_date,
                         race_weekdays, planned_days, status, date_precision, extra_dates, dark_dates,
                         source_name, source_url, notes, origin)
                       VALUES (:meet_key,:track_id,:name,:breed,:season_year,:start_date,:end_date,
                         :race_weekdays,:planned_days,:status,:date_precision,:extra_dates,:dark_dates,
                         :source_name,:source_url,:notes,'seed')""", params)
                touched.append(cur.lastrowid)
                stats.bump("meets_added")
            elif existing["origin"] == "seed" or self.force:
                cur = conn.execute(
                    """UPDATE meets SET track_id=:track_id, name=:name, breed=:breed, season_year=:season_year,
                         start_date=:start_date, end_date=:end_date, race_weekdays=:race_weekdays,
                         planned_days=:planned_days, status=:status, date_precision=:date_precision,
                         extra_dates=:extra_dates, dark_dates=:dark_dates, source_name=:source_name,
                         source_url=:source_url, notes=:notes, origin='seed', updated_at=datetime('now')
                       WHERE meet_key=:meet_key AND (
                         name IS NOT :name OR breed IS NOT :breed OR start_date IS NOT :start_date
                         OR end_date IS NOT :end_date OR race_weekdays IS NOT :race_weekdays
                         OR planned_days IS NOT :planned_days OR status IS NOT :status
                         OR date_precision IS NOT :date_precision OR extra_dates IS NOT :extra_dates
                         OR dark_dates IS NOT :dark_dates OR notes IS NOT :notes OR source_url IS NOT :source_url
                         OR origin IS NOT 'seed' OR track_id IS NOT :track_id)""", params)
                if cur.rowcount:
                    stats.bump("meets_updated")
                touched.append(existing["meet_id"])
            else:
                # A live source (e.g. USTA) owns this meet's dates; keep them.
                touched.append(existing["meet_id"])
                stats.bump("meets_kept_from_" + existing["origin"])

        # Explicit dates: replace per meet.
        meet_id_by_key = {r["meet_key"]: r["meet_id"] for r in conn.execute("SELECT meet_id, meet_key FROM meets")}
        by_meet: dict[int, list[tuple[str, str]]] = {}
        for r in meet_dates:
            by_meet.setdefault(meet_id_by_key[r["meet_key"]], []).append((r["race_date"], r.get("note") or None))
        for meet_id, rows in by_meet.items():
            current = {(r["race_date"], r["note"]) for r in
                       conn.execute("SELECT race_date, note FROM meet_dates WHERE meet_id = ?", (meet_id,))}
            if current != set(rows):
                conn.execute("DELETE FROM meet_dates WHERE meet_id = ?", (meet_id,))
                conn.executemany("INSERT INTO meet_dates(meet_id, race_date, note) VALUES (?,?,?)",
                                 [(meet_id, d, n) for d, n in rows])
                stats.bump("meet_date_sets_replaced")

        if self.prune:
            keys = {m["meet_key"] for m in meets}
            for r in conn.execute("SELECT meet_id, meet_key FROM meets WHERE origin = 'seed'").fetchall():
                if r["meet_key"] not in keys:
                    conn.execute("DELETE FROM race_days WHERE meet_id = ? AND locked = 0 "
                                 "AND status IN ('scheduled','estimated')", (r["meet_id"],))
                    conn.execute("DELETE FROM meets WHERE meet_id = ?", (r["meet_id"],))
                    stats.bump("meets_pruned")

        for e in events:
            cur = conn.execute(
                """INSERT INTO events(event_key, track_id, event_date, end_date, name, grade, notes, source_url)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(event_key) DO UPDATE SET track_id=excluded.track_id,
                     event_date=excluded.event_date, end_date=excluded.end_date, name=excluded.name,
                     grade=excluded.grade, notes=excluded.notes, source_url=excluded.source_url,
                     updated_at=datetime('now')
                   WHERE events.event_date IS NOT excluded.event_date OR events.name IS NOT excluded.name
                      OR events.end_date IS NOT excluded.end_date OR events.notes IS NOT excluded.notes
                      OR events.grade IS NOT excluded.grade OR events.track_id IS NOT excluded.track_id""",
                (e["event_key"], ids[e["track_code"]], e["event_date"], e.get("end_date") or None, e["name"],
                 e.get("grade") or None, e.get("notes") or None, e.get("source_url") or None))
            stats.bump("events_upserted", cur.rowcount)

        rebuild_race_days(conn, stats, touched)

    @staticmethod
    def _validate(tracks, meets, meet_dates, events) -> None:
        errors = []
        codes = {t["code"] for t in tracks}
        if len(codes) != len(tracks):
            errors.append("duplicate track codes in tracks.csv")
        keys = set()
        for m in meets:
            k = m["meet_key"]
            if k in keys:
                errors.append(f"duplicate meet_key {k}")
            keys.add(k)
            if m["track_code"] not in codes:
                errors.append(f"{k}: unknown track_code {m['track_code']}")
            try:
                if parse_date(m["start_date"]) > parse_date(m["end_date"]):
                    errors.append(f"{k}: start_date after end_date")
                weekday_matcher(m.get("race_weekdays"))
                date_list(m.get("extra_dates"))
                date_list(m.get("dark_dates"))
            except ValueError as err:
                errors.append(f"{k}: {err}")
            if m["date_precision"] == "pattern" and not m.get("race_weekdays"):
                errors.append(f"{k}: date_precision 'pattern' needs race_weekdays")
        for r in meet_dates:
            if r["meet_key"] not in keys:
                errors.append(f"meet_dates: unknown meet_key {r['meet_key']}")
            else:
                try:
                    parse_date(r["race_date"])
                except ValueError:
                    errors.append(f"meet_dates: bad date {r['race_date']} for {r['meet_key']}")
        for e in events:
            if e["track_code"] not in codes:
                errors.append(f"events: unknown track_code {e['track_code']} ({e['event_key']})")
        if errors:
            raise ValueError("Seed data problems:\n  - " + "\n  - ".join(errors))


# --------------------------------------------------------------------------
# Source: USTA harness track list
# --------------------------------------------------------------------------
class _TextExtractor(html.parser.HTMLParser):
    """HTML -> text where each table row / block becomes one line and cells are ' | ' separated."""
    LINE = {"p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section",
            "article", "ul", "ol", "dl", "dt", "dd"}
    CELL = {"td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1
        elif tag in self.LINE:
            self.parts.append("\n")
        elif tag in self.CELL:
            self.parts.append(" | ")
        elif tag == "br":
            self.parts.append(" ; ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg"):
            self._skip = max(0, self._skip - 1)
        elif tag in self.LINE:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(raw: str) -> str:
    parser = _TextExtractor()
    parser.feed(raw)
    text = html.unescape("".join(parser.parts))
    lines = (" ".join(line.split()).strip(" |;") for line in text.splitlines())
    return "\n".join(line for line in lines if line)


class UstaSource:
    """Reads the USTA 'Track Information' page (harness meet dates for every US track).

    The parser does not depend on the page's exact markup. It turns the page into
    lines (one per table row or block). Every line with 'MM/DD/YYYY - MM/DD/YYYY'
    ranges is tied to a track by (1) a '(Code)' that matches tracks.usta_code,
    (2) a known track name or alias in the line, or (3) the nearest track named
    on an earlier line.
    """
    name = "usta"
    URL = "https://www.ustrotting.com/track-information/"
    CODE_RE = re.compile(r"\(([A-Za-z]{1,8})\)")
    RANGE_RE = re.compile(r"(\d{1,2}/\d{1,2}/\d{4})\s*(?:-|–|—|to)\s*(\d{1,2}/\d{1,2}/\d{4})")
    MIN_TRACKS = 10  # fewer matches than this means the page layout changed: abort without changes

    def __init__(self, html_text: str | None = None):
        self.html_text = html_text

    @staticmethod
    def build_index(conn: sqlite3.Connection) -> tuple[dict, list]:
        by_code, by_name = {}, []
        for t in conn.execute("SELECT * FROM tracks WHERE track_type IN ('Harness','Mixed') OR usta_code IS NOT NULL"):
            if t["usta_code"]:
                by_code[t["usta_code"].lower()] = t
            for n in {t["name"]} | set(filter(None, (t["aliases"] or "").split("|"))):
                if len(norm_name(n)) >= 4:
                    by_name.append((norm_name(n), t))
        by_name.sort(key=lambda x: -len(x[0]))
        return by_code, by_name

    @classmethod
    def parse(cls, raw_html: str, by_code: dict, by_name: list) -> tuple[list[tuple], list[str]]:
        """Return ([(track_row, start, end), ...], [unmatched line, ...])."""
        results, unmatched = [], []
        current, current_line = None, -99
        unknown, unknown_line = None, -99
        for idx, line in enumerate(html_to_text(raw_html).splitlines()):
            if idx - current_line > 3:  # a track name only carries over to the next few lines
                current = None
            codes = cls.CODE_RE.findall(line)
            track = next((by_code[c.lower()] for c in codes if c.lower() in by_code), None)
            if track is None:
                key = norm_name(line)
                track = next((t for n, t in by_name if re.search(rf"\b{re.escape(n)}\b", key)), None)
            ranges = cls.RANGE_RE.findall(line)
            if track is not None:
                current, current_line = track, idx
                unknown = None
            elif codes:
                # Names some other track ("Name (Code)") that we don't know: never misattribute
                # its dates to the previous track; report it instead.
                current, unknown, unknown_line = None, line, idx
            if ranges and current is None:
                if unknown is not None and idx - unknown_line <= 3:
                    label = unknown if unknown == line else f"{unknown} {' '.join('-'.join(r) for r in ranges)}"
                    unmatched.append(label[:140])
                    unknown = None
                continue
            if not ranges:
                continue
            for a, b in ranges:
                start = dt.datetime.strptime(a, "%m/%d/%Y").date()
                end = dt.datetime.strptime(b, "%m/%d/%Y").date()
                if start <= end:
                    results.append((current, start, end))
        return results, unmatched

    def run(self, conn: sqlite3.Connection, stats: Stats) -> None:
        raw = self.html_text if self.html_text is not None else http_get(self.URL).decode("utf-8", "replace")
        by_code, by_name = self.build_index(conn)
        ranges, unmatched = self.parse(raw, by_code, by_name)
        matched_tracks = {t["track_id"] for t, _, _ in ranges}
        if len(matched_tracks) < self.MIN_TRACKS:
            raise RuntimeError(f"USTA page matched only {len(matched_tracks)} tracks; the layout may have "
                               "changed. No changes made.")
        touched: list[int] = []
        seen = set()
        for track, start, end in ranges:
            if (track["track_id"], start, end) in seen or end < CALENDAR_START or start > CALENDAR_END:
                continue
            seen.add((track["track_id"], start, end))
            touched.extend(self._apply_range(conn, track, start, end, stats))
        stats["usta_tracks_matched"] = len(matched_tracks)
        if unmatched:
            stats["usta_unmatched"] = len(unmatched)
            log("  USTA rows for tracks not in tracks.csv (add them with a usta_code):\n    " +
                "\n    ".join(unmatched))
        rebuild_race_days(conn, stats, sorted(set(touched)))

    def _apply_range(self, conn, track, start: dt.date, end: dt.date, stats: Stats) -> list[int]:
        s, e = start.isoformat(), end.isoformat()
        overlapping = conn.execute(
            """SELECT * FROM meets WHERE track_id = ? AND breed = 'Standardbred'
               AND start_date <= ? AND end_date >= ? ORDER BY start_date""",
            (track["track_id"], e, s)).fetchall()
        if overlapping:
            meet = overlapping[0]
            if (meet["start_date"], meet["end_date"]) == (s, e):
                return [meet["meet_id"]]
            conn.execute(
                """UPDATE meets SET start_date = ?, end_date = ?, origin = 'usta',
                     source_name = 'USTA', source_url = ?, updated_at = datetime('now'),
                     notes = trim(COALESCE(notes, '') || ' [USTA dates updated ' || date('now') || ']')
                   WHERE meet_id = ?""", (s, e, self.URL, meet["meet_id"]))
            stats.bump("meets_updated")
            return [meet["meet_id"]]
        # New meet. Re-use the weekday pattern of the track's most recent harness meet, if any.
        prev = conn.execute(
            """SELECT race_weekdays FROM meets WHERE track_id = ? AND breed = 'Standardbred'
               AND race_weekdays IS NOT NULL AND race_weekdays NOT LIKE '%=%'
               ORDER BY end_date DESC LIMIT 1""", (track["track_id"],)).fetchone()
        weekdays = prev["race_weekdays"] if prev else None
        cur = conn.execute(
            """INSERT INTO meets(meet_key, track_id, name, breed, season_year, start_date, end_date,
                 race_weekdays, status, date_precision, source_name, source_url, notes, origin)
               VALUES (?,?,?,?,?,?,?,?,'approved',?,'USTA',?,?, 'usta')""",
            (f"{track['code']}-{start:%Y%m%d}-USTA", track["track_id"],
             f"Live Racing {start.year}" + (f"-{str(end.year)[2:]}" if end.year != start.year else ""),
             "Standardbred", start.year, s, e, weekdays, "pattern" if weekdays else "range_only",
             self.URL, "Created by USTA sync"))
        stats.bump("meets_added")
        return [cur.lastrowid]


# --------------------------------------------------------------------------
# Source: The Racing API (North America add-on)
# --------------------------------------------------------------------------
class RacingApiSource:
    name = "racingapi"
    URL = "https://api.theracingapi.com/v1/north-america/meets"
    PAGE = 50

    def __init__(self, start: dt.date, end: dt.date, username: str | None = None, password: str | None = None,
                 mark_missing: bool = False, payload_pages: list[dict] | None = None):
        self.start, self.end = start, end
        self.username = username or os.environ.get("RACINGAPI_USERNAME")
        self.password = password or os.environ.get("RACINGAPI_PASSWORD")
        self.mark_missing = mark_missing
        self.payload_pages = payload_pages  # for tests / offline use

    @property
    def configured(self) -> bool:
        return bool(self.payload_pages is not None or (self.username and self.password))

    def fetch(self) -> list[dict]:
        if self.payload_pages is not None:
            pages = self.payload_pages
        else:
            if not (self.username and self.password):
                raise RuntimeError("Set RACINGAPI_USERNAME and RACINGAPI_PASSWORD to use the racingapi source.")
            token = base64.b64encode(f"{self.username}:{self.password}".encode()).decode()
            pages, skip = [], 0
            while True:
                q = urllib.parse.urlencode({"start_date": self.start.isoformat(), "end_date": self.end.isoformat(),
                                            "limit": self.PAGE, "skip": skip})
                body = json.loads(http_get(f"{self.URL}?{q}", headers={"Authorization": f"Basic {token}"}))
                pages.append(body)
                n = len(self._items(body))
                total = body.get("total") if isinstance(body, dict) else None
                skip += self.PAGE
                if n < self.PAGE or (isinstance(total, int) and skip >= total) or skip > 5000:
                    break
                time.sleep(0.6)  # the API allows 2 requests/second
        items: list[dict] = []
        for page in pages:
            items.extend(self._items(page))
        return items

    @staticmethod
    def _items(body) -> list[dict]:
        if isinstance(body, list):
            return body
        for key in ("meets", "results", "data", "items"):
            if isinstance(body.get(key), list):
                return body[key]
        return []

    @staticmethod
    def _field(item: dict, *names):
        for n in names:
            v = item.get(n)
            if isinstance(v, dict):
                v = v.get("name") or v.get("track_name")
            if v not in (None, ""):
                return v
        return None

    def run(self, conn: sqlite3.Connection, stats: Stats) -> None:
        items = self.fetch()
        index = self._track_index(conn)
        seen: set[tuple[int, str]] = set()
        unmatched: dict[str, int] = {}
        for item in items:
            country = str(self._field(item, "country", "country_code") or "USA").upper()
            if country not in ("USA", "US", "UNITED STATES"):
                continue
            name = self._field(item, "track_name", "track", "course", "venue", "name")
            raw_date = self._field(item, "date", "meet_date", "race_date", "start_date")
            if not name or not raw_date:
                continue
            track = self._match(index, str(name))
            if track is None:
                unmatched[str(name)] = unmatched.get(str(name), 0) + 1
                continue
            day = str(raw_date)[:10]
            ext_id = self._field(item, "meet_id", "id")
            post = self._field(item, "first_post", "post_time", "start_time")
            seen.add((track["track_id"], day))
            self._confirm(conn, track, day, str(ext_id) if ext_id else None,
                          str(post)[11:16] if post and len(str(post)) >= 16 else None, stats)
        if unmatched:
            stats["api_unmatched_tracks"] = len(unmatched)
            log("  Racing API tracks not in tracks.csv (add them or an alias): " +
                ", ".join(sorted(unmatched)))
        if self.mark_missing:
            self._flag_missing(conn, seen, stats)

    @staticmethod
    def _track_index(conn) -> list[tuple[str, sqlite3.Row]]:
        idx = []
        for t in conn.execute("SELECT * FROM tracks"):
            names = {t["name"], t["code"]} | set(filter(None, (t["aliases"] or "").split("|")))
            for n in names:
                idx.append((norm_name(n), t))
        idx.sort(key=lambda x: -len(x[0]))  # longest names first for substring matching
        return idx

    @staticmethod
    def _match(index, name: str):
        key = norm_name(name)
        for n, t in index:
            if n == key:
                return t
        for n, t in index:
            if len(n) > 4 and re.search(rf"\b{re.escape(n)}\b", key):
                return t
        return None

    def _confirm(self, conn, track, day: str, ext_id, post, stats: Stats) -> None:
        rows = conn.execute("SELECT * FROM race_days WHERE track_id = ? AND race_date = ?",
                            (track["track_id"], day)).fetchall()
        if rows:
            for r in rows:
                if r["locked"] or (r["status"] == "confirmed" and r["external_id"] == ext_id):
                    continue
                conn.execute(
                    """UPDATE race_days SET status = 'confirmed', external_id = COALESCE(?, external_id),
                         first_post_local = COALESCE(?, first_post_local), updated_at = datetime('now')
                       WHERE race_day_id = ?""", (ext_id, post, r["race_day_id"]))
                stats.bump("race_days_confirmed")
            return
        meet = conn.execute("SELECT meet_id, breed FROM meets WHERE track_id = ? AND ? BETWEEN start_date AND end_date "
                            "ORDER BY start_date DESC LIMIT 1", (track["track_id"], day)).fetchone()
        conn.execute(
            """INSERT INTO race_days(track_id, meet_id, race_date, breed, status, first_post_local, source,
                                      external_id, notes)
               VALUES (?,?,?,?,'confirmed',?,'racingapi',?,?)""",
            (track["track_id"], meet["meet_id"] if meet else None, day,
             meet["breed"] if meet else default_breed(track["track_type"]), post, ext_id,
             None if meet else "Card found in API outside any known meet"))
        stats.bump("race_days_added_from_api")

    def _flag_missing(self, conn, seen: set[tuple[int, str]], stats: Stats) -> None:
        """Past days we expected but the API never listed -> cancelled.
        Only for tracks the API covered in this window, and only up to yesterday."""
        covered = {t for t, _ in seen}
        last = min(self.end, dt.date.today() - dt.timedelta(days=1))
        if last < self.start or not covered:
            return
        rows = conn.execute(
            f"""SELECT race_day_id, track_id, race_date FROM race_days
                WHERE race_date BETWEEN ? AND ? AND status IN ('scheduled','estimated') AND locked = 0
                AND track_id IN ({','.join('?' * len(covered))})""",
            (self.start.isoformat(), last.isoformat(), *covered)).fetchall()
        for r in rows:
            if (r["track_id"], r["race_date"]) not in seen:
                conn.execute("UPDATE race_days SET status = 'cancelled', notes = 'Not listed by The Racing API', "
                             "updated_at = datetime('now') WHERE race_day_id = ?", (r["race_day_id"],))
                stats.bump("race_days_flagged_cancelled")


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------
def run_source(conn: sqlite3.Connection, source, dry_run: bool) -> Stats:
    stats = Stats()
    started = now_iso()
    log(f"> {source.name}: syncing...")
    try:
        conn.execute("SAVEPOINT sync")
        source.run(conn, stats)
        if dry_run:
            conn.execute("ROLLBACK TO sync")
            conn.execute("RELEASE sync")
            log(f"  [dry run] would apply: {stats.text()}")
            return stats
        conn.execute("RELEASE sync")
        conn.execute("INSERT INTO sync_runs(source, started_at, finished_at, ok, summary) VALUES (?,?,?,?,?)",
                     (source.name, started, now_iso(), 1, stats.text()))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (f"last_sync_{source.name}", now_iso()))
        conn.commit()
        log(f"  done: {stats.text()}")
    except Exception as err:  # keep DB consistent and record the failure
        conn.execute("ROLLBACK TO sync")
        conn.execute("RELEASE sync")
        if not dry_run:
            conn.execute("INSERT INTO sync_runs(source, started_at, finished_at, ok, summary) VALUES (?,?,?,?,?)",
                         (source.name, started, now_iso(), 0, f"ERROR: {err}"))
            conn.commit()
        log(f"  FAILED: {err}")
        raise
    return stats


def cmd_init(args) -> int:
    db = Path(args.db)
    if db.exists() and not args.force:
        log(f"{db} already exists. Use --force to rebuild it from scratch, or run 'sync'.")
        return 1
    if db.exists():
        db.unlink()
    conn = connect(db)
    ensure_schema(conn)
    conn.commit()
    run_source(conn, SeedSource(Path(args.seed_dir), args.seed_url), dry_run=False)
    rc = cmd_status(args, conn)
    conn.close()
    return rc


def cmd_sync(args) -> int:
    conn = connect(Path(args.db))
    ensure_schema(conn)
    sources = []
    if args.source in ("seed", "all"):
        sources.append(SeedSource(Path(args.seed_dir), args.seed_url, prune=args.prune, force=args.force))
    if args.source in ("usta", "all"):
        sources.append(UstaSource())
    if args.source in ("racingapi", "all"):
        today = dt.date.today()
        start = parse_date(args.date_from) if args.date_from else today - dt.timedelta(days=3)
        end = parse_date(args.date_to) if args.date_to else today + dt.timedelta(days=7)
        api = RacingApiSource(start, end, mark_missing=args.mark_missing)
        if api.configured:
            sources.append(api)
        elif args.source == "racingapi":
            log("RACINGAPI_USERNAME / RACINGAPI_PASSWORD are not set.")
            return 2
        else:
            log("> racingapi: skipped (no credentials set)")
    failures = 0
    for src in sources:
        try:
            run_source(conn, src, args.dry_run)
        except Exception:
            failures += 1
            if args.source != "all":
                break
    conn.close()
    return 1 if failures else 0


def cmd_status(args, conn: sqlite3.Connection | None = None) -> int:
    conn = conn or connect(Path(args.db))
    q = lambda sql: conn.execute(sql).fetchall()
    log("\nDatabase: " + str(Path(args.db).resolve()))
    log("Tracks: " + ", ".join(f"{r[0]} {r[1]}" for r in q(
        "SELECT track_type, COUNT(*) FROM tracks GROUP BY track_type ORDER BY 2 DESC")))
    log("Meets by season year: " + ", ".join(f"{r[0]}: {r[1]}" for r in q(
        "SELECT season_year, COUNT(*) FROM meets GROUP BY season_year")))
    log("Race days by year/status:")
    for r in q("SELECT substr(race_date,1,4) y, status, COUNT(*) FROM race_days GROUP BY y, status ORDER BY y, status"):
        log(f"  {r[0]}  {r[1]:<10} {r[2]}")
    log("Events: " + str(q("SELECT COUNT(*) FROM events")[0][0]))
    runs = q("SELECT source, finished_at, ok, summary FROM sync_runs ORDER BY run_id DESC LIMIT 5")
    if runs:
        log("Recent syncs:")
        for r in runs:
            log(f"  {r[1]}  {r[0]:<9} {'ok ' if r[2] else 'ERR'} {r[3]}")
    return 0


def cmd_export(args) -> int:
    conn = connect(Path(args.db))
    lo = args.date_from or CALENDAR_START.isoformat()
    hi = args.date_to or CALENDAR_END.isoformat()
    rows = lambda sql, p=(): [dict(r) for r in conn.execute(sql, p)]
    payload = {
        "generated_at": now_iso(),
        "window": {"from": lo, "to": hi},
        "tracks": rows("SELECT * FROM v_tracks ORDER BY state, name"),
        "meets": rows("SELECT * FROM v_meets WHERE end_date >= ? AND start_date <= ? ORDER BY start_date", (lo, hi)),
        "race_days": rows("SELECT * FROM v_calendar WHERE race_date BETWEEN ? AND ? ORDER BY race_date, track_code",
                          (lo, hi)),
        "events": rows("""SELECT e.event_key, t.code AS track_code, t.name AS track_name, e.event_date, e.end_date,
                                 e.name, e.grade, e.notes FROM events e JOIN tracks t USING(track_id)
                          WHERE e.event_date BETWEEN ? AND ? ORDER BY e.event_date""", (lo, hi)),
    }
    conn.close()
    out = Path(args.out)
    if out.suffix == ".js":
        # A <script> file works for pages opened straight from disk, where fetching JSON is blocked
        body = json.dumps(payload, separators=(",", ":"))
        out.write_text("// Generated from calendar/racing_calendar.db. Regenerate with Sync Calendar.bat; "
                       f"don't edit by hand.\nwindow.MEJIRO_CALENDAR = {body};\n", encoding="utf-8")
    else:
        out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    log(f"Wrote {args.out}: {len(payload['race_days'])} race days, {len(payload['meets'])} meets.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Mejiro Assistant racetrack calendar sync")
    p.add_argument("--db", default=str(DEFAULT_DB), help="SQLite file (default: racing_calendar.db next to this script)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def seed_opts(sp):
        sp.add_argument("--seed-dir", default=str(DEFAULT_SEED_DIR), help="folder with the seed CSVs")
        sp.add_argument("--seed-url", default=os.environ.get("MEJIRO_SEED_URL"),
                        help="base URL serving tracks.csv, meets.csv, meet_dates.csv, events.csv")

    sp = sub.add_parser("init", help="create the database and load the seed data")
    seed_opts(sp)
    sp.add_argument("--force", action="store_true", help="delete and rebuild an existing database")

    sp = sub.add_parser("sync", help="pull updates from a source")
    sp.add_argument("--source", choices=["seed", "usta", "racingapi", "all"], default="all")
    seed_opts(sp)
    sp.add_argument("--from", dest="date_from", help="racingapi window start (default: 3 days ago)")
    sp.add_argument("--to", dest="date_to", help="racingapi window end (default: 7 days ahead)")
    sp.add_argument("--mark-missing", action="store_true",
                    help="racingapi: mark past expected days that the API never listed as cancelled")
    sp.add_argument("--prune", action="store_true", help="seed: delete seed meets that are no longer in meets.csv")
    sp.add_argument("--force", action="store_true", help="seed: overwrite meets that a live source has updated")
    sp.add_argument("--dry-run", action="store_true", help="show what would change, write nothing")

    sub.add_parser("status", help="show what is in the database")

    sp = sub.add_parser("export", help="write the calendar to JSON (or a .js file for the website)")
    sp.add_argument("--out", default="calendar.json")
    sp.add_argument("--from", dest="date_from")
    sp.add_argument("--to", dest="date_to")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {"init": cmd_init, "sync": cmd_sync, "status": cmd_status, "export": cmd_export}
    try:
        return handlers[args.cmd](args)
    except ValueError as err:
        log(str(err))
        return 1


if __name__ == "__main__":
    sys.exit(main())
