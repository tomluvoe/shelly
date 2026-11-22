"""SQLite archive shared between the collector and the dashboard."""

from contextlib import contextmanager
from pathlib import Path
import sqlite3
import time


RANGES = {"24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400,
          "1y": 365 * 86_400, "all": None}
LIMIT_FIELDS = ("temperature_min", "temperature_max", "humidity_min", "humidity_max")
LIMIT_SCHEMA = """
CREATE TABLE IF NOT EXISTS alert_limits (
    device_id TEXT PRIMARY KEY,
    temperature_min REAL,
    temperature_max REAL,
    humidity_min REAL,
    humidity_max REAL
);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS areas (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    device_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting'
);
CREATE TABLE IF NOT EXISTS readings (
    device_id TEXT NOT NULL,
    report_time INTEGER,
    seen_at INTEGER NOT NULL,
    at INTEGER NOT NULL,
    temperature REAL,
    humidity REAL,
    battery REAL,
    UNIQUE (device_id, report_time)
);
CREATE INDEX IF NOT EXISTS reading_time ON readings (device_id, at);
CREATE TABLE IF NOT EXISTS collector (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    interval INTEGER NOT NULL,
    demo INTEGER NOT NULL,
    checked_at INTEGER,
    success_at INTEGER,
    error TEXT
);
""" + LIMIT_SCHEMA


