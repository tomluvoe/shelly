"""Collect Gen1 Shelly H&T reports or serve their local dashboard."""

import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import count
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
from threading import Event
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from archive import Archive, LIMIT_FIELDS, RANGES


ASSETS = Path(__file__).resolve().parent / "dashboard"
DEVICE_ID = re.compile(r"(?:[a-fA-F0-9]{6}|[a-fA-F0-9]{12})")
DEMO_AREAS = [(slug, name, f"demo-{slug}") for slug, name in [
    ("living-room", "Living room"), ("bedroom", "Bedroom"),
    ("office", "Office"), ("utility-room", "Utility room"),
]]
MAX_RESPONSE = 1024 * 1024
AREA_REFRESH_SECONDS = 5 * 60


def selected_devices(raw):
    ids = [part.strip().lower() for part in raw.split(",")]
    if not 1 <= len(ids) <= 10 or not all(DEVICE_ID.fullmatch(device_id) for device_id in ids):
        raise ValueError("Set SHELLY_DEVICE_IDS to 1 to 10 comma-separated Shelly device IDs.")
    if len(ids) != len(set(ids)):
        raise ValueError("Use each Shelly device ID once.")
    return ids


def as_object(value):
    return value if isinstance(value, dict) else {}


def cloud_name(*candidates):
    for value in candidates:
        if isinstance(value, str):
            name = value.strip()[:80]
            if name and not re.fullmatch(r"unnamed|shellyht-(?:[a-f0-9]{6}|[a-f0-9]{12})", name, re.IGNORECASE):
                return name
    return None


def assign_areas(ids, existing, inventory, payload, app_names):
    previous = {device_id: (slug, name) for slug, name, device_id in existing}
    reserved = {slug for slug, _, _ in existing}
    free_numbers = (n for n in count(1) if f"area-{n}" not in reserved)
    names = {}
    for entry in payload:
        entry = as_object(entry)
        device_id = entry.get("id")
        if isinstance(device_id, str):
            settings = as_object(entry.get("settings"))
            names[device_id.lower()] = cloud_name(settings.get("name"), as_object(settings.get("device")).get("name"))

    areas = []
    for device_id in ids:
        if device_id in previous:
            slug, fallback = previous[device_id]
        else:
            n = next(free_numbers)
            slug, fallback = f"area-{n}", f"Area {n}"
        if app_names is None and device_id in previous:
            name = fallback
        else:
            name = (app_names or {}).get(device_id) or names.get(device_id) or inventory.get(device_id) or fallback
        areas.append((slug, name, device_id))
    return areas


