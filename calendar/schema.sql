-- Mejiro Assistant: US racetrack calendar database (SQLite)
-- Schema version 1. All dates are ISO-8601 'YYYY-MM-DD' in the track's local time zone.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per racetrack.
CREATE TABLE IF NOT EXISTS tracks (
    track_id    INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,          -- short code used everywhere (e.g. 'CD', 'SAR')
    name        TEXT NOT NULL,
    city        TEXT,
    state       TEXT NOT NULL,                 -- 2-letter US state
    country     TEXT NOT NULL DEFAULT 'USA',
    track_type  TEXT NOT NULL CHECK (track_type IN ('Thoroughbred','Harness','Quarter Horse','Mixed')),
    breeds      TEXT NOT NULL,                 -- comma list: Thoroughbred, Quarter Horse, Standardbred, Arabian, Paint, Appaloosa
    timezone    TEXT,                          -- IANA zone, e.g. America/New_York
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
    usta_code   TEXT,                          -- harness track code used by the USTA (for the USTA sync)
    website     TEXT,
    youtube     TEXT,                          -- official YouTube channel URL, if any
    livestream  INTEGER NOT NULL DEFAULT 0 CHECK (livestream IN (0,1)),  -- 1 = races are live-streamed on that channel
    aliases     TEXT,                          -- '|' separated names used by outside feeds (for matching)
    notes       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A meet is a block of racing at one track (e.g. "Saratoga Summer Meet 2026").
CREATE TABLE IF NOT EXISTS meets (
    meet_id         INTEGER PRIMARY KEY,
    meet_key        TEXT NOT NULL UNIQUE,      -- stable key, e.g. 'SAR-2026-SUMMER'
    track_id        INTEGER NOT NULL REFERENCES tracks(track_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    breed           TEXT NOT NULL,             -- Thoroughbred | Quarter Horse | Standardbred | Mixed | Arabian
    season_year     INTEGER NOT NULL,
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    race_weekdays   TEXT,                      -- 'Thu,Fri,Sat,Sun' or segments 'YYYY-MM-DD..YYYY-MM-DD=Fri,Sat|...'; NULL = unknown
    planned_days    INTEGER,                   -- day count announced by the track/commission (if any)
    status          TEXT NOT NULL CHECK (status IN ('approved','announced','tentative','ended_early','cancelled')),
    date_precision  TEXT NOT NULL CHECK (date_precision IN ('exact','pattern','range_only')),
    extra_dates     TEXT,                      -- ';' list of added race dates outside the weekday pattern
    dark_dates      TEXT,                      -- ';' list of dates removed from the weekday pattern
    source_name     TEXT,
    source_url      TEXT,
    notes           TEXT,
    origin          TEXT NOT NULL DEFAULT 'seed',   -- which sync source last wrote this row
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (start_date <= end_date)
);

-- Explicit race dates for meets with date_precision = 'exact'.
CREATE TABLE IF NOT EXISTS meet_dates (
    meet_id    INTEGER NOT NULL REFERENCES meets(meet_id) ON DELETE CASCADE,
    race_date  TEXT NOT NULL,
    note       TEXT,
    PRIMARY KEY (meet_id, race_date)
);

-- The calendar itself: one row per track per racing day (per breed).
--   status: scheduled = date published in an official calendar
--           estimated = generated from the meet's weekday pattern
--           confirmed = seen on a live race-card feed (e.g. The Racing API)
--           cancelled = card cancelled / not run
CREATE TABLE IF NOT EXISTS race_days (
    race_day_id      INTEGER PRIMARY KEY,
    track_id         INTEGER NOT NULL REFERENCES tracks(track_id) ON DELETE CASCADE,
    meet_id          INTEGER REFERENCES meets(meet_id) ON DELETE SET NULL,
    race_date        TEXT NOT NULL,
    breed            TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('scheduled','estimated','confirmed','cancelled')),
    first_post_local TEXT,                     -- 'HH:MM' local time, when known
    source           TEXT NOT NULL,            -- seed | racingapi | usta | manual
    external_id      TEXT,                     -- id in the external feed (e.g. Racing API meet_id)
    locked           INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),  -- 1 = manual edit, sync will not touch
    notes            TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (track_id, race_date, breed)
);

