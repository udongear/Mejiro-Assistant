"""Run with:  python -m unittest discover -s tests -v   (from the project folder)"""
import datetime as dt
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import sync_calendar as sc  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


def fresh_db() -> tuple[sqlite3.Connection, Path]:
    tmp = Path(tempfile.mkdtemp())
    conn = sc.connect(tmp / "t.db")
    sc.ensure_schema(conn)
    conn.commit()
    sc.run_source(conn, sc.SeedSource(), dry_run=False)
    return conn, tmp


def one(conn, sql, *p):
    return conn.execute(sql, p).fetchone()


class WeekdayTests(unittest.TestCase):
    def test_simple_and_segments(self):
        m = sc.weekday_matcher("Fri,Sat")
        self.assertTrue(m(dt.date(2026, 11, 6)))      # Friday
        self.assertFalse(m(dt.date(2026, 11, 5)))     # Thursday
        seg = sc.weekday_matcher("2026-01-01..2026-01-31=Fri|2026-02-01..2026-02-28=Sun")
        self.assertTrue(seg(dt.date(2026, 1, 2)))
        self.assertFalse(seg(dt.date(2026, 2, 6)))    # Friday, but February is Sunday-only
        self.assertTrue(seg(dt.date(2026, 2, 1)))
        self.assertFalse(seg(dt.date(2026, 3, 6)))    # outside every segment
        self.assertIsNone(sc.weekday_matcher(""))
        with self.assertRaises(ValueError):
            sc.weekday_matcher("Fry")


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.tmp = fresh_db()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp)

    def test_loaded(self):
        self.assertGreaterEqual(one(self.conn, "SELECT COUNT(*) FROM tracks")[0], 100)
        self.assertGreater(one(self.conn, "SELECT COUNT(*) FROM race_days WHERE race_date LIKE '2027%'")[0], 500)
        # Saratoga 2026 summer meet: 46 announced days, pattern must reproduce it exactly.
        self.assertEqual(one(self.conn, "SELECT calendar_days FROM v_meets WHERE meet_key='SAR-2026-SUMMER'")[0], 46)
        # Christmas is never generated from a pattern.
        self.assertEqual(one(self.conn, "SELECT COUNT(*) FROM race_days WHERE substr(race_date,6)='12-25'")[0], 0)
        # Exact meets produce 'scheduled', pattern meets 'estimated'.
        self.assertEqual(one(self.conn, "SELECT DISTINCT status FROM v_calendar WHERE meet_key='KD-2027'")[0], "scheduled")
        self.assertEqual(one(self.conn, "SELECT DISTINCT status FROM v_calendar WHERE meet_key='KEE-2027-FALL'")[0], "estimated")
        # Range-only meets create no days.
        self.assertEqual(one(self.conn, "SELECT calendar_days FROM v_meets WHERE meet_key='MNR-2026'")[0], 0)
        # Every race day sits inside the 2026-2027 window.
        lo, hi = one(self.conn, "SELECT MIN(race_date), MAX(race_date) FROM race_days")
        self.assertGreaterEqual(lo, "2026-01-01")
        self.assertLessEqual(hi, "2027-12-31")

    def test_idempotent(self):
        before = one(self.conn, "SELECT COUNT(*), MAX(updated_at) FROM race_days")
        stats = sc.run_source(self.conn, sc.SeedSource(), dry_run=False)
        self.assertNotIn("race_days_added", stats)
        self.assertNotIn("race_days_removed", stats)
        self.assertNotIn("meets_updated", stats)
        self.assertEqual(stats.get("tracks_upserted", 0), 0)
        self.assertEqual(before, one(self.conn, "SELECT COUNT(*), MAX(updated_at) FROM race_days"))

    def test_locked_rows_survive(self):
        rid, = one(self.conn, "SELECT race_day_id FROM race_days WHERE race_date='2027-05-01' "
                              "AND track_id=(SELECT track_id FROM tracks WHERE code='CD')")
        self.conn.execute("UPDATE race_days SET locked=1, notes='manual', status='scheduled' WHERE race_day_id=?", (rid,))
        self.conn.execute("UPDATE meets SET race_weekdays='Mon', origin='seed' WHERE meet_key='CD-2027-SPRING'")
        sc.rebuild_race_days(self.conn, sc.Stats())
        self.assertEqual(one(self.conn, "SELECT notes FROM race_days WHERE race_day_id=?", rid)[0], "manual")

    def test_dry_run_writes_nothing(self):
        n = one(self.conn, "SELECT COUNT(*) FROM race_days")[0]
        self.conn.execute("DELETE FROM race_days WHERE race_date LIKE '2027-01%'")
        self.conn.commit()
        sc.run_source(self.conn, sc.SeedSource(), dry_run=True)
        self.assertLess(one(self.conn, "SELECT COUNT(*) FROM race_days")[0], n)
        sc.run_source(self.conn, sc.SeedSource(), dry_run=False)
        self.assertEqual(one(self.conn, "SELECT COUNT(*) FROM race_days")[0], n)


class UstaTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.tmp = fresh_db()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp)

    def _parse(self, fixture):
        by_code, by_name = sc.UstaSource.build_index(self.conn)
        return sc.UstaSource.parse((FIX / fixture).read_text(), by_code, by_name)

    def test_table_layout(self):
        ranges, unmatched = self._parse("usta_table.html")
        tracks = {t["code"] for t, _, _ in ranges}
        self.assertEqual(len(tracks), 31)
        batavia = sorted((s, e) for t, s, e in ranges if t["code"] == "BTV")
        self.assertEqual(batavia, [(dt.date(2026, 1, 3), dt.date(2026, 2, 5)),
                                   (dt.date(2026, 7, 22), dt.date(2026, 12, 19))])
        self.assertEqual(unmatched, [])

    def test_real_page_markup(self):
        # Markup captured from ustrotting.com/track-information on 2026-10-29.
        ranges, unmatched = self._parse("usta_real_2026-10-29.html")
        self.assertEqual(len({t["code"] for t, _, _ in ranges}), 31)
        self.assertEqual(len(ranges), 35)  # 4 tracks have two meets
        self.assertEqual(unmatched, [])
        dover = [(s, e) for t, s, e in ranges if t["code"] == "DD"]
        self.assertEqual(dover, [(dt.date(2026, 11, 2), dt.date(2027, 4, 1))])
        # Seed data already matches the live page: a sync should change no meets.
        html = (FIX / "usta_real_2026-10-29.html").read_text()
        stats = sc.run_source(self.conn, sc.UstaSource(html_text=html), dry_run=False)
        self.assertNotIn("meets_updated", stats)
        self.assertNotIn("meets_added", stats)

    def test_card_layout_and_unknown_track(self):
        ranges, unmatched = self._parse("usta_cards.html")
        self.assertEqual(len({t["code"] for t, _, _ in ranges}), 31)
        # The unknown track's dates must not be pinned on Yonkers (the previous card).
        yr = [(s, e) for t, s, e in ranges if t["code"] == "YR"]
        self.assertEqual(yr, [(dt.date(2026, 1, 19), dt.date(2026, 12, 18))])
        self.assertTrue(any("Brand New Raceway" in u for u in unmatched))

    def test_sync_updates_and_seed_respects_it(self):
        html = (FIX / "usta_table.html").read_text().replace("01/19/2026 - 12/18/2026", "01/19/2026 - 12/20/2026")
        sc.run_source(self.conn, sc.UstaSource(html_text=html), dry_run=False)
        row = one(self.conn, "SELECT end_date, origin FROM meets WHERE meet_key='YR-2026'")
        self.assertEqual(tuple(row), ("2026-12-20", "usta"))
        stats = sc.run_source(self.conn, sc.SeedSource(), dry_run=False)
        self.assertEqual(one(self.conn, "SELECT end_date FROM meets WHERE meet_key='YR-2026'")[0], "2026-12-20")
        self.assertIn("meets_kept_from_usta", stats)

    def test_layout_change_aborts(self):
        with self.assertRaises(RuntimeError):
            sc.run_source(self.conn, sc.UstaSource(html_text="<html><body>Redesigned!</body></html>"), dry_run=False)
        self.assertEqual(one(self.conn, "SELECT ok FROM sync_runs ORDER BY run_id DESC LIMIT 1")[0], 0)


class RacingApiTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.tmp = fresh_db()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp)

    def test_confirm_insert_and_flag(self):
        payload = [{"meets": [
            {"meet_id": "cd_1101", "track_name": "Churchill Downs", "country": "USA", "date": "2026-11-01"},
            {"meet_id": "gp_x", "track_name": "GULFSTREAM PARK", "country": "USA", "date": "2026-11-02"},
            {"meet_id": "wo_1", "track_name": "Woodbine", "country": "CAN", "date": "2026-11-01"},
            {"meet_id": "zz_1", "track_name": "Nowhere Downs", "country": "USA", "date": "2026-11-01"},
        ], "total": 4}]
        api = sc.RacingApiSource(dt.date(2026, 10, 28), dt.date(2026, 11, 3), payload_pages=payload,
                                 mark_missing=True)
        stats = sc.run_source(self.conn, api, dry_run=False)
        cd = one(self.conn, "SELECT rd.status, rd.external_id FROM race_days rd JOIN tracks t USING(track_id) "
                            "WHERE t.code='CD' AND rd.race_date='2026-11-01'")
        self.assertEqual(tuple(cd), ("confirmed", "cd_1101"))
        # Monday Nov 2 is outside Gulfstream's Fri-Sun pattern: inserted from the API, linked to its meet.
        gp = one(self.conn, "SELECT status, meet_key, source FROM v_calendar WHERE track_code='GP' AND race_date='2026-11-02'")
        self.assertEqual(tuple(gp), ("confirmed", "GP-2026-SUNSHINE", "racingapi"))
        self.assertEqual(stats.get("api_unmatched_tracks"), 1)          # Nowhere Downs; Woodbine skipped (CAN)
        # Churchill Oct 28/29 were expected but not in the payload -> cancelled (dates are in the past).
        if dt.date.today() > dt.date(2026, 10, 29):
            self.assertEqual(one(self.conn, "SELECT status FROM v_calendar WHERE track_code='CD' "
                                            "AND race_date='2026-10-28'")[0], "cancelled")
        # Tracks the API did not cover in the window are left alone.
        self.assertNotEqual(one(self.conn, "SELECT status FROM v_calendar WHERE track_code='DED' "
                                           "AND race_date='2026-10-28'")[0], "cancelled")


class ExportTests(unittest.TestCase):
    def test_export(self):
        conn, tmp = fresh_db()
        conn.close()
        out = tmp / "c.json"
        rc = sc.main(["--db", str(tmp / "t.db"), "export", "--out", str(out), "--from", "2027-01-01"])
        self.assertEqual(rc, 0)
        import json
        data = json.loads(out.read_text())
        self.assertTrue(all(r["race_date"] >= "2027-01-01" for r in data["race_days"]))
        self.assertTrue(any(e["name"] == "Kentucky Derby" for e in data["events"]))
        shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
