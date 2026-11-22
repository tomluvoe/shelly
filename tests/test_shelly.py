import json
from io import BytesIO
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from archive import Archive
from shelly import CloudClient, CloudError, collect, normalize, selected_devices, serve


DEVICE_ID = "a1b2c3"
SECOND_ID = "d4e5f6"
AREAS = [("area-1", "Area 1", DEVICE_ID), ("area-2", "Area 2", SECOND_ID)]
BLANK_LIMITS = {"temperature_min": None, "temperature_max": None, "humidity_min": None, "humidity_max": None}


class CloudTest(unittest.TestCase):
    def test_batch_request_and_safe_errors(self):
        client = CloudClient("https://cloud.example.test/", "demo+key&value")
        client.opener = MagicMock()
        response = client.opener.open.return_value.__enter__.return_value
        response.read.return_value = b"[]"
        self.assertEqual(client.fetch([DEVICE_ID, SECOND_ID]), [])
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(urlsplit(request.full_url).path, "/v2/devices/api/get")
        self.assertEqual(parse_qs(urlsplit(request.full_url).query), {"auth_key": ["demo+key&value"]})
        self.assertEqual(json.loads(request.data), {"ids": [DEVICE_ID, SECOND_ID], "select": ["status"]})
        client.opener.open.side_effect = HTTPError(request.full_url, 401, "unauthorized", {}, None)
        with self.assertRaisesRegex(CloudError, r"^Shelly Cloud returned HTTP 401\. Check the cloud URL and key\.$"):
            client.fetch([DEVICE_ID])

    def test_sleeping_sensor_and_partial_status(self):
        now = 1_800_000_000
        payload = [{"id": DEVICE_ID.upper(), "online": 0, "status": {
            "unixtime": now - 600,
            "tmp": {"value": 68, "units": "F", "is_valid": True},
            "hum": {"value": 45, "is_valid": False}, "bat": {"value": 0},
        }}]
        self.assertEqual(normalize(payload, [DEVICE_ID, SECOND_ID], now), {
            DEVICE_ID: ("reported", now - 600, (20, None, 0)),
            SECOND_ID: ("missing", None, None),
        })

    def test_discovery_uses_metadata_and_filters_other_models(self):
        client = CloudClient("https://cloud.example.test", "test-key")
        client.opener = MagicMock()
        response = client.opener.open.return_value.__enter__.return_value
        response.read.return_value = json.dumps({"isok": True, "data": {"devices_status": {
            "unreliable-map-key": {"_dev_info": {"id": DEVICE_ID.upper(), "gen": "G1", "code": "SHHT-1"}},
            "relay": {"_dev_info": {"id": SECOND_ID, "gen": "G1", "code": "SHSW-1"}},
            "another-sensor": {"_dev_info": {"id": "abcdef", "gen": "G1", "code": "SHHT-1", "name": "Office"}},
        }}}).encode()
        self.assertEqual(client.discover(), {DEVICE_ID: None, "abcdef": "Office"})
        request = client.opener.open.call_args.args[0]
        self.assertEqual(urlsplit(request.full_url).path, "/device/all_status")
        self.assertEqual(urlsplit(request.full_url).query, "")
        self.assertEqual(parse_qs(request.data.decode()), {
            "auth_key": ["test-key"], "show_info": ["true"], "no_shared": ["true"],
        })

    def test_config_rejects_reusing_same_device(self):
        with self.assertRaisesRegex(ValueError, "ID once"):
            selected_devices(f"{DEVICE_ID},{DEVICE_ID.upper()}")

    def test_app_names_use_device_name_and_assigned_room(self):
        client = CloudClient("https://cloud.example.test", "test-key")
        client.post = MagicMock(side_effect=[
            {"data": {"devices": {
                DEVICE_ID.upper(): {"name": "Workshop"},
                str(int(SECOND_ID, 16)): {"name": f"shellyht-{SECOND_ID}", "room_id": 42},
            }}},
            {"data": {"rooms": {"42": {"name": "Greenhouse"}}}},
        ])
        stop = MagicMock()
        stop.wait.return_value = False
        self.assertEqual(client.app_names([DEVICE_ID, SECOND_ID], stop), {
            DEVICE_ID: "Workshop", SECOND_ID: "Greenhouse",
        })
        self.assertEqual([call.args[0] for call in client.post.call_args_list], [
            "/interface/device/list", "/interface/room/list",
        ])
        client.post.side_effect = CloudError("Unavailable")
        self.assertEqual(client.app_names([DEVICE_ID], stop), {})


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.archive = Archive(Path(directory.name) / "archive.sqlite3")
        self.archive.initialize(AREAS, 60, False)
        self.now = int(time.time()) - 60

    def record(self, checked_at, report_time, temperature):
        self.archive.record(checked_at, {DEVICE_ID: ("reported", report_time, (temperature, 50, 80))})

    def test_cached_reports_and_failed_poll_leave_archive_intact(self):
        self.record(self.now, self.now - 100, 20)
        self.record(self.now + 10, self.now - 100, 20)
        self.archive.poll_failed(self.now + 20, "Cloud unavailable")
        reopened = Archive(self.archive.path)
        self.assertEqual(len(reopened.history("area-1", "7d")["points"]), 1)
        overview = reopened.overview()
        self.assertEqual(overview["collector"]["success_at"], self.now + 10)
        self.assertEqual(overview["collector"]["error"], "Cloud unavailable")
        self.assertEqual(overview["areas"][0]["at"], self.now - 100)
        self.assertEqual(overview["areas"][0]["seen_at"], self.now)
        self.assertNotIn("device_id", overview["areas"][0])

    def test_untimed_reports_only_log_changes(self):
        self.record(self.now, None, 20)
        self.record(self.now + 10, None, 20)
        self.record(self.now + 20, None, 21)
        self.record(self.now + 30, None, 20)
        history = self.archive.history("area-1", "7d")["points"]
        self.assertEqual([point["at"] for point in history], [self.now, self.now + 20, self.now + 30])
        self.assertIsNone(self.archive.overview()["areas"][0]["report_time"])
        averaged = self.archive.history("area-1", "all")["points"]
        self.assertEqual(averaged[0]["count"], 3)
        self.assertAlmostEqual(averaged[0]["temperature"], 61 / 3)

    def test_area_renaming_and_separate_demo_mode(self):
        self.record(self.now, self.now - 100, 20)
        self.archive.initialize([("new-name", "New name", DEVICE_ID)], 60, False)
        self.assertIsNone(self.archive.history("area-1", "all"))
        self.assertEqual(self.archive.overview()["areas"][0]["temperature"], 20)
        with self.assertRaisesRegex(ValueError, "separate archives"):
            self.archive.initialize(AREAS, 60, True)
        self.assertEqual(self.archive.overview()["areas"][0]["slug"], "new-name")

    def request(self, path, *, method="GET", host="127.0.0.1:8766", origin=None, payload=None):
        headers = [f"{method} {path} HTTP/1.1", f"Host: {host}"]
        body = b""
        if origin is not None:
            headers.append(f"Origin: {origin}")
        if payload is not None:
            body = json.dumps(payload).encode()
            headers.extend(["Content-Type: application/json", f"Content-Length: {len(body)}"])
        incoming = BytesIO("\r\n".join(headers).encode() + b"\r\n\r\n" + body)
        outgoing = BytesIO()
        connection = MagicMock()
        connection.makefile.return_value = incoming
        connection.sendall.side_effect = outgoing.write
        with patch("shelly.ThreadingHTTPServer") as server_class:
            def handle():
                handler = server_class.call_args.args[1]
                handler(connection, ("127.0.0.1", 0), server)

            server = server_class.return_value.__enter__.return_value
            server.serve_forever.side_effect = handle
            serve(self.archive, "127.0.0.1", 8766)
        headers, body = outgoing.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), body

    def test_dashboard_serves_area_and_reads_history(self):
        self.record(self.now, self.now - 10, 20)
        status, document = self.request("/areas/area-1/")
        self.assertEqual(status, 200)
        self.assertIn(b'id="history"', document)
        status, data = self.request("/api/areas/area-1/history?range=24h")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["points"][0]["temperature"], 20)
        self.assertEqual(self.request("/api/areas/area-1/history?range=unknown")[0], 400)
        self.assertEqual(self.request("/api/areas/missing/history")[0], 404)
        self.assertEqual(self.request("/api/areas", host="foreign.example")[0], 403)

    def test_dashboard_persists_thresholds_and_migrates_existing_database(self):
        with self.archive.connect() as database:
            database.execute("DROP TABLE alert_limits")
        path = "/api/areas/area-1/limits"
        limits = {**BLANK_LIMITS, "temperature_max": 22, "humidity_min": 55}
        self.assertEqual(self.request(path, method="PUT", origin="http://127.0.0.1:8766", payload=limits)[0], 200)
        invalid_limits = {**limits, "temperature_min": 23}
        self.assertEqual(self.request(path, method="PUT", payload=invalid_limits)[0], 400)
        self.assertEqual(self.request(path, method="PUT", payload={**limits, "humidity_min": 101})[0], 400)
        self.assertEqual(self.request(path, method="PUT", origin="https://other.test", payload=BLANK_LIMITS)[0], 403)
        self.assertEqual(self.request("/api/areas/missing/limits", method="PUT", payload=limits)[0], 404)
        first, second = Archive(self.archive.path).overview()["areas"]
        self.assertEqual(first["limits"], limits)
        self.assertEqual(second["limits"], BLANK_LIMITS)

    def test_alerts_follow_sensors_and_clear_on_in_range_readings(self):
        self.archive.set_limits("area-1", {**BLANK_LIMITS, "temperature_max": 22, "humidity_min": 55})
        self.record(self.now, self.now, 24)
        self.archive.initialize([("workshop", "Workshop", DEVICE_ID)], 60, False)
        self.archive.record(self.now + 1, {DEVICE_ID: ("reported", self.now + 1, (None, 55, 75))})
        area = self.archive.overview()["areas"][0]
        self.assertEqual(area["slug"], "workshop")
        self.assertEqual(area["alerts"], [
            {"metric": "temperature", "direction": "above", "value": 24, "limit": 22, "at": self.now},
        ])
        self.archive.record(self.now + 2, {DEVICE_ID: ("reported", self.now + 2, (22, 56, 75))})
        self.assertEqual(self.archive.overview()["areas"][0]["alerts"], [])
        self.record(self.now + 3, self.now + 3, 24)
        self.assertEqual(len(self.archive.overview()["areas"][0]["alerts"]), 2)
        self.archive.set_limits("workshop", BLANK_LIMITS)
        self.assertEqual(self.archive.overview()["areas"][0]["alerts"], [])

    def run_poll(self, env, inventory, payload):
        defaults = {"SHELLY_CLOUD_URL": "https://cloud.example.test", "SHELLY_CLOUD_KEY": "test-key"}
        with patch.dict(os.environ, {**defaults, **env}, clear=True), patch("shelly.CloudClient") as client_class, \
                patch("shelly.Event") as event_class, patch("shelly.signal.signal"):
            event = event_class.return_value
            event.is_set.side_effect = [False, True]
            event.wait.return_value = False
            client = client_class.return_value
            client.discover.return_value = inventory
            if isinstance(inventory, CloudError):
                client.discover.side_effect = inventory
            client.fetch.return_value = payload
            client.app_names.return_value = {}
            collect(self.archive)
            return client

    def test_discovery_preserves_urls_and_uses_cloud_names(self):
        self.record(self.now, self.now - 10, 20)
        with self.assertLogs(level="WARNING"):
            client = self.run_poll({}, {DEVICE_ID: None, SECOND_ID: "Bedroom"}, [
                {"id": DEVICE_ID, "settings": {"name": "Office"}}, {"id": SECOND_ID},
            ])
        client.fetch.assert_called_once_with([DEVICE_ID, SECOND_ID], include_names=True)
        self.assertEqual(self.archive.configured_areas(), [
            ("area-1", "Office", DEVICE_ID), ("area-2", "Bedroom", SECOND_ID),
        ])
        self.assertEqual(self.archive.history("area-1", "7d")["points"][0]["temperature"], 20)

    def test_discovery_configures_an_empty_archive(self):
        self.archive = Archive(self.archive.path.with_name("new.sqlite3"))
        client = self.run_poll({}, {DEVICE_ID: None}, [{
            "id": DEVICE_ID, "settings": {"name": f"shellyht-{DEVICE_ID}"}, "status": {"tmp": {"tC": 20}},
        }])
        client.discover.assert_called_once()
        self.assertEqual(self.archive.configured_areas(), [AREAS[0]])

    def test_manual_ids_skip_discovery(self):
        client = self.run_poll({"SHELLY_DEVICE_IDS": SECOND_ID.upper()}, {}, [
            {"id": SECOND_ID, "status": {"tmp": {"tC": 18}, "hum": {"value": 46}}},
        ])
        client.discover.assert_not_called()
        client.fetch.assert_called_once_with([SECOND_ID], include_names=True)
        self.assertEqual(self.archive.configured_areas(), [AREAS[1]])
        self.assertEqual(self.archive.overview()["areas"][0]["temperature"], 18)

    def test_discovery_failure_keeps_polling_the_saved_inventory(self):
        with self.assertLogs(level="WARNING"):
            client = self.run_poll({}, CloudError("Inventory unavailable"), [])
        client.fetch.assert_called_once_with([DEVICE_ID, SECOND_ID], include_names=False)
        self.assertEqual(self.archive.configured_areas(), AREAS)


if __name__ == "__main__":
    unittest.main()