-- Marquee race days (Derby, Breeders' Cup, etc.) to highlight on the calendar.
CREATE TABLE IF NOT EXISTS events (
    event_id    INTEGER PRIMARY KEY,
    event_key   TEXT NOT NULL UNIQUE,
    track_id    INTEGER NOT NULL REFERENCES tracks(track_id) ON DELETE CASCADE,
    event_date  TEXT NOT NULL,
    end_date    TEXT,
    name        TEXT NOT NULL,
    grade       TEXT,
    notes       TEXT,
    source_url  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log written by sync_calendar.py.
CREATE TABLE IF NOT EXISTS sync_runs (
    run_id       INTEGER PRIMARY KEY,
    source       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    ok           INTEGER,
    summary      TEXT
);

CREATE INDEX IF NOT EXISTS idx_race_days_date  ON race_days(race_date);
CREATE INDEX IF NOT EXISTS idx_race_days_track ON race_days(track_id, race_date);
CREATE INDEX IF NOT EXISTS idx_meets_track     ON meets(track_id, start_date);
CREATE INDEX IF NOT EXISTS idx_events_date     ON events(event_date);

-- ---------------------------------------------------------------------------
-- Views for the site
-- ---------------------------------------------------------------------------

-- Every racing day with track info: the main calendar feed.
DROP VIEW IF EXISTS v_calendar;
CREATE VIEW v_calendar AS
SELECT rd.race_date,
       t.code        AS track_code,
       t.name        AS track_name,
       t.state,
       t.track_type,
       rd.breed,
       rd.status,
       rd.first_post_local,
       t.timezone,
       m.meet_key,
       m.name        AS meet_name,
       rd.source,
       (SELECT group_concat(e.name, ' / ') FROM events e
         WHERE e.track_id = t.track_id
           AND rd.race_date BETWEEN e.event_date AND COALESCE(e.end_date, e.event_date)) AS featured_event
FROM race_days rd
JOIN tracks t      ON t.track_id = rd.track_id
LEFT JOIN meets m  ON m.meet_id = rd.meet_id;

-- Meets with track info, a computed phase, and counts of generated days.
DROP VIEW IF EXISTS v_meets;
CREATE VIEW v_meets AS
SELECT m.meet_key,
       t.code AS track_code,
       t.name AS track_name,
       t.state,
       t.track_type,
       m.name AS meet_name,
       m.breed,
       m.season_year,
       m.start_date,
       m.end_date,
       m.race_weekdays,
       m.planned_days,
       (SELECT COUNT(*) FROM race_days rd WHERE rd.meet_id = m.meet_id AND rd.status <> 'cancelled') AS calendar_days,
       m.status,
       m.date_precision,
       CASE WHEN date('now') < m.start_date THEN 'upcoming'
            WHEN date('now') > m.end_date   THEN 'completed'
            ELSE 'in_progress' END AS phase,
       m.source_name,
       m.source_url,
       m.notes
FROM meets m
JOIN tracks t ON t.track_id = m.track_id;

-- Tracks with their next racing day (from today).
DROP VIEW IF EXISTS v_tracks;
CREATE VIEW v_tracks AS
SELECT t.code, t.name, t.city, t.state, t.track_type, t.breeds, t.timezone, t.status, t.website,
       t.youtube, t.livestream,
       (SELECT MIN(rd.race_date) FROM race_days rd
         WHERE rd.track_id = t.track_id AND rd.race_date >= date('now') AND rd.status <> 'cancelled') AS next_race_date,
       (SELECT m.name FROM meets m
         WHERE m.track_id = t.track_id AND date('now') BETWEEN m.start_date AND m.end_date
         ORDER BY m.start_date LIMIT 1) AS current_meet,
       t.notes
FROM tracks t;
