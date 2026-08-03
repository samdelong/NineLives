import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCameraArgs,
  CameraPublisher,
} from "./src/camera-publisher.mjs";
import { DetectionLog } from "./src/detection-log.mjs";
import {
  EventClipRecorder,
  isValidClipId,
} from "./src/event-clip-recorder.mjs";
import { InferenceStreamPublisher } from "./src/inference-publisher.mjs";
import { InferenceScheduleController } from "./src/inference-schedule.mjs";
import { InferenceWorker } from "./src/inference-worker.mjs";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function integerFromEnv(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseExtraArgs(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((argument) => typeof argument === "string")
    ) {
      return parsed;
    }
  } catch {
    // The clear startup error below is more useful than a JSON parser trace.
  }
  throw new Error("CAMERA_EXTRA_ARGS must be a JSON array of strings.");
}

function parseList(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadLocalEnvironment(filename = ".env.local") {
  let contents;
  try {
    contents = await readFile(join(ROOT_DIR, filename), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function createConfig(env = process.env) {
  const width = integerFromEnv(env.CAMERA_WIDTH, 1280, {
    min: 320,
    max: 3840,
  });
  const height = integerFromEnv(env.CAMERA_HEIGHT, 720, {
    min: 240,
    max: 2160,
  });
  const framerate = integerFromEnv(env.CAMERA_FPS, 24, { min: 1, max: 30 });
  const quality = integerFromEnv(env.CAMERA_QUALITY, 80, {
    min: 1,
    max: 100,
  });

  const port = integerFromEnv(env.PORT, 3000, { min: 1, max: 65_535 });
  const internalBaseUrl =
    env.INTERNAL_BASE_URL || `http://127.0.0.1:${port}`;

  return {
    host: env.HOST || "0.0.0.0",
    port,
    camera: {
      command: env.CAMERA_COMMAND || "rpicam-vid",
      width,
      height,
      framerate,
      quality,
      args: buildCameraArgs({
        width,
        height,
        framerate,
        quality,
        extraArgs: parseExtraArgs(env.CAMERA_EXTRA_ARGS),
      }),
      mockImage: env.MOCK_CAMERA_IMAGE || null,
    },
    inference: {
      apiKey: env.ROBOFLOW_API_KEY || "",
      apiUrl: env.ROBOFLOW_API_URL || "http://127.0.0.1:9001",
      workspace: env.ROBOFLOW_WORKSPACE || "",
      workflow: env.ROBOFLOW_WORKFLOW || "",
      imageInput: env.ROBOFLOW_IMAGE_INPUT || "image",
      streamOutput: env.ROBOFLOW_STREAM_OUTPUT || "output_image",
      dataOutputs: parseList(
        env.ROBOFLOW_DATA_OUTPUTS ||
          "identified_cats,raw_cat_predictions,vision_events_message,vision_events_event_id",
      ),
      framerate: integerFromEnv(env.INFERENCE_DECLARED_FPS, framerate, {
        min: 1,
        max: 30,
      }),
      processingTimeout: integerFromEnv(
        env.INFERENCE_PROCESSING_TIMEOUT,
        3_600,
        { min: 60, max: 86_400 },
      ),
      jpegQuality: integerFromEnv(env.INFERENCE_JPEG_QUALITY, 85, {
        min: 30,
        max: 100,
      }),
      pythonCommand:
        env.PYTHON_COMMAND || resolve(ROOT_DIR, ".venv/bin/python"),
      workerScript: resolve(
        ROOT_DIR,
        env.INFERENCE_WORKER_SCRIPT || "inference_stream.py",
      ),
      scheduleFile: resolve(
        ROOT_DIR,
        env.INFERENCE_SCHEDULE_FILE || "data/inference-schedule.json",
      ),
      cameraMjpegUrl:
        env.CAMERA_MJPEG_URL ||
        `${internalBaseUrl}/api/camera/stream`,
      sinkUrl: internalBaseUrl,
    },
    detectionLog: {
      filePath: resolve(
        ROOT_DIR,
        env.DETECTION_LOG_FILE || "data/detection-log.jsonl",
      ),
      cooldownMs: integerFromEnv(env.DETECTION_LOG_COOLDOWN_MS, 1_000, {
        min: 0,
        max: 60_000,
      }),
    },
    clips: {
      enabled: env.DETECTION_CLIPS_ENABLED?.toLowerCase() !== "false",
      directory: resolve(
        ROOT_DIR,
        env.DETECTION_CLIP_DIRECTORY || "data/clips",
      ),
      durationMs:
        integerFromEnv(env.DETECTION_CLIP_DURATION_SECONDS, 30, {
          min: 2,
          max: 60,
        }) * 1_000,
      ffmpegCommand: env.FFMPEG_COMMAND || "ffmpeg",
    },
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function isLoopback(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isAuthorizedInferenceWorker(request, expectedToken) {
  if (!isLoopback(request.socket.remoteAddress)) return false;

  const suppliedToken = request.headers["x-inference-token"];
  if (typeof suppliedToken !== "string") return false;

  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function applyPageSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Invalid path." });
    return;
  }

  const filePath = resolve(PUBLIC_DIR, decodedPath);
  const relativePath = relative(PUBLIC_DIR, filePath);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  try {
    const file = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    applyPageSecurityHeaders(response);
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": file.length,
      "Cache-Control": filePath.endsWith("og.png")
        ? "public, max-age=86400"
        : "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(file);
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    sendJson(response, 500, { error: "The file could not be served." });
  }
}

export function createMonitorServer({
  publisher,
  inferencePublisher,
  inferenceSchedule,
  detectionLog,
  clipRecorder,
  sinkToken,
  config,
}) {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/stream" && method === "GET") {
      inferencePublisher.openStream(response);
      return;
    }

    if (url.pathname === "/api/camera/stream" && method === "GET") {
      publisher.openStream(response);
      return;
    }

    if (
      url.pathname === "/api/inference/frame" &&
      method === "POST"
    ) {
      if (!isAuthorizedInferenceWorker(request, sinkToken)) {
        sendJson(response, 404, { error: "API route not found." });
        return;
      }

      try {
        const frame = await readRequestBody(request, 20_000_000);
        const contentType = request.headers["content-type"] || "image/jpeg";
        inferencePublisher.publishFrame(frame, {
          contentType,
          frameId: request.headers["x-frame-id"] || null,
        });
        sendJson(response, 202, { ok: true });
      } catch (error) {
        sendJson(response, error?.status || 400, {
          error: error instanceof Error ? error.message : "Invalid frame.",
        });
      }
      return;
    }

    if (
      url.pathname === "/api/inference/data" &&
      method === "POST"
    ) {
      if (!isAuthorizedInferenceWorker(request, sinkToken)) {
        sendJson(response, 404, { error: "API route not found." });
        return;
      }

      try {
        const body = await readRequestBody(request, 2_000_000);
        const payload = JSON.parse(body.toString("utf8"));
        const data = payload.data ?? payload;
        const frameId =
          payload.frame_id ?? request.headers["x-frame-id"] ?? null;
        inferencePublisher.publishData(data, {
          frameId,
        });
        const entries = await detectionLog.recordFromInference(data, {
          frameId,
        });
        for (const entry of entries) {
          void clipRecorder?.record(entry).catch((error) => {
            console.error(
              `Could not record event clip: ${
                error instanceof Error ? error.message : error
              }`,
            );
          });
        }
        sendJson(response, 202, { ok: true });
      } catch (error) {
        const status =
          error?.status || (error instanceof SyntaxError ? 400 : 500);
        sendJson(response, status, {
          error:
            error instanceof Error ? error.message : "Invalid inference data.",
        });
      }
      return;
    }

    if (url.pathname === "/api/status" && method === "GET") {
      sendJson(response, 200, {
        camera: {
          ...publisher.getStatus(),
          width: config.camera.width,
          height: config.camera.height,
          framerate: config.camera.framerate,
        },
        inference: inferencePublisher.getStatus(),
        schedule: inferenceSchedule.getStatus(),
        detections: detectionLog.getStatus(),
      });
      return;
    }

    if (url.pathname === "/api/detections" && method === "GET") {
      sendJson(response, 200, {
        entries: detectionLog
          .getEntries()
          .map((entry) => clipRecorder?.withClipStatus(entry) ?? entry),
        ...detectionLog.getStatus(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      return;
    }

    if (url.pathname === "/api/detections/stream" && method === "GET") {
      detectionLog.openStream(response);
      return;
    }

    const clipMatch = url.pathname.match(/^\/api\/clips\/([^/]+)\.mp4$/);
    if (clipMatch && (method === "GET" || method === "HEAD")) {
      const clipId = clipMatch[1];
      if (!clipRecorder || !isValidClipId(clipId)) {
        sendJson(response, 404, { error: "Clip not found." });
        return;
      }

      const status = clipRecorder.getClipStatus(clipId);
      if (status === "recording") {
        sendJson(response, 425, { error: "Clip is still recording." });
        return;
      }
      if (status !== "ready") {
        sendJson(response, 404, { error: "Clip not found." });
        return;
      }

      try {
        const clip = await readFile(clipRecorder.clipPath(clipId));
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": clip.length,
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Disposition": `inline; filename="${clipId}.mp4"`,
          "X-Content-Type-Options": "nosniff",
        });
        response.end(method === "HEAD" ? undefined : clip);
      } catch {
        sendJson(response, 404, { error: "Clip not found." });
      }
      return;
    }

    if (url.pathname === "/api/schedule" && method === "GET") {
      sendJson(response, 200, inferenceSchedule.getStatus());
      return;
    }

    if (url.pathname === "/api/schedule" && method === "PUT") {
      try {
        const body = await readRequestBody(request, 32_000);
        const schedule = JSON.parse(body.toString("utf8"));
        sendJson(response, 200, await inferenceSchedule.update(schedule));
      } catch (error) {
        const status =
          error?.status || (error instanceof SyntaxError ? 400 : 500);
        sendJson(response, status, {
          error:
            error instanceof Error ? error.message : "Invalid schedule.",
        });
      }
      return;
    }

    if (url.pathname === "/api/camera/restart" && method === "POST") {
      publisher.restart();
      inferenceSchedule.restartIfActive();
      sendJson(response, 202, { ok: true });
      return;
    }

    if (url.pathname === "/api/inference/latest" && method === "GET") {
      if (!inferencePublisher.latestResult) {
        sendJson(response, 503, {
          error:
            inferencePublisher.lastError ||
            "Waiting for the first inference result.",
        });
        return;
      }

      sendJson(response, 200, {
        result: inferencePublisher.latestResult,
        capturedAt: inferencePublisher.latestFrameAt?.toISOString() ?? null,
        inferredAt:
          inferencePublisher.latestDataAt?.toISOString() ??
          inferencePublisher.latestFrameAt?.toISOString() ??
          null,
        inferenceCount: inferencePublisher.inferenceCount,
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API route not found." });
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    await serveStatic(request, response, url.pathname);
  });
}

export async function startApplication() {
  await loadLocalEnvironment();
  const config = createConfig();
  const mockFrame = config.camera.mockImage
    ? await readFile(resolve(ROOT_DIR, config.camera.mockImage))
    : null;
  const publisher = new CameraPublisher({
    command: config.camera.command,
    args: config.camera.args,
    mockFrame,
    mockFps: config.camera.framerate,
  });
  const inferencePublisher = new InferenceStreamPublisher({
    targetFps: config.inference.framerate,
  });
  let detectionLog;
  const clipRecorder = config.clips.enabled
    ? new EventClipRecorder({
        publisher: inferencePublisher,
        directory: config.clips.directory,
        durationMs: config.clips.durationMs,
        fps: config.inference.framerate,
        ffmpegCommand: config.clips.ffmpegCommand,
        onStatus: (entry) => detectionLog?.broadcast(entry),
      })
    : null;
  const sinkToken = randomBytes(32).toString("hex");
  const inferenceWorker = new InferenceWorker({
    command: config.inference.pythonCommand,
    script: config.inference.workerScript,
    publisher: inferencePublisher,
    enabled: Boolean(
      config.inference.apiKey &&
        config.inference.workspace &&
        config.inference.workflow,
    ),
    env: {
      ROBOFLOW_API_KEY: config.inference.apiKey,
      ROBOFLOW_API_URL: config.inference.apiUrl,
      ROBOFLOW_WORKSPACE: config.inference.workspace,
      ROBOFLOW_WORKFLOW: config.inference.workflow,
      ROBOFLOW_IMAGE_INPUT: config.inference.imageInput,
      ROBOFLOW_STREAM_OUTPUT: config.inference.streamOutput,
      ROBOFLOW_DATA_OUTPUTS: config.inference.dataOutputs.join(","),
      CAMERA_MJPEG_URL: config.inference.cameraMjpegUrl,
      INFERENCE_SINK_URL: config.inference.sinkUrl,
      INFERENCE_SINK_TOKEN: sinkToken,
      INFERENCE_DECLARED_FPS: String(config.inference.framerate),
      INFERENCE_PROCESSING_TIMEOUT: String(
        config.inference.processingTimeout,
      ),
      INFERENCE_JPEG_QUALITY: String(config.inference.jpegQuality),
    },
  });
  const inferenceSchedule = new InferenceScheduleController({
    worker: inferenceWorker,
    filePath: config.inference.scheduleFile,
  });
  detectionLog = new DetectionLog({
    filePath: config.detectionLog.filePath,
    cooldownMs: config.detectionLog.cooldownMs,
    clipsEnabled: config.clips.enabled,
  });
  await Promise.all([
    inferenceSchedule.load(),
    detectionLog.load(),
    clipRecorder?.start(),
  ]);
  const server = createMonitorServer({
    publisher,
    inferencePublisher,
    inferenceSchedule,
    detectionLog,
    clipRecorder,
    sinkToken,
    config,
  });

  publisher.start();
  server.listen(config.port, config.host, () => {
    console.log(`Nine Lives is running at http://${config.host}:${config.port}`);
    console.log(
      mockFrame
        ? `Camera source: mock image (${config.camera.mockImage})`
        : `Camera source: ${config.camera.command}`,
    );
    inferenceSchedule.start();
    if (
      config.inference.apiKey &&
      config.inference.workspace &&
      config.inference.workflow
    ) {
      const schedule = inferenceSchedule.getStatus();
      console.log(
        schedule.active
          ? `Inference active: WebRTC video at ${config.inference.framerate} fps`
          : `Inference paused by schedule (${schedule.timezone})`,
      );
    }
  });

  const shutdown = () => {
    inferenceSchedule.stop();
    detectionLog.stop();
    clipRecorder?.stop();
    inferenceWorker.stop();
    publisher.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    server,
    publisher,
    inferencePublisher,
    inferenceWorker,
    inferenceSchedule,
    detectionLog,
    clipRecorder,
    config,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  startApplication().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