class CloudError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CloudClient:
    def __init__(self, server, key):
        try:
            url = urlsplit(server.strip())
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.path not in ("", "/") or url.query or url.fragment):
                raise ValueError
        except ValueError:
            raise ValueError("Set SHELLY_CLOUD_URL to the HTTPS server shown in the Shelly app.") from None
        if not key.strip():
            raise ValueError("Set SHELLY_CLOUD_KEY in .env.")
        self.base = f"https://{url.netloc}"
        self.key = key.strip()
        self.opener = build_opener(NoRedirect())

    def fetch(self, ids, *, include_names=False):
        select = ["status", "settings"] if include_names else ["status"]
        body = {"ids": ids, "select": select}
        if include_names:
            body["pick"] = {"status": ["tmp", "hum", "bat", "is_valid", "unixtime", "_updated"],
                            "settings": ["name", "device"]}
        path = "/v2/devices/api/get?" + urlencode({"auth_key": self.key})
        payload = self.post(path, json.dumps(body).encode(), "application/json")
        if not isinstance(payload, list):
            raise CloudError("Shelly Cloud returned an unexpected response.")
        return payload

    def discover(self):
        form = urlencode({"auth_key": self.key, "show_info": "true", "no_shared": "true"})
        response = as_object(self.post("/device/all_status", form.encode(), "application/x-www-form-urlencoded"))
        statuses = as_object(response.get("data")).get("devices_status")
        if response.get("isok") is not True or not isinstance(statuses, dict):
            raise CloudError("Shelly Cloud did not return a device inventory. You can set SHELLY_DEVICE_IDS in .env.")
        found = {}
        for status in statuses.values():
            status = as_object(status)
            info = as_object(status.get("_dev_info"))
            device_id = info.get("id")
            if (info.get("gen") == "G1" and info.get("code") == "SHHT-1"
                    and isinstance(device_id, str) and DEVICE_ID.fullmatch(device_id)):
                found[device_id.lower()] = cloud_name(info.get("name"), status.get("name"))
        if not found:
            raise CloudError("Shelly Cloud returned no Gen1 H&T devices. You can set SHELLY_DEVICE_IDS in .env.")
        if len(found) > 10:
            raise CloudError("More than 10 Gen1 H&T devices were discovered. Select up to 10 with SHELLY_DEVICE_IDS.")
        return dict(sorted(found.items()))

    def app_names(self, ids, stop):
        # The app's account labels may differ from the device settings returned by v2.
        if stop.wait(1):
            return None
        devices = self.app_listing("device", "devices")
        devices = {key.lower(): as_object(value) for key, value in devices.items()}
        names = {}
        rooms_by_device = {}
        for device_id in ids:
            decimal_id = str(int(device_id, 16))
            device = (devices.get(device_id) or devices.get(f"{device_id}_0")
                      or devices.get(decimal_id) or devices.get(f"{decimal_id}_0", {}))
            name = cloud_name(device.get("name"))
            room_id = device.get("room_id")
            if name:
                names[device_id] = name
            if type(room_id) in (int, str) and str(room_id) not in ("", "-10"):
                rooms_by_device[device_id] = str(room_id)
        if rooms_by_device:
            if stop.wait(1):
                return None
            rooms = self.app_listing("room", "rooms")
            for device_id, room_id in rooms_by_device.items():
                name = cloud_name(as_object(rooms.get(room_id)).get("name"))
                if name:
                    names[device_id] = name
        return names

    def app_listing(self, resource, key):
        body = urlencode({"auth_key": self.key}).encode()
        response = self.post(f"/interface/{resource}/list", body, "application/x-www-form-urlencoded")
        listing = as_object(as_object(response).get("data")).get(key)
        if not isinstance(listing, dict):
            raise CloudError(f"Shelly Cloud did not return the Smart Control {resource} list.")
        return listing

    def post(self, path, body, content_type):
        request = Request(self.base + path, data=body, headers={"Content-Type": content_type}, method="POST")
        try:
            with self.opener.open(request, timeout=15) as response:
                content = response.read(MAX_RESPONSE + 1)
            if len(content) > MAX_RESPONSE:
                raise CloudError("Shelly Cloud response exceeded the size limit.")
            payload = json.loads(content)
        except HTTPError as error:
            error.close()
            hint = " Check the cloud URL and key." if error.code in (401, 403) else ""
            raise CloudError(f"Shelly Cloud returned HTTP {error.code}.{hint}") from None
        except (OSError, ValueError) as error:
            message = "Shelly Cloud returned invalid JSON." if isinstance(error, ValueError) else "Could not reach Shelly Cloud."
            raise CloudError(message) from None
        return payload


def number(value):
    if type(value) in (float, int) and -1e9 < value < 1e9:
        return float(value)
    return None


def percent(value):
    value = number(value)
    return value if value is not None and 0 <= value <= 100 else None


def validate_limits(payload):
    if not isinstance(payload, dict) or payload.keys() != set(LIMIT_FIELDS):
        raise ValueError("Send all four alert thresholds. Use null for a disabled threshold.")
    limits = {}
    for field in LIMIT_FIELDS:
        value = payload[field]
        validator = percent if field.startswith("humidity_") else number
        limits[field] = validator(value)
        if value is not None and limits[field] is None:
            if field.startswith("humidity_"):
                raise ValueError("Enter humidity values between 0 and 100 percent.")
            raise ValueError("Enter numeric temperature values in Celsius.")
    for metric in ("temperature", "humidity"):
        low, high = limits[f"{metric}_min"], limits[f"{metric}_max"]
        if low is not None and high is not None and low > high:
            raise ValueError(f"The {metric} minimum must be at or below the maximum.")
    return limits


def component(status, key):
    value = status.get(key)
    if isinstance(value, dict) and value.get("is_valid") is not False:
        return value
    return {}