class Archive:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connect(self, *, readonly=False):
        uri = self.path.resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw')
        database = sqlite3.connect(uri, uri=True)
        database.row_factory = sqlite3.Row
        try:
            with database:
                yield database
        finally:
            database.close()

    def initialize(self, areas, interval, demo):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(exist_ok=True)
        with self.connect() as database:
            database.executescript(SCHEMA)
            database.execute("BEGIN IMMEDIATE")
            mode = database.execute("SELECT demo FROM collector").fetchone()
            if mode is not None and mode["demo"] != demo:
                raise ValueError("Demo and live collection require separate archives.")
            if areas is not None:
                self.replace_areas(database, areas)
            database.execute("""
                INSERT INTO collector(singleton, interval, demo) VALUES (1, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET interval=excluded.interval, demo=excluded.demo
            """, (interval, demo))

    @staticmethod
    def replace_areas(database, areas):
        database.execute("CREATE TEMP TABLE configured(slug TEXT PRIMARY KEY)")
        for position, (slug, name, device_id) in enumerate(areas):
            database.execute("INSERT INTO configured VALUES (?)", (slug,))
            database.execute("""
                INSERT INTO areas (slug, name, device_id, position) VALUES (?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET name=excluded.name, position=excluded.position,
                    state=CASE WHEN areas.device_id=excluded.device_id THEN areas.state ELSE 'waiting' END,
                    device_id=excluded.device_id
            """, (slug, name, device_id, position))
        database.execute("DELETE FROM areas WHERE slug NOT IN (SELECT slug FROM configured)")

    def configured_areas(self):
        with self.connect(readonly=True) as database:
            rows = database.execute("SELECT slug, name, device_id FROM areas ORDER BY position").fetchall()
            return [tuple(row) for row in rows]

    def poll_failed(self, now, error):
        with self.connect() as database:
            database.execute("UPDATE collector SET checked_at=?, error=?", (now, error))

    def prepare_dashboard(self):
        if self.path.is_file():
            with self.connect() as database:
                database.execute(LIMIT_SCHEMA)

    def set_limits(self, slug, limits):
        if not self.path.is_file():
            return False
        with self.connect() as database:
            updated = database.execute("""
                INSERT INTO alert_limits (device_id, temperature_min, temperature_max, humidity_min, humidity_max)
                SELECT device_id, ?, ?, ?, ? FROM areas WHERE slug=?
                ON CONFLICT(device_id) DO UPDATE SET
                    temperature_min=excluded.temperature_min, temperature_max=excluded.temperature_max,
                    humidity_min=excluded.humidity_min, humidity_max=excluded.humidity_max
            """, (*(limits[field] for field in LIMIT_FIELDS), slug))
            return updated.rowcount == 1

    def record(self, now, results, *, areas=None):
        with self.connect() as database:
            if areas is not None:
                database.execute("BEGIN IMMEDIATE")
                self.replace_areas(database, areas)
            for device_id, (state, report_time, values) in results.items():
                if values is not None:
                    self.save_reading(database, device_id, now, report_time, values)
                database.execute("UPDATE areas SET state=? WHERE device_id=?", (state, device_id))
            database.execute("UPDATE collector SET checked_at=?, success_at=?, error=NULL", (now, now))

    @staticmethod
    def save_reading(database, device_id, seen_at, report_time, values):
        if report_time is None:
            previous = database.execute("""
                SELECT temperature, humidity, battery FROM readings WHERE device_id=?
                ORDER BY at DESC, rowid DESC LIMIT 1
            """, (device_id,)).fetchone()
            if previous is not None and tuple(previous) == values:
                return
        database.execute("""
            INSERT INTO readings VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, report_time) DO UPDATE SET
                temperature=COALESCE(excluded.temperature, readings.temperature),
                humidity=COALESCE(excluded.humidity, readings.humidity),
                battery=COALESCE(excluded.battery, readings.battery)
        """, (device_id, report_time, seen_at, report_time or seen_at, *values))

    def overview(self):
        if not self.path.is_file():
            return {"collector": None, "areas": []}
        with self.connect(readonly=True) as database:
            database.execute("BEGIN")
            collector = database.execute("SELECT interval, demo, checked_at, success_at, error FROM collector").fetchone()
            areas = database.execute("""
                SELECT a.slug, a.name, a.state, r.at, r.report_time, r.seen_at,
                       r.temperature, r.humidity, r.battery,
                       l.temperature_min, l.temperature_max, l.humidity_min, l.humidity_max,
                       t.temperature AS last_temperature, t.at AS temperature_at,
                       h.humidity AS last_humidity, h.at AS humidity_at
                FROM areas a LEFT JOIN alert_limits l ON l.device_id=a.device_id
                LEFT JOIN readings r ON r.rowid = (
                    SELECT rowid FROM readings WHERE device_id=a.device_id ORDER BY at DESC, rowid DESC LIMIT 1
                ) LEFT JOIN readings t ON t.rowid = (
                    SELECT rowid FROM readings WHERE device_id=a.device_id AND temperature IS NOT NULL
                    ORDER BY at DESC, rowid DESC LIMIT 1
                ) AND (l.temperature_min IS NOT NULL OR l.temperature_max IS NOT NULL)
                LEFT JOIN readings h ON h.rowid = (
                    SELECT rowid FROM readings WHERE device_id=a.device_id AND humidity IS NOT NULL
                    ORDER BY at DESC, rowid DESC LIMIT 1
                ) AND (l.humidity_min IS NOT NULL OR l.humidity_max IS NOT NULL)
                ORDER BY a.position
            """).fetchall()
        return {"collector": dict(collector) if collector else None,
                "areas": [self.area_with_alerts(dict(area)) for area in areas]}

    @staticmethod
    def area_with_alerts(area):
        limits = {field: area.pop(field) for field in LIMIT_FIELDS}
        alerts = []
        for metric in ("temperature", "humidity"):
            value = area.pop(f"last_{metric}")
            at = area.pop(f"{metric}_at")
            if value is None:
                continue
            minimum = limits[f"{metric}_min"]
            maximum = limits[f"{metric}_max"]
            if minimum is not None and value < minimum:
                alerts.append({"metric": metric, "direction": "below", "value": value, "limit": minimum, "at": at})
            if maximum is not None and value > maximum:
                alerts.append({"metric": metric, "direction": "above", "value": value, "limit": maximum, "at": at})
        return {**area, "limits": limits, "alerts": alerts}

    def history(self, slug, period):
        if not self.path.is_file():
            return None
        with self.connect(readonly=True) as database:
            database.execute("BEGIN")
            area = database.execute("SELECT device_id FROM areas WHERE slug=?", (slug,)).fetchone()
            if area is None:
                return None
            device_id = area["device_id"]
            end = int(time.time())
            duration = RANGES[period]
            if duration is None:
                first = database.execute("SELECT MIN(at) FROM readings WHERE device_id=?", (device_id,)).fetchone()[0]
                start = first if first is not None else end - RANGES["7d"]
            else:
                start = end - duration
            start = min(start, end - 1)
            # Round long ranges to whole-hour windows with roughly 600 points at most.
            if period in ("24h", "7d"):
                bucket = 0
            else:
                hours_per_bucket = (end - start + 600 * 3600 - 1) // (600 * 3600)
                bucket = hours_per_bucket * 3600
            if bucket:
                rows = database.execute("""
                    SELECT CAST(AVG(at) AS INTEGER) AS at, AVG(temperature) AS temperature,
                           AVG(humidity) AS humidity, COUNT(*) AS count
                    FROM readings WHERE device_id=? AND at BETWEEN ? AND ?
                    GROUP BY (at - ?) / ? ORDER BY at
                """, (device_id, start, end, start, bucket)).fetchall()
            else:
                rows = database.execute("""
                    SELECT at, temperature, humidity, 1 AS count FROM readings
                    WHERE device_id=? AND at BETWEEN ? AND ? ORDER BY at, rowid
                """, (device_id, start, end)).fetchall()
        return {"start": start, "end": end, "bucket": bucket, "points": [dict(row) for row in rows]}
