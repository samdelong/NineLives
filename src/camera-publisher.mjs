import { spawn as spawnChild } from "node:child_process";

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export function buildCameraArgs({
  width,
  height,
  framerate,
  quality,
  extraArgs = [],
}) {
  return [
    "--timeout",
    "0",
    "--nopreview",
    "--codec",
    "mjpeg",
    "--quality",
    String(quality),
    "--width",
    String(width),
    "--height",
    String(height),
    "--framerate",
    String(framerate),
    "--flush",
    "--output",
    "-",
    ...extraArgs,
  ];
}

export class MjpegFrameDecoder {
  constructor(onFrame, { maxFrameBytes = 10_000_000 } = {}) {
    this.onFrame = onFrame;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length) {
      const start = this.buffer.indexOf(JPEG_START);

      if (start === -1) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        return;
      }

      if (start > 0) {
        this.buffer = this.buffer.subarray(start);
      }

      const end = this.buffer.indexOf(JPEG_END, JPEG_START.length);
      if (end === -1) {
        if (this.buffer.length > this.maxFrameBytes) {
          this.buffer = this.buffer.subarray(this.buffer.length - 1);
        }
        return;
      }

      const frameEnd = end + JPEG_END.length;
      const frame = Buffer.from(this.buffer.subarray(0, frameEnd));
      this.buffer = this.buffer.subarray(frameEnd);

      if (frame.length <= this.maxFrameBytes) {
        this.onFrame(frame);
      }
    }
  }
}

export class CameraPublisher {
  constructor({
    command = "rpicam-vid",
    args,
    spawn = spawnChild,
    restartDelayMs = 1_500,
    maxRestartDelayMs = 15_000,
    mockFrame = null,
    mockFps = 2,
  }) {
    this.command = command;
    this.args = args;
    this.spawn = spawn;
    this.restartDelayMs = restartDelayMs;
    this.maxRestartDelayMs = maxRestartDelayMs;
    this.currentRestartDelayMs = restartDelayMs;
    this.mockFrame = mockFrame;
    this.mockFps = mockFps;

    this.child = null;
    this.restartTimer = null;
    this.mockTimer = null;
    this.clients = new Set();
    this.latestFrame = null;
    this.latestFrameAt = null;
    this.frameCount = 0;
    this.state = "stopped";
    this.lastError = null;
    this.stopping = false;
    this.stderrTail = [];
  }

  start() {
    this.stopping = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    if (this.mockFrame) {
      this.state = "live";
      this.lastError = null;
      this.publishFrame(this.mockFrame);
      const period = Math.max(100, Math.round(1_000 / this.mockFps));
      this.mockTimer = setInterval(
        () => this.publishFrame(this.mockFrame),
        period,
      );
      this.mockTimer.unref?.();
      return;
    }

    this.state = "starting";
    this.stderrTail = [];

    let camera;
    try {
      camera = this.spawn(this.command, this.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.handleCameraFailure(error);
      return;
    }

    this.child = camera;
    const decoder = new MjpegFrameDecoder((frame) => this.publishFrame(frame));

    camera.stdout.on("data", (chunk) => decoder.push(chunk));
    camera.stderr.setEncoding("utf8");
    camera.stderr.on("data", (chunk) => {
      const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      this.stderrTail.push(...lines);
      this.stderrTail = this.stderrTail.slice(-8);
    });

    camera.once("error", (error) => {
      if (this.child !== camera) return;
      this.handleCameraFailure(error, camera);
    });

    camera.once("close", (code, signal) => {
      if (this.child !== camera) return;
      this.child = null;
      if (this.stopping) return;

      const detail = this.stderrTail.at(-1);
      const exitDescription = signal
        ? `Camera process stopped with ${signal}.`
        : `Camera process exited with code ${code ?? "unknown"}.`;
      this.lastError = detail ? `${exitDescription} ${detail}` : exitDescription;
      this.scheduleRestart();
    });
  }

  publishFrame(frame) {
    this.latestFrame = frame;
    this.latestFrameAt = new Date();
    this.frameCount += 1;
    this.state = "live";
    this.lastError = null;
    this.currentRestartDelayMs = this.restartDelayMs;

    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    const ending = Buffer.from("\r\n");

    for (const response of this.clients) {
      if (response.destroyed || response.writableEnded) {
        this.clients.delete(response);
        continue;
      }

      if (response.writableNeedDrain || response.writableLength > frame.length * 2) {
        continue;
      }

      response.write(header);
      response.write(frame);
      response.write(ending);
    }
  }

  openStream(response) {
    response.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Connection: "keep-alive",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });

    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));

    if (this.latestFrame) {
      const frame = this.latestFrame;
      response.write(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      );
      response.write(frame);
      response.write("\r\n");
    }
  }

  handleCameraFailure(error, camera = null) {
    if (camera && this.child === camera) {
      this.child = null;
    }

    this.lastError =
      error?.code === "ENOENT"
        ? `Camera command "${this.command}" was not found.`
        : error instanceof Error
          ? error.message
          : "The camera process could not be started.";
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.state = "restarting";

    const delay = this.currentRestartDelayMs;
    this.currentRestartDelayMs = Math.min(
      this.currentRestartDelayMs * 2,
      this.maxRestartDelayMs,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  restart() {
    this.stop({ closeClients: false });
    this.start();
  }

  stop({ closeClients = true } = {}) {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.mockTimer);
    this.restartTimer = null;
    this.mockTimer = null;

    const camera = this.child;
    this.child = null;
    if (camera && !camera.killed) {
      camera.kill("SIGTERM");
    }

    this.state = "stopped";

    if (closeClients) {
      for (const response of this.clients) {
        response.end();
      }
      this.clients.clear();
    }
  }

  getStatus() {
    return {
      state: this.state,
      hasFrame: Boolean(this.latestFrame),
      frameAgeMs: this.latestFrameAt
        ? Date.now() - this.latestFrameAt.getTime()
        : null,
      latestFrameAt: this.latestFrameAt?.toISOString() ?? null,
      frameCount: this.frameCount,
      clients: this.clients.size,
      command: this.mockFrame ? "mock-image" : this.command,
      lastError: this.lastError,
    };
  }
}