def read_temperature(tmp):
    celsius = number(tmp.get("tC"))
    if celsius is None and tmp.get("units") == "C":
        celsius = number(tmp.get("value"))
    if celsius is None:
        fahrenheit = number(tmp.get("tF"))
        if fahrenheit is None and tmp.get("units") == "F":
            fahrenheit = number(tmp.get("value"))
        if fahrenheit is not None:
            celsius = round((fahrenheit - 32) * 5 / 9, 2)
    return celsius


def report_timestamp(status, now):
    # Gen1 status can have a synced Unix time. Some Cloud responses include _updated.
    updated = status.get("_updated")
    candidates = [status.get("unixtime")]
    if isinstance(updated, str):
        try:
            timestamp = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            candidates.append(timestamp.timestamp())
        except (ValueError, OverflowError, OSError):
            pass
    for candidate in candidates:
        if type(candidate) in (float, int) and 946684800 <= candidate <= now + 120:
            return int(candidate)
    return None


def normalize(payload, ids, now):
    results = dict.fromkeys(ids, ("missing", None, None))
    for entry in payload:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        device_id = entry["id"].lower()
        if device_id not in results:
            continue
        status = entry.get("status")
        if not isinstance(status, dict) or status.get("is_valid") is False:
            results[device_id] = ("no-readings", None, None)
            continue
        temperature = read_temperature(component(status, "tmp"))
        humidity = percent(component(status, "hum").get("value"))
        battery = percent(component(status, "bat").get("value"))
        if temperature is None and humidity is None:
            results[device_id] = ("no-readings", None, None)
            continue
        state = "awake" if entry.get("online") == 1 else "reported"
        results[device_id] = (state, report_timestamp(status, now), (temperature, humidity, battery))
    return results


def demo_readings(at):
    results = {}
    hours = at / 3600
    for index, (_, _, device_id) in enumerate(DEMO_AREAS):
        daily = math.sin(hours * math.tau / 24 + index * 0.7)
        weekly = math.sin(hours * math.tau / (24 * 7) + index)
        temperature = round(21 - index * 1.2 + daily * 1.3 + weekly * 0.55, 1)
        humidity = round(44 + index * 4 - daily * 4 + weekly * 2, 1)
        results[device_id] = ("reported", at, (temperature, humidity, 87 - index * 9))
    return results


