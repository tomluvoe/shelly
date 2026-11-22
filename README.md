# Shelly H&T dashboard

A local dashboard and SQLite archive for Gen1 Shelly H&T temperature and humidity sensors. Each area has its own URL, latest readings, and history charts. The home page links to the areas and shows their latest readings. The collector keeps running when the dashboard tab or container is closed.

## Configure and run

For a fresh checkout, create the local configuration file.

```sh
cp .env.example .env
```

Edit the local `.env` file. Find your cloud server and authorization key in the Shelly Smart Control app under **User settings → Authorization cloud key**.

| Variable | Setting |
| --- | --- |
| `SHELLY_CLOUD_URL` | HTTPS server shown in the Shelly app |
| `SHELLY_CLOUD_KEY` | Cloud authorization key. Keep it inside the single quotes. |
| `SHELLY_DEVICE_IDS` | Optional comma-separated list of device IDs. Leave blank for cloud discovery. |
| `SHELLY_POLL_SECONDS` | Time between checks, 60 seconds by default |
| `SHELLY_DASHBOARD_PORT` | Local port, 8766 by default |

```sh
docker compose up -d --build --wait
docker compose logs -f collector
```

Open [the dashboard](http://127.0.0.1:8766/). A configured slug such as `area-1` has its own page at `/areas/area-1/`. The dashboard listens on loopback by default. Use the refresh button to reload saved data immediately, or leave the tab open for automatic refreshes every 30 seconds. The cloud key and upstream URL go only to the collector container. The sample `.env.example` is safe to commit. Git ignores `.env` and SQLite files, and Docker excludes them from the build context.

### Device discovery

The collector looks for Gen1 H&T sensors owned by your account at startup, then refreshes the list and names about every five minutes. It uses the assigned room name in Shelly Smart Control, then the device name if there is no room name. If Shelly temporarily fails to return its room or device list, the dashboard keeps the names it already has. Sensor history, alert limits and dashboard URLs stay with the device when you rename a room or move the sensor. [Shelly Cloud inventory documentation](https://shelly-api-docs.shelly.cloud/cloud-control-api/real-time-events/#list-of-currentlast-known-statuses-of--owned-devices)

If you want to select specific sensors or discovery fails, set `SHELLY_DEVICE_IDS` in `.env`. Copy each **Device ID** from **Settings → Device Information** in the Shelly app. For example, `SHELLY_DEVICE_IDS=000000000001,000000000002`. Run `docker compose up -d` after changing `.env` to apply it.

## How collection works

The collector checks all configured sensors in one request to [Shelly Cloud's v2 device-state API](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2/). Each check sees the latest status Shelly provides. The archive starts with the first available status and grows as new reports arrive. Reports sent between checks may be missed because the endpoint returns a snapshot.

[Gen1 H&T sensors sleep between reports](https://shelly-api-docs.shelly.cloud/gen1/#shelly-h-amp-t). On battery, the documented periodic report interval is 12 hours, with additional reports when readings cross configured change thresholds. With external power the documented periodic interval is 10 minutes. A successful cloud check and the sensor’s last report have separate timestamps on the dashboard.

The archive stores temperature in Celsius, relative humidity, and battery percentage when present. A sensor report timestamp is recorded once per device. If Shelly provides no usable timestamp, a changed reading is stored as **First seen** at the collection time. Repeated identical snapshots without a timestamp add no rows. Missing readings and cloud errors leave archived values available.

The 24-hour and 7-day charts show individual readings. Longer views use averages for the plotted time windows. Original readings stay in SQLite without an expiry. Charts display dates in the browser’s time zone.

## Sensor alerts

Open an area and set any minimums or maximums in **Alert limits**. Temperature uses Celsius and humidity uses percent. Leave a field blank to disable that limit. Limits are stored in SQLite per sensor, so renaming a device keeps its thresholds.

An area is highlighted on both the home page and its room page when the most recent available value is below a minimum or above a maximum. The warning shows the reading and the limit it crossed. It clears when that metric next reports a value within range or you change the threshold. Warnings appear in the dashboard.

## Keep or back up the archive

The collector and dashboard share `/data/shelly.sqlite3` in the Compose `history` volume. The collector saves readings and the dashboard saves alert thresholds. `docker compose down` and rebuilds preserve the volume. `docker compose down -v` deletes it. Keep the same Compose project name to reuse the volume.

To make a consistent file backup, briefly stop both services while copying the database.

```sh
docker compose stop collector dashboard
docker compose cp dashboard:/data/shelly.sqlite3 ./shelly-backup.sqlite3
docker compose start collector dashboard
```

## Demo without hardware

Use a separate Compose project and port for the demo. It starts with 45 days of simulated readings and needs no cloud credentials.

```sh
SHELLY_DEMO=1 SHELLY_DASHBOARD_PORT=8767 docker compose --env-file .env.example -p shelly-demo up -d --build --wait
```

Open [the demo dashboard](http://127.0.0.1:8767/). Stop it with `docker compose --env-file .env.example -p shelly-demo down`.

The local archive workflow is inspired by a GARO charger dashboard.
