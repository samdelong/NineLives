# Nine Lives cat camera

A Node.js service for a Raspberry Pi camera. The server starts `rpicam-vid`,
publishes its raw MJPEG feed locally, supervises a Python WebRTC worker, and
publishes the workflow's annotated video output to the browser.

## Architecture

```text
Pi camera → rpicam-vid → Node raw MJPEG → Python local capture
                                                │
                                                ▼
browser ← Node annotated stream ← WebRTC ← ManualSource frames
```

The browser does not request webcam permission. There are no per-frame Workflow
HTTP requests: during an active schedule window, a single WebRTC video session
stays connected and is restarted automatically if it exits or reaches its
processing timeout.

The Raspberry Pi runs Node, `rpicam-vid`, and the lightweight Python WebRTC
client. A configured Roboflow Inference Server—such as an NVIDIA machine on
the same LAN—performs the Workflow compute.

## Raspberry Pi setup

Use Raspberry Pi OS Bookworm or newer, Node.js 20 or newer, and Python
3.10–3.12. The current `inference-sdk` does not support Python 3.13 or newer.
The Workflow must expose `output_image` as a video output for the annotated
stream callback.

1. Confirm that the camera works:

   ```bash
   rpicam-vid --list-cameras
   ```

2. Install the WebRTC worker dependencies:

   ```bash
   npm run setup:python
   ```

3. Configure the app:

   ```bash
   cp .env.example .env.local
   ```

   Put your Roboflow key, workspace, workflow, and Inference Server address in
   `.env.local`. The server address can be a self-hosted machine on your LAN or
   another compatible Roboflow Inference endpoint.

4. Start the service:

   ```bash
   npm start
   ```

5. From another device on the same network, open:

   ```text
   http://<raspberry-pi-ip>:3000
   ```

The server listens on all network interfaces by default. Keep it on a trusted
LAN or put it behind an authenticated reverse proxy before exposing it to the
internet.

## Camera settings

The default process is equivalent to:

```bash
rpicam-vid --timeout 0 --nopreview --codec mjpeg --quality 80 \
  --width 1280 --height 720 --framerate 24 --flush --output -
```

Change resolution, frame rate, quality, or the command itself in `.env.local`.
Set `CAMERA_COMMAND=libcamera-vid` only on an older Pi OS release that still
uses that command name. `CAMERA_EXTRA_ARGS` accepts a JSON array so arguments
are passed directly without a shell.

`INFERENCE_DECLARED_FPS` describes the expected camera frame rate to the WebRTC
session and defaults to 24. `INFERENCE_PROCESSING_TIMEOUT` defaults to one hour;
the Node supervisor starts a new session whenever the worker exits.

The Python worker reads the Node server's private loopback MJPEG URL locally,
then sends the decoded frames to the NVIDIA server over WebRTC. The inference
server never needs network access to the Pi's HTTP server. Set
`CAMERA_MJPEG_URL` only if the worker should read a different MJPEG source.

## Inference schedule

Use the schedule section on the site to add exact start and end times with
minute-level precision. You can add multiple windows, including windows that
cross midnight. The schedule repeats every day using the Raspberry Pi's local
timezone. The camera stream stays live all day, while the WebRTC inference
worker starts at the beginning of a selected period and stops at its end.

The schedule is off by default, which preserves all-day inference. Turning it
on with no periods selected pauses inference all day. The saved schedule lives
in `data/inference-schedule.json`; override that path with
`INFERENCE_SCHEDULE_FILE`.

## Detection log

Each cat event is appended to `data/detection-log.jsonl` on the Raspberry Pi.
The site loads the saved history when it opens and receives new entries live,
so detections remain visible after a refresh or server restart and can span
multiple days.

When the Workflow returns `vision_events_event_id`, the server records that
event only once. If no event ID is present, repeated positive frames are
deduplicated for five minutes by default so a cat standing in frame does not
produce 24 log entries per second. Configure the path with
`DETECTION_LOG_FILE` and the fallback interval with
`DETECTION_LOG_DEDUPE_SECONDS`.

## Develop without a Pi camera

Set this in `.env.local`:

```text
MOCK_CAMERA_IMAGE=public/og.png
```

Then `npm start` publishes that image as a mock MJPEG source while preserving
the same WebRTC worker and browser endpoints.

## HTTP endpoints

- `GET /api/stream` — annotated workflow output stream shown on the site
- `GET /api/camera/stream` — raw `rpicam-vid` stream for diagnostics
- `GET /api/status` — camera, inference, and schedule status
- `GET /api/detections` — complete persistent cat-detection history
- `GET /api/detections/stream` — live detection events using server-sent events
- `GET /api/schedule` — saved daily inference schedule
- `PUT /api/schedule` — save the daily inference schedule
- `GET /api/inference/latest` — latest workflow prediction data
- `POST /api/camera/restart` — restart the camera process

## License

The Nine Lives source code is licensed under the
[Apache License 2.0](LICENSE).

Roboflow software, hosted services, workflows, datasets, models, and model
weights are not licensed by this repository. They remain subject to their own
licenses and terms. This project does not redistribute model weights; users
must supply and verify the rights to any models, datasets, and workflows they
configure.