def collect(archive):
    demo = os.environ.get("SHELLY_DEMO") == "1"
    try:
        interval = int(os.environ.get("SHELLY_POLL_SECONDS", "60"))
        if not 5 <= interval <= 86400:
            raise ValueError
    except ValueError:
        raise ValueError("Set SHELLY_POLL_SECONDS to an integer from 5 to 86400.") from None
    manual_ids = None
    if not demo:
        client = CloudClient(os.environ.get("SHELLY_CLOUD_URL", ""), os.environ.get("SHELLY_CLOUD_KEY", ""))
        id_config = os.environ.get("SHELLY_DEVICE_IDS", "").strip()
        if id_config:
            manual_ids = selected_devices(id_config)

    archive.initialize(DEMO_AREAS if demo else None, interval, demo)
    areas = DEMO_AREAS if demo else archive.configured_areas()
    next_area_refresh = 0.0
    stop = Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logging.info("Collector started (poll interval %ds).", interval)
    if demo:
        now = int(time.time())
        latest = now // 3600 * 3600
        for at in range(latest - 45 * 86400, latest + 1, 3600):
            if stop.is_set():
                return
            archive.record(now, demo_readings(at))
    while not stop.is_set():
        try:
            if demo:
                now = int(time.time())
                archive.record(now, demo_readings(now // 3600 * 3600))
                stop.wait(interval)
                continue
            refresh_due = time.monotonic() >= next_area_refresh
            inventory = None
            if refresh_due and manual_ids is None:
                try:
                    inventory = client.discover()
                except CloudError as error:
                    if not areas:
                        raise
                    logging.warning("Discovery failed. Checking previously configured sensors. %s", error)
                if stop.wait(1):
                    break
            ids = list(inventory) if inventory is not None else manual_ids or [device_id for _, _, device_id in areas]
            configure = refresh_due and (inventory is not None or manual_ids is not None)
            payload = client.fetch(ids, include_names=configure)
            now = int(time.time())
            results = normalize(payload, ids, now)
            updated_areas = areas
            if configure:
                try:
                    app_names = client.app_names(ids, stop)
                except CloudError as error:
                    logging.warning("Could not refresh Smart Control names. %s", error)
                    app_names = None
                updated_areas = assign_areas(ids, areas, inventory or {}, payload, app_names)
                next_area_refresh = time.monotonic() + AREA_REFRESH_SECONDS
            changed = updated_areas != areas
            archive.record(now, results, areas=updated_areas if changed else None)
            if changed:
                areas = updated_areas
                logging.info("Configured %d area(s).", len(areas))
            unavailable = sum(values is None for _, _, values in results.values())
            if unavailable:
                logging.warning("Shelly Cloud returned no valid temperature or humidity for %d area(s).", unavailable)
        except CloudError as error:
            logging.warning("%s", error)
            archive.poll_failed(int(time.time()), str(error))
        stop.wait(interval)


def serve(archive, host, port):
    archive.prepare_dashboard()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def send_bytes(self, status, media_type, body):
            self.send_response(status)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, status, value):
            self.send_bytes(status, "application/json; charset=utf-8", json.dumps(value).encode())

        def local_host(self):
            authority = self.headers.get("Host", "").lower()
            if re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?", authority):
                return authority
            self.send_json(403, {"error": "Open the dashboard using its loopback address."})
            return None

        def do_PUT(self):
            authority = self.local_host()
            if authority is None:
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{authority}":
                self.send_json(403, {"error": "Save thresholds from the local dashboard."})
                return
            match = re.fullmatch(r"/api/areas/([a-z0-9-]+)/limits", urlsplit(self.path).path)
            if not match:
                self.send_json(404, {"error": "Area or endpoint not found."})
                return
            if self.headers.get_content_type() != "application/json":
                self.send_json(415, {"error": "Send thresholds as JSON."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 1024:
                    raise ValueError
                payload = json.loads(self.rfile.read(length))
            except (ValueError, RecursionError):
                self.send_json(400, {"error": "Send a valid JSON object with the alert thresholds."})
                return
            try:
                limits = validate_limits(payload)
                saved = archive.set_limits(match[1], limits)
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            except sqlite3.Error:
                self.send_json(503, {"error": "The archive is temporarily unavailable. Try saving again."})
                return
            if saved:
                self.send_json(200, {"limits": limits})
            else:
                self.send_json(404, {"error": "Area not found."})

        def do_GET(self):
            if self.local_host() is None:
                return
            url = urlsplit(self.path)
            if url.path == "/healthz":
                self.send_json(200, {"ok": True})
                return
            if url.path.startswith("/api/"):
                try:
                    self.serve_api(url)
                except sqlite3.Error:
                    self.send_json(503, {"error": "The archive is temporarily unavailable. Check the collector logs."})
                return
            asset = {
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/style.css": ("style.css", "text/css; charset=utf-8"),
            }.get(url.path)
            if url.path == "/" or re.fullmatch(r"/areas/[a-z0-9-]+/?", url.path):
                asset = ("index.html", "text/html; charset=utf-8")
            if asset is None:
                self.send_json(404, {"error": "Page not found."})
                return
            name, media_type = asset
            self.send_bytes(200, media_type, (ASSETS / name).read_bytes())

        def serve_api(self, url):
            if url.path == "/api/areas":
                self.send_json(200, archive.overview())
                return
            match = re.fullmatch(r"/api/areas/([a-z0-9-]+)/history", url.path)
            if match:
                period = parse_qs(url.query).get("range", ["7d"])[0]
                if period not in RANGES:
                    self.send_json(400, {"error": "Choose a supported history range."})
                    return
                history = archive.history(match[1], period)
                if history is not None:
                    self.send_json(200, history)
                    return
            self.send_json(404, {"error": "Area or endpoint not found."})

    with ThreadingHTTPServer((host, port), Handler) as server:
        logging.info("Dashboard listening on %s:%d", host, port)
        server.serve_forever()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="/data/shelly.sqlite3", help="path to the SQLite archive")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("collect", help="archive readings in the background")
    web = commands.add_parser("serve", help="serve the local dashboard")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8766)
    options = parser.parse_args()
    archive = Archive(options.db)
    try:
        if options.command == "collect":
            collect(archive)
        else:
            serve(archive, options.host, options.port)
    except (ValueError, sqlite3.Error, OSError) as error:
        logging.error("%s", error)
        return 1
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
