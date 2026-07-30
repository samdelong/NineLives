# Nine Lives

**A self-hosted cat camera that watches feeding time for you.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi-camera-C51A4A?logo=raspberrypi&logoColor=white)

![Nine Lives detecting a cat](public/og.png)

Nine Lives turns a Raspberry Pi camera into a real-time feeding-area monitor.
Open the dashboard from any browser to see annotated video, choose exactly when
inference should run, and review a detection history that survives refreshes
and restarts.

The camera stays responsive at 24 FPS while a scheduled, long-lived Roboflow
WebRTC session performs inference on a server you control. That means useful
coverage around feeding time without keeping the inference workload running
all day.

[Explore the Roboflow Workflow][roboflow-workflow] ·
[Get started](#quick-start) ·
[View the HTTP API](#http-api)

## Why Nine Lives?

- **See what the model sees.** Watch the Workflow's annotated output live
  instead of relying on a background process or a stream of JSON.
- **Run inference when it matters.** Create any number of exact, minute-level
  daily windows, including schedules that cross midnight.
- **Keep a durable history.** Cat events are stored on the Raspberry Pi and
  pushed into the dashboard as they happen.
- **Use your own inference hardware.** Point the Pi at a Roboflow Inference
  Server on a LAN GPU or another compatible Roboflow endpoint.
- **Keep secrets server-side.** The Roboflow API key lives in `.env.local` and
  is never sent to the browser.
- **Recover automatically.** Nine Lives supervises the camera and inference
  worker, exposes their health, and restarts inference sessions when needed.

## The Workflow

Nine Lives is more than a camera wrapper: the behavior of the product is
defined by a visual Roboflow Workflow.

**[Open the cat-monitoring Workflow in Roboflow →][roboflow-workflow]**

The shared Workflow shows how frames are processed, cats are identified, the
annotated image is produced, and detection events are emitted. Its outputs map
directly into the application:

| Workflow output | Nine Lives uses it for |
| --- | --- |
| `output_image` | Annotated video displayed in the dashboard |
| `identified_cats` | Human-readable detection status |
| `raw_cat_predictions` | Underlying model predictions |
| `vision_events_message` | Detection event context |
| `vision_events_event_id` | Stable event deduplication and logging |

The output names can be changed through `.env.local`, so the application can
also run with a forked or entirely different Workflow.

## How it works

```mermaid
flowchart LR
    Camera["Raspberry Pi camera"] --> Rpicam["rpicam-vid<br/>24 FPS MJPEG"]
    Rpicam --> App["Nine Lives<br/>Node.js server"]
    App --> Worker["Python WebRTC worker"]
    Worker --> GPU["Roboflow Inference Server<br/>LAN GPU or compatible endpoint"]
    GPU -->|"Annotated frames + event data"| Worker
    Worker --> App
    App --> Dashboard["Browser dashboard"]
    App --> Log["Persistent detection log"]
    Schedule["Daily inference schedule"] --> Worker
```

`rpicam-vid` publishes the camera as MJPEG. A lightweight Python worker reads
that stream from the Node server over loopback and sends frames through one
long-lived WebRTC Workflow session. Annotated frames and Workflow data return
to Node, which serves the dashboard, broadcasts live events, and persists the
detection log.

The schedule controls the inference worker, not the camera. The live camera can
therefore remain available while GPU inference is paused outside the periods
you care about.

## Features

- Live 1280×720 MJPEG camera capture at 24 FPS by default
- Continuously annotated Workflow video in a browser
- Self-hosted or compatible remote Roboflow inference
- Exact daily inference windows with overnight scheduling
- Persistent, multi-day JSONL detection history
- Live log updates using server-sent events
- Per-cat entry and exit transitions without repeated-frame spam
- Camera and inference health reporting
- Automatic WebRTC session recovery
- Mock-camera mode for development on a laptop
- No browser webcam permission or proprietary viewer
- Apache-2.0 licensed

## What you need

- A Raspberry Pi with a supported CSI camera
- Raspberry Pi OS Bookworm or newer
- Node.js 20 or newer
- Python 3.10–3.12
- `rpicam-vid` available on the Pi
- A Roboflow API key, workspace, and Workflow
- A reachable Roboflow Inference Server or compatible endpoint

The current `inference-sdk` dependency does not support Python 3.13 or newer.
On older Raspberry Pi OS releases, `libcamera-vid` can be used instead of
`rpicam-vid`.

## Quick start

1. Confirm the Pi can see the camera:

   ```bash
   rpicam-vid --list-cameras
   ```

2. Install the Node and Python dependencies:

   ```bash
   npm ci
   npm run setup:python
   ```

3. Create your private configuration:

   ```bash
   cp .env.example .env.local
   ```

4. Add the required Roboflow settings to `.env.local`:

   ```dotenv
   ROBOFLOW_API_KEY=your_roboflow_api_key
   ROBOFLOW_API_URL=http://your-inference-server:9001
   ROBOFLOW_WORKSPACE=your_workspace_slug
   ROBOFLOW_WORKFLOW=your_workflow_slug
   ```

5. Start Nine Lives:

   ```bash
   npm start
   ```

6. Open the dashboard from another device on the same network:

   ```text
   http://<raspberry-pi-ip>:3000
   ```

Nine Lives binds to all network interfaces by default. Keep it on a trusted
LAN or put it behind an authenticated reverse proxy before exposing it to the
internet.

## Everyday use

### Schedule inference

Open **Inference windows** in the dashboard and add the exact start and end
times when you want detection to run. Add as many windows as needed. An end
time before its start creates an overnight window.

Schedules repeat every day in the Raspberry Pi's local timezone:

- Schedule disabled: inference runs all day.
- Schedule enabled with windows: inference runs only inside those windows.
- Schedule enabled with no windows: inference remains paused.

The schedule is saved to `data/inference-schedule.json` by default.

### Review detections

Each presence change appears immediately in the live detection log and is
appended to `data/detection-log.jsonl`. The first frame containing an identified
cat records an entry such as `Bobby entered.`. Repeated frames are silent until
that cat disappears, when Nine Lives records `Bobby left.`.

Because the history is stored on the server, it remains available across
browser refreshes, device restarts, and multiple days.

## Configuration

Every setting can be placed in `.env.local`. The file is excluded from Git so
API keys and private network addresses stay out of the repository. See
[`.env.example`](.env.example) for the complete template.

### Camera

| Variable | Default | Purpose |
| --- | --- | --- |
| `CAMERA_COMMAND` | `rpicam-vid` | Camera executable |
| `CAMERA_WIDTH` | `1280` | Capture width |
| `CAMERA_HEIGHT` | `720` | Capture height |
| `CAMERA_FPS` | `24` | Camera frame rate |
| `CAMERA_QUALITY` | `80` | MJPEG quality |
| `CAMERA_EXTRA_ARGS` | — | JSON array of additional camera arguments |

The default camera process is equivalent to:

```bash
rpicam-vid --timeout 0 --nopreview --codec mjpeg --quality 80 \
  --width 1280 --height 720 --framerate 24 --flush --output -
```

Arguments are passed directly to the camera process without a shell.

### Inference and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBOFLOW_API_URL` | `http://127.0.0.1:9001` | Inference Server address |
| `ROBOFLOW_IMAGE_INPUT` | `image` | Workflow image input name |
| `ROBOFLOW_STREAM_OUTPUT` | `output_image` | Annotated image output name |
| `ROBOFLOW_DATA_OUTPUTS` | Workflow defaults | Comma-separated data outputs |
| `INFERENCE_DECLARED_FPS` | Camera FPS | Frame rate declared to WebRTC |
| `INFERENCE_PROCESSING_TIMEOUT` | `3600` | Session lifetime in seconds |
| `INFERENCE_JPEG_QUALITY` | `85` | Frames sent to the inference session |
| `INFERENCE_SCHEDULE_FILE` | `data/inference-schedule.json` | Saved schedule |
| `DETECTION_LOG_FILE` | `data/detection-log.jsonl` | Detection history |

`CAMERA_MJPEG_URL` can point the worker at a different MJPEG source. By
default, it uses the Node server's private loopback stream, so the inference
server does not need direct access to the Pi's HTTP server.

## Develop without a Pi

Use the included product artwork as a mock frame:

```dotenv
MOCK_CAMERA_IMAGE=public/og.png
```

Then start the application normally:

```bash
npm start
```

Nine Lives will publish the image through the same MJPEG, WebRTC worker, API,
and browser paths used by the real camera. Run the checks with:

```bash
npm run check
npm test
```

## HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/stream` | Annotated Workflow stream shown in the dashboard |
| `GET` | `/api/camera/stream` | Raw `rpicam-vid` stream for local diagnostics |
| `GET` | `/api/status` | Camera, inference, and schedule health |
| `GET` | `/api/detections` | Complete persistent detection history |
| `GET` | `/api/detections/stream` | Live detection events over SSE |
| `GET` | `/api/schedule` | Current daily inference schedule |
| `PUT` | `/api/schedule` | Validate and save the schedule |
| `GET` | `/api/inference/latest` | Latest Workflow prediction data |
| `POST` | `/api/camera/restart` | Restart the camera process |

## Roadmap

- [ ] Guided cat enrollment: hold up a cat to create its profile
- [ ] Add, rename, and remove known cats
- [ ] Save snapshots and short clips around detections
- [ ] Optional notifications and webhooks
- [ ] Multi-camera support

## License

Nine Lives is licensed under the [Apache License 2.0](LICENSE).

Roboflow software, hosted services, workflows, datasets, models, and model
weights are not licensed by this repository. They remain subject to their own
licenses and terms. This project does not redistribute model weights; users
must supply and verify the rights to any models, datasets, and workflows they
configure.

[roboflow-workflow]: https://app.roboflow.com/workflows/embed/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ3b3JrZmxvd0lkIjoieWZGWVQ5cFlMWUJFbDE3NmdnVnEiLCJ3b3Jrc3BhY2VJZCI6InNsMDEyQUFpS1BZUEZ0OEFaeGg0MlZqYWF2MDIiLCJ1c2VySWQiOiJzbDAxMkFBaUtQWVBGdDhBWnhoNDJWamFhdjAyIiwiaWF0IjoxNzg1NDQ0NjEzfQ.LuQyUvGFHV6D84Hk8Uab4kT2qIMpASvwqgmMiW6w2GY
